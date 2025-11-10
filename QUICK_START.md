# Quick Start: Running Production vs Test

## ❓ How Does It Work?

The bot **always reads from the `.env` file**. When you run a command, it:
1. **Copies** the right config (`.env.production` or `.env.test`) → `.env`
2. **Starts** the bot with that configuration

```
npm run prod  →  .env.production  →  .env  →  Bot runs with PRODUCTION config
npm run test  →  .env.test        →  .env  →  Bot runs with TEST config
```

---

## ✅ Check Current Environment

**Before starting the bot**, check which environment is currently active:

```bash
npm run check
```

This will show you:
- Which environment is active (Production/Test)
- Current bot token (first 15 chars)
- Current Google Sheet ID
- Current port

---

## 🔴 Running Production Bot

```bash
npm run prod
```

When it starts, you'll see:
```
✅ Bot started successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 ENVIRONMENT: PRODUCTION
📱 Bot Token: 8592139001:AAE...
📊 Google Sheet ID: 1J2y9G6XbkoVLuR...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 🟢 Running Test Bot

```bash
npm run test
```

When it starts, you'll see:
```
✅ Bot started successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 ENVIRONMENT: DEVELOPMENT
📱 Bot Token: YOUR_TEST_TOKEN...
📊 Google Sheet ID: YOUR_TEST_SHEET...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## First Time Setup

### 1. Set up Test Environment

Follow the detailed guide in `SETUP_GUIDE.md`:
- Duplicate the production Google Sheet
- Get the new sheet ID
- Update `.env.test` with the sheet ID
- Share the test sheet with the service account

### 2. Verify Production Bot

Your production bot is already configured in `.env.production` with:
- Bot Token: `8592139001:AAE1J7ippir07SOtjH-oEAsmLqL5Uvux-4w`
- Same Google Sheets credentials as before

### 3. Start Using

```bash
# For production
npm run prod

# For testing/development
npm run test
```

---

## What's Different?

| Aspect | Production | Test |
|--------|-----------|------|
| **Bot Token** | `8592139001:AAE...` | Your test bot token |
| **Google Sheet** | Production sheet | Test sheet (copy) |
| **Port** | 3000 | 3001 |
| **Auto-reload** | No | Yes (nodemon) |
| **Log Level** | info | debug |
| **NODE_ENV** | production | development |

---

## Current Status

✅ **Production environment**: Ready to use
⚠️ **Test environment**: Needs Google Sheet setup

Follow `SETUP_GUIDE.md` Part 1 & 2 to set up test environment.

---

## Need Help?

See `SETUP_GUIDE.md` for detailed instructions on:
- Creating test Google Sheet
- Setting up Google Service Account
- Troubleshooting common issues
