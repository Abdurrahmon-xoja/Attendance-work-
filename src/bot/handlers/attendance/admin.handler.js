/**
 * Admin button handlers for attendance
 * Handles daily report, monthly report, and broadcast message buttons
 */

const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const sheetsService = require('../../../services/sheets.service');
const Keyboards = require('../../keyboards/buttons');
const Config = require('../../../config');
const logger = require('../../../utils/logger');

/**
 * Setup admin button handlers
 */
function setupAdminHandlers(bot) {
  // Admin command: Clear cache
  bot.command('clearcache', async (ctx) => {
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      return;
    }

    try {
      await ctx.reply('🔄 Очистка кэша Google Sheets...');
      sheetsService._invalidateCache();
      
      await ctx.reply('⏳ Загрузка свежих данных из таблиц...');
      // Warm up cache to make immediate subsequent operations fast
      await sheetsService.warmupCache();
      
      await ctx.reply('✅ Кэш успешно очищен и обновлен. Новые сотрудники добавленные в таблицу теперь доступны для регистрации.', Keyboards.getMainMenu(ctx.from.id));
      logger.info(`Admin ${ctx.from.id} manually cleared the cache`);
    } catch (error) {
      await ctx.reply(`❌ Ошибка при очистке кэша: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
      logger.error(`Error clearing cache: ${error.message}`);
    }
  });

  // Admin button: Daily report
  bot.hears('📊 Отчёт за день', async (ctx) => {
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      return;
    }

    try {
      const now = moment.tz(Config.TIMEZONE);
      const today = now.format('YYYY-MM-DD');

      await ctx.reply(`📊 Формирую дневной отчёт за ${today}...`);

      const worksheet = await sheetsService.getWorksheet(today);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      if (rows.length === 0) {
        await ctx.reply('📭 Нет данных за сегодня.', Keyboards.getMainMenu(ctx.from.id));
        return;
      }

      await generateAndSendDailyReport(ctx, today, now, rows);

    } catch (error) {
      await ctx.reply(`❌ Ошибка: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
      logger.error(`Error in daily report button: ${error.message}`);
    }
  });

  // Admin button: Monthly report
  bot.hears('📈 Отчёт за месяц', async (ctx) => {
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      return;
    }

    try {
      const now = moment.tz(Config.TIMEZONE);
      const yearMonth = now.format('YYYY-MM');
      const sheetName = `Report_${yearMonth}`;

      await ctx.reply(`📊 Формирую месячный отчёт за ${yearMonth}...`);
      logger.info(`Monthly report requested by admin ${ctx.from.id} for ${yearMonth}`);

      let worksheet = sheetsService.doc.sheetsByTitle[sheetName];

      if (!worksheet) {
        logger.warn(`Monthly report sheet ${sheetName} doesn't exist, creating...`);
        await ctx.reply(`⚙️ Создаю отчёт за ${yearMonth}...`);

        await sheetsService.initializeMonthlyReport(yearMonth);
        worksheet = sheetsService.doc.sheetsByTitle[sheetName];

        if (!worksheet) {
          throw new Error(`Не удалось создать лист отчёта ${sheetName}`);
        }
      }

      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      if (rows.length === 0) {
        await ctx.reply(
          '📭 Отчёт пуст.\n\n' +
          '💡 Отчёт обновляется автоматически каждый день.\n' +
          'Или используйте команду /updatereport для ручного обновления.',
          Keyboards.getMainMenu(ctx.from.id)
        );
        return;
      }

      await generateAndSendMonthlyReport(ctx, yearMonth, now, rows);

    } catch (error) {
      logger.error(`Error in monthly report button: ${error.message}`, error.stack);
      await ctx.reply(
        `❌ Ошибка при формировании отчёта: ${error.message}\n\n` +
        `Попробуйте команду /updatereport для обновления данных.`,
        Keyboards.getMainMenu(ctx.from.id)
      );
    }
  });

  // Admin button: Broadcast to all
  bot.hears('📢 Отправить всем сообщение', async (ctx) => {
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      return;
    }
    ctx.session = ctx.session || {};
    ctx.session.awaitingBroadcastMessage = true;
    ctx.session.broadcastTarget = 'all';
    await ctx.reply(
      '📢 Введите сообщение для ВСЕХ сотрудников:\n\nИли отправьте /cancel для отмены.',
      Keyboards.getTextInput('Ваше сообщение...')
    );
  });

  // Admin button: Broadcast to НО.UZ only
  bot.hears('📢 Сообщение → НО.UZ', async (ctx) => {
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      return;
    }
    ctx.session = ctx.session || {};
    ctx.session.awaitingBroadcastMessage = true;
    ctx.session.broadcastTarget = 'НО.UZ';
    await ctx.reply(
      '📢 Введите сообщение для сотрудников НО.UZ:\n\nИли отправьте /cancel для отмены.',
      Keyboards.getTextInput('Ваше сообщение...')
    );
  });

  // Admin button: Broadcast to Grace only
  bot.hears('📢 Сообщение → Grace', async (ctx) => {
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      return;
    }
    ctx.session = ctx.session || {};
    ctx.session.awaitingBroadcastMessage = true;
    ctx.session.broadcastTarget = 'Grace';
    await ctx.reply(
      '📢 Введите сообщение для сотрудников Grace:\n\nИли отправьте /cancel для отмены.',
      Keyboards.getTextInput('Ваше сообщение...')
    );
  });

  // Handle broadcast message input
  bot.on('text', async (ctx, next) => {
    if (ctx.session?.awaitingBroadcastMessage) {
      const message = ctx.message.text;
      const target = ctx.session.broadcastTarget || 'all';

      if (message === '/cancel') {
        ctx.session.awaitingBroadcastMessage = false;
        ctx.session.broadcastTarget = null;
        await ctx.reply('❌ Отправка отменена.', Keyboards.getMainMenu(ctx.from.id));
        return;
      }

      try {
        const targetLabel = target === 'all' ? 'всем сотрудникам' : `сотрудникам ${target}`;
        await ctx.reply(`📤 Отправляю сообщение ${targetLabel}...`);

        const rosterWorksheet = await sheetsService.getWorksheet(Config.SHEET_ROSTER);
        await rosterWorksheet.loadHeaderRow();
        const employees = await rosterWorksheet.getRows();

        let successCount = 0;
        let failCount = 0;

        for (const employee of employees) {
          const telegramId = (employee.get('Telegram Id') || '').toString().trim();
          if (!telegramId) continue;

          // Filter by company if a specific target is selected
          if (target !== 'all') {
            const company = (employee.get('Company') || '').trim();
            const isGrace = company.toLowerCase().includes('grace');
            if (target === 'Grace' && !isGrace) continue;
            if (target === 'НО.UZ' && isGrace) continue;
          }

          try {
            await bot.telegram.sendMessage(
              telegramId,
              `📢 Сообщение от администрации:\n\n${message}`
            );
            successCount++;
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (err) {
            logger.error(`Failed to send message to ${telegramId}: ${err.message}`);
            failCount++;
          }
        }

        await ctx.reply(
          `✅ Сообщение отправлено!\n\n` +
          `📬 Успешно: ${successCount}\n` +
          `❌ Ошибки: ${failCount}`,
          Keyboards.getMainMenu(ctx.from.id)
        );

        ctx.session.awaitingBroadcastMessage = false;
        ctx.session.broadcastTarget = null;
        logger.info(`Admin ${ctx.from.id} sent broadcast (${target}) to ${successCount} employees`);

      } catch (error) {
        await ctx.reply(`❌ Ошибка: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
        logger.error(`Error in broadcast: ${error.message}`);
        ctx.session.awaitingBroadcastMessage = false;
        ctx.session.broadcastTarget = null;
      }

      return;
    }

    return next();
  });
}

/**
 * Generate and send daily report as HTML file
 */
async function generateAndSendDailyReport(ctx, today, now, rows) {
  let presentCount = 0;
  let lateCount = 0;
  let absentCount = 0;
  let leftEarlyCount = 0;
  let notifiedLateCount = 0;

  let employeeRows = '';
  for (const row of rows) {
    const name = row.get('Name') || 'N/A';
    const cameOnTime = row.get('Came on time') || '';
    const whenCome = row.get('When come') || '';
    const leaveTime = row.get('Leave time') || '';
    const hoursWorked = row.get('Hours worked') || '0';
    const leftEarly = row.get('Left early') || '';
    const absent = row.get('Absent') || '';
    const whyAbsent = row.get('Why absent') || '';
    const willBeLate = row.get('will be late') || '';
    const willBeLateTime = row.get('will be late will come at') || '';
    const point = row.get('Point') || '0';
    const pointNum = parseFloat(point);

    let status = '';
    let statusClass = '';
    let pointClass = '';

    if (absent.toLowerCase() === 'yes' || absent.toLowerCase() === 'true') {
      status = `Отсутствует`;
      if (whyAbsent) status += ` (${whyAbsent})`;
      statusClass = 'status-absent';
      absentCount++;
    } else if (whenCome) {
      if (cameOnTime.toLowerCase() === 'no' || cameOnTime.toLowerCase() === 'false') {
        status = `Опоздал (${whenCome})`;
        statusClass = 'status-late';
        lateCount++;
      } else {
        status = `Вовремя (${whenCome})`;
        statusClass = 'status-ontime';
      }

      if (willBeLate.toLowerCase() === 'yes' || willBeLate.toLowerCase() === 'true') {
        status += `<br><small>⏰ Предупредил об опоздании`;
        if (willBeLateTime.trim()) {
          status += ` (${willBeLateTime})`;
        }
        status += `</small>`;
        notifiedLateCount++;
      }

      presentCount++;

      if (leaveTime) {
        status += `<br><small>Ушёл: ${leaveTime} (${hoursWorked}ч)`;
        if (leftEarly && leftEarly.toLowerCase().includes('yes')) {
          status += ` - Рано`;
          leftEarlyCount++;
        }
        status += `</small>`;
      }
    } else {
      status = `Не пришёл`;
      statusClass = 'status-notarrived';

      if (willBeLate.toLowerCase() === 'yes' || willBeLate.toLowerCase() === 'true') {
        status = `Ожидается`;
        if (willBeLateTime.trim()) {
          status += ` (${willBeLateTime})`;
        }
        statusClass = 'status-waiting';
        notifiedLateCount++;
      }
    }

    if (pointNum > 0) {
      pointClass = 'point-good';
    } else if (pointNum === 0) {
      pointClass = 'point-neutral';
    } else {
      pointClass = 'point-bad';
    }

    employeeRows += `
      <tr>
        <td data-label="Сотрудник">${name}</td>
        <td class="${statusClass}" data-label="Статус">${status}</td>
        <td class="${pointClass}" data-label="Баллы">${point}</td>
      </tr>
    `;
  }

  const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Дневной отчёт - ${today}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px;
      text-align: center;
    }
    .header h1 { font-size: 36px; margin-bottom: 10px; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
    .header .date { font-size: 20px; opacity: 0.9; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      padding: 30px;
      background: #f8f9fa;
    }
    .stat-card {
      background: white;
      padding: 25px;
      border-radius: 15px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      text-align: center;
    }
    .stat-card .number { font-size: 36px; font-weight: bold; margin-bottom: 10px; }
    .stat-card .label { color: #6c757d; font-size: 14px; }
    .stat-total .number { color: #667eea; }
    .stat-present .number { color: #10b981; }
    .stat-late .number { color: #f59e0b; }
    .stat-absent .number { color: #ef4444; }
    .stat-early .number { color: #8b5cf6; }
    .stat-notified .number { color: #3b82f6; }
    .table-container { padding: 30px; overflow-x: auto; }
    table { width: 100%; border-collapse: separate; border-spacing: 0 10px; }
    thead th {
      background: #667eea;
      color: white;
      padding: 15px;
      text-align: left;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 12px;
      letter-spacing: 1px;
    }
    thead th:first-child { border-radius: 10px 0 0 10px; }
    thead th:last-child { border-radius: 0 10px 10px 0; }
    tbody tr {
      background: white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    }
    tbody tr:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    tbody td {
      padding: 20px 15px;
      border-top: 1px solid #f1f3f5;
      border-bottom: 1px solid #f1f3f5;
    }
    tbody td:first-child {
      font-weight: 600;
      color: #2d3748;
      border-left: 1px solid #f1f3f5;
      border-radius: 10px 0 0 10px;
    }
    tbody td:last-child {
      border-right: 1px solid #f1f3f5;
      border-radius: 0 10px 10px 0;
      text-align: center;
      font-weight: bold;
      font-size: 18px;
    }
    .status-ontime { color: #10b981; font-weight: 500; }
    .status-late { color: #f59e0b; font-weight: 500; }
    .status-absent { color: #ef4444; font-weight: 500; }
    .status-notarrived { color: #94a3b8; font-weight: 500; }
    .status-waiting { color: #3b82f6; font-weight: 500; }
    .point-good { color: #10b981; }
    .point-neutral { color: #f59e0b; }
    .point-bad { color: #ef4444; }
    .footer {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      color: #6c757d;
      font-size: 14px;
    }
    @media (max-width: 600px) {
      body { padding: 10px; }
      .header { padding: 25px 15px; }
      .header h1 { font-size: 24px; }
      .header .date { font-size: 15px; }
      .stats {
        padding: 15px;
        gap: 10px;
        grid-template-columns: repeat(2, 1fr);
      }
      .stat-card { padding: 15px; }
      .stat-card .number { font-size: 26px; }
      .stat-card .label { font-size: 12px; }
      .table-container { padding: 10px; overflow-x: visible; }
      table, thead, tbody, tr, th, td { display: block; }
      thead { display: none; }
      tbody tr {
        margin-bottom: 12px;
        border-radius: 12px;
        padding: 5px 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        border-left: 4px solid #667eea;
      }
      tbody td {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
        border: none;
        border-radius: 0 !important;
        border-bottom: 1px solid #f1f3f5;
        text-align: right;
        font-size: 14px;
      }
      tbody td:last-child { border-bottom: none; }
      tbody td::before {
        content: attr(data-label);
        font-weight: 600;
        color: #667eea;
        text-align: left;
        margin-right: 10px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        flex-shrink: 0;
      }
      tbody td:first-child {
        border-left: none;
        font-size: 15px;
        padding-top: 10px;
      }
      tbody td:last-child {
        border-right: none;
        font-size: 18px;
        padding-bottom: 10px;
      }
      .footer { padding: 15px; font-size: 12px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Дневной отчёт</h1>
      <div class="date">${today} | ${now.format('HH:mm:ss')}</div>
    </div>
    <div class="stats">
      <div class="stat-card stat-total"><div class="number">${rows.length}</div><div class="label">Всего сотрудников</div></div>
      <div class="stat-card stat-present"><div class="number">${presentCount}</div><div class="label">Присутствуют</div></div>
      <div class="stat-card stat-late"><div class="number">${lateCount}</div><div class="label">Опоздали</div></div>
      <div class="stat-card stat-notified"><div class="number">${notifiedLateCount}</div><div class="label">Предупредили</div></div>
      <div class="stat-card stat-absent"><div class="number">${absentCount}</div><div class="label">Отсутствуют</div></div>
      <div class="stat-card stat-early"><div class="number">${leftEarlyCount}</div><div class="label">Ушли рано</div></div>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>Сотрудник</th><th>Статус</th><th>Баллы</th></tr></thead>
        <tbody>${employeeRows}</tbody>
      </table>
    </div>
    <div class="footer">Сгенерировано системой учёта посещаемости | ${now.format('DD.MM.YYYY HH:mm:ss')}</div>
  </div>
</body>
</html>
  `;

  const tempDir = path.join(__dirname, '../../../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filename = `daily_report_${today}.html`;
  const filepath = path.join(tempDir, filename);
  fs.writeFileSync(filepath, html, 'utf8');

  await ctx.replyWithDocument({ source: filepath, filename: filename }, {
    caption: `Дневной отчёт за ${today}\n\nПрисутствуют: ${presentCount}\nОпоздали: ${lateCount}\nОтсутствуют: ${absentCount}`
  });

  fs.unlinkSync(filepath);
}

/**
 * Build monthly report HTML for a group of rows
 */
function buildMonthlyHtml(groupRows, yearMonth, companyLabel, now) {
  // Extract all data from sheet rows into plain objects
  let excellentCount = 0, goodCount = 0, acceptableCount = 0, badCount = 0, unacceptableCount = 0;

  const employees = groupRows.map(row => {
    const rating         = row.get('Rating (0-10)') || '0';
    const totalPoints    = row.get('Total Points') || '0';
    const totalHoursWorked = row.get('Total Hours Worked') || '0';
    const daysWorked     = row.get('Days Worked') || '0';
    const daysAbsent     = row.get('Days Absent') || '0';
    const lateNotified   = parseInt(row.get('Late Arrivals (Notified)') || '0');
    const lateSilent     = parseInt(row.get('Late Arrivals (Silent)') || '0');
    const totalLate      = lateNotified + lateSilent;
    const daysWorkedNum  = parseInt(daysWorked) || 0;

    const ratingNum = parseFloat(rating);
    let zoneClass = 'zone-unacceptable';
    if (ratingNum >= Config.EXCELLENT_ZONE_MIN)       { zoneClass = 'zone-excellent'; excellentCount++; }
    else if (ratingNum >= Config.GOOD_ZONE_MIN)       { zoneClass = 'zone-good';      goodCount++; }
    else if (ratingNum >= Config.ACCEPTABLE_ZONE_MIN) { zoneClass = 'zone-acceptable'; acceptableCount++; }
    else if (ratingNum >= Config.BAD_ZONE_MIN)        { zoneClass = 'zone-bad';       badCount++; }
    else                                               {                               unacceptableCount++; }

    return {
      name:             row.get('Name') || 'N/A',
      totalWorkDays:    row.get('Total Work Days') || '0',
      daysWorked, daysAbsent,
      onTimeArrivals:   row.get('On Time Arrivals') || '0',
      totalLate,
      lateRate:         daysWorkedNum > 0 ? ((totalLate / daysWorkedNum) * 100).toFixed(1) : '0.0',
      totalHoursRequired: row.get('Total Hours Required') || '0',
      totalHoursWorked,
      attendanceRate:   row.get('Attendance Rate %') || '0',
      onTimeRate:       row.get('On-Time Rate %') || '0',
      rating, totalPoints, zoneClass,
      _rating:  ratingNum,
      _points:  parseFloat(totalPoints),
      _hours:   parseFloat(totalHoursWorked),
      _days:    parseInt(daysWorked),
      _absent:  parseInt(daysAbsent),
      _late:    totalLate,
    };
  });

  // Six pre-sorted orderings — each gets its own <tbody id="s-*">
  const sortDefs = [
    { id: 's-rating', data: [...employees].sort((a, b) => b._rating - a._rating || b._points - a._points || b._hours - a._hours) },
    { id: 's-hours',  data: [...employees].sort((a, b) => b._hours  - a._hours) },
    { id: 's-points', data: [...employees].sort((a, b) => b._points - a._points) },
    { id: 's-days',   data: [...employees].sort((a, b) => b._days   - a._days) },
    { id: 's-absent', data: [...employees].sort((a, b) => b._absent - a._absent) },
    { id: 's-late',   data: [...employees].sort((a, b) => b._late   - a._late) },
  ];

  const medals = ['&#x1F947;', '&#x1F948;', '&#x1F949;'];
  function buildTbody({ id, data }) {
    const rows = data.map((e, i) => `
      <tr class="${e.zoneClass}">
        <td class="rank" data-label="Место"><span class="td-val">${medals[i] || ''} ${i + 1}</span></td>
        <td class="name" data-label="Сотрудник"><span class="td-val">${e.name}</span></td>
        <td class="rating" data-label="Рейтинг"><span class="td-val"><strong>${e.rating}</strong>/10</span></td>
        <td data-label="Всего баллов"><span class="td-val">${e.totalPoints}</span></td>
        <td data-label="Дни работы"><span class="td-val">${e.daysWorked}/${e.totalWorkDays}</span></td>
        <td data-label="Вовремя"><span class="td-val">${e.onTimeArrivals}</span></td>
        <td data-label="Опоздания"><span class="td-val">${e.totalLate}</span></td>
        <td data-label="Часы"><span class="td-val">${e.totalHoursWorked}<br><small>из ${e.totalHoursRequired}</small></span></td>
        <td data-label="Отсутствия"><span class="td-val">${e.daysAbsent}</span></td>
      </tr>`).join('');
    return `<tbody id="${id}" class="sort-body">${rows}</tbody>`;
  }
  const allTbodies = sortDefs.map(buildTbody).join('');

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Месячный отчёт - ${yearMonth} - ${companyLabel}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px; min-height: 100vh;
    }
    .container {
      max-width: 1400px; margin: 0 auto; background: white;
      border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white; padding: 40px; text-align: center;
    }
    .header h1 { font-size: 42px; margin-bottom: 10px; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
    .header .date { font-size: 20px; opacity: 0.9; }
    .legend {
      display: flex; flex-direction: column; gap: 12px;
      padding: 30px; background: #f8f9fa; max-width: fit-content; margin: 0 auto;
    }
    .legend-item { display: flex; align-items: center; gap: 12px; font-size: 16px; }
    .legend-badge { width: 20px; height: 20px; border-radius: 50%; }
    .badge-excellent { background: #10b981; }
    .badge-good { background: #3b82f6; }
    .badge-acceptable { background: #f59e0b; }
    .badge-bad { background: #f97316; }
    .badge-unacceptable { background: #ef4444; }
    /* ── Sort bar (works on all browsers — pure anchor links, no JS) ── */
    .sort-bar {
      display: flex; flex-wrap: wrap; gap: 8px;
      padding: 16px 30px; background: #f0f1ff; border-bottom: 1px solid #d9ddf5;
      align-items: center;
    }
    .sort-bar-label {
      font-size: 11px; font-weight: 700; color: #6c757d;
      text-transform: uppercase; letter-spacing: 0.5px; width: 100%;
    }
    a.sort-btn {
      padding: 7px 14px; border: 1.5px solid #667eea; border-radius: 20px;
      background: white; color: #667eea; font-size: 13px; font-weight: 600;
      text-decoration: none; white-space: nowrap;
    }
    /* Active button highlight via CSS :has() — no JS needed */
    body:not(:has(.sort-body:target)) a[href="#s-rating"],
    body:has(#s-rating:target)  a[href="#s-rating"],
    body:has(#s-hours:target)   a[href="#s-hours"],
    body:has(#s-points:target)  a[href="#s-points"],
    body:has(#s-days:target)    a[href="#s-days"],
    body:has(#s-absent:target)  a[href="#s-absent"],
    body:has(#s-late:target)    a[href="#s-late"]  { background: #667eea; color: white; }
    /* ── Pre-sorted table bodies — only the targeted one is shown ── */
    .sort-body { display: none; }
    #s-rating { display: table-row-group; }        /* default */
    .sort-body:target { display: table-row-group; }
    body:has(#s-hours:target)  #s-rating,
    body:has(#s-points:target) #s-rating,
    body:has(#s-days:target)   #s-rating,
    body:has(#s-absent:target) #s-rating,
    body:has(#s-late:target)   #s-rating { display: none; }
    /* ── Table ── */
    .table-container { padding: 30px; overflow-x: auto; }
    table { width: 100%; border-collapse: separate; border-spacing: 0 8px; }
    thead th {
      background: #667eea; color: white; padding: 15px 8px;
      text-align: center; font-weight: 600; text-transform: uppercase;
      font-size: 11px; letter-spacing: 0.5px;
    }
    thead th:first-child { border-radius: 10px 0 0 10px; text-align: left; padding-left: 15px; }
    thead th:last-child { border-radius: 0 10px 10px 0; }
    tbody tr { background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
    tbody tr:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    tbody td {
      padding: 18px 8px; text-align: center;
      border-top: 1px solid #f1f3f5; border-bottom: 1px solid #f1f3f5; font-size: 14px;
    }
    tbody td:first-child { border-left: 1px solid #f1f3f5; border-radius: 10px 0 0 10px; text-align: left; padding-left: 15px; }
    tbody td:last-child { border-right: 1px solid #f1f3f5; border-radius: 0 10px 10px 0; }
    .rank { font-weight: bold; font-size: 16px; color: #667eea; }
    .name { font-weight: 600; color: #2d3748; text-align: left !important; font-size: 15px; }
    .rating { font-size: 18px; font-weight: bold; }
    .zone-excellent { border-left: 4px solid #10b981; }
    .zone-excellent .rating { color: #10b981; }
    .zone-good { border-left: 4px solid #3b82f6; }
    .zone-good .rating { color: #3b82f6; }
    .zone-acceptable { border-left: 4px solid #f59e0b; }
    .zone-acceptable .rating { color: #f59e0b; }
    .zone-bad { border-left: 4px solid #f97316; }
    .zone-bad .rating { color: #f97316; }
    .zone-unacceptable { border-left: 4px solid #ef4444; }
    .zone-unacceptable .rating { color: #ef4444; }
    small { color: #6c757d; font-size: 11px; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px; }
    @media (max-width: 768px) {
      body { padding: 10px; }
      .header { padding: 25px 15px; }
      .header h1 { font-size: 24px; }
      .header .date { font-size: 15px; }
      .legend { padding: 20px; gap: 10px; width: 100%; box-sizing: border-box; }
      .legend-item { font-size: 14px; }
      .legend-badge { width: 16px; height: 16px; }
      .sort-bar { padding: 12px 10px; }
      a.sort-btn { font-size: 12px; padding: 6px 11px; }
      .table-container { padding: 10px; overflow-x: visible; }
      table, thead, tbody, tr, th, td { display: block; }
      thead { display: none; }
      tbody tr {
        margin-bottom: 15px; border-radius: 12px; padding: 12px 15px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1); border-left-width: 5px !important; background: white;
      }
      tbody td {
        display: flex; justify-content: space-between; align-items: center;
        padding: 6px 0; border: none !important; border-radius: 0 !important;
        border-bottom: 1px solid #f1f3f5 !important; text-align: right !important; font-size: 14px;
      }
      tbody td:last-child { border-bottom: none !important; }
      tbody td::before {
        content: attr(data-label); font-weight: 600; color: #667eea;
        text-align: left; margin-right: 10px; font-size: 11px;
        text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0;
      }
      .td-val { text-align: right; display: flex; flex-direction: column; align-items: flex-end; }
      .rating .td-val { flex-direction: row; gap: 2px; align-items: center; }
      tbody td:first-child { border-left: none !important; padding-left: 0 !important; padding-top: 8px; }
      tbody td:last-child { border-right: none !important; padding-bottom: 8px; }
      .name { text-align: right !important; font-size: 15px; }
      .name .td-val { align-items: flex-end; }
      .rank { font-size: 15px; }
      .rating { font-size: 16px !important; }
      .footer { padding: 15px; font-size: 12px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Месячный отчёт — ${companyLabel}</h1>
      <div class="date">${yearMonth} | Сгенерировано ${now.format('DD.MM.YYYY HH:mm')}</div>
    </div>

    <div class="legend">
      <div class="legend-item"><div class="legend-badge badge-excellent"></div><span><strong>Отлично:</strong> 10 баллов</span></div>
      <div class="legend-item"><div class="legend-badge badge-good"></div><span><strong>Хорошо:</strong> 8-9.9 баллов</span></div>
      <div class="legend-item"><div class="legend-badge badge-acceptable"></div><span><strong>Допустимо:</strong> 5-7.9 баллов</span></div>
      <div class="legend-item"><div class="legend-badge badge-bad"></div><span><strong>Плохо:</strong> 3-4.9 баллов</span></div>
      <div class="legend-item"><div class="legend-badge badge-unacceptable"></div><span><strong>Недопустимо:</strong> &lt;3 баллов</span></div>
    </div>

    <div class="sort-bar">
      <span class="sort-bar-label">Сортировать по:</span>
      <a href="#s-rating" class="sort-btn">Рейтинг</a>
      <a href="#s-hours"  class="sort-btn">Часы</a>
      <a href="#s-points" class="sort-btn">Баллы</a>
      <a href="#s-days"   class="sort-btn">Дни</a>
      <a href="#s-absent" class="sort-btn">Отсутствия</a>
      <a href="#s-late"   class="sort-btn">Опоздания</a>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Место</th>
            <th>Сотрудник</th>
            <th>Рейтинг</th>
            <th>Всего баллов</th>
            <th>Дни работы</th>
            <th>Вовремя</th>
            <th>Опоздания</th>
            <th>Часы</th>
            <th>Отсутствия</th>
          </tr>
        </thead>
        ${allTbodies}
      </table>
    </div>

    <div class="footer">
      Сгенерировано системой учёта посещаемости | ${now.format('DD.MM.YYYY HH:mm:ss')}
    </div>
  </div>
</body>
</html>`;

  return { html, excellentCount, goodCount, acceptableCount, badCount, unacceptableCount };
}

/**
 * Generate and send monthly report as two HTML files split by company
 */
async function generateAndSendMonthlyReport(ctx, yearMonth, now, rows) {
  // Split rows by company
  const groups = { 'НО.UZ': [], 'Grace': [] };
  for (const row of rows) {
    const company = (row.get('Company') || '').trim();
    if (company.toLowerCase().includes('grace')) {
      groups['Grace'].push(row);
    } else {
      groups['НО.UZ'].push(row);
    }
  }

  const tempDir = path.join(__dirname, '../../../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const reportGroups = [
    { key: 'НО.UZ', label: 'НО.UZ' },
    { key: 'Grace', label: 'Grace' }
  ];

  for (const group of reportGroups) {
    const groupRows = groups[group.key];
    if (groupRows.length === 0) continue;

    const { html, excellentCount, goodCount, acceptableCount, badCount, unacceptableCount } =
      buildMonthlyHtml(groupRows, yearMonth, group.label, now);

    const safeName = group.label.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `monthly_report_${yearMonth}_${safeName}.html`;
    const filepath = path.join(tempDir, filename);
    fs.writeFileSync(filepath, html, 'utf8');

    await ctx.replyWithDocument({ source: filepath, filename }, {
      caption: `Месячный отчёт за ${yearMonth} — ${group.label}\n\nОтлично: ${excellentCount}\nХорошо: ${goodCount}\nДопустимо: ${acceptableCount}\nПлохо: ${badCount}\nНедопустимо: ${unacceptableCount}`
    });

    fs.unlinkSync(filepath);
  }
}

module.exports = {
  setupAdminHandlers
};
