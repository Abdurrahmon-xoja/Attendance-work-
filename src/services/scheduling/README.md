# Scheduler Service

Modular scheduler service for automated attendance bot tasks.

## Quick Start

```javascript
const schedulerService = require('./services/scheduling');

// Initialize with bot instance
schedulerService.init(bot);

// Stop all jobs
schedulerService.stop();
```

## Architecture

### Core Components

- **index.js** - Main entry point, exports singleton
- **scheduler.service.js** - Core scheduler with job registration
- **jobs/** - Individual job modules

### Job Pattern

Each job follows this structure:

```javascript
const schedule = '*/5 * * * *';  // Cron expression

async function execute(schedulerService) {
  // Job implementation
}

module.exports = {
  schedule,
  execute,
  name: 'Job Name',
  description: 'Job description'
};
```

## Available Jobs

| Job | Schedule | Purpose | Lines |
|-----|----------|---------|-------|
| dailySheet | `1 0 * * *` | Create daily sheets | 46 |
| monthlyReport | `5 0 1 * *` | Create monthly reports | 36 |
| reminderChecks | `*/5 * * * *` | All reminders | 884 |
| noShowCheck | `0 20 * * *` | Mark no-shows | 144 |
| dailyReportToAdmins | `59 23 * * *` | HTML reports to admins | 277 |
| monthlyReportToAdmins | `59 23 28-31 * *` | Monthly reports to admins | 117 |
| endOfDayArchiving | `0 0 * * *` | Archive daily data | 602 |

## Adding a New Job

1. Create job file in `jobs/` directory:

```javascript
// jobs/myNewJob.job.js
const schedule = '0 12 * * *'; // Noon daily

async function execute(schedulerService) {
  // Your job logic here
}

module.exports = {
  schedule,
  execute,
  name: 'My New Job',
  description: 'Does something awesome'
};
```

2. Register in `jobs/index.js`:

```javascript
const myNewJob = require('./myNewJob.job');

module.exports = {
  // ... existing jobs
  myNewJob
};
```

3. Set up in `scheduler.service.js`:

```javascript
setupMyNewJob() {
  const job = cron.schedule(jobs.myNewJob.schedule, async () => {
    try {
      await jobs.myNewJob.execute(this);
    } catch (error) {
      logger.error(`Error in my new job: ${error.message}`);
    }
  }, {
    timezone: Config.TIMEZONE
  });

  this.jobs.push(job);
  logger.info(`${jobs.myNewJob.name} job scheduled (${jobs.myNewJob.schedule})`);
}
```

4. Call setup in `init()` method.

## Utility Methods

### retryOperation(operation, maxRetries)
Retry operation with exponential backoff for Google Sheets quota errors.

```javascript
await schedulerService.retryOperation(async () => {
  return await sheetsService.getSomething();
}, 3);
```

### retryTelegramOperation(operation, maxRetries)
Retry Telegram API calls with exponential backoff for network errors.

```javascript
await schedulerService.retryTelegramOperation(async () => {
  await bot.telegram.sendMessage(userId, 'Hello');
});
```

### sendMessageSafe(telegramId, message, options)
Send message with blocked user detection and handling.

```javascript
const sent = await schedulerService.sendMessageSafe(
  telegramId,
  'Your message',
  { parse_mode: 'HTML' }
);

if (!sent) {
  logger.warn('User blocked bot');
}
```

### roundToNearest5Minutes(momentTime)
Round time to nearest 5-minute interval for cron matching.

```javascript
const rounded = schedulerService.roundToNearest5Minutes(
  moment.tz('2024-01-15 09:17', Config.TIMEZONE)
);
// Returns: '09:15'
```

## Job Dependencies

Jobs may depend on:
- **Config** - Application configuration
- **sheetsService** - Google Sheets operations
- **logger** - Logging utility
- **moment-timezone** - Time manipulation
- **schedulerService** - Passed as parameter to execute()

## Testing

Test individual jobs:

```javascript
const { dailySheetJob } = require('./services/scheduling/jobs');

// Test job execution
await dailySheetJob.execute(schedulerServiceMock);
```

Test helper functions:

```javascript
const { handleEndOfDay } = require('./services/scheduling/jobs/endOfDayArchiving.job');

await handleEndOfDay('2024-01-15', schedulerServiceMock, true);
```

## Debugging

Enable debug logs:

```javascript
const logger = require('./utils/logger');
logger.level = 'debug';
```

Check scheduled jobs:

```javascript
console.log('Active jobs:', schedulerService.jobs.length);
schedulerService.jobs.forEach((job, i) => {
  console.log(`Job ${i}:`, job.options);
});
```

## Migration from Old Structure

Old imports automatically redirect:

```javascript
// This still works (redirects to ./scheduling/)
const schedulerService = require('./services/scheduler.service');

// But you can use new path:
const schedulerService = require('./services/scheduling');
```

## Notes

- All jobs run in Asia/Tashkent timezone (Config.TIMEZONE)
- Jobs handle their own error logging
- Scheduler uses exponential backoff for retries
- Blocked users are tracked to prevent repeated failures
- Auto-departure warning messages are tracked for cleanup

## License

Internal use only.
