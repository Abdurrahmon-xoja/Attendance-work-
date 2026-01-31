# Deployment Checklist - Sheets Service Refactoring

## Pre-Deployment

- [x] All modular files created in `src/services/sheets/`
- [x] All syntax validated
- [x] Backward compatibility file created
- [x] Documentation created
- [x] Verification script created

## Deployment Steps

### Step 1: Backup Original File
```bash
cp src/services/sheets.service.js src/services/sheets.service.js.BACKUP
```

**Verify backup:**
```bash
ls -lh src/services/sheets.service.js.BACKUP
# Should show 2557 lines
wc -l src/services/sheets.service.js.BACKUP
```

### Step 2: Deploy New Version
```bash
cp src/services/sheets.service.js.NEW src/services/sheets.service.js
```

**Verify deployment:**
```bash
cat src/services/sheets.service.js
# Should show: module.exports = require('./sheets/index');
```

### Step 3: Test Application

#### 3.1 Basic Import Test
```bash
node -e "const service = require('./src/services/sheets/index'); console.log('Import OK');"
```

#### 3.2 Method Availability Test
```bash
node -e "
const service = require('./src/services/sheets.service');
console.log('connect:', typeof service.connect);
console.log('findEmployeeByTelegramId:', typeof service.findEmployeeByTelegramId);
console.log('initializeDailySheet:', typeof service.initializeDailySheet);
console.log('updateMonthlyReport:', typeof service.updateMonthlyReport);
"
```

#### 3.3 Start Application
```bash
npm start
# or
node src/index.js
```

**Check for:**
- [ ] No import errors
- [ ] Application starts successfully
- [ ] Connection to Google Sheets established
- [ ] Cache warmup completes

### Step 4: Integration Tests

Test each major function:

- [ ] **Roster Operations**
  - Test employee lookup by Telegram ID
  - Test employee registration
  - Test unregistered employees list

- [ ] **Daily Operations**
  - Test check-in (arrival)
  - Test check-out (departure)
  - Test status queries
  - Test daily sheet initialization

- [ ] **Monthly Operations**
  - Test monthly statistics
  - Test monthly balance calculation
  - Test monthly report update

- [ ] **Location Tracking**
  - Test arrival location update
  - Test departure location update
  - Test location verification

### Step 5: Monitor Logs

Watch for:
- [ ] No error messages related to sheets service
- [ ] Cache operations working correctly
- [ ] API quota usage normal
- [ ] All operations completing successfully

```bash
# Tail application logs
tail -f logs/combined.log
# or
pm2 logs
```

## Rollback Plan

If any issues occur:

### Quick Rollback
```bash
# Restore original file
cp src/services/sheets.service.js.BACKUP src/services/sheets.service.js

# Restart application
pm2 restart attendance-bot
# or
npm start
```

### Troubleshooting

**Issue: Import errors**
- Check file paths in require statements
- Verify all files in `src/services/sheets/` exist
- Check file permissions

**Issue: Method not found**
- Verify method is delegated in `index.js`
- Check method name spelling
- Review modular file for method existence

**Issue: Cache not working**
- Check cache manager initialization
- Verify cache properties are exposed in index.js
- Review warmupCache execution

## Post-Deployment

### Week 1: Monitor
- [ ] Check logs daily for any errors
- [ ] Monitor API quota usage
- [ ] Verify all features working as expected
- [ ] Collect user feedback

### Week 2: Cleanup
- [ ] If all stable, can remove backup file
- [ ] Update team documentation
- [ ] Share refactoring learnings with team

### Future: Optimize
- [ ] Consider adding unit tests for each module
- [ ] Add TypeScript definitions
- [ ] Extract more shared utilities
- [ ] Add performance monitoring

## Success Criteria

✅ Application starts without errors
✅ All attendance operations work correctly
✅ Monthly reports generate successfully
✅ No increase in API quota usage
✅ No user-reported issues
✅ Code is more maintainable

## Contacts

For issues or questions:
- Review: REFACTORING_SUMMARY.md
- Run: ./verify-refactoring.sh
- Check: Application logs

---

**Last Updated:** 2026-01-22
**Refactoring by:** Claude Code Agent
**Status:** ✅ Ready for Deployment
