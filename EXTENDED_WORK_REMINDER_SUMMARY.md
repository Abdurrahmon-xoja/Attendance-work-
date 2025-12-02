# Extended Work Reminder Implementation - Summary

## Problem

When a user extended their work time, they were NOT receiving a reminder 15 minutes before the extended end time.

### Example Issue:
- Normal work: 09:00-18:00
- User extends by 60 minutes at 17:30
- Extended end time: 19:00
- **Bug:** No reminder at 18:45 (15 min before extended end) ❌
- Only got auto-departure warning at 19:05 (10 min before auto-departure)

## Solution

Added a new reminder system that sends reminders 15 minutes before extended work end time, with proper rounding to match the 5-minute cron schedule.

## Implementation

### 1. Added New Sheet Column

**File:** `src/services/sheets.service.js:573`

```javascript
'extended_work_reminder_sent'
```

This column tracks whether the extended work reminder has been sent.

### 2. Added Extended Work Reminder Check

**File:** `src/services/scheduler.service.js:698-793`

New section added after departure reminders:

```javascript
// Check for extended work reminders (15 min before extended end time)
for (const row of rows) {
  // Get work extension minutes
  const workExtensionMinutes = parseInt(row.get('work_extension_minutes') || '0');

  // Skip if no extension
  if (workExtensionMinutes <= 0) continue;

  // Calculate extended end time
  const extendedWorkEnd = workEnd.clone().add(workExtensionMinutes, 'minutes');

  // Calculate and round reminder time (15 min before)
  const extendedWorkReminderTime = this.roundToNearest5Minutes(
    extendedWorkEnd.clone().subtract(15, 'minutes')
  );

  // Send reminder if time matches
  if (currentMinute === extendedWorkReminderTime) {
    // Send message and mark as sent
  }
}
```

**Key Features:**
- Checks every 5 minutes (cron schedule)
- Only sends if user has active work extension
- Uses rounding function for 5-minute interval matching
- Marks reminder as sent to prevent duplicates
- Includes error handling and rate limiting

### 3. Reset Reminder Flag on Extension

**File:** `src/bot/handlers/attendance.handler.js:3491`

```javascript
// Reset extended work reminder flag so user gets a new reminder for the new extended time
employeeRow.set('extended_work_reminder_sent', 'false');
```

When user extends work (again), the reminder flag is reset so they receive a new reminder for the new extended time.

### 4. Applied Rounding Logic

Uses the same `roundToNearest5Minutes()` function implemented for late notifications to ensure reminder times match the cron schedule.

## How It Works

### Example Flow:

**Scenario:** Work time 09:00-18:00, user extends by 60 minutes

1. **17:30** - User clicks "+1 час" button
   - System stores: `work_extension_minutes = 60`
   - System stores: `extended_work_reminder_sent = false`
   - Extended end time: 18:00 + 60 min = **19:00**

2. **Cron checks every 5 minutes:**

3. **18:45** (cron runs)
   - Calculates: 19:00 - 15 min = 18:45
   - Rounds: 18:45 → **18:45** (already on 5-min)
   - Match! ✅
   - **Sends Reminder:** "Your extended work time ends in 15 minutes at 19:00"
   - Sets: `extended_work_reminder_sent = true`

4. **19:05** (cron runs)
   - Sends auto-departure warning (existing functionality)

## Reminder Message

```
⏰ Напоминание о продленном рабочем времени

Ваше продленное рабочее время заканчивается через 15 минут
Время окончания: 19:00

Вы продлили работу на: 1 ч 0 мин

Не забудьте отметить уход командой "- сообщение"
```

## All Extension Durations Supported

| Button | Minutes | Example: End 18:00 | Extended End | Reminder |
|--------|---------|-------------------|--------------|----------|
| +30 мин | 30 | 18:00 + 30 min | 18:30 | 18:15 |
| +1 час | 60 | 18:00 + 60 min | 19:00 | 18:45 |
| +2 часа | 120 | 18:00 + 120 min | 20:00 | 19:45 |
| Работаю всю ночь | 480 | 18:00 + 480 min | 02:00 | 01:45 |

## Multiple Extensions Handling

**Scenario:** User extends multiple times

1. **17:30** - User extends by +30 min
   - Total extension: 30 min
   - End: 18:30
   - Reminder will be sent at: 18:15

2. **18:00** - User extends again by +30 min
   - Total extension: 60 min (cumulative)
   - End: 19:00
   - **Reminder flag reset to 'false'**
   - New reminder will be sent at: 18:45

3. **18:30** - User extends again by +1 hour
   - Total extension: 120 min (cumulative)
   - End: 20:00
   - **Reminder flag reset to 'false'**
   - New reminder will be sent at: 19:45

✅ Each extension resets the flag, allowing new reminders for the new time

## Rounding Examples

Since cron runs every 5 minutes, all reminder times are rounded:

| Extension | Extended End | Unrounded Reminder | Rounded Reminder | Difference |
|-----------|--------------|-------------------|------------------|------------|
| 30 min | 18:30 | 18:15 | 18:15 | 0 min |
| 47 min | 18:47 | 18:32 | 18:30 | 2 min early |
| 60 min | 19:00 | 18:45 | 18:45 | 0 min |
| 73 min | 19:13 | 18:58 | 19:00 | 2 min late |
| 120 min | 20:00 | 19:45 | 19:45 | 0 min |

**Maximum difference:** ±2 minutes (acceptable for reminders)

## Conditions for Reminder

Reminder is sent only if ALL conditions are met:

1. ✅ User has arrived today (`When come` not empty)
2. ✅ User has NOT departed (`Leave time` empty)
3. ✅ User has work extension (`work_extension_minutes > 0`)
4. ✅ Reminder NOT already sent (`extended_work_reminder_sent != 'true'`)
5. ✅ Current time matches reminder time (rounded to 5-min interval)

## Changed Files

### 1. `src/services/sheets.service.js`
**Line 573:** Added column header
```javascript
'extended_work_reminder_sent'
```

### 2. `src/services/scheduler.service.js`
**Lines 698-793:** Added complete reminder check logic
```javascript
// Check for extended work reminders (15 min before extended end time)
```

### 3. `src/bot/handlers/attendance.handler.js`
**Line 3491:** Reset reminder flag on extension
```javascript
employeeRow.set('extended_work_reminder_sent', 'false');
```

## Benefits

✅ Users get timely reminder before extended work ends
✅ Reminder timing matches cron schedule (every 5 minutes)
✅ Works with all extension durations (+30 min to +8 hours)
✅ Handles multiple cumulative extensions correctly
✅ Separate from auto-departure warning (earlier notification)
✅ Maximum ±2 minute difference (acceptable for reminders)
✅ Proper error handling and rate limiting
✅ No breaking changes to existing functionality

## Testing

Run the test to verify:

```bash
node test-extended-work-reminder.js
```

**Result:** All tests pass ✅

Test covers:
- All extension durations (+30 min, +1 hour, +2 hours, +8 hours)
- Odd minute results with rounding
- Multiple cumulative extensions
- Cron matching verification

## Timeline Comparison

### Before (No Extended Work Reminder):
```
17:30 - User extends work by 60 min
18:45 - (nothing - no reminder) ❌
19:00 - Extended work time ends
19:05 - Auto-departure warning (10 min before 19:15)
19:15 - Auto-departure triggered
```

### After (With Extended Work Reminder):
```
17:30 - User extends work by 60 min
18:45 - ✅ Extended work reminder sent
19:00 - Extended work time ends
19:05 - Auto-departure warning (10 min before 19:15)
19:15 - Auto-departure triggered
```

## Integration with Existing Systems

### Works alongside:
- ✅ Departure reminders (normal end time)
- ✅ Auto-departure warnings (10 min before auto-departure)
- ✅ Auto-departure system (automatic marking)
- ✅ Work extension buttons (+30 min, +1 hour, +2 hours, +8 hours)

### Does NOT interfere with:
- Late notification reminders
- Temporary exit reminders
- Daily/monthly reports
- No-show checks

## Production Ready

✅ Code tested
✅ Syntax verified
✅ All edge cases handled
✅ No breaking changes
✅ Error handling in place
✅ Rate limiting implemented
✅ Logging added
✅ No config changes required
✅ No database migration needed (column auto-created)

---

**Status:** ✅ COMPLETE AND TESTED
**Date:** 2025-11-25
**Version:** 1.0.0
