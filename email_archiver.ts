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
    !['TRASH', 'SPAM', 'UNREAD', 'STARRED', 'IMPORTANT'].includes(label.name)
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

interface EmailWithLabels {
  id: string;
  raw: string;
  labels: string[];
}

async function resolveLabelName(gmail: any, labelId: string): Promise<string> {
  try {
    const response: GaxiosResponse = await gmail.users.labels.get({
      userId: 'me',
      id: labelId
    });
    return response.data.name;
  } catch (error) {
    console.error(`Failed to resolve name for label ID ${labelId}:`, error);
    return labelId; // Fallback to using the ID if we can't resolve the name
  }
}

async function getAllUniqueEmails(gmail: any): Promise<EmailWithLabels[]> {
  const response: GaxiosResponse = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 500 // Adjust as needed
  });

  const emails: EmailWithLabels[] = [];
  for (const message of response.data.messages || []) {
    const fullMessage: GaxiosResponse = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'raw'
    });

    // Resolve label names
    const labelNames = await Promise.all(
      (fullMessage.data.labelIds || []).map(id => resolveLabelName(gmail, id))
    );

    emails.push({
      id: message.id,
      raw: fullMessage.data.raw,
      labels: labelNames
    });
  }

  return emails;
}

async function transferEmails(sourceGmail: any, destGmail: any, sourceEmail: string, isDryRun: boolean): Promise<TransferSummary> {
  console.log(chalk.cyan('Fetching all unique emails...'));
  const allEmails = await getAllUniqueEmails(sourceGmail);
  console.log(chalk.yellow(`Total unique emails to be transferred: ${chalk.bold(allEmails.length)}`));

  // Count emails per label
  const labelCounts = new Map<string, number>();
  allEmails.forEach(email => {
    email.labels.forEach(label => {
      if (!label.startsWith('CATEGORY_') && !['UNREAD', 'STARRED', 'IMPORTANT'].includes(label)) {
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
      }
    });
  });

  // Output label counts
  console.log(chalk.cyan('\nEmails per label:'));
  labelCounts.forEach((count, label) => {
    console.log(chalk.cyan(`${label}: ${chalk.bold(count)}`));
  });

  const confirmMessage = isDryRun
    ? `Do you want to proceed with the dry run? (y/n): `
    : `Do you want to proceed with transferring ${allEmails.length} emails? (y/n): `;

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
  console.log(chalk.green(`${isDryRun ? '[DRY RUN] Would use' : 'Using'} main label: ${chalk.bold(sourceEmail)}`));
  summary.labelsCreated.push(sourceEmail);

  const labelMap = new Map<string, string>();

  for (const email of allEmails) {
    if (!isDryRun) {
      const importRes: GaxiosResponse = await destGmail.users.messages.import({
        userId: 'me',
        requestBody: { raw: email.raw },
        internalDateSource: 'dateHeader',
      });

      const labelIds = [mainLabelId];
      for (const sourceLabel of email.labels) {
        if (!sourceLabel.startsWith('CATEGORY_') && !['UNREAD', 'STARRED', 'IMPORTANT'].includes(sourceLabel)) {
          if (!labelMap.has(sourceLabel)) {
            const destLabelId = await createOrGetLabel(destGmail, `${sourceEmail}/${sourceLabel}`);
            labelMap.set(sourceLabel, destLabelId);
            summary.labelsCreated.push(`${sourceEmail}/${sourceLabel}`);
          }
          labelIds.push(labelMap.get(sourceLabel)!);
        }
      }

      await destGmail.users.messages.modify({
        userId: 'me',
        id: importRes.data.id,
        requestBody: { addLabelIds: labelIds },
      });
    } else {
      // For dry run, simulate label creation
      for (const sourceLabel of email.labels) {
        if (!sourceLabel.startsWith('CATEGORY_') && !['UNREAD', 'STARRED', 'IMPORTANT'].includes(sourceLabel)) {
          if (!labelMap.has(sourceLabel)) {
            labelMap.set(sourceLabel, `dry-run-label-${sourceLabel}`);
            summary.labelsCreated.push(`${sourceEmail}/${sourceLabel}`);
          }
        }
      }
    }
    console.log(chalk.green(`${isDryRun ? '[DRY RUN] Would transfer' : 'Transferred'} message: ${email.id}`));
    summary.totalEmailsTransferred++;
    await delay(100);
  }

  // Output created labels
  console.log(chalk.cyan('\nLabels that would be created:'));
  summary.labelsCreated.forEach(label => {
    console.log(chalk.cyan(`- ${label}`));
  });

  return summary;
}

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
    console.log(chalk.green(`Total emails ${isDryRun ? 'that would be' : ''} transferred: ${chalk.bold(summary.totalEmailsTransferred)}`));
    if (!isDryRun) {
      console.log(chalk.green('Labels created:'));
      summary.labelsCreated.forEach(label => console.log(chalk.green(`- ${label}`)));
    }

    console.log(chalk.bgGreen.black(`\nEmail transfer ${isDryRun ? 'dry run' : 'completed'} successfully.`));
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.message === 'Transfer cancelled by user.') {
        console.log(chalk.yellow('Transfer cancelled by user.'));
      } else {
        console.error(chalk.bgRed.white('An error occurred:'));
        console.error(chalk.red(error.message));
      }
    } else {
      console.error(chalk.bgRed.white('An unknown error occurred'));
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(chalk.bgRed.white('An error occurred:'));
    console.error(chalk.red(error.message));
  } else {
    console.error(chalk.bgRed.white('An unknown error occurred'));
  }
});