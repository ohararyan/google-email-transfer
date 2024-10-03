import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { GaxiosResponse } from 'gaxios';
import dotenv from 'dotenv';
import fs from 'fs';
import chalk from 'chalk';
import readline from 'readline';
import { parseArgs } from 'util';
import { rateLimiter, exponentialBackoff } from './utils/rateLimiter.js';

dotenv.config();

// Interfaces
interface EmailLabel {
  id: string;
  name: string;
}

interface TransferSummary {
  labelsCreated: string[];
  totalEmailsTransferred: number;
  totalEmailsProcessed: number;
}

// Utility functions
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

// Gmail API functions
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

async function createOrGetLabel(gmail: any, name: string): Promise<string> {
  await rateLimiter.waitForToken();
  const existingLabel = await getLabelByName(gmail, name);
  if (existingLabel) {
    console.log(`Label already exists: ${name}`);
    return existingLabel.id;
  }

  await rateLimiter.waitForToken();
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

async function getLabelByName(gmail: any, name: string): Promise<EmailLabel | null> {
  const response: GaxiosResponse = await gmail.users.labels.list({ userId: 'me' });
  const labels = response.data.labels;
  return labels.find((label: EmailLabel) => label.name === name) || null;
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

// Main transfer function
async function transferEmails(sourceGmail: any, destGmail: any, sourceEmail: string, isDryRun: boolean): Promise<TransferSummary> {
  console.log(chalk.cyan('Starting email transfer process...'));

  const summary: TransferSummary = {
    labelsCreated: [],
    totalEmailsTransferred: 0,
    totalEmailsProcessed: 0
  };

  const labelMap = new Map<string, string>();
  const labelCounts = new Map<string, number>();

  const mainLabelId = isDryRun ? 'dry-run-main-label' : await createOrGetLabel(destGmail, sourceEmail);
  console.log(chalk.green(`${isDryRun ? '[DRY RUN] Would use' : 'Using'} main label: ${chalk.bold(sourceEmail)}`));
  summary.labelsCreated.push(sourceEmail);

  const confirmMessage = isDryRun
    ? 'Are you sure you want to proceed with the dry run? (y/n): '
    : 'Are you sure you want to proceed with the live transfer? This will copy emails to the archive account. (y/n): ';

  const confirmed = await promptForConfirmation(chalk.yellow(confirmMessage));

  if (!confirmed) {
    console.log(chalk.red('Transfer cancelled by user.'));
    return summary;
  }

  const batchSize = 100;
  let pageToken: string | undefined;

  do {
    await rateLimiter.waitForToken();
    const response: GaxiosResponse = await sourceGmail.users.messages.list({
      userId: 'me',
      maxResults: batchSize,
      pageToken: pageToken
    });

    const emails = response.data.messages || [];
    summary.totalEmailsProcessed += emails.length;

    for (const email of emails) {
      await processEmail(email, sourceGmail, destGmail, sourceEmail, isDryRun, summary, labelMap, labelCounts, mainLabelId);
    }

    console.log(chalk.cyan(`\nProgress: ${summary.totalEmailsProcessed} emails processed, ${summary.totalEmailsTransferred} transferred`));

    pageToken = response.data.nextPageToken;
  } while (pageToken);

  // Output final label counts and created labels
  outputSummary(labelCounts, summary);

  return summary;
}

async function processEmail(message: any, sourceGmail: any, destGmail: any, sourceEmail: string, isDryRun: boolean, summary: TransferSummary, labelMap: Map<string, string>, labelCounts: Map<string, number>, mainLabelId: string) {
  let retries = 0;
  const maxRetries = 5;

  while (retries < maxRetries) {
    try {
      await rateLimiter.waitForToken();
      const fullMessage: GaxiosResponse = await sourceGmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'raw'
      });

      const labelNames = await Promise.all(
        (fullMessage.data.labelIds || []).map(async (id: string) => {
          await rateLimiter.waitForToken();
          return resolveLabelName(sourceGmail, id);
        })
      );

      if (!isDryRun) {
        await transferMessage(destGmail, fullMessage, labelNames, sourceEmail, mainLabelId, labelMap, summary);
      } else {
        console.log(chalk.green(`[DRY RUN] Would transfer message: ${message.id}`));
        summary.totalEmailsTransferred++;
      }

      updateLabelCounts(labelNames, labelCounts);
      break; // If successful, break out of the retry loop
    } catch (error) {
      if (error instanceof Error && (error.message.includes('ReceivingRate') || error.message.includes('Internal error encountered'))) {
        retries++;
        console.log(chalk.yellow(`Rate limit hit, retrying (${retries}/${maxRetries}) for message ${message.id}`));
        await exponentialBackoff(retries);
      } else {
        console.error(chalk.red(`Error processing message ${message.id}:`, error));
        break; // If it's not a rate limit error, break out of the retry loop
      }
    }
  }

  // Add a delay between processing each email
  await rateLimiter.waitForToken();
}

async function transferMessage(destGmail: any, fullMessage: GaxiosResponse, labelNames: string[], sourceEmail: string, mainLabelId: string, labelMap: Map<string, string>, summary: TransferSummary) {
  await rateLimiter.waitForToken();
  const importRes: GaxiosResponse = await destGmail.users.messages.import({
    userId: 'me',
    requestBody: { raw: fullMessage.data.raw },
    internalDateSource: 'dateHeader',
  });

  const labelIds = [mainLabelId];
  for (const sourceLabel of labelNames) {
    if (!sourceLabel.startsWith('CATEGORY_') && !['UNREAD', 'STARRED', 'IMPORTANT'].includes(sourceLabel)) {
      if (!labelMap.has(sourceLabel)) {
        await rateLimiter.waitForToken();
        const destLabelId = await createOrGetLabel(destGmail, `${sourceEmail}/${sourceLabel}`);
        labelMap.set(sourceLabel, destLabelId);
        summary.labelsCreated.push(`${sourceEmail}/${sourceLabel}`);
      }
      labelIds.push(labelMap.get(sourceLabel)!);
    }
  }

  await rateLimiter.waitForToken();
  await destGmail.users.messages.modify({
    userId: 'me',
    id: importRes.data.id,
    requestBody: { addLabelIds: labelIds },
  });

  console.log(chalk.green(`Transferred message: ${fullMessage.data.id}`));
  summary.totalEmailsTransferred++;
}

function updateLabelCounts(labelNames: string[], labelCounts: Map<string, number>) {
  labelNames.forEach(label => {
    if (!label.startsWith('CATEGORY_') && !['UNREAD', 'STARRED', 'IMPORTANT'].includes(label)) {
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    }
  });
}

function outputSummary(labelCounts: Map<string, number>, summary: TransferSummary) {
  console.log(chalk.cyan('\nEmails per label:'));
  labelCounts.forEach((count, label) => {
    console.log(chalk.cyan(`${label}: ${chalk.bold(count)}`));
  });

  console.log(chalk.cyan('\nLabels that would be created:'));
  summary.labelsCreated.forEach(label => {
    console.log(chalk.cyan(`- ${label}`));
  });
}

function parseCommandLineArgs() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'dry-run': {
        type: 'boolean',
        short: 'd',
      },
    },
    allowPositionals: true,
  });

  if (positionals.length !== 1) {
    throw new Error('Please provide exactly one source email address as an argument.');
  }

  return {
    sourceEmail: positionals[0],
    isDryRun: values['dry-run'] || false,
  };
}

async function main() {
  try {
    const { sourceEmail, isDryRun } = parseCommandLineArgs();
    const archiveEmail = process.env.ARCHIVE_EMAIL;

    if (!archiveEmail) {
      throw new Error('ARCHIVE_EMAIL environment variable is not set');
    }

    console.log(chalk.cyan(`Source email: ${sourceEmail}`));
    console.log(chalk.cyan(`Archive email: ${archiveEmail}`));
    console.log(chalk.bgBlue.white(`Running in ${isDryRun ? 'DRY RUN' : 'LIVE'} mode`));

    const sourceAuth = await getAuthClient(sourceEmail);
    const archiveAuth = await getAuthClient(archiveEmail);

    const sourceGmail = google.gmail({ version: 'v1', auth: sourceAuth });
    const archiveGmail = google.gmail({ version: 'v1', auth: archiveAuth });

    const summary = await transferEmails(sourceGmail, archiveGmail, sourceEmail, isDryRun);

    if (summary.totalEmailsTransferred === 0) {
      console.log(chalk.yellow('No emails were transferred. The process may have been cancelled.'));
      return;
    }

    console.log(chalk.bgGreen.black('\nTransfer Summary:'));
    console.log(chalk.green(`Total emails ${isDryRun ? 'that would be' : ''} transferred: ${chalk.bold(summary.totalEmailsTransferred)}`));
    if (!isDryRun) {
      console.log(chalk.green('Labels created:'));
      summary.labelsCreated.forEach(label => console.log(chalk.green(`- ${label}`)));
    }

    console.log(chalk.bgGreen.black(`\nEmail transfer ${isDryRun ? 'dry run' : 'completed'} successfully.`));
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(chalk.bgRed.white('An error occurred:'));
      console.error(chalk.red(error.message));
    } else {
      console.error(chalk.bgRed.white('An unknown error occurred'));
    }
    process.exit(1);
  }
}

main();