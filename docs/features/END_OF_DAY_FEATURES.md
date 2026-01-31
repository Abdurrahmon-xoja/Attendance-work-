# End-of-Day Archiving Features

## Overview

The bot now automatically archives daily attendance data at midnight (00:00), transfers it to monthly reports, sends a summary to a Telegram group, and deletes the daily sheet. This keeps your Google Sheets organized and prevents it from becoming cluttered with old daily sheets.

---

## 🌟 New Features

### 1. **Automatic Daily Sheet Creation**
- **When**: Every day at 00:01 (1 minute after midnight)
- **What**: Creates a new daily attendance sheet with all employees
- **Configuration**: `AUTO_CREATE_DAILY_SHEET=true` (now enabled in both prod and test)

### 2. **End-of-Day Archiving Process**
- **When**: Every day at 00:00 (midnight)
- **What happens**:
  1. Handles overnight workers (auto-ends their work time)
  2. Waits 2 minutes for responses
  3. Transfers all data to monthly report
  4. Sends summary to Telegram group
  5. Deletes the daily sheet from Google Sheets

### 3. **Overnight Worker Handling**
- **Problem**: Employees working past midnight
- **Solution**:
  - At midnight, automatically sets their leave time to 23:59
  - Calculates hours worked
  - Sends notification with button: "✅ I'm still here - Mark arrival"
  - If clicked: marks arrival for new day automatically

### 4. **Telegram Group Reports**
- Daily Google Sheet sent to configured group **as Excel file (.xlsx)**
- Includes brief statistics in message caption:
  - Present/Late/Absent counts
  - Total hours worked
- Full attendance data in attached Excel file

### 5. **Manual Testing Command: /endday**
- **For admins only**
- **Test mode**: Works immediately without confirmation
- **Production mode**: Requires `/endday_confirm` for safety

---

## ⚙️ Configuration

### Required Environment Variables

Add to both `.env.production` and `.env.test`:

```bash
# Telegram group ID for daily reports
DAILY_REPORT_GROUP_ID=

# Enable automatic daily sheet creation
AUTO_CREATE_DAILY_SHEET=true
```

### How to Get Group ID

1. Add your bot to the Telegram group
2. Send a message in the group
3. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Find the `chat` object with `"type": "group"` or `"type": "supergroup"`
5. Copy the `id` value (will be negative, like `-1001234567890`)
6. Add it to your `.env` file:
   ```bash
   DAILY_REPORT_GROUP_ID=-1001234567890
   ```

---

## 🕐 Schedule

| Time | Event | Description |
|------|-------|-------------|
| **00:00** | End-of-Day Process | Archives yesterday's data |
| **00:01** | Sheet Creation | Creates today's sheet |
| Every minute | Reminder Checks | Sends work reminders |
| **20:00** | No-Show Check | Marks employees with no activity |
| **23:59** | Daily Admin Report | Sends report to admins (emails) |

---

## 🔄 End-of-Day Process Flow

```
Midnight (00:00)
    ↓
Step 1: Find overnight workers
    ├─ Auto-set leave time to 23:59
    ├─ Calculate hours worked
    └─ Send notification with button
    ↓
Step 2: Wait 2 minutes (automatic mode only)
    └─ Allows overnight workers to respond
    ↓
Step 3: Transfer data to monthly report
    ├─ Update worked days
    ├─ Update late days
    ├─ Update absent days
    ├─ Update total hours
    └─ Update rating
    ↓
Step 4: Send report to Telegram group
    └─ Full summary with statistics
    ↓
Step 5: Delete daily sheet
    └─ Keeps Google Sheets clean
    ↓
00:01: Create new sheet for today
```

---

## 📊 Data Preserved in Monthly Report

Before deleting daily sheet, these are recorded:

- ✅ Employee name and Telegram ID
- ✅ Arrival time (When come)
- ✅ Departure time (Leave time)
- ✅ Hours worked
- ✅ Came on time status
- ✅ Late notifications
- ✅ Absences and reasons
- ✅ Temporary exits
- ✅ Penalty points
- ✅ All rating impacts

**No data is lost** - everything is transferred before deletion.

---

## 🧪 Testing with /endday

### In Test Environment (NODE_ENV=development)

```
Admin: /endday
Bot: 🔄 Starting end-of-day process...
     [Processes immediately]
Bot: ✅ Day ended!
     📊 Data transferred to monthly report
     📨 Report sent to group
     🗑 Sheet deleted
```

### In Production (NODE_ENV=production)

```
Admin: /endday
Bot: ⚠️ WARNING
     This will end the day and DELETE the sheet.
     Use /endday_confirm to confirm.

Admin: /endday_confirm
Bot: 🔄 Starting end-of-day process...
     [Processes]
Bot: ✅ Day ended!
```

**Safety feature**: Production requires confirmation to prevent accidental deletion.

---

## 🌙 Overnight Worker Experience

### Scenario: Employee works past midnight

**At 23:59 (last minute of day)**:
- Employee is working, hasn't left

**At 00:00 (midnight)**:
- Bot auto-ends their work: Leave time = 23:59
- Bot calculates hours worked
- Bot sends message:

```
⚠️ Your work time has been automatically ended

📅 Date: 10.11.2025
🕐 End time: 23:59
⏱ Hours worked: 8.5

If you're still working overnight, click below
to mark arrival for the new day (11.11.2025):

[Button: ✅ I'm still here - Mark arrival]
```

**If employee clicks button**:
```
✅ Arrival marked for 11.11.2025!

⏰ Time: 00:05
🌙 Continuing overnight shift
📊 Bonus: +0.5 points

Don't forget to mark your departure!
```

---

## 📨 Group Report Format

The group receives:

### 1. **Excel File Attachment**
- Filename: `attendance_2025-11-10.xlsx`
- Contains complete daily attendance sheet
- All columns: Name, Telegram ID, Arrival, Departure, Hours, etc.
- Can be opened in Excel, Google Sheets, or any spreadsheet app

### 2. **Message Caption with Summary**
```
📊 ОТЧЁТ ЗА 10.11.2025 (ПЯТНИЦА)

✅ Присутствовали: 15
⚠️ Опоздали: 3
❌ Отсутствовали: 2
⏱ Всего часов: 120.5

📄 Полный отчёт во вложении
🤖 Данные архивированы автоматически

[Excel file: attendance_2025-11-10.xlsx]
```

**Benefits of Excel format:**
- ✅ Complete data preservation
- ✅ Easy to open and analyze
- ✅ Can be archived locally
- ✅ Can be imported into other systems
- ✅ All formulas and formatting preserved

---

## 🚨 Error Handling

### Data Loss Prevention

- If data transfer **fails**, daily sheet is **NOT deleted**
- Error logged and admin notified
- Can retry manually or wait for next day

### Sheet Already Deleted

- No-op if sheet doesn't exist
- Logs warning but doesn't crash

### Group ID Not Configured

- Skips group report sending
- Logs warning: "DAILY_REPORT_GROUP_ID not configured"
- Process continues (data still archived)

---

## 🔍 Logging

All operations are logged:

```
2025-11-10 00:00:00 info: Starting end-of-day archiving for 2025-11-09
2025-11-10 00:00:01 info: Step 1: Handling overnight workers...
2025-11-10 00:00:01 info: Handled 2 overnight workers on 2025-11-09
2025-11-10 00:02:02 info: Step 3: Transferring data to monthly report...
2025-11-10 00:02:05 info: Successfully transferred data from 2025-11-09 to Report_2025-11
2025-11-10 00:02:06 info: Step 4: Sending report to Telegram group...
2025-11-10 00:02:07 info: Daily report sent to group -1001234567890
2025-11-10 00:02:08 info: Step 5: Deleting daily sheet...
2025-11-10 00:02:09 info: Successfully deleted daily sheet: 2025-11-09
2025-11-10 00:02:09 info: === End-of-Day Process Completed for 2025-11-09 ===
```

---

## 🛠 Troubleshooting

### Issue: Group reports not sending

**Solution**:
1. Check `DAILY_REPORT_GROUP_ID` is set correctly
2. Verify bot is in the group
3. Ensure bot has "Send Messages" permission
4. Check logs for errors

### Issue: Data not transferring to monthly report

**Solution**:
1. Check if monthly report sheet exists (Report_YYYY-MM)
2. Verify Google Sheets permissions
3. Check logs for specific error
4. Monthly report auto-creates if missing

### Issue: /endday not working

**Solution**:
1. Verify you're an admin: check `ADMIN_TELEGRAM_IDS`
2. In production, use `/endday_confirm`
3. Check bot logs for errors
4. Ensure daily sheet exists

### Issue: Overnight workers not getting notifications

**Solution**:
1. Check employee has Telegram ID in roster
2. Verify they marked arrival but not departure
3. Check logs for message send errors
4. Ensure bot can send messages to user

---

## 📝 Admin Commands

| Command | Access | Description |
|---------|--------|-------------|
| `/createsheet` | Admin | Manually create today's sheet |
| `/endday` | Admin | Trigger end-of-day (test: instant, prod: needs confirm) |
| `/endday_confirm` | Admin | Confirm end-of-day in production |
| `/updatereport` | Admin | Manually update monthly report |

---

## ✅ Verification Checklist

After setup, verify:

- [ ] `AUTO_CREATE_DAILY_SHEET=true` in both env files
- [ ] `DAILY_REPORT_GROUP_ID` set in both env files
- [ ] Bot added to Telegram group
- [ ] Bot has send message permissions in group
- [ ] Test `/endday` command (in test environment)
- [ ] Check logs for "End-of-day archiving ENABLED"
- [ ] Verify midnight cron jobs are scheduled

---

## 🎯 Benefits

1. **Clean Google Sheets**: Old daily sheets automatically removed
2. **Historical Data**: All data preserved in monthly reports
3. **Team Visibility**: Group gets daily summaries
4. **Overnight Support**: Smooth handling of 24/7 workers
5. **Easy Testing**: `/endday` command for development
6. **Data Safety**: Multiple checks prevent data loss

---

## 🔐 Security

- Admin commands require authentication
- Production mode requires confirmation
- Data validated before deletion
- All operations logged
- Errors don't cause data loss

---

## 📞 Support

If you encounter issues:

1. Check this documentation
2. Review bot logs (`bot.log` or terminal output)
3. Verify configuration in `.env` files
4. Test with `/endday` in test environment first

---

**Implementation Date**: 2025-11-10
**Version**: 1.0.0
**Status**: ✅ Fully Implemented
