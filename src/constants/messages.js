/**
 * Message templates and text constants
 * All user-facing messages and notifications
 */

module.exports = {
  // Status Messages
  STATUS: {
    ON_TIME: 'Вовремя',
    ON_TIME_EN: 'On time',
    LATE_NOTIFIED: 'Опоздал (уведомил)',
    LATE_NOTIFIED_EN: 'Late (notified)',
    LATE_SILENT: 'Опоздал (не уведомил)',
    LATE_SILENT_EN: 'Late (silent)',
    ABSENT_NOTIFIED: 'Не пришел (уведомил)',
    ABSENT_NOTIFIED_EN: 'Absent (notified)',
    ABSENT_SILENT: 'Не пришел (не уведомил)',
    ABSENT_SILENT_EN: 'Absent (silent)',
    NO_SHOW: 'Не явился',
    NO_SHOW_EN: 'No-show'
  },

  // Welcome and Registration
  WELCOME: '👋 Добро пожаловать в систему учета рабочего времени!',
  REGISTER_PROMPT: '❌ К сожалению, Вы не зарегистрированы в системе.\nПожалуйста, используйте команду /start для регистрации.',
  REGISTER_SUCCESS: '✅ Регистрация успешно завершена!',
  REGISTER_ALREADY: '⚠️ Вы уже зарегистрированы в системе.',

  // Check-in Messages
  CHECKIN_SUCCESS: '✅ Приход зарегистрирован!',
  CHECKIN_ALREADY: '⚠️ Вы уже отметили приход сегодня.',
  CHECKIN_ON_TIME: '✅ Отлично! Вы пришли вовремя.',
  CHECKIN_LATE_NOTIFIED: '⏰ Вы опоздали, но уведомили заранее.',
  CHECKIN_LATE_SILENT: '❌ Вы опоздали и не уведомили.',

  // Check-out Messages
  CHECKOUT_SUCCESS: '✅ Уход зарегистрирован!',
  CHECKOUT_NOT_CHECKED_IN: '❌ Вы не отметили приход сегодня.',
  CHECKOUT_ALREADY: '⚠️ Вы уже отметили уход сегодня.',
  CHECKOUT_EARLY: '⚠️ Внимание! Вы уходите раньше положенного времени.',
  CHECKOUT_NO_MESSAGE: '⚠️ Пожалуйста, укажите причину раннего ухода.',

  // System Messages
  BUSY_NOTIFICATION: '🔄 Система временно занята. Пожалуйста, попробуйте через несколько секунд.',
  ERROR_GENERIC: '❌ Произошла ошибка. Пожалуйста, попробуйте позже.',
  ERROR_QUOTA: '⏳ Превышен лимит запросов к Google Sheets. Повторная попытка через несколько секунд...',
  SUCCESS: '✅ Операция выполнена успешно!',

  // Location Messages
  LOCATION_REQUEST_CHECKIN: '📍 Пожалуйста, отправьте вашу геолокацию для регистрации прихода.',
  LOCATION_REQUEST_CHECKOUT: '📍 Пожалуйста, отправьте вашу геолокацию для регистрации ухода.',
  LOCATION_OUTSIDE_GEOFENCE: '❌ Вы находитесь вне офисной зоны. Регистрация невозможна.',
  LOCATION_POOR_ACCURACY: '⚠️ Точность GPS слишком низкая. Попробуйте еще раз.',
  LOCATION_TIMEOUT: '⏱️ Время ожидания геолокации истекло.',

  // Reminder Messages
  REMINDER_ARRIVAL_SOON: '⏰ Напоминание: через 5 минут начало рабочего дня!',
  REMINDER_ARRIVAL_NOW: '🏢 Время прихода! Не забудьте отметиться.',
  REMINDER_LATE: '⚠️ Вы опаздываете! Пожалуйста, уведомите HR.',
  REMINDER_DEPARTURE_SOON: '🏁 Напоминание: через 10 минут конец рабочего дня.',
  REMINDER_DEPARTURE_NOW: '👋 Время ухода! Не забудьте отметить уход.',
  REMINDER_EXTENDED_WORK: '⏰ Вы работаете дольше обычного. Не забудьте отметить уход.',

  // Auto-departure Messages
  AUTO_DEPARTURE_WARNING: '⚠️ Внимание! Через {minutes} минут будет автоматически зарегистрирован уход без сообщения.',
  AUTO_DEPARTURE_EXECUTED: '🤖 Автоматически зарегистрирован уход (вы не отметили уход вовремя).',

  // Sent to the last person still checked in at an office when they leave.
  // {office} is the office name from the daily sheet's "Location Name" column.
  LAST_LEAVER: '🔑 Вы уходите последним{office}.\n\n' +
    'Пожалуйста, проверьте перед уходом:\n' +
    '• 💡 свет\n' +
    '• ❄️ кондиционеры\n' +
    '• 🪟 окна\n' +
    '• 🚪 закрыта ли дверь\n\n' +
    'Спасибо и хорошего вечера! 👋',

  // Daily Report
  DAILY_REPORT_HEADER: '📊 Ежедневный отчет за {date}',
  DAILY_REPORT_NO_DATA: 'Нет данных за сегодня.',

  // Rating Messages
  RATING_IMPROVED: '📈 Ваш рейтинг улучшился!',
  RATING_DECREASED: '📉 Ваш рейтинг снизился.',
  RATING_GREEN_ZONE: '🟢 Отличная работа! Вы в зеленой зоне.',
  RATING_YELLOW_ZONE: '🟡 Внимание! Вы в желтой зоне.',
  RATING_RED_ZONE: '🔴 Критично! Вы в красной зоне.',

  // Command Descriptions
  COMMANDS: {
    START: '🏁 Начать работу / Регистрация',
    STATUS: '📊 Мой статус и рейтинг',
    HELP: '❓ Помощь',
    CANCEL: '❌ Отмена',
    CHECKIN: '➕ Отметить приход',
    CHECKOUT: '➖ Отметить уход'
  },

  // Button Labels
  BUTTONS: {
    CHECKIN: '➕ Приход',
    CHECKOUT: '➖ Уход',
    STATUS: '📊 Статус',
    SEND_LOCATION: '📍 Отправить геолокацию',
    CANCEL: '❌ Отмена',
    CONFIRM: '✅ Подтвердить'
  },

  // Error Messages
  ERRORS: {
    NOT_REGISTERED: 'Пользователь не зарегистрирован',
    ALREADY_CHECKED_IN: 'Уже отмечен приход',
    ALREADY_CHECKED_OUT: 'Уже отмечен уход',
    NOT_CHECKED_IN: 'Не отмечен приход',
    INVALID_LOCATION: 'Неверная геолокация',
    QUOTA_EXCEEDED: 'Превышен лимит запросов',
    NETWORK_ERROR: 'Ошибка сети',
    UNKNOWN_ERROR: 'Неизвестная ошибка'
  },

  // Emojis
  EMOJIS: {
    SUCCESS: '✅',
    ERROR: '❌',
    WARNING: '⚠️',
    INFO: 'ℹ️',
    CLOCK: '⏰',
    LOCATION: '📍',
    CHART: '📊',
    TROPHY: '🏆',
    STAR: '⭐',
    THUMBS_UP: '👍',
    THUMBS_DOWN: '👎',
    FIRE: '🔥',
    HOURGLASS: '⏳',
    CHECK_MARK: '✓',
    CROSS_MARK: '✗'
  }
};
