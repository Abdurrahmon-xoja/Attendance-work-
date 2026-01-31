# How to Switch Between Production and Test

## Simple Explanation

You have **3 configuration files**:

```
.env.production  ← Production config (real users)
.env.test        ← Test config (for testing)
.env             ← The file the bot actually reads
```

The bot **ONLY reads `.env`** file. To switch environments, you copy the right config into `.env`.

---

## Visual Flow

### Starting Production:

```
┌─────────────────┐
│ npm run prod    │  You run this command
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Copy:           │
│ .env.production │  Command copies production config
│      ↓          │
│    .env         │  Into the .env file
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Start bot with: │
│ - Token: 8592.. │  Bot starts with production settings
│ - Prod Sheet    │
│ - Port 3000     │
└─────────────────┘
```

### Starting Test:

```
┌─────────────────┐
│ npm run test    │  You run this command
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Copy:           │
│ .env.test       │  Command copies test config
│      ↓          │
│    .env         │  Into the .env file
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Start bot with: │
│ - Test Token    │  Bot starts with test settings
│ - Test Sheet    │
│ - Port 3001     │
└─────────────────┘
```

---

## Step-by-Step Instructions

### To Run PRODUCTION Bot:

1. **Stop** any running bot (press Ctrl+C)
2. Run: `npm run prod`
3. **Look at the startup logs**:
   ```
   🤖 ENVIRONMENT: PRODUCTION
   📱 Bot Token: 8592139001:AAE...
   ```
4. ✅ If you see **PRODUCTION** and token starting with `8592139001`, you're good!

### To Run TEST Bot:

1. **Stop** any running bot (press Ctrl+C)
2. Run: `npm run test`
3. **Look at the startup logs**:
   ```
   🤖 ENVIRONMENT: DEVELOPMENT
   📱 Bot Token: YOUR_TEST...
   ```
4. ✅ If you see **DEVELOPMENT**, you're in test mode!

---

## How to Check WITHOUT Starting the Bot

If you want to see which environment is configured **without starting the bot**:

```bash
npm run check
```

Output example:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 CURRENT ENVIRONMENT CONFIGURATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔴 Environment: PRODUCTION
📝 NODE_ENV: production
🤖 Bot Token: 8592139001:AAE...
📊 Google Sheet: 1J2y9G6XbkoVLuRFSJ_s...
🔌 Port: 3000
```

---

## Common Scenarios

### Scenario 1: "I'm not sure which mode I'm in"

**Solution:**
```bash
npm run check
```

Look at the **Environment** line:
- 🔴 PRODUCTION = Production mode
- 🟢 TEST = Test mode

---

### Scenario 2: "I want to switch from production to test"

**Solution:**
```bash
# Stop the bot (Ctrl+C if running)
npm run test
```

That's it! The command automatically switches the config.

---

### Scenario 3: "I want to test something without affecting real users"

**Solution:**
1. Make sure test environment is set up (see SETUP_GUIDE.md)
2. Run: `npm run test`
3. Test your changes
4. When done, run: `npm run prod` to switch back

---

## Files Overview

| File | Purpose | When to Use |
|------|---------|-------------|
| `.env` | **Active config** (bot reads this) | Auto-created by npm commands |
| `.env.production` | Production settings | Edit when changing prod config |
| `.env.test` | Test settings | Edit when changing test config |
| `check-env.js` | Check current environment | Run `npm run check` |

---

## Key Points to Remember

1. ✅ The bot **always** reads `.env` file
2. ✅ `npm run prod` or `npm run test` **copies** the right config to `.env`
3. ✅ Check startup logs to confirm which environment is running
4. ✅ Use `npm run check` to see current config without starting
5. ✅ **Never edit `.env` directly** - edit `.env.production` or `.env.test` instead

---

## Quick Reference Commands

```bash
# Check current environment
npm run check

# Run production
npm run prod

# Run test
npm run test

# Stop bot
Ctrl+C
```

---

## Still Confused?

The **easiest way** to know which environment you're in:

**Look at the first few lines when the bot starts:**

```
✅ Bot started successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 ENVIRONMENT: PRODUCTION  ← THIS LINE!
```

If it says **PRODUCTION** → You're in production
If it says **DEVELOPMENT** → You're in test mode
