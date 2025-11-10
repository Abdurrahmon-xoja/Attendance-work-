# Excel Export Feature

## 📊 What Gets Sent to the Group

Instead of a text report, the bot now sends the **actual Google Sheet as an Excel file** to your Telegram group.

---

## 📄 File Details

### Filename Format
```
attendance_YYYY-MM-DD.xlsx
```

Examples:
- `attendance_2025-11-10.xlsx`
- `attendance_2025-12-25.xlsx`

### File Contents
The Excel file contains the **complete daily attendance sheet** with all columns:

| Column | Description |
|--------|-------------|
| Name | Employee name |
| TelegramId | Telegram user ID |
| Came on time | Yes/No/Empty |
| When come | Arrival time (HH:mm) |
| Leave time | Departure time (HH:mm) |
| Hours worked | Total hours (decimal) |
| Remaining hours to work | Hours deficit/surplus |
| Left early | Yes/No |
| Why left early | Reason text |
| will be late | Late notification |
| will be late will come at | Expected arrival time |
| reminder_1_sent | Reminder status |
| reminder_2_sent | Reminder status |
| reminder_3_sent | Reminder status |
| Absent | Yes/No |
| Why absent | Absence reason |
| Left temporarily | Temp exit info |
| Temp exit time | Exit timestamp |
| Temp exit reason | Reason for exit |
| Currently out | Yes/No |
| Penalty minutes | Late penalty |
| Required end time | Adjusted end time |
| Point | Rating impact |

---

## 📨 Message Format

When the file is sent to the group, it includes a caption with summary statistics:

```
📊 ОТЧЁТ ЗА 10.11.2025 (ПЯТНИЦА)

✅ Присутствовали: 15
⚠️ Опоздали: 3
❌ Отсутствовали: 2
⏱ Всего часов: 120.5

📄 Полный отчёт во вложении
🤖 Данные архивированы автоматически
```

Then the Excel file is attached below the message.

---

## 💡 How It Works

1. **Export**: Bot uses Google Sheets API to export the sheet as Excel (.xlsx)
2. **Download**: File is temporarily downloaded to bot's server
3. **Send**: File is sent to Telegram group via bot API
4. **Cleanup**: Temporary file is deleted from server

---

## ✅ Benefits

### For Managers
- 📥 **Download** and archive locally
- 📊 **Analyze** in Excel with pivot tables
- 📧 **Forward** to other systems
- 💾 **Backup** important daily records

### For HR
- 📋 **Review** complete attendance data
- 🔍 **Search** for specific employees
- 📈 **Generate** custom reports
- 📁 **Store** for compliance

### For Team
- 👀 **Transparency** - everyone sees the same data
- 📱 **Mobile access** - download directly from Telegram
- 🔄 **Real data** - not a summary, but actual sheet
- 🕐 **Historical** - files stay in chat history

---

## 🔧 Technical Details

### Export Format
- **Format**: Microsoft Excel 2007+ (.xlsx)
- **Compatibility**: Excel, Google Sheets, LibreOffice, Numbers
- **File size**: Typically 10-50 KB (very small)
- **Encoding**: UTF-8 (supports all languages)

### Authentication
- Uses Google Service Account credentials
- Same account that accesses the sheets
- Secure OAuth 2.0 authentication
- No user interaction required

### Temporary Storage
- Files stored in: `/tmp/attendance_YYYY-MM-DD.xlsx`
- Automatically deleted after sending
- No permanent storage on server
- Privacy preserved

---

## 📥 Opening the Excel File

### On Mobile

**Android**:
1. Tap the file in Telegram
2. Choose "Open with..."
3. Select Excel, Google Sheets, or WPS Office

**iOS**:
1. Tap the file in Telegram
2. Choose "Share"
3. Select "Open in Excel" or "Open in Numbers"

### On Desktop

**Windows**:
1. Click the file in Telegram Desktop
2. Opens in Microsoft Excel (if installed)
3. Or save and open with any spreadsheet app

**Mac**:
1. Click the file in Telegram Desktop
2. Opens in Numbers or Excel (if installed)
3. Or save and open manually

**Linux**:
1. Click the file in Telegram Desktop
2. Opens in LibreOffice Calc (if installed)
3. Or save to Downloads folder

---

## 🎯 Use Cases

### Daily Review
Download the file each morning to review yesterday's attendance.

### Weekly Reports
Collect all daily files from the week and consolidate them.

### Monthly Audits
Use the files for monthly attendance audits and payroll.

### Data Analysis
Import files into your own database or BI tool.

### Compliance
Keep archived copies for labor law compliance.

---

## 🔒 Security & Privacy

### Data Protection
- ✅ Only sent to configured group (DAILY_REPORT_GROUP_ID)
- ✅ Requires bot to be group member
- ✅ Files encrypted in transit (Telegram's encryption)
- ✅ No permanent storage on bot server
- ✅ Temporary files deleted after sending

### Access Control
- Only group members can see the files
- Only admins can trigger manual exports
- Bot permissions controlled by group admins

---

## ⚠️ Important Notes

### File Permissions
- Group must allow bots to send files
- Bot must have "Send Documents" permission
- If permission denied, check group settings

### File Size Limits
- Telegram supports files up to 2 GB
- Daily sheets are typically < 100 KB
- No issues expected with normal usage

### Group Storage
- Files stored in Telegram group chat
- Count towards group's media storage
- Can be deleted manually if needed

---

## 🔍 Troubleshooting

### File Not Sent

**Check**:
1. Group ID configured correctly?
2. Bot is in the group?
3. Bot has send documents permission?
4. Google Sheets API accessible?

**Logs will show**:
```
info: Exporting sheet 2025-11-10 from URL: ...
info: Downloaded Excel file to: /tmp/attendance_2025-11-10.xlsx
info: Daily report (Excel file) sent to group -1234567890
```

### File Opens as Corrupted

**Usually caused by**:
- Incomplete download
- Network interruption during export
- Google Sheets API timeout

**Solution**:
- Retry with `/endday` command
- Check bot logs for errors
- Verify Google Sheets access

### Wrong Sheet Sent

**Check**:
- Date in command is correct
- Sheet exists in Google Sheets
- Sheet has data (not empty)

---

## 🆚 Comparison: Excel vs Text Report

| Aspect | Excel File | Text Report |
|--------|-----------|-------------|
| **Data completeness** | ✅ All columns | ❌ Summary only |
| **Archival** | ✅ Easy to save | ❌ Must copy text |
| **Analysis** | ✅ Spreadsheet tools | ❌ Manual parsing |
| **File size** | 10-50 KB | 1-2 KB |
| **Mobile viewing** | Requires app | Direct in chat |
| **Searchable** | ✅ In Excel | ❌ In chat only |
| **Professional** | ✅ Business format | ❌ Casual format |

---

## 📚 Related Documentation

- `END_OF_DAY_FEATURES.md` - Complete feature overview
- `SETUP_END_OF_DAY.md` - Quick setup guide
- `SETUP_TELEGRAM_GROUP.md` - Group configuration

---

**Last Updated**: 2025-11-10
**Feature Status**: ✅ Implemented and Active
