# Attendance Bot - Production & Test Environments

## 🎯 Quick Answer: How to Switch?

```bash
# To check which environment is active:
npm run check

# To run PRODUCTION bot:
npm run prod

# To run TEST bot:
npm run test
```

**Look at the startup logs** to confirm which environment is running!

---

## 📚 Documentation Files

| File | What's Inside | When to Read |
|------|---------------|--------------|
| **`HOW_TO_SWITCH.md`** | Step-by-step guide with diagrams | ⭐ **Read this first!** |
| **`QUICK_START.md`** | Quick commands reference | Daily use |
| **`SETUP_GUIDE.md`** | Detailed Google Sheets setup | First-time setup only |
| **`README_ENVIRONMENTS.md`** | This file - overview | Start here |

---

## 🚀 Getting Started (3 Steps)

### Step 1: Check Current Environment

```bash
npm run check
```

You'll see which environment is currently configured.

### Step 2: Run Production Bot

```bash
npm run prod
```

Watch the startup logs - you should see:
```
🤖 ENVIRONMENT: PRODUCTION
📱 Bot Token: 8592139001:AAE...
```

### Step 3: Set Up Test Environment (Optional)

To create a test environment:
1. Read **`SETUP_GUIDE.md`** Part 1 & 2
2. Duplicate your Google Sheet
3. Update `.env.test` with test sheet ID
4. Run: `npm run test`

---

## ❓ How It Works (Simple Explanation)

```
You have 3 files:
├── .env.production  (production config)
├── .env.test        (test config)
└── .env             (← the bot reads THIS one)

When you run:
  npm run prod  → copies .env.production → .env
  npm run test  → copies .env.test → .env
```

The bot **always reads `.env`** file. The npm commands just copy the right config into it.

---

## 📊 Current Setup

Based on `npm run check`, your current setup is:

### Production Environment ✅
- **Bot Token:** `8592139001:AAE1J7ippir07SOtjH-oEAsmLqL5Uvux-4w`
- **Google Sheet:** `1J2y9G6XbkoVLuRFSJ_sjZYhM4nEJi7OqrW-L1-uMkbY`
- **Status:** Ready to use

### Test Environment ⚠️
- **Status:** Needs Google Sheet setup
- **To Do:** Follow `SETUP_GUIDE.md` to create test Google Sheet

---

## 🔍 How to Know Which Mode You're In?

### Method 1: Check Before Starting (Fastest)

```bash
npm run check
```

### Method 2: Check Startup Logs

When the bot starts, look for this:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 ENVIRONMENT: PRODUCTION   ← THIS!
📱 Bot Token: 8592139001:AAE...
📊 Google Sheet ID: 1J2y9G6XbkoVLuR...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If you see **PRODUCTION** → production mode
If you see **DEVELOPMENT** → test mode

---

## ⚠️ Important Notes

1. **Always stop the bot before switching:**
   - Press `Ctrl+C` to stop
   - Then run `npm run prod` or `npm run test`

2. **Don't edit `.env` directly:**
   - Edit `.env.production` for production changes
   - Edit `.env.test` for test changes
   - Then run the appropriate npm command

3. **These files are in `.gitignore`:**
   - `.env`
   - `.env.production`
   - `.env.test`
   - They won't be committed to git (for security)

---

## 🆘 Troubleshooting

### "I don't know which mode I'm in!"
→ Run: `npm run check`

### "The bot is using the wrong environment!"
→ Stop the bot (Ctrl+C) and run the right command:
- `npm run prod` for production
- `npm run test` for test

### "I want to test without affecting real users!"
→ Set up test environment (see `SETUP_GUIDE.md`), then run `npm run test`

### "How do I switch back to production?"
→ Stop the bot (Ctrl+C) and run: `npm run prod`

---

## 📖 Next Steps

1. **First time?** → Read `HOW_TO_SWITCH.md`
2. **Need to set up test?** → Read `SETUP_GUIDE.md`
3. **Daily use?** → Just run `npm run prod` or `npm run test`
4. **Not sure which mode?** → Run `npm run check`

---

## 🎓 Summary

| Command | What It Does |
|---------|-------------|
| `npm run check` | Shows current environment |
| `npm run prod` | Start production bot |
| `npm run test` | Start test bot |
| `Ctrl+C` | Stop bot |

**Remember:** Look at the startup logs to confirm which environment is running!

```
🤖 ENVIRONMENT: PRODUCTION  ← This tells you!
```
