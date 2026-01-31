# Scheduler Service Architecture

## Overview

The scheduler service has been refactored from a monolithic 2,268-line file into a modular architecture with 11 separate files totaling 2,502 lines.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Entry                         │
│                     src/index.js                             │
│                                                              │
│  schedulerService = require('./services/scheduler.service') │
└────────────────────────┬────────────────────────────────────┘
                         │ (redirects to ./services/scheduling/)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              src/services/scheduling/index.js                │
│                   (Singleton Export)                         │
│                                                              │
│  const schedulerService = new SchedulerService();           │
│  module.exports = schedulerService;                          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│        src/services/scheduling/scheduler.service.js          │
│                   (Core Scheduler)                           │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ SchedulerService Class (363 lines)                  │   │
│  │                                                      │   │
│  │ Properties:                                          │   │
│  │  • bot                - Telegraf bot instance       │   │
│  │  • jobs[]             - Active cron jobs            │   │
│  │  • _lastAdjustedEndTimes - End time cache          │   │
│  │  • _blockedUsers      - Blocked user tracking      │   │
│  │                                                      │   │
│  │ Utility Methods:                                     │   │
│  │  • retryOperation()           - Google API retry    │   │
│  │  • retryTelegramOperation()   - Telegram API retry  │   │
│  │  • sendMessageSafe()          - Safe messaging      │   │
│  │  • roundToNearest5Minutes()   - Time rounding      │   │
│  │                                                      │   │
│  │ Setup Methods:                                       │   │
│  │  • init(bot)                  - Initialize         │   │
│  │  • setupDailySheetCreation()                        │   │
│  │  • setupReminderChecks()                            │   │
│  │  • setupMonthlyReportCreation()                     │   │
│  │  • setupDailyReportToAdmins()                       │   │
│  │  • setupMonthlyReportToAdmins()                     │   │
│  │  • setupNoShowCheck()                               │   │
│  │  • setupEndOfDayArchiving()                         │   │
│  │  • stop()                     - Stop all jobs      │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │ imports jobs from
                         ▼
┌─────────────────────────────────────────────────────────────┐
│          src/services/scheduling/jobs/index.js               │
│                    (Job Registry)                            │
│                                                              │
│  Exports:                                                    │
│   • dailySheetJob                                            │
│   • monthlyReportJob                                         │
│   • reminderChecksJob                                        │
│   • noShowCheckJob                                           │
│   • dailyReportToAdminsJob                                   │
│   • monthlyReportToAdminsJob                                 │
│   • endOfDayArchivingJob                                     │
└────────────────────────┬────────────────────────────────────┘
                         │ imports from
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                 Individual Job Modules                       │
│             src/services/scheduling/jobs/                    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ dailySheet.job.js (46 lines)                       │    │
│  │ Schedule: '1 0 * * *' (00:01 daily)                │    │
│  │ Purpose: Create daily attendance sheets            │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ monthlyReport.job.js (36 lines)                    │    │
│  │ Schedule: '5 0 1 * *' (00:05 on 1st)               │    │
│  │ Purpose: Create monthly report sheets              │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ reminderChecks.job.js (884 lines)                  │    │
│  │ Schedule: '*/5 * * * *' (every 5 minutes)          │    │
│  │ Purpose: All reminder types                        │    │
│  │  • Arrival reminders (3 types)                     │    │
│  │  • Auto-late marking                               │    │
│  │  • Temp exit return reminders                      │    │
│  │  • Departure reminders                             │    │
│  │  • Extended work reminders                         │    │
│  │  • Auto-departure system                           │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ noShowCheck.job.js (144 lines)                     │    │
│  │ Schedule: '0 20 * * *' (20:00 daily)               │    │
│  │ Purpose: Mark no-shows with -2 penalty             │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ dailyReportToAdmins.job.js (277 lines)             │    │
│  │ Schedule: '59 23 * * *' (23:59 daily)              │    │
│  │ Purpose: Send HTML reports to admins               │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ monthlyReportToAdmins.job.js (117 lines)           │    │
│  │ Schedule: '59 23 28-31 * *' (23:59 last day)       │    │
│  │ Purpose: Send monthly reports to admins            │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ endOfDayArchiving.job.js (602 lines)               │    │
│  │ Schedule: '0 0 * * *' (00:00 daily)                │    │
│  │ Purpose: Archive previous day                      │    │
│  │  1. Handle overnight workers                       │    │
│  │  2. Wait 2 minutes                                 │    │
│  │  3. Transfer to monthly                            │    │
│  │  4. Send Excel to group                            │    │
│  │  5. Delete daily sheet                             │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### Job Execution Flow

```
Cron Trigger (node-cron)
        ↓
scheduler.service.js (setup method)
        ↓
job.execute(schedulerService) ← Pass scheduler instance
        ↓
Job Implementation
        ↓
        ├─→ sheetsService (Google Sheets API)
        ├─→ bot.telegram (Telegram API)
        ├─→ Config (application config)
        └─→ logger (logging)
```

### Example: Reminder Check Flow

```
Every 5 minutes (cron: */5 * * * *)
        ↓
setupReminderChecks() in scheduler.service.js
        ↓
reminderChecksJob.execute(this)
        ↓
checkAndSendReminders(schedulerService)
        ↓
        ├─→ Get daily sheet (sheetsService._getCachedDailySheet)
        ├─→ Get roster (sheetsService._getCachedRoster)
        ├─→ For each employee:
        │   ├─→ Check arrival reminders
        │   ├─→ Check auto-late marking
        │   ├─→ Check temp exit reminders
        │   ├─→ Check departure reminders
        │   ├─→ Check extended work reminders
        │   └─→ Check auto-departure
        └─→ Batch save all updates (sheetsService.batchSaveRows)
```

## Job Pattern

Every job follows this consistent pattern:

```javascript
// 1. Imports
const moment = require('moment-timezone');
const sheetsService = require('../../sheets.service');
const Config = require('../../../config');
const logger = require('../../../utils/logger');

// 2. Schedule (cron expression)
const schedule = '*/5 * * * *';

// 3. Helper functions (if needed)
async function helperFunction(param) {
  // Helper logic
}

// 4. Main execution function
async function execute(schedulerService) {
  try {
    // Job implementation
    // Has access to:
    // - schedulerService.bot
    // - schedulerService.retryOperation()
    // - schedulerService.sendMessageSafe()
    // - etc.
  } catch (error) {
    logger.error(`Error: ${error.message}`);
  }
}

// 5. Exports
module.exports = {
  schedule,
  execute,
  helperFunction,  // Optional - for testing/external use
  name: 'Job Name',
  description: 'Job description'
};
```

## Dependency Graph

```
schedulerService
    ├── bot (Telegraf instance)
    ├── Config
    ├── logger
    ├── moment-timezone
    └── jobs/
        ├── All jobs depend on:
        │   ├── sheetsService (Google Sheets)
        │   ├── Config (settings)
        │   ├── logger (logging)
        │   └── moment-timezone (time)
        │
        └── Some jobs also use:
            ├── CalculatorService (rating calculations)
            ├── XLSX (Excel generation)
            ├── fs (file system)
            └── Markup (Telegraf keyboards)
```

## Key Design Decisions

### 1. Singleton Pattern
- Maintains single instance across application
- Preserves state (_lastAdjustedEndTimes, _blockedUsers)
- Ensures consistent job execution

### 2. Job Modules
- Each job is self-contained
- Jobs receive schedulerService as parameter
- Helper functions exported for testing

### 3. Backward Compatibility
- Redirect file maintains old import path
- Same API surface as original
- Zero breaking changes

### 4. Error Handling
- Each job handles its own errors
- Retry logic for API calls (Google, Telegram)
- Blocked user detection prevents spam

### 5. Optimization
- Batch saving for sheet updates
- Cached data methods
- Exponential backoff for retries

## Performance Characteristics

### Memory
- **Before:** 2,268 lines in memory
- **After:** Only loaded modules in memory
- **Impact:** Marginal improvement

### Execution
- No performance impact
- Same cron scheduling
- Same execution flow

### Development
- **Build time:** Negligible increase (more files)
- **Cognitive load:** Significant decrease (smaller files)
- **Debug time:** Faster (isolated concerns)

## File Size Comparison

| Component | Lines | % of Total |
|-----------|-------|------------|
| Core Scheduler | 363 | 14.5% |
| Reminder Checks | 884 | 35.3% |
| End-of-Day | 602 | 24.1% |
| Daily Report | 277 | 11.1% |
| No-Show Check | 144 | 5.8% |
| Monthly Report Admins | 117 | 4.7% |
| Daily Sheet | 46 | 1.8% |
| Monthly Report | 36 | 1.4% |
| Registries | 33 | 1.3% |
| **Total** | **2,502** | **100%** |

Original file was 2,268 lines, new structure is 2,502 lines (234 lines added for modularity).

## Testing Strategy

### Unit Tests (per job)
```javascript
const job = require('./jobs/dailySheet.job');
const mockScheduler = { /* mock */ };

test('creates daily sheet', async () => {
  await job.execute(mockScheduler);
  // assertions
});
```

### Integration Tests
```javascript
const schedulerService = require('./scheduling');

test('scheduler initializes all jobs', () => {
  schedulerService.init(mockBot);
  expect(schedulerService.jobs.length).toBe(7);
});
```

### End-to-End Tests
```javascript
// Test actual cron execution
// Wait for scheduled time
// Verify job executed
```

## Migration Checklist

- [x] Extract all 7 jobs into separate files
- [x] Create job registry
- [x] Create core scheduler
- [x] Create main entry point (singleton)
- [x] Create backward compatibility redirect
- [x] Verify all imports still work
- [x] Document new structure
- [ ] Run existing tests
- [ ] Deploy to staging
- [ ] Monitor job execution
- [ ] Deploy to production

---

**Architecture Status:** ✅ Complete
**Documentation:** ✅ Complete
**Testing:** ⏳ Pending
**Deployment:** ⏳ Pending
