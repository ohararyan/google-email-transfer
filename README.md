# Gmail Email Archiver

This tool allows you to transfer emails from one Gmail account to another, preserving labels and handling rate limits. It's particularly useful for archiving emails from user accounts that are being decommissioned.

## Prerequisites

- Node.js (v14 or later)
- npm (comes with Node.js)
- A Google Cloud Project
- Two Gmail accounts: a source account (to transfer from) and an archive account (to transfer to)

## Setup

### 1. Google Cloud Project Setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project or select an existing one.
3. Enable the Gmail API:
   - In the sidebar, navigate to "APIs & Services" > "Library".
   - Search for "Gmail API" and click on it.
   - Click "Enable".

### 2. Create a Service Account

1. In the Google Cloud Console, go to "IAM & Admin" > "Service Accounts".
2. Click "Create Service Account".
3. Enter a name for the service account (e.g., "gmail-archiver").
4. Click "Create and Continue".
5. For "Select a role", choose "Basic" > "Editor".
6. Click "Continue" and then "Done".

### 3. Create and Download the Service Account Key

1. In the Service Accounts list, find the account you just created.
2. Click on the three dots in the "Actions" column and select "Manage keys".
3. Click "Add Key" > "Create new key".
4. Choose "JSON" as the key type and click "Create".
5. The key file will be downloaded to your computer. Keep this file secure and do not share it.

### 4. Enable Domain-Wide Delegation

1. On the Service Accounts page, click on your service account.
2. Under "Domain-wide delegation", click "View Client ID".
3. Copy the Client ID (you'll need this later).

### 5. Configure Google Workspace

1. Go to your [Google Workspace Admin Console](https://admin.google.com/).
2. Navigate to Security > Access and data control > API Controls.
3. In the "Domain-wide Delegation" section, click "Manage Domain Wide Delegation".
4. Click "Add new".
5. In the "Client ID" field, paste the Client ID you copied earlier.
6. In the "OAuth Scopes" field, enter: `https://www.googleapis.com/auth/gmail.modify`
7. Click "Authorize".

### 6. Project Setup

1. Clone this repository:

   ```
   git clone https://github.com/your-repo/gmail-email-archiver.git
   cd gmail-email-archiver
   ```

2. Install dependencies:

   ```
   npm install
   ```

3. Create a `.env` file in the project root with the following content:
   ```
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/service-account-key.json
   ARCHIVE_EMAIL=archive@yourdomain.com
   ```
   Replace `/path/to/your/service-account-key.json` with the actual path to the JSON key file you downloaded earlier, and `archive@yourdomain.com` with the email address of your archive account.

## Usage

To run the script, use the following command:

```
npm run start -- source@yourdomain.com
```

Replace `source@yourdomain.com` with the email address of the account you want to transfer emails from.

To perform a dry run (which doesn't actually transfer any emails):

```
npm run start -- --dry-run source@yourdomain.com
```

or

```
npm run start -- -d source@yourdomain.com
```

## Important Notes

- The script uses rate limiting to avoid hitting Google's API quotas. If you encounter rate limit errors, you may need to adjust the rate limit in `utils/rateLimiter.ts`.
- The script transfers emails in batches of 100. For very large mailboxes, the process may take a long time.
- Make sure you have sufficient storage in the archive account to accommodate all the emails being transferred.
- It's recommended to run a dry run first to see what would be transferred without actually moving any emails.
- This script does not delete emails from the source account. If you need to delete emails after transfer, you'll need to modify the script or perform this action manually.

## Troubleshooting

- If you encounter authentication errors, double-check that your service account key is correct and that you've properly set up domain-wide delegation.
- If you hit rate limits, try reducing the rate in `utils/rateLimiter.ts` (e.g., change `new RateLimiter(2)` to `new RateLimiter(1)`).
- For any other errors, check the console output for error messages. The script includes error logging that should help identify the issue.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
