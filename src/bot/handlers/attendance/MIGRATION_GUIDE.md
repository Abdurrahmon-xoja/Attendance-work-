# Migration Guide: attendance.handler.js Split

## Overview

The monolithic `attendance.handler.js` file (4,841 lines) has been split into focused modules for better maintainability.

## Current Status

### ✅ Completed Modules

1. **shared.js** (65 lines)
   - Shared utilities and state management
   - Fully functional

2. **checkin.handler.js** (536 lines)  
   - All check-in functionality
   - Fully functional

3. **location.handler.js** (527 lines)
   - Location tracking and verification
   - Fully functional

4. **status.handler.js** (125 lines)
   - Status checking functionality
   - Fully functional

5. **index.js** (47 lines)
   - Main entry point with backward compatibility
   - Fully functional

### ⚠️ Pending Completion

**checkout.handler.js** (67 lines - placeholder)
- This file contains a placeholder with comprehensive documentation
- Requires manual completion due to complex text handler merging
- See the file itself for detailed extraction instructions

## Directory Structure

```
src/bot/handlers/
├── attendance.handler.js          # Original file (4,841 lines) - KEEP FOR NOW
└── attendance/                     # New modular structure
    ├── README.md                   # Module documentation
    ├── MIGRATION_GUIDE.md         # This file
    ├── index.js                    # Main entry point
    ├── shared.js                   # Shared utilities
    ├── checkin.handler.js         # Check-in handlers
    ├── checkout.handler.js        # Checkout handlers (PLACEHOLDER)
    ├── location.handler.js        # Location tracking
    └── status.handler.js          # Status display

```

## Usage Options

### Option 1: Continue Using Original (Current)

No changes needed. The original file still works:

```javascript
const { setupAttendanceHandlers } = require('./handlers/attendance.handler');
setupAttendanceHandlers(bot);
```

### Option 2: Partial Migration (Recommended for Testing)

Use the completed modules while keeping checkout in the original:

```javascript
const { setupCheckinHandlers } = require('./handlers/attendance/checkin.handler');
const { setupLocationHandler } = require('./handlers/attendance/location.handler');
const { handleStatus } = require('./handlers/attendance/status.handler');

// Setup completed modules
setupCheckinHandlers(bot);
setupLocationHandler(bot);

// Setup status handlers
bot.command('status', async (ctx) => await handleStatus(ctx));
bot.hears('📋 Мой статус', async (ctx) => await handleStatus(ctx));

// Still use original for checkout (until checkout.handler.js is completed)
// Extract and call only checkout setup from original file
```

### Option 3: Full Migration (After Completing checkout.handler.js)

Once checkout.handler.js is completed:

```javascript
const { setupAttendanceHandlers } = require('./handlers/attendance');
setupAttendanceHandlers(bot);
```

This will use all the new modular files instead of the original.

## Completing checkout.handler.js

The checkout handler is the most complex part of the original file (~2000 lines when complete).

### Why It's Complex

1. **Multiple Text Handlers**: The original file has 4 different `bot.on('text')` handlers that need to be merged
2. **Session States**: Multiple session state checks (`awaitingDepartureMessage`, `awaitingAbsentReason`, etc.)
3. **Async Contexts**: All handlers need proper async/await wrapping
4. **Nested Logic**: Deep nesting of conditionals and try-catch blocks

### Extraction Steps

1. **Copy the header** from the placeholder
2. **Extract button handlers** (lines 430-861, 1448-1891, 3244-3633)
3. **Extract action handlers** (lines 1522-1727)
4. **Combine text handlers** into a single `bot.on('text', async (ctx, next) => { ... })`
   - Lines 1170-1280: Departure message input
   - Lines 1284-1337: Absent reason input
   - Lines 1341-1441: Early departure reason input
   - Lines 1893-2063: Extend work input
   - Lines 3182-3241: Broadcast message input
   - Lines 3697-3769: Temp exit return input
5. **Ensure** all `if` blocks for session states are inside the async handler
6. **Test** thoroughly

### Verification Checklist

- [ ] All button handlers work (`🚪 Ухожу`, `🚫 Отсутствую`, etc.)
- [ ] All action handlers work (absent_reason, early_reason, etc.)
- [ ] Departure with message works (e.g., "- Going home")
- [ ] Early departure flow works
- [ ] Absent notification works
- [ ] Temporary exit works
- [ ] Return from temp exit works
- [ ] No syntax errors (`node -c checkout.handler.js`)
- [ ] No runtime errors in bot

## Testing Strategy

1. **Unit Testing**: Test each module independently
2. **Integration Testing**: Test cross-module functionality (check-in → location → checkout)
3. **Regression Testing**: Ensure all original functionality still works
4. **Edge Cases**: Test all session states and edge cases

## Rollback Plan

If issues arise:
1. Keep the original `attendance.handler.js` file intact
2. Revert to using the original file
3. Fix issues in modular files
4. Re-test before migration

## Benefits After Complete Migration

1. **Maintainability**: Each module is ~500 lines instead of 4,800
2. **Readability**: Clear separation of concerns
3. **Testability**: Individual modules can be unit tested
4. **Collaboration**: Multiple developers can work simultaneously
5. **Debugging**: Easier to locate and fix issues

## Timeline Estimate

- **checkout.handler.js completion**: 2-3 hours (careful extraction + testing)
- **Testing**: 1-2 hours (comprehensive testing)
- **Migration**: 15 minutes (update imports)
- **Total**: 3-5 hours

## Support

For questions or issues:
1. Refer to the inline documentation in each file
2. Check the README.md in the attendance/ directory
3. Compare with the original file sections listed in comments
4. Test incrementally, not all at once

## Important Notes

- **DO NOT DELETE** the original `attendance.handler.js` until fully migrated and tested
- All functionality must be preserved exactly (no behavior changes)
- State management (Maps) is shared via `shared.js`
- Location tracking is separated into `location.handler.js`
- The `index.js` maintains backward compatibility
