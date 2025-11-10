# Setup Guide: Production & Test Environments

## Overview
This guide will help you set up separate production and test environments for the attendance bot.

---

## Part 1: Create Test Google Sheet

### Step 1: Duplicate the Production Google Sheet

1. Open your production Google Sheet: https://docs.google.com/spreadsheets/d/1J2y9G6XbkoVLuRFSJ_sjZYhM4nEJi7OqrW-L1-uMkbY
2. Click **File** → **Make a copy**
3. Rename it to something like: "Attendance Bot - TEST"
4. Click **Create**
5. **Copy the Sheet ID** from the URL. The URL will look like:
   ```
   https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit
   ```
   Example: If URL is `https://docs.google.com/spreadsheets/d/ABC123xyz456/edit`
   Then your SHEET_ID is: `ABC123xyz456`

### Step 2: Verify Sheet Structure

Your test sheet should have these tabs (same as production):
- **Worker info** - Employee roster with names, Telegram IDs, work schedules
- **Teams** - Team assignments
- **Schedule** - Work schedule definitions
- **Duty** - Duty rotation
- **DutyChecklist** - Duty task checklist
- **Daily sheets** - One sheet per day (e.g., "2025-01-15")
- **Monthly reports** - Monthly summaries

---

## Part 2: Google Service Account Setup

### Option A: Use Same Service Account (Easier, Recommended for Testing)

**Advantages**: Quick setup, no new Google Cloud project needed
**Disadvantages**: Both environments share the same credentials

**Steps**:
1. Open your test Google Sheet
2. Click **Share** button (top-right)
3. Add this email: `attendance-bot@atendence-telegram-bot.iam.gserviceaccount.com`
4. Give it **Editor** permissions
5. Click **Send**

Now you can use the **same** credentials in your `.env.test` file:
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: Same as production
- `GOOGLE_PRIVATE_KEY`: Same as production
- `GOOGLE_SHEETS_ID`: Your new test sheet ID

---

### Option B: Create New Service Account (More Secure, Recommended for Production)

**Advantages**: Complete separation, better security
**Disadvantages**: More complex setup

#### Step 1: Create New Google Cloud Project

1. Go to: https://console.cloud.google.com/
2. Click the project dropdown (top-left)
3. Click **NEW PROJECT**
4. Name it: "Attendance Bot Test"
5. Click **CREATE**
6. Wait for project creation, then **SELECT** the new project

#### Step 2: Enable Google Sheets API

1. In the new project, go to: **APIs & Services** → **Library**
2. Search for "Google Sheets API"
3. Click on it
4. Click **ENABLE**

#### Step 3: Create Service Account

1. Go to: **APIs & Services** → **Credentials**
2. Click **+ CREATE CREDENTIALS** → **Service account**
3. Fill in:
   - **Service account name**: `attendance-bot-test`
   - **Service account ID**: `attendance-bot-test` (auto-filled)
   - **Description**: "Service account for test attendance bot"
4. Click **CREATE AND CONTINUE**
5. Click **DONE** (no need to grant roles)

#### Step 4: Create Service Account Key

1. You'll see your new service account in the list
2. Click on the **service account email** (looks like: `attendance-bot-test@PROJECT-ID.iam.gserviceaccount.com`)
3. Go to **KEYS** tab
4. Click **ADD KEY** → **Create new key**
5. Choose **JSON** format
6. Click **CREATE**
7. A JSON file will download automatically
8. **SAVE THIS FILE SECURELY** - it contains your credentials

#### Step 5: Share Google Sheet with New Service Account

1. Open the JSON file you just downloaded
2. Copy the `client_email` value (e.g., `attendance-bot-test@PROJECT-ID.iam.gserviceaccount.com`)
3. Open your test Google Sheet
4. Click **Share** button
5. Paste the service account email
6. Give it **Editor** permissions
7. Click **Send**

#### Step 6: Extract Credentials for .env.test

Open the downloaded JSON file and extract:

```json
{
  "client_email": "attendance-bot-test@PROJECT-ID.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\nYOUR_VERY_LONG_KEY_HERE\n-----END PRIVATE KEY-----\n"
}
```

---

## Part 3: Configure .env Files

### For Production (`.env.production`):
Already created with your new production bot token.

### For Test (`.env.test`):
1. Open `.env.test` file
2. Replace these values:

```bash
# If using Option A (same service account):
GOOGLE_SHEETS_ID=YOUR_TEST_SHEET_ID
GOOGLE_SERVICE_ACCOUNT_EMAIL=attendance-bot@atendence-telegram-bot.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCw8tVsZLXmZsM4...

# If using Option B (new service account):
GOOGLE_SHEETS_ID=YOUR_TEST_SHEET_ID
GOOGLE_SERVICE_ACCOUNT_EMAIL=attendance-bot-test@YOUR-PROJECT-ID.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nYOUR_NEW_PRIVATE_KEY_HERE...
```

**IMPORTANT**: The `GOOGLE_PRIVATE_KEY` must have `\n` (backslash-n) for newlines, not actual newlines.

---

## Part 4: Running Different Environments

### Method 1: Manual Copy (Simple)

**For Production**:
```bash
cp .env.production .env
npm start
```

**For Test**:
```bash
cp .env.test .env
npm start
```

### Method 2: Using package.json scripts (Recommended)

I can add these scripts to your `package.json`:

```json
"scripts": {
  "start": "node src/index.js",
  "dev": "nodemon src/index.js",
  "start:prod": "cp .env.production .env && node src/index.js",
  "start:test": "cp .env.test .env && nodemon src/index.js",
  "prod": "npm run start:prod",
  "test": "npm run start:test"
}
```

Then you can run:
```bash
npm run prod   # Start production
npm run test   # Start test
```

### Method 3: Using PM2 (Advanced, for servers)

Create `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    {
      name: 'attendance-bot-prod',
      script: './src/index.js',
      env_file: '.env.production',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
    {
      name: 'attendance-bot-test',
      script: './src/index.js',
      env_file: '.env.test',
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: '500M',
    }
  ]
};
```

Commands:
```bash
pm2 start ecosystem.config.js --only attendance-bot-prod
pm2 start ecosystem.config.js --only attendance-bot-test
pm2 list
pm2 logs attendance-bot-prod
pm2 logs attendance-bot-test
```

---

## Part 5: Testing Setup

### Verify Test Environment Works:

1. Start test bot:
   ```bash
   cp .env.test .env
   npm start
   ```

2. Open Telegram and find your test bot
3. Send: `/start`
4. Send: `+` (mark arrival)
5. Check your test Google Sheet - a new daily sheet should be created
6. Verify data appears correctly

### Verify Production Environment Works:

1. Start production bot:
   ```bash
   cp .env.production .env
   npm start
   ```

2. Test with a real user
3. Check production Google Sheet

---

## Part 6: Security Best Practices

### ⚠️ Important:

1. **Never commit `.env` files to git**
   - Already in `.gitignore`

2. **Keep service account keys secure**
   - Don't share JSON key files
   - Don't commit them to git

3. **Rotate credentials periodically**
   - Especially if compromised

4. **Use separate service accounts for prod/test**
   - Prevents accidental production data access from test environment

### Update .gitignore:

Make sure these are in your `.gitignore`:
```
.env
.env.production
.env.test
.env.local
*.json
!package.json
!package-lock.json
```

---

## Troubleshooting

### Error: "GOOGLE_SHEETS_ID is required"
→ Make sure you copied `.env.test` or `.env.production` to `.env`

### Error: "No permission to access sheet"
→ Make sure you shared the Google Sheet with the service account email

### Error: "Invalid credentials"
→ Check that `GOOGLE_PRIVATE_KEY` has `\n` for newlines (not actual newlines)

### Bot doesn't respond
→ Check the bot token is correct
→ Check bot is started in Telegram (send `/start` to @BotFather)

### Reminders not working
→ Check `ENABLE_WORK_REMINDERS=true` in your .env file
→ Check "Worker info" sheet has correct work times

---

## Summary Checklist

- [ ] Duplicate production Google Sheet for testing
- [ ] Copy test sheet ID
- [ ] Choose service account option (A or B)
- [ ] Share test sheet with service account email
- [ ] Update `.env.test` with correct values
- [ ] Test the bot in test environment
- [ ] Verify production bot with new token
- [ ] Set up npm scripts for easy switching
- [ ] Add both .env files to .gitignore
- [ ] Document which environment is running where

---

## Quick Reference

| Environment | Bot Token | Google Sheet | Service Account |
|-------------|-----------|--------------|-----------------|
| **Production** | `8592139001:AAE...` | `1J2y9G6Xbko...` | `attendance-bot@atendence-telegram-bot...` |
| **Test** | Your test token | Your test sheet ID | Same or new service account |

