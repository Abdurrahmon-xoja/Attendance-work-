# Quick Setup Guide: End-of-Day Features

## 🚀 Getting Started in 5 Minutes

### Step 1: Get Your Telegram Group ID

1. **Create a Telegram group** (or use existing one)
2. **Add your bot** to the group
3. **Send any message** in the group
4. **Get the group ID**:

   Visit in your browser (replace with your bot token):
   ```
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```

   Example with your production bot:
   ```
   https://api.telegram.org/bot8592139001:AAE1J7ippir07SOtjH-oEAsmLqL5Uvux-4w/getUpdates
   ```

5. **Find the group ID** in the JSON response:
   ```json
   {
     "chat": {
       "id": -1001234567890,  ← This is your group ID
       "type": "supergroup",
       "title": "Attendance Reports"
     }
   }
   ```

### Step 2: Update Configuration Files

**Edit `.env.production`:**
```bash
DAILY_REPORT_GROUP_ID=-1001234567890
AUTO_CREATE_DAILY_SHEET=true  # Already set
```

**Edit `.env.test`:**
```bash
DAILY_REPORT_GROUP_ID=-1001234567890
AUTO_CREATE_DAILY_SHEET=true  # Already set
```

### Step 3: Restart the Bot

**For production:**
```bash
npm run prod
```

**For testing:**
```bash
npm run test
```

### Step 4: Verify Setup

Check the startup logs for:
```
✅ Auto daily sheet creation ENABLED
✅ End-of-day archiving ENABLED
End-of-day archiving job scheduled (runs at 00:00 every day)
```

### Step 5: Test It! (Optional)

In **test environment** only:

1. Create today's sheet (if not exists):
   ```
   /createsheet
   ```

2. Add some test data (mark attendance)

3. Trigger end-of-day manually:
   ```
   /endday
   ```

4. Check:
   - ✅ Monthly report updated
   - ✅ Excel file sent to group
   - ✅ Daily sheet deleted

---

## ✅ You're Done!

The bot will now:
- ✅ Create daily sheets automatically at 00:01
- ✅ Archive and delete them at 00:00 (midnight)
- ✅ Send Excel files to your group
- ✅ Handle overnight workers

---

## 🧪 Testing Commands

| Command | What It Does |
|---------|--------------|
| `/createsheet` | Create today's sheet manually |
| `/endday` | Trigger end-of-day process (test only) |

---

## 🔍 How to Check Group ID Later

If you forget your group ID:

1. Check your `.env` files
2. Or visit the Telegram API URL again
3. Or use `/getMe` bot command and check logs

---

## ⚠️ Important Notes

1. **Group Permissions**: Ensure bot can send messages in the group
2. **Test First**: Use test environment before production
3. **Backup**: Monthly reports preserve all data before deletion
4. **Time Zone**: All times use `Asia/Tashkent` timezone

---

## 📚 Full Documentation

See `END_OF_DAY_FEATURES.md` for complete documentation including:
- Detailed process flow
- Error handling
- Overnight worker scenarios
- Troubleshooting guide

---

## 🆘 Quick Troubleshooting

**Bot not sending to group?**
- Verify bot is in the group
- Check group ID is correct (starts with `-`)
- Ensure bot has message permissions

**Sheets not auto-creating?**
- Check `AUTO_CREATE_DAILY_SHEET=true`
- Look for cron job in startup logs
- Verify time zone is correct

**Want to test without waiting?**
- Use `/endday` in test environment
- Check logs for detailed output
- Verify in Google Sheets

---

That's it! You're all set up. 🎉
