# ✅ Setup Configuration - Ready to Use!

## 🎯 Your Configuration

### **Google Sheet**
- **URL:** https://docs.google.com/spreadsheets/d/1J2y9G6XbkoVLuRFSJ_sjZYhM4nEJi7OqrW-L1-uMkbY/edit
- **Sheet ID:** `1J2y9G6XbkoVLuRFSJ_sjZYhM4nEJi7OqrW-L1-uMkbY`
- **Tab Name:** `Worker info`

### **Column Structure**
| Column | Name | Purpose |
|--------|------|---------|
| A | Name full | Employee full name |
| B | Work time | Schedule (9:00-18:00) |
| C | Telegram name | Display name |
| D | Company | HO.UZ or Grace project |
| E | Telegram user name | @username |
| F | Telegram Id | **Bot fills this automatically** |

### **Bot Token**
- ✅ Already configured: `7860148820:AAG_ye0jrEqY3YXpWq83BFkQXH1TUPZfMAo`

### **Admin ID**
- ✅ Already configured: `215197299`

### **Service Account**
- ✅ Email: `attendance-bot@atendence-telegram-bot.iam.gserviceaccount.com`
- ✅ Private Key: Configured

---

## 🔧 Changes Made

1. ✅ Updated sheet name from `"Roster"` → `"Worker info"`
2. ✅ Set correct Sheet ID in `.env`
3. ✅ Created `.env` file from `.env.example`

---

## 📋 Registration Flow (How It Works)

### **Step 1: User types `/start`**

Bot checks:
1. Is user already registered? (Column F has their Telegram ID)
   - **YES** → Show "✅ Вы уже зарегистрированы!"
   - **NO** → Continue to Step 2

### **Step 2: Try automatic match by username**

If user has Telegram @username (like `@JamoL234`):
1. Bot searches Column E ("Telegram user name")
2. **If found** → Show confirmation:
   ```
   👤 Имя: Комилов Жамолиддин
   🏢 Компания: HO.UZ
   ⏰ График работы: 9:00-18:00

   Это вы?
   [ ✅ Да, это я ] [ ❌ Нет, это не я ]
   ```
3. User clicks "✅ Да, это я" → **Bot writes their Telegram ID to Column F**
4. Registration complete! ✅

### **Step 3: Manual selection (if no username or not found)**

If:
- User has NO @username, OR
- Username not found in Column E, OR
- User clicked "❌ Нет" in Step 2

Then bot shows **all employees where Column F is empty**:
```
👋 Добро пожаловать в систему учёта посещаемости!

Выберите ваше имя из списка:

[1. Комилов Жамолиддин (HO.UZ)]
[2. Толипов Азиз (HO.UZ)]
[3. Одилов Азим (Grace project)]
...
```

User clicks their name → Confirmation → **Bot writes Telegram ID to Column F**

---

## ⚠️ IMPORTANT: Share Sheet with Service Account

**YOU MUST DO THIS STEP!**

1. Open your Google Sheet: https://docs.google.com/spreadsheets/d/1J2y9G6XbkoVLuRFSJ_sjZYhM4nEJi7OqrW-L1-uMkbY/edit

2. Click **"Share"** button (top right)

3. Add this email:
   ```
   attendance-bot@atendence-telegram-bot.iam.gserviceaccount.com
   ```

4. Give **"Editor"** access

5. **Uncheck** "Notify people"

6. Click **"Share"**

**Without this, bot cannot read or write to your sheet!** ⚠️

---

## 🚀 Start the Bot

```bash
cd attendance-bot-nodejs

# Install dependencies (first time only)
npm install

# Start bot
npm start
```

**Expected output:**
```
✅ Google Sheets connected successfully
✅ Bot started successfully!
Timezone: Asia/Tashkent
Grace period: 7 minutes
Late deadline: 10:00
Bot is now running. Press Ctrl+C to stop.
```

---

## 🧪 Test Registration

1. **Open your bot in Telegram**
   - Search for your bot
   - Click "Start"

2. **If you have username in Column E:**
   ```
   Bot: "👤 Имя: YOUR NAME
         🏢 Компания: YOUR COMPANY
         ⏰ График работы: 9:00-18:00

         Это вы?"

   You: Click "✅ Да, это я"

   Bot: "✅ Регистрация успешно завершена!"
   ```

3. **Check Google Sheet:**
   - Open: https://docs.google.com/spreadsheets/d/1J2y9G6XbkoVLuRFSJ_sjZYhM4nEJi7OqrW-L1-uMkbY/edit
   - Go to "Worker info" tab
   - Check Column F - **Your Telegram ID should appear!**

---

## 📊 What Happens After Registration

Once user is registered (Telegram ID in Column F):

### **User can check in:**
```
User: +
Bot: ✅ Отмечен приход: 09:05
     🎉 Вы пришли вовремя!
     📊 Текущий рейтинг: 10.0 🟢
```

### **User can check out:**
```
User: - Иду домой
Bot: ✅ Отмечен уход: 18:15
     💬 Сообщение: "Иду домой"
     👋 Хорошего вечера!
     📊 Текущий рейтинг: 10.0 🟢
```

### **Data is logged to new sheet:**
Bot automatically creates new sheet named `2024-10` (current month) with:

| Date | Telegram_Id | Name | Event | Time | Details | Rating_Impact |
|------|-------------|------|-------|------|---------|---------------|
| 2024-10-28 | 215197299 | Your Name | ARRIVAL | 09:05 | on_time | 0 |
| 2024-10-28 | 215197299 | Your Name | DEPARTURE | 18:15 | Иду домой | 0 |

---

## 🔍 Troubleshooting

### **Error: "Failed to connect to Google Sheets"**

**Solution:**
1. Make sure you **shared the sheet** with service account email
2. The email is: `attendance-bot@atendence-telegram-bot.iam.gserviceaccount.com`
3. Give "Editor" access
4. Check Sheet ID is correct in `.env`

### **Error: "You are not found in system"**

**Possible reasons:**
1. Employee not in "Worker info" sheet
2. Sheet not shared with service account
3. Sheet ID is wrong

**Solution:**
1. Check employee exists in sheet
2. Verify sheet is shared
3. Verify Sheet ID: `1J2y9G6XbkoVLuRFSJ_sjZYhM4nEJi7OqrW-L1-uMkbY`

### **Bot doesn't find username**

**Check:**
1. Column E has username with `@` (example: `@JamoL234`)
2. Username matches exactly (case-insensitive)
3. No extra spaces in Column E

### **Bot doesn't write Telegram ID**

**Check:**
1. Sheet is shared with service account (Editor access)
2. Column F exists and is named "Telegram Id"
3. No formula or validation in Column F

---

## ✅ Checklist Before Starting

- [ ] Google Sheet shared with `attendance-bot@atendence-telegram-bot.iam.gserviceaccount.com`
- [ ] Service account has "Editor" access
- [ ] Sheet ID is `1J2y9G6XbkoVLuRFSJ_sjZYhM4nEJi7OqrW-L1-uMkbY`
- [ ] Tab name is "Worker info"
- [ ] Columns A-F are correct (Name full, Work time, etc.)
- [ ] Column F (Telegram Id) is **EMPTY** for new users
- [ ] Column E has usernames with `@` symbol
- [ ] Column B has work time format `HH:MM-HH:MM`
- [ ] `.env` file exists (not just `.env.example`)
- [ ] `npm install` completed successfully

---

## 🎉 You're Ready!

Everything is configured! Just:

1. ✅ Share sheet with service account
2. ✅ Run `npm start`
3. ✅ Test with `/start` in Telegram
4. ✅ Check Column F gets filled with Telegram ID

**Your bot is ready to track attendance!** 🚀
