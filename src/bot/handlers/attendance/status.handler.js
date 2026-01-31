/**
 * Status checking functions for attendance
 */

const moment = require('moment-timezone');
const sheetsService = require('../../../services/sheets.service');
const CalculatorService = require('../../../services/calculator.service');
const Keyboards = require('../../keyboards/buttons');
const Config = require('../../../config');
const { getUserOrPromptRegistration } = require('./shared');

/**
 * Handle status command - show user's current status and statistics
 */
async function handleStatus(ctx) {
  const user = await getUserOrPromptRegistration(ctx);
  if (!user) return;

  // Get today's status
  const status = await sheetsService.getUserStatusToday(user.telegramId);

  // Get today's point from status
  const todayPoint = status.todayPoint || 0;

  // Determine emoji and message based on today's point
  let pointEmoji = '⚪';
  let pointMessage = 'Пока не отмечен';

  if (todayPoint >= 1.0) {
    pointEmoji = '🟢';
    if (status.isAbsent) {
      pointMessage = 'Отсутствие зафиксировано';
    } else if (status.lateNotified) {
      pointMessage = 'Опоздание предупреждено!';
    } else {
      pointMessage = 'Отличная работа!';
    }
  } else if (todayPoint > 0 && todayPoint < 1.0) {
    pointEmoji = '🟡';
    pointMessage = 'Небольшое нарушение';
  } else if (todayPoint === 0) {
    if (status.hasArrived) {
      pointEmoji = '🟢';
      pointMessage = 'Без нарушений';
    } else {
      pointEmoji = '⚪';
      pointMessage = 'Ожидается отметка';
    }
  } else if (todayPoint < 0) {
    if (todayPoint >= -0.5) {
      pointEmoji = '🟡';
      pointMessage = 'Небольшое нарушение';
    } else {
      pointEmoji = '🔴';
      pointMessage = 'Есть нарушения';
    }
  }

  const now = moment.tz(Config.TIMEZONE);

  let response = `📊 ВАШ СТАТУС\n\n`;

  response += `⏰ График работы: ${user.workTime}\n\n`;

  // Check if user is absent today
  if (status.isAbsent) {
    response += `🏠 Сегодня (${now.format('DD.MM.YYYY')}):\n`;
    response += `Вы отметили отсутствие\n\n`;
    response += `📊 Баллы сегодня: ${todayPoint} ${pointEmoji}\n`;
  } else {
    // Parse work schedule to calculate required hours
    const workTime = CalculatorService.parseWorkTime(user.workTime);
    let requiredMinutes = 0;
    let workedMinutes = 0;

    if (workTime) {
      requiredMinutes = workTime.end.diff(workTime.start, 'minutes');
    }

    // Calculate worked minutes if arrived
    if (status.hasArrived && status.arrivalTime) {
      const arrivalMoment = moment.tz(status.arrivalTime, 'HH:mm:ss', Config.TIMEZONE);
      if (status.hasDeparted && status.departureTime) {
        const departureMoment = moment.tz(status.departureTime, 'HH:mm:ss', Config.TIMEZONE);
        workedMinutes = departureMoment.diff(arrivalMoment, 'minutes');
      } else {
        // Still working - calculate current worked time
        workedMinutes = now.diff(arrivalMoment, 'minutes');
      }
    }

    response += `📅 Сегодня (${now.format('DD.MM.YYYY')}):\n`;
    response += `Отработано: ${CalculatorService.formatTimeDiff(workedMinutes)} / ${CalculatorService.formatTimeDiff(requiredMinutes)}\n\n`;
    response += `📊 Баллы сегодня: ${todayPoint} ${pointEmoji}\n`;
  }

  // Add monthly work hours summary
  const monthlyStats = await sheetsService.getMonthlyStats(user.telegramId);

  if (monthlyStats) {
    response += `\n⏱ За месяц (${now.format('MMMM').toUpperCase()}):\n`;
    response += `Отработано: ${CalculatorService.formatTimeDiff(Math.round(monthlyStats.totalHoursWorked * 60))} / ${CalculatorService.formatTimeDiff(Math.round(monthlyStats.totalHoursRequired * 60))}\n`;
    response += `Баллы: ${monthlyStats.totalPoints.toFixed(1)}\n`;
    response += `Рейтинг: ${monthlyStats.rating.toFixed(1)}/10 ${monthlyStats.ratingZone}`;
  } else {
    // Fallback if monthly stats not available
    const balance = await sheetsService.getMonthlyBalance(user.telegramId);
    response += `\n⏱ За месяц:\n`;

    const netBalance = balance.netBalanceMinutes;
    if (netBalance > 0) {
      response += `Баланс: +${CalculatorService.formatTimeDiff(netBalance)}`;
    } else if (netBalance < 0) {
      response += `Баланс: -${CalculatorService.formatTimeDiff(Math.abs(netBalance))}`;
    } else {
      response += `Баланс: 0 (норма)`;
    }
  }

  await ctx.reply(response, Keyboards.getMainMenu(ctx.from.id));
}

module.exports = {
  handleStatus
};
