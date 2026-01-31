# Render Deployment Guide

## Fixing "409 Conflict" Error - Multiple Bot Instances

If you see this error in your Render logs:
```
error: Bot launch error: 409: Conflict: terminated by other getUpdates request;
make sure that only one bot instance is running
```

This means **two bot instances are running simultaneously** (e.g., one locally and one on Render, or two Render services).

### How to Fix:

#### Option 1: Stop Local Instance (If Running)
If you're running the bot locally:
```bash
# Press Ctrl+C in the terminal where the bot is running
# Or kill the process:
pkill -f "node index.js"
```

#### Option 2: Restart Render Service
1. Go to your Render dashboard: https://dashboard.render.com
2. Click on your bot service (attendance-bot-nodejs)
3. Click **"Manual Deploy"** → **"Clear build cache & deploy"**
   OR
4. Click **"Suspend"** → Wait 10 seconds → Click **"Resume"**

#### Option 3: Check for Multiple Render Services
1. Go to https://dashboard.render.com
2. Check if you have multiple services running the same bot
3. If yes, **delete or suspend** the duplicate services

## Understanding the Logs

### Normal Operation
When the bot is running correctly, you'll see:
```
info: Bot is now running. Press Ctrl+C to stop.
info: Timezone: Asia/Tashkent
info: Work reminders: ON
```

### Reminder System Logs
The bot checks every minute for reminders to send. You will **NOT** see logs every minute anymore (this was fixed).

Logs will only appear when:
- **A reminder is actually sent** (e.g., "Sent reminder 1 to John at 11:45")
- **Someone is marked late** (e.g., "Automatically marked John as late")
- **End-of-day processes run** (midnight)

### What are the 3 reminders?

For example, if work starts at **12:00**:
1. **11:45** - "Your work starts in 15 minutes" (Reminder 1)
2. **12:00** - "Your work starts now" (Reminder 2)
3. **12:15** - "15 minutes have passed since work start" (Reminder 3)

If someone notifies they'll be late and will arrive at 13:00, the reminders adjust:
1. **12:45** - Reminder 1 (15 min before 13:00)
2. **13:00** - Reminder 2 (at expected arrival)
3. **13:15** - Reminder 3 (15 min after expected arrival)

## Environment Variables on Render

Make sure these are set in your Render service:
- `BOT_TOKEN` - Your Telegram bot token
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` - Service account email
- `GOOGLE_PRIVATE_KEY` - Service account private key
- `GOOGLE_SPREADSHEET_ID` - Your Google Sheet ID
- `TIMEZONE` - Asia/Tashkent
- `NODE_ENV` - production

## Deployment Commands

Render automatically deploys when you push to GitHub (main branch).

Manual deployment:
```bash
git add .
git commit -m "Your commit message"
git push origin main
```

Then Render will automatically:
1. Pull the latest code
2. Install dependencies
3. Restart the bot

## Checking Logs on Render

1. Go to https://dashboard.render.com
2. Click your service
3. Click **"Logs"** tab
4. You'll see real-time logs

## Troubleshooting

### Bot not responding
1. Check Render logs for errors
2. Verify environment variables are set
3. Check Google Sheets API access
4. Verify bot token is correct

### Reminders not sending
1. Check timezone is set to `Asia/Tashkent`
2. Verify `ENABLE_WORK_REMINDERS=true` in config
3. Check employee work times in Roster sheet
4. Look for reminder logs around expected times

### 409 Conflict persists
1. Suspend Render service
2. Wait 2 minutes
3. Resume Render service
4. Check logs - should see "Bot is now running"
