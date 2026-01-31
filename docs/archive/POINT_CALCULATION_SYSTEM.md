# 📊 Point Calculation System

## Daily Points Overview

Each day, employees can earn **1 point** for good behavior or lose points for violations.

---

## ✅ Ways to Earn 1 Point

### 1. **Came On Time** → +1.0 point 🟢
- Arrived within grace period (10 minutes after work start)
- Example: Work starts at 9:00, arrived at 9:08 ✅

### 2. **Late but Notified** → +1.0 point 🟢
- Used "🕒 Опоздаю" button BEFORE coming
- Then arrived (even if late)
- **Reward for being responsible!**

### 3. **Absent but Notified** → +1.0 point 🟢
- Used "🚫 Отсутствую" button
- Told reason (sick, family, etc.)
- **Reward for informing!**

---

## ❌ Ways to Lose Points

### 1. **Late Without Warning** → -1.0 point 🔴
- Arrived late WITHOUT using "🕒 Опоздаю" button
- Example: Work starts 9:00, arrived 10:30 without warning
- **Plus penalty time: lateness × 0.5 (max 4 hours extra work)**

### 2. **Absent Without Notice** → -1.5 points 🔴
- Didn't come to work
- Didn't use "🚫 Отсутствую" button
- **Most serious violation**

### 3. **Early Departure** → -0.5 points 🟡
- Left before completing penalty time (if late)
- Example: Should work until 19:00, left at 18:30

### 4. **Left Without Message** → -0.3 points 🟡
- Used "🚪 Ухожу" but didn't write a message
- Minor violation

---

## 🔢 Point Calculation Examples

### Example 1: Perfect Day
```
✅ Arrived on time (9:00)
✅ Worked full day
✅ Left with message (18:00)

Daily Points: 1.0 🟢
```

### Example 2: Late but Responsible
```
🕒 Clicked "Опоздаю" at 8:50 (before work)
✅ Arrived at 9:45 (45 min late)
✅ Worked until 18:23 (penalty time: 45 × 0.5 = 23 min)
✅ Left with message

Daily Points: 1.0 🟢
Penalty Work: 23 minutes extra
```

### Example 3: Late Without Warning
```
❌ Didn't notify
❌ Arrived at 9:45 (45 min late)
✅ Worked until 18:23 (penalty time)

Daily Points: -1.0 🔴
Penalty Work: 23 minutes extra
```

### Example 4: Absent but Notified
```
🚫 Clicked "Отсутствую" at 8:30
📝 Reason: "Болею" (Sick)

Daily Points: 1.0 🟢
```

### Example 5: Absent Without Notice
```
❌ Didn't come to work
❌ No notification

Daily Points: -1.5 🔴
```

---

## ⏰ Penalty Time Calculation

When arriving late **without notification**:

### Formula
```
Penalty Time = Lateness × 0.5
Maximum Penalty = 4 hours (240 minutes)
```

### Examples

| Lateness | Calculation | Penalty Time | Required Extra Work |
|----------|-------------|--------------|---------------------|
| 10 min   | 10 × 0.5    | 5 min        | ✅ Minimal |
| 30 min   | 30 × 0.5    | 15 min       | ✅ Fair |
| 60 min   | 60 × 0.5    | 30 min       | 🟡 Moderate |
| 120 min  | 120 × 0.5   | 60 min       | 🟡 1 hour extra |
| 183 min  | 183 × 0.5   | 92 min       | 🟠 1.5 hours |
| 300 min+ | 300 × 0.5   | **240 min** (capped) | 🔴 Max: 4 hours |

---

## 📊 Point Display

### In Bot Messages

**Arrival Message:**
```
✅ Отмечен приход: 9:45
⚠️ Опоздание: 45 мин (без предупреждения)
⏳ Необходимо отработать дополнительно: 23 мин
⏰ Уход не раньше: 18:23

📊 Баллы сегодня: -1 🔴
```

**Status Command ("📋 Мой статус"):**
```
📊 ВАШ СТАТУС

👤 Имя: John Doe
🏢 Компания: Tech Corp
⏰ График: 9:00-18:00

📅 СЕГОДНЯ (29.10.2025):
✅ Приход: 9:45
❌ Уход: не отмечен

📊 ВАШ БАЛЛ СЕГОДНЯ:
Баллы: -1 🔴
Статус: Есть нарушения
```

---

## 🎯 Point Emoji Guide

| Points | Emoji | Status |
|--------|-------|--------|
| +1.0   | 🟢    | Отличная работа! / Опоздание предупреждено! / Отсутствие зафиксировано |
| 0      | 🟡    | Без нарушений (if arrived) / Ожидается отметка |
| -0.3 to -0.5 | 🟡 | Небольшое нарушение |
| -1.0   | 🔴    | Есть нарушения |
| -1.5   | 🔴    | Есть нарушения |

---

## 🔑 Key Rules

### ✅ Good Behavior = 1 Point
- Be on time
- **OR** notify if you'll be late/absent

### ❌ Bad Behavior = Negative Points
- Late without warning: -1.0 + penalty time
- Absent without notice: -1.5
- Leave early: -0.5

### 💡 Pro Tips
1. **Always notify!** → Get +1 point instead of -1 or -1.5
2. Click "🕒 Опоздаю" before 10:00 AM (deadline)
3. Use "🚫 Отсутствую" as soon as you know you won't come
4. Write a message when leaving ("🚪 Ухожу")

---

## 📝 Configuration Variables

Located in `.env` file:

```bash
# Grace period (no penalty within this time)
GRACE_PERIOD_MINUTES=10

# Penalty calculation
PENALTY_MULTIPLIER=0.5          # Multiply lateness by this
PENALTY_MAX_MINUTES=240         # Max 4 hours penalty

# Point penalties
LATE_NOTIFIED_PENALTY=-0.5      # NOT USED (we give +1 instead)
LATE_SILENT_PENALTY=-1.0        # Late without warning
ABSENT_PENALTY=-1.5             # Absent without notice
EARLY_DEPARTURE_PENALTY=-0.5    # Left before required time
LEFT_WITHOUT_MESSAGE_PENALTY=-0.3
```

---

## 📌 Summary

**The system rewards responsibility:**
- Notify = Get rewarded (+1 point)
- Don't notify = Get penalized (-1 or -1.5 points)

**Being responsible is always rewarded! 🎉**
