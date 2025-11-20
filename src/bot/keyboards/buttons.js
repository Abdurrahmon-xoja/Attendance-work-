/**
 * Keyboard layouts and buttons for the bot interface.
 */

const { Markup } = require('telegraf');

class Keyboards {
  /**
   * Get the main menu keyboard with attendance buttons
   * @param {number} userId - Telegram user ID to check if admin
   * @param {boolean} currentlyOut - Whether user is currently out temporarily
   * @returns {Object} Keyboard markup
   */
  static getMainMenu(userId = null, currentlyOut = false) {
    // Check if user is admin
    const Config = require('../../config');
    const isAdmin = userId && Config.ADMIN_TELEGRAM_IDS.includes(userId);

    if (isAdmin) {
      return this.getAdminMenu(currentlyOut);
    }

    // Build third row based on currently out status
    const thirdRow = currentlyOut
      ? ['↩️ Вернулся', '📋 Мой статус']
      : ['🚶 Выхожу временно', '📋 Мой статус'];

    return Markup.keyboard([
      ['✅ Пришёл', '🕒 Опоздаю', '🚫 Отсутствую'],
      ['🚪 Ухожу', '⏰ Работаю дольше'],
      thirdRow
    ]).resize();
  }

  /**
   * Get the admin menu keyboard with special admin buttons
   * @param {boolean} currentlyOut - Whether user is currently out temporarily
   * @returns {Object} Keyboard markup
   */
  static getAdminMenu(currentlyOut = false) {
    // Build temp exit row based on currently out status
    const tempExitRow = currentlyOut
      ? ['↩️ Вернулся']
      : ['🚶 Выхожу временно'];

    return Markup.keyboard([
      ['✅ Пришёл', '🕒 Опоздаю', '🚫 Отсутствую'],
      ['📋 Мой статус', '🚪 Ухожу', '⏰ Работаю дольше'],
      tempExitRow,
      ['📊 Отчёт за день', '📈 Отчёт за месяц'],
      ['📢 Отправить всем сообщение']
    ]).resize();
  }

  /**
   * Get keyboard for selecting how long person will be late
   * @returns {Object} Inline keyboard markup
   */
  static getLateReasonKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('⏳ 15 мин', 'late_duration:15'),
        Markup.button.callback('⏳ 30 мин', 'late_duration:30')
      ],
      [
        Markup.button.callback('⏳ 45 мин', 'late_duration:45'),
        Markup.button.callback('⏳ 1 час', 'late_duration:60')
      ],
      [
        Markup.button.callback('⏳ 2 часа', 'late_duration:120'),
        Markup.button.callback('⏳ 3 часа', 'late_duration:180')
      ],
      [Markup.button.callback('🔢 Другое время', 'late_duration:custom')],
      [Markup.button.callback('❌ Отмена', 'late_duration:cancel')]
    ]);
  }

  /**
   * Get numeric keyboard for entering custom late duration
   * @param {string} placeholder - Placeholder text for input field
   * @returns {Object} Regular keyboard markup
   */
  static getNumericKeyboard(placeholder = '30') {
    return Markup.keyboard([
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['7', '8', '9'],
      ['0', '⬅️ Удалить', '✅ Готово']
    ], { input_field_placeholder: placeholder }).resize();
  }

  /**
   * Get keyboard for selecting absence reason
   * @returns {Object} Inline keyboard markup
   */
  static getAbsentReasonKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🤒 Болею', 'absent_reason:sick')],
      [Markup.button.callback('👨‍👩‍👧 Семья', 'absent_reason:family')],
      [Markup.button.callback('✈️ Командировка', 'absent_reason:business_trip')],
      [Markup.button.callback('🧭 Личные дела', 'absent_reason:personal')],
      [Markup.button.callback('📝 Другая причина', 'absent_reason:other')],
      [Markup.button.callback('❌ Отмена', 'absent_reason:cancel')]
    ]);
  }

  /**
   * Get keyboard for selecting how long person will work extra
   * @returns {Object} Inline keyboard markup
   */
  static getExtendDurationKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('⏳ 15 мин', 'extend_duration:15'),
        Markup.button.callback('⏳ 30 мин', 'extend_duration:30')
      ],
      [
        Markup.button.callback('⏳ 45 мин', 'extend_duration:45'),
        Markup.button.callback('⏳ 1 час', 'extend_duration:60')
      ],
      [
        Markup.button.callback('⏳ 2 часа', 'extend_duration:120'),
        Markup.button.callback('⏳ 3 часа', 'extend_duration:180')
      ],
      [Markup.button.callback('🔢 Другое время', 'extend_duration:custom')],
      [Markup.button.callback('❌ Отмена', 'extend_duration:cancel')]
    ]);
  }

  /**
   * Get keyboard for selecting early departure reason
   * @returns {Object} Inline keyboard markup
   */
  static getEarlyDepartureReasonKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('👨‍👩‍👧 Семья', 'early_reason:family')],
      [Markup.button.callback('🏥 Здоровье', 'early_reason:health')],
      [Markup.button.callback('🧭 Личные дела', 'early_reason:personal')],
      [Markup.button.callback('🚗 Транспорт', 'early_reason:transport')],
      [Markup.button.callback('📝 Другая причина', 'early_reason:other')],
      [Markup.button.callback('❌ Отмена', 'early_reason:cancel')]
    ]);
  }

  /**
   * Get keyboard for selecting temporary exit duration
   * @returns {Object} Inline keyboard markup
   */
  static getTempExitDurationKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('⏱ 15 мин', 'temp_exit_duration:15'),
        Markup.button.callback('⏱ 30 мин', 'temp_exit_duration:30')
      ],
      [
        Markup.button.callback('⏱ 45 мин', 'temp_exit_duration:45'),
        Markup.button.callback('⏱ 1 час', 'temp_exit_duration:60')
      ],
      [
        Markup.button.callback('⏱ 1.5 часа', 'temp_exit_duration:90'),
        Markup.button.callback('⏱ 2 часа', 'temp_exit_duration:120')
      ],
      [Markup.button.callback('🔢 Другое время', 'temp_exit_duration:custom')],
      [Markup.button.callback('❌ Отмена', 'temp_exit_duration:cancel')]
    ]);
  }

  /**
   * Get keyboard for selecting temporary exit reason
   * @returns {Object} Inline keyboard markup
   */
  static getTempExitReasonKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🍽 Обед', 'temp_exit_reason:lunch')],
      [Markup.button.callback('🏥 Врач/Аптека', 'temp_exit_reason:medical')],
      [Markup.button.callback('🏦 Банк/Документы', 'temp_exit_reason:documents')],
      [Markup.button.callback('👨‍👩‍👧 Семейные дела', 'temp_exit_reason:family')],
      [Markup.button.callback('🚗 Транспорт', 'temp_exit_reason:transport')],
      [Markup.button.callback('🏗 Выхожу на обек', 'temp_exit_reason:object')],
      [Markup.button.callback('📝 Другая причина', 'temp_exit_reason:other')],
      [Markup.button.callback('❌ Отмена', 'temp_exit_reason:cancel')]
    ]);
  }

  /**
   * Get a yes/no confirmation keyboard
   * @param {string} confirmData - Callback data for confirmation
   * @param {string} cancelData - Callback data for cancellation
   * @returns {Object} Inline keyboard markup
   */
  static getConfirmationKeyboard(confirmData, cancelData = 'cancel') {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Да, это я', confirmData),
        Markup.button.callback('❌ Нет, это не я', cancelData)
      ]
    ]);
  }

  /**
   * Get keyboard for selecting employee from list
   * @param {Array} employees - List of employee objects
   * @returns {Object} Inline keyboard markup
   */
  static getEmployeeSelectionKeyboard(employees) {
    const buttons = employees.slice(0, 20).map((emp, idx) => {
      const name = emp.nameFull || 'Unknown';
      const company = emp.company || '';
      const buttonText = `${idx + 1}. ${name} (${company})`;

      return [Markup.button.callback(buttonText, `select_employee:${emp.rowNumber}`)];
    });

    buttons.push([Markup.button.callback('❌ Отмена', 'select_employee:cancel')]);

    return Markup.inlineKeyboard(buttons);
  }

  /**
   * Get keyboard for duty person menu
   * @returns {Object} Inline keyboard markup
   */
  static getDutyMenuKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('✅ Принял дежурство', 'duty:accept')],
      [Markup.button.callback('📋 Чек-лист задач', 'duty:checklist')],
      [Markup.button.callback('✅ Завершить дежурство', 'duty:complete')],
      [Markup.button.callback('❌ Закрыть', 'duty:close')]
    ]);
  }

  /**
   * Get force reply for text input with placeholder
   * @param {string} placeholder - Placeholder text for input field
   * @returns {Object} Force reply markup
   */
  static getTextInput(placeholder = 'Введите текст...') {
    return Markup.forceReply({ input_field_placeholder: placeholder });
  }

  /**
   * Remove keyboard (for inline responses)
   * @returns {Object} Remove keyboard markup
   */
  static removeKeyboard() {
    return Markup.removeKeyboard();
  }
}

module.exports = Keyboards;
