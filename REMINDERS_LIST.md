# 📋 Complete List of Bot Reminders

This document lists **all** cases when the bot sends reminders/notifications to employees.

---

## ⏰ Work Start Reminders (3 reminders)

### 1. Reminder #1: 15 Minutes Before Work
**When:** 15 minutes before work start time
**Condition:** Employee hasn't arrived AND hasn't notified they'll be late
**Message:**
```
⏰ Напоминание о начале работы

Ваша работа начинается через 15 минут (в [TIME])!

💡 Если вы опаздываете, лучше сообщить об этом администрации через бот.

Отметьте свой приход, когда придёте в офис.
```
**Skipped on:** Sunday, or Saturday (if employee doesn't work Saturdays)

---

### 2. Reminder #2: At Work Start Time
**When:** Exactly at work start time
**Condition:** Employee hasn't arrived AND hasn't notified they'll be late
**Message:**
```
⏰ Время начала работы

Ваша работа начинается сейчас ([TIME]).

💡 Если вы опаздываете, лучше сообщить об этом администрации через бот.

Отметьте свой приход, когда придёте в офис.
```
**Skipped on:** Sunday, or Saturday (if employee doesn't work Saturdays)

---

### 3. Reminder #3: 15 Minutes After Work Start
**When:** 15 minutes after work start time
**Condition:** Employee hasn't arrived AND hasn't notified they'll be late
**Message:**
```
⚠️ Напоминание о работе

Прошло 15 минут с начала рабочего дня ([TIME]).

💡 Если вы опаздываете, лучше сообщить об этом администрации через бот.

Не забудьте отметить свой приход.
```
**Skipped on:** Sunday, or Saturday (if employee doesn't work Saturdays)

---

## ⚠️ Auto-Late Marking

### 4. Auto-Late Notification
**When:** 20 minutes after work start time
**Condition:**
- Employee hasn't arrived
- Employee hasn't notified they'll be late
- Employee hasn't been marked absent

**Actions:**
1. Automatically marks employee as late in Google Sheets
2. Sends notification

**Message:**
```
⚠️ Вы автоматически отмечены как опоздавший

Вы не пришли на работу вовремя ([TIME]).
Прошло уже [N] минут с начала рабочего дня.

Пожалуйста, отметьте свой приход, когда придёте.
```

---

## 🚶 Temporary Exit Reminder

### 5. Temporary Exit Return Reminder
**When:** 15 minutes before expected return time
**Condition:**
- Employee marked temporary exit
- Still marked as "Currently out"
- Reminder not yet sent

**Message:**
```
⏰ Напоминание о возвращении

У вас осталось 15 минут до времени возвращения.
Причина выхода: [REASON]
Ожидаемое возвращение: [TIME]

Вам нужно больше времени?
```

**Interactive Buttons:**
- ✅ Вернусь вовремя
- ⏱ +15 мин
- ⏱ +30 мин
- ⏱ +45 мин
- ⏱ +1 час

---

## 🏃 Departure Reminders

### 6. Departure Reminder (Normal)
**When:** 15 minutes before work end time
**Condition:**
- Employee has arrived
- Employee hasn't departed yet
- No work deficit

**Message:**
```
⏰ Напоминание об окончании рабочего дня

Ваше рабочее время заканчивается в [TIME]

Не забудьте отметить уход командой "- сообщение"
```

---

### 7. Departure Reminder (With Deficit)
**When:** 15 minutes before adjusted end time (end time + deficit)
**Condition:**
- Employee has arrived
- Employee hasn't departed yet
- Has work deficit from previous days

**Message:**
```
⏰ Напоминание об окончании рабочего дня

Ваше рабочее время заканчивается в [NORMAL_TIME]
⚠️ НО у вас есть недоработка: [DEFICIT_TIME]

📌 Вам нужно остаться до [ADJUSTED_TIME]

💡 Это поможет погасить вашу недоработку за предыдущие дни.
```

---

## ⏰ Extended Work Reminder

### 8. Extended Work Reminder
**When:** 15 minutes before extended work end time
**Condition:**
- Employee has arrived
- Employee hasn't departed yet
- Employee has active work extension (clicked +30 min, +1 hour, etc.)
- Reminder not yet sent

**Message:**
```
⏰ Напоминание о продленном рабочем времени

Ваше продленное рабочее время заканчивается через 15 минут
Время окончания: [TIME]

Вы продлили работу на: [EXTENSION]

Не забудьте отметить уход командой "- сообщение"
```

**Note:** Reminder time is rounded to nearest 5-minute interval to match cron schedule (max ±2 min difference)

---

## 🤖 Auto-Departure System

### 9. Auto-Departure Warning
**When:** 10 minutes before auto-departure (work end + 15 min grace period)
**Condition:**
- Employee has arrived
- Employee hasn't departed yet
- Warning not yet sent

**Message:**
```
⏰ Напоминание об окончании работы

Ваше рабочее время закончилось в [TIME].
Вы не отметили уход.

⚠️ Через 10 минут вы будете автоматически отмечены как ушедший.

Что вы хотите сделать?
```

**Interactive Buttons:**
- ✅ Отметить уход сейчас
- ⏱ +30 мин
- ⏱ +1 час
- ⏱ +2 часа
- ⏱ Работаю всю ночь (8h)

---

### 10. Auto-Departure Notification
**When:** At auto-departure time (work end + 15 min grace period + any extensions)
**Condition:**
- Employee has arrived
- Employee hasn't departed yet
- Warning was sent but no action taken

**Actions:**
1. Automatically marks departure in Google Sheets
2. Calculates hours worked
3. Sends confirmation

**Message:**
```
✅ Вы автоматически отмечены как ушедший

🕐 Время ухода: [TIME]
⏱ Отработано: [HOURS]

Если вы всё ещё на работе, пожалуйста, отметьте приход заново.
```

---

## 📊 Summary Table

| # | Reminder Type | Timing | Frequency |
|---|---------------|--------|-----------|
| 1 | Work Start -15 min | Before start | Once per day |
| 2 | Work Start time | At start | Once per day |
| 3 | Work Start +15 min | After start | Once per day |
| 4 | Auto-Late Mark | +20 min after start | Once per day |
| 5 | Temp Exit Return | -15 min before return | Per exit |
| 6 | Departure Normal | -15 min before end | Once per day |
| 7 | Departure w/ Deficit | -15 min before adjusted end | Once per day |
| 8 | Extended Work Reminder | -15 min before extended end | Per extension |
| 9 | Auto-Departure Warning | -10 min before auto-depart | Once per day |
| 10 | Auto-Departure | At auto-depart time | Once per day |

---

## ⚙️ Configuration

All reminder timings can be configured in `.env`:

```env
# Auto-departure settings
AUTO_DEPARTURE_GRACE_MINUTES=15      # Minutes after work end to auto-depart
AUTO_DEPARTURE_WARNING_MINUTES=10    # Minutes before auto-depart to warn

# Late marking
LATE_THRESHOLD_MINUTES=20            # Minutes before auto-marking as late

# Weekend notifications
SEND_NOTIFICATIONS_SATURDAY=true     # Send reminders on Saturday
SEND_NOTIFICATIONS_SUNDAY=false      # Send reminders on Sunday
```

---

## 🔄 Reminder Check Frequency

The bot checks for reminders **every 5 minutes** using a cron job:
```
*/5 * * * * (every 5 minutes)
```

Located in: `src/services/scheduler.service.js:231`

---

## 📅 Additional Scheduled Tasks

These are not reminders but scheduled system tasks:

### Daily Report to Admins
**When:** 23:59 every day
**Action:** Sends HTML daily report to all admins

### Monthly Report Update
**When:** 23:55 every day
**Action:** Updates monthly report sheet with today's data

### Monthly Report Creation
**When:** 00:05 on 1st of each month
**Action:** Creates new monthly report sheet

---

## 🎯 Notes

- All reminders respect timezone: `Asia/Tashkent` (configurable)
- Reminders use retry logic to handle API failures
- Rate limiting: 1-2 second delays between messages
- Employees who are absent are skipped
- Employees who already took action are skipped
- Sunday reminders are disabled by default
- Saturday reminders respect individual work schedules
