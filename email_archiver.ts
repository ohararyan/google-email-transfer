import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { GaxiosResponse } from 'gaxios';
import dotenv from 'dotenv';
import fs from 'fs';
import chalk from 'chalk';
import readline from 'readline';

dotenv.config();

interface EmailLabel {
  id: string;
  name: string;
}

interface EmailMetadata {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  payload?: {
    headers?: Array<{ name: string, value: string }>;
  };
}

// Add this function at the top of your file
function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Add this function to prompt for user confirmation
function promptForConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// Add this function to count emails for a label
async function countEmailsForLabel(gmail: any, labelId: string): Promise<number> {
  const response: GaxiosResponse = await gmail.users.messages.list({
    userId: 'me',
    labelIds: [labelId],
  });
  return response.data.messages?.length || 0;
}

async function getAuthClient(email: string): Promise<JWT> {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable is not set');
  }

  console.log(`Authenticating for email: ${email}`);
  const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));

  const client = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    subject: email
  });

  await client.authorize();
  console.log('Authorization successful');
  return client;
}

async function getLabels(gmail: any): Promise<EmailLabel[]> {
  const response: GaxiosResponse = await gmail.users.labels.list({ userId: 'me' });
  return response.data.labels.filter((label: EmailLabel) =>
    !label.name.startsWith('CATEGORY_') &&
    !['TRASH', 'SPAM'].includes(label.name)
  );
}

async function createLabel(gmail: any, name: string): Promise<string> {
  const response: GaxiosResponse = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  return response.data.id;
}

async function checkIfEmailExists(gmail: any, subject: string, internalDate: string): Promise<boolean> {
  const query = `subject:"${subject.replace(/"/g, '\\"')}" after:${Math.floor(parseInt(internalDate) / 1000 - 1)} before:${Math.floor(parseInt(internalDate) / 1000 + 1)}`;
  const response: GaxiosResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query,
  });

  return (response.data.messages && response.data.messages.length > 0);
}

async function getLabelByName(gmail: any, name: string): Promise<EmailLabel | null> {
  const response: GaxiosResponse = await gmail.users.labels.list({ userId: 'me' });
  const labels = response.data.labels;
  return labels.find((label: EmailLabel) => label.name === name) || null;
}

async function createOrGetLabel(gmail: any, name: string): Promise<string> {
  const existingLabel = await getLabelByName(gmail, name);
  if (existingLabel) {
    console.log(`Label already exists: ${name}`);
    return existingLabel.id;
  }

  const response: GaxiosResponse = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  console.log(`Created new label: ${name}`);
  return response.data.id;
}

// Add these interfaces at the top of the file
interface TransferSummary {
  labelsCreated: string[];
  totalEmailsTransferred: number;
}

// Modify the transferEmailsForLabel function to return the number of emails transferred
async function transferEmailsForLabel(sourceGmail: any, destGmail: any, sourceEmail: string, label: EmailLabel, mainLabelId: string, isDryRun: boolean): Promise<number> {
  const messagesResponse: GaxiosResponse = await sourceGmail.users.messages.list({
    userId: 'me',
    labelIds: [label.id],
  });

  const messages = messagesResponse.data.messages || [];
  console.log(chalk.cyan(`Found ${chalk.bold(messages.length)} messages for label: ${chalk.bold(label.name)}`));

  if (messages.length === 0) {
    console.log(chalk.yellow(`Skipping label creation for ${chalk.bold(label.name)} as there are no messages`));
    return 0;
  }

  const sublabelName = `${sourceEmail}/${label.name}`;
  const sublabelId = isDryRun ? `dry-run-sublabel-${label.id}` : await createOrGetLabel(destGmail, sublabelName);
  console.log(chalk.green(`Using sublabel: ${chalk.bold(sublabelName)}`));

  let emailsTransferred = 0;

  for (const message of messages) {
    const metadata: GaxiosResponse<EmailMetadata> = await sourceGmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'metadata',
      metadataHeaders: ['Subject'],
    });

    const subject = metadata.data.payload?.headers?.find((h: any) => h.name === 'Subject')?.value || 'No Subject';
    const internalDate = metadata.data.internalDate;

    const emailExists = await checkIfEmailExists(destGmail, subject, internalDate);

    if (emailExists) {
      console.log(chalk.yellow(`Skipping existing email: ${chalk.italic(subject)}`));
      continue;
    }

    if (!isDryRun) {
      const res: GaxiosResponse = await sourceGmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'raw',
      });

      const importRes: GaxiosResponse = await destGmail.users.messages.import({
        userId: 'me',
        requestBody: { raw: res.data.raw },
        internalDateSource: 'dateHeader',
      });

      await destGmail.users.messages.modify({
        userId: 'me',
        id: importRes.data.id,
        requestBody: { addLabelIds: [mainLabelId, sublabelId] },
      });
    }
    console.log(chalk.green(`${isDryRun ? chalk.yellow('[DRY RUN]') + ' Would transfer' : 'Transferred'} message: ${chalk.italic(subject)}`));
    emailsTransferred++;
    await delay(100);
  }

  return emailsTransferred;
}

// Modify the transferEmails function to first count emails and prompt for confirmation
async function transferEmails(sourceGmail: any, destGmail: any, sourceEmail: string, isDryRun: boolean): Promise<TransferSummary> {
  const sourceLabels = await getLabels(sourceGmail);
  console.log(chalk.cyan(`Found ${chalk.bold(sourceLabels.length)} labels to process`));

  let totalEmailCount = 0;
  const emailCounts = new Map<string, number>();

  // Count INBOX, SENT, and DRAFT separately
  for (const specialLabel of ['INBOX', 'SENT', 'DRAFT']) {
    const count = await countEmailsForLabel(sourceGmail, specialLabel);
    emailCounts.set(specialLabel, count);
    totalEmailCount += count;
    console.log(chalk.cyan(`${specialLabel}: ${chalk.bold(count)} emails`));
  }

  // Count other labels
  for (const label of sourceLabels) {
    if (!['INBOX', 'SENT', 'DRAFT'].includes(label.name)) {
      const count = await countEmailsForLabel(sourceGmail, label.id);
      emailCounts.set(label.name, count);
      console.log(chalk.cyan(`${label.name}: ${chalk.bold(count)} emails`));
      // We don't add to totalEmailCount here to avoid double-counting
    }
  }

  console.log(chalk.yellow(`Total unique emails to be transferred: ${chalk.bold(totalEmailCount)}`));

  const confirmMessage = isDryRun
    ? `Do you want to proceed with the dry run? (y/n): `
    : `Do you want to proceed with transferring ${totalEmailCount} emails? (y/n): `;

  const confirmed = await promptForConfirmation(chalk.yellow(confirmMessage));

  if (!confirmed) {
    console.log(chalk.red('Transfer cancelled by user.'));
    process.exit(0);
  }

  const summary: TransferSummary = {
    labelsCreated: [],
    totalEmailsTransferred: 0
  };

  const mainLabelId = isDryRun ? 'dry-run-main-label' : await createOrGetLabel(destGmail, sourceEmail);
  console.log(chalk.green(`Using main label: ${chalk.bold(sourceEmail)}`));
  summary.labelsCreated.push(sourceEmail);

  // Transfer INBOX, SENT, and DRAFT messages first
  for (const specialLabel of ['INBOX', 'SENT', 'DRAFT']) {
    summary.totalEmailsTransferred += await transferEmailsForLabel(sourceGmail, destGmail, sourceEmail, { id: specialLabel, name: specialLabel }, mainLabelId, isDryRun);
  }

  // Transfer other labels
  for (const label of sourceLabels) {
    if (!['INBOX', 'SENT', 'DRAFT'].includes(label.name)) {
      const emailsTransferred = await transferEmailsForLabel(sourceGmail, destGmail, sourceEmail, label, mainLabelId, isDryRun);
      if (emailsTransferred > 0) {
        summary.labelsCreated.push(`${sourceEmail}/${label.name}`);
        summary.totalEmailsTransferred += emailsTransferred;
      }
    }
  }

  return summary;
}

// Modify the main function to handle the case where the user cancels the transfer
async function main() {
  const sourceEmail = process.env.SOURCE_EMAIL;
  const archiveEmail = process.env.ARCHIVE_EMAIL;
  const isDryRun = process.argv.includes('--dry-run');

  if (!sourceEmail || !archiveEmail) {
    throw new Error('Missing required environment variables');
  }

  console.log(chalk.bgBlue.white(`Running in ${isDryRun ? 'DRY RUN' : 'LIVE'} mode`));

  const sourceAuth = await getAuthClient(sourceEmail);
  const archiveAuth = await getAuthClient(archiveEmail);

  const sourceGmail = google.gmail({ version: 'v1', auth: sourceAuth });
  const archiveGmail = google.gmail({ version: 'v1', auth: archiveAuth });

  try {
    const summary = await transferEmails(sourceGmail, archiveGmail, sourceEmail, isDryRun);

    console.log(chalk.bgGreen.black('\nTransfer Summary:'));
    console.log(chalk.green(`Total emails transferred: ${chalk.bold(summary.totalEmailsTransferred)}`));
    console.log(chalk.green('Labels created:'));
    summary.labelsCreated.forEach(label => console.log(chalk.green(`- ${label}`)));

    console.log(chalk.bgGreen.black(`\nEmail transfer ${isDryRun ? 'dry run' : 'completed'} successfully.`));
  } catch (error) {
    if (error.message === 'Transfer cancelled by user.') {
      console.log(chalk.yellow('Transfer cancelled by user.'));
    } else {
      console.error(chalk.bgRed.white('An error occurred:'));
      console.error(chalk.red(error.message));
    }
  }
}

main().catch(error => {
  console.error(chalk.bgRed.white('An error occurred:'));
  console.error(chalk.red(error.message));
});