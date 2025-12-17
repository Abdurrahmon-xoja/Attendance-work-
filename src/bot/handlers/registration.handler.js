/**
 * Registration handler for new users.
 * Implements the complete registration flow with Google Sheets matching.
 */

const { Scenes } = require('telegraf');
const sheetsService = require('../../services/sheets.service');
const CalculatorService = require('../../services/calculator.service');
const Keyboards = require('../keyboards/buttons');
const Config = require('../../config');
const logger = require('../../utils/logger');
const { sendBusyNotification } = require('../../utils/messageHelper');

// Create wizard scene for registration
const registrationWizard = new Scenes.WizardScene(
  'registration',
  // Step 1: Employee selection
  async (ctx) => {
    const unregistered = ctx.wizard.state.unregistered;

    if (!unregistered || unregistered.length === 0) {
      await ctx.reply(
        '❌ К сожалению, Вы не найдены в системе. Пожалуйста, обратитесь к администратору.\n\n' +
        `Ваши данные:\n` +
        `• Telegram ID: ${ctx.from.id}\n` +
        `• Username: @${ctx.from.username || 'не указан'}\n` +
        `• Имя: ${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`
      );

      // Notify admins
      await notifyAdminsAboutUnknownUser(ctx);
      return ctx.scene.leave();
    }

    await ctx.reply(
      '👋 Добро пожаловать в систему учёта посещаемости!\n\n' +
      'Пожалуйста, выберите Ваше имя из списка:',
      Keyboards.getEmployeeSelectionKeyboard(unregistered)
    );

    return ctx.wizard.next();
  },
  // Step 2: Confirmation
  async (ctx) => {
    if (!ctx.callbackQuery) return;

    const data = ctx.callbackQuery.data;

    if (data === 'select_employee:cancel') {
      await ctx.editMessageText('❌ Регистрация отменена. Если у Вас возникли вопросы, пожалуйста, обратитесь к администратору.');
      return ctx.scene.leave();
    }

    if (!data.startsWith('select_employee:')) return;

    const rowNumber = parseInt(data.split(':')[1]);
    const unregistered = ctx.wizard.state.unregistered;
    const employee = unregistered.find(e => e.rowNumber === rowNumber);

    if (!employee) {
      await ctx.editMessageText('❌ К сожалению, произошла ошибка: сотрудник не найден. Пожалуйста, попробуйте команду /start снова.');
      return ctx.scene.leave();
    }

    // Validate work time
    const workTime = CalculatorService.parseWorkTime(employee.workTime);
    if (!workTime) {
      await ctx.editMessageText(
        '❌ К сожалению, в расписании работы для этого сотрудника обнаружена ошибка.\n' +
        'Пожалуйста, обратитесь к администратору для исправления данных.\n\n' +
        `График в системе: ${employee.workTime}`
      );
      return ctx.scene.leave();
    }

    // Store selected employee
    ctx.wizard.state.selectedEmployee = employee;

    // Show confirmation
    const confirmationText =
      `👤 Имя: ${employee.nameFull}\n` +
      `🏢 Компания: ${employee.company}\n` +
      `⏰ График работы: ${employee.workTime}\n\n` +
      `Правильно ли указаны Ваши данные?`;

    await ctx.editMessageText(
      confirmationText,
      Keyboards.getConfirmationKeyboard('confirm_registration', 'cancel_registration')
    );

    return ctx.wizard.next();
  }
);

// Handle confirmation
registrationWizard.action('confirm_registration', async (ctx) => {
  const employee = ctx.wizard.state.selectedEmployee;

  if (!employee) {
    await ctx.editMessageText('❌ К сожалению, произошла ошибка: данные не найдены. Пожалуйста, попробуйте команду /start снова.');
    return ctx.scene.leave();
  }

  // Register employee
  const success = await sheetsService.registerEmployee(employee.rowNumber, ctx.from.id);

  if (success) {
    await ctx.editMessageText(
      `✅ Поздравляем! Регистрация успешно завершена!\n\n` +
      `👤 Имя: ${employee.nameFull}\n` +
      `🏢 Компания: ${employee.company}\n` +
      `⏰ График работы: ${employee.workTime}\n\n` +
      `Теперь Вы можете отмечать приход и уход.\n` +
      `Пожалуйста, используйте кнопки ниже или следующие команды:\n` +
      `• '+' - отметить приход\n` +
      `• '- сообщение' - отметить уход\n` +
      `• /status - проверить статус\n` +
      `• /help - справка`
    );

    await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu());

    logger.info(`Successfully registered user: ${ctx.from.id} as ${employee.nameFull}`);
  } else {
    await ctx.editMessageText(
      '❌ К сожалению, произошла ошибка при регистрации. Пожалуйста, попробуйте позже или обратитесь к администратору.'
    );
  }

  return ctx.scene.leave();
});

// Handle cancellation
registrationWizard.action('cancel_registration', async (ctx) => {
  const unregistered = ctx.wizard.state.unregistered;

  if (!unregistered || unregistered.length === 0) {
    await ctx.editMessageText('❌ Регистрация отменена. Пожалуйста, используйте команду /start для повтора.');
    return ctx.scene.leave();
  }

  // Show selection list again
  await ctx.editMessageText(
    'Пожалуйста, выберите Ваше имя из списка:',
    Keyboards.getEmployeeSelectionKeyboard(unregistered)
  );

  // Go back to step 2 (confirmation step)
  ctx.wizard.selectStep(1);
});

/**
 * Notify administrators about user not found in system
 */
async function notifyAdminsAboutUnknownUser(ctx) {
  const notification =
    '⚠️ НОВЫЙ ПОЛЬЗОВАТЕЛЬ НЕ НАЙДЕН В СИСТЕМЕ\n\n' +
    `• Telegram ID: ${ctx.from.id}\n` +
    `• Username: @${ctx.from.username || 'не указан'}\n` +
    `• Имя: ${ctx.from.first_name || ''} ${ctx.from.last_name || ''}\n\n` +
    `Пожалуйста, добавьте пользователя в Google Sheets (лист 'Roster')`;

  for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
    try {
      await ctx.telegram.sendMessage(adminId, notification);
    } catch (error) {
      logger.error(`Failed to notify admin ${adminId}: ${error.message}`);
    }
  }
}

/**
 * Setup registration handlers
 */
function setupRegistrationHandlers(bot) {
  // /start command
  bot.command('start', async (ctx) => {
    try {
      const telegramId = ctx.from.id;
      const username = ctx.from.username;
      const displayName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();

      logger.info(`Registration attempt: telegram_id=${telegramId}, username=${username}, display=${displayName}`);

      // Step 1: Check if already registered
      const employee = await sheetsService.findEmployeeByTelegramId(telegramId);
    if (employee) {
      // Check if admin
      const Config = require('../../config');
      const isAdmin = Config.ADMIN_TELEGRAM_IDS.includes(telegramId);
      const greeting = isAdmin ?
        `✅ Добро пожаловать, администратор!\n\n` :
        `✅ Вы уже зарегистрированы!\n\n`;

      await ctx.reply(
        greeting +
        `👤 Имя: ${employee.nameFull}\n` +
        `🏢 Компания: ${employee.company}\n` +
        `⏰ График работы: ${employee.workTime}` +
        (isAdmin ? `\n\n🔑 У вас есть доступ к админ-панели` : ''),
        Keyboards.getMainMenu(telegramId)
      );
      return;
    }

    // Step 2: Try to match by Telegram first name (PRIORITY 1)
    const firstName = ctx.from.first_name;
    if (firstName) {
      const employeeByName = await sheetsService.findEmployeeByTelegramName(firstName);
      if (employeeByName) {
        // Found by Telegram name - validate and register immediately
        const workTime = CalculatorService.parseWorkTime(employeeByName.workTime);
        if (!workTime) {
          await ctx.reply(
            '❌ К сожалению, в расписании работы для этого сотрудника обнаружена ошибка.\n' +
            'Пожалуйста, обратитесь к администратору для исправления данных.\n\n' +
            `График в системе: ${employeeByName.workTime}`
          );
          return;
        }

        // Register immediately without confirmation
        const success = await sheetsService.registerEmployee(employeeByName.rowNumber, telegramId);

        if (success) {
          const Config = require('../../config');
          const isAdmin = Config.ADMIN_TELEGRAM_IDS.includes(telegramId);

          await ctx.reply(
            `✅ Поздравляем! Успешно подключено!\n\n` +
            `👤 Имя: ${employeeByName.nameFull}\n` +
            `🏢 Компания: ${employeeByName.company}\n` +
            `⏰ График работы: ${employeeByName.workTime}\n\n` +
            `Теперь Вы можете отмечать приход и уход.\n` +
            `• '+' - отметить приход\n` +
            `• '- сообщение' - отметить уход\n` +
            `• /status - проверить статус` +
            (isAdmin ? `\n\n🔑 У Вас есть доступ к админ-панели` : ''),
            Keyboards.getMainMenu(telegramId)
          );

          logger.info(`Auto-registered by Telegram name: ${telegramId} as ${employeeByName.nameFull}`);
          return;
        } else {
          await ctx.reply('❌ К сожалению, произошла ошибка при регистрации. Пожалуйста, попробуйте позже.');
          return;
        }
      }
    }

    // Step 3: Try to match by username (PRIORITY 2)
    if (username) {
      const employeeByUsername = await sheetsService.findEmployeeByUsername(username);
      if (employeeByUsername) {
        // Found by username - validate and register immediately
        const workTime = CalculatorService.parseWorkTime(employeeByUsername.workTime);
        if (!workTime) {
          await ctx.reply(
            '❌ К сожалению, в расписании работы для этого сотрудника обнаружена ошибка.\n' +
            'Пожалуйста, обратитесь к администратору для исправления данных.\n\n' +
            `График в системе: ${employeeByUsername.workTime}`
          );
          return;
        }

        // Register immediately without confirmation
        const success = await sheetsService.registerEmployee(employeeByUsername.rowNumber, telegramId);

        if (success) {
          await ctx.reply(
            `✅ Поздравляем! Успешно подключено!\n\n` +
            `👤 Имя: ${employeeByUsername.nameFull}\n` +
            `🏢 Компания: ${employeeByUsername.company}\n` +
            `⏰ График работы: ${employeeByUsername.workTime}\n\n` +
            `Теперь Вы можете отмечать приход и уход.\n` +
            `• '+' - отметить приход\n` +
            `• '- сообщение' - отметить уход\n` +
            `• /status - проверить статус`,
            Keyboards.getMainMenu()
          );

          logger.info(`Auto-registered by username: ${telegramId} as ${employeeByUsername.nameFull}`);
          return;
        } else {
          await ctx.reply('❌ К сожалению, произошла ошибка при регистрации. Пожалуйста, попробуйте позже.');
          return;
        }
      }
    }

    // Step 3: Show list of unregistered employees
    const unregistered = await sheetsService.getUnregisteredEmployees();

    if (unregistered.length === 0) {
      await ctx.reply(
        '❌ К сожалению, Вы не найдены в системе. Пожалуйста, обратитесь к администратору.\n\n' +
        `Ваши данные:\n` +
        `• Telegram ID: ${telegramId}\n` +
        `• Username: @${username || 'не указан'}\n` +
        `• Имя: ${displayName}`
      );

      await notifyAdminsAboutUnknownUser(ctx);
      return;
    }

      // Enter registration wizard
      ctx.scene.enter('registration', { unregistered });
    } catch (error) {
      // Handle quota errors with a friendly message
      if (error.isQuotaError) {
        await sendBusyNotification(
          ctx,
          '⏳ В данный момент система перегружена, много сотрудников используют бот.\n\n' +
          'Пожалуйста, попробуйте команду /start снова через несколько секунд.'
        );
        return;
      }

      // Re-throw other errors
      throw error;
    }
  });

  // Handle auto-registration confirmation (by username)
  bot.action('confirm_auto_registration', async (ctx) => {
    const employee = ctx.session?.autoRegistrationEmployee;

    if (!employee) {
      await ctx.editMessageText('❌ К сожалению, произошла ошибка: данные не найдены. Пожалуйста, попробуйте команду /start снова.');
      return;
    }

    const success = await sheetsService.registerEmployee(employee.rowNumber, ctx.from.id);

    if (success) {
      await ctx.editMessageText(
        `✅ Поздравляем! Регистрация успешно завершена!\n\n` +
        `👤 Имя: ${employee.nameFull}\n` +
        `🏢 Компания: ${employee.company}\n` +
        `⏰ График работы: ${employee.workTime}\n\n` +
        `Теперь Вы можете отмечать приход и уход.\n` +
        `Пожалуйста, используйте кнопки ниже или следующие команды:\n` +
        `• '+' - отметить приход\n` +
        `• '- сообщение' - отметить уход\n` +
        `• /status - проверить статус\n` +
        `• /help - справка`
      );

      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu());

      logger.info(`Successfully registered user: ${ctx.from.id} as ${employee.nameFull}`);
      delete ctx.session.autoRegistrationEmployee;
    } else {
      await ctx.editMessageText(
        '❌ К сожалению, произошла ошибка при регистрации. Пожалуйста, попробуйте позже или обратитесь к администратору.'
      );
    }
  });

  // Handle auto-registration cancellation
  bot.action('cancel_auto_registration', async (ctx) => {
    await ctx.editMessageText('❌ Регистрация отменена. Пожалуйста, используйте команду /start для повтора.');
    delete ctx.session?.autoRegistrationEmployee;
  });

  // /help command
  bot.command('help', async (ctx) => {
    const helpText =
      '📖 СПРАВКА ПО ИСПОЛЬЗОВАНИЮ БОТА\n\n' +
      '🔹 ОСНОВНЫЕ КОМАНДЫ:\n' +
      '• /start - Регистрация\n' +
      '• /status - Мой статус\n' +
      '• /help - Эта справка\n\n' +
      '🔹 ОТМЕТКИ:\n' +
      '• \'+\' или кнопка \'✅ Пришёл\' - отметить приход\n' +
      '• \'- сообщение\' - отметить уход (пожалуйста, обязательно с сообщением!)\n' +
      '  Пример: \'- Иду домой\', \'- До завтра\'\n\n' +
      '🔹 ОПОЗДАНИЯ:\n' +
      `• Пожалуйста, используйте кнопку '🕒 Опоздаю' до ${Config.LATE_DEADLINE_TIME}\n` +
      `• Льготное время: ${Config.GRACE_PERIOD_MINUTES} минут\n` +
      '• При опоздании необходимо отработать дополнительное время\n\n' +
      '🔹 ДРУГИЕ ФУНКЦИИ:\n' +
      '• \'⏰ Работаю дольше\' - если остаётесь после графика\n' +
      '• \'🚫 Отсутствую\' - отметить отсутствие\n' +
      '• \'🧹 Я дежурный\' - меню дежурного\n\n' +
      '🔹 РЕЙТИНГ:\n' +
      `• Начальный балл: 10.0\n` +
      `• 🟢 Зелёная зона: ≥ ${Config.GREEN_ZONE_MIN}\n` +
      `• 🟡 Жёлтая зона: ${Config.YELLOW_ZONE_MIN} - ${Config.GREEN_ZONE_MIN - 0.1}\n` +
      `• 🔴 Красная зона: < ${Config.YELLOW_ZONE_MIN}\n\n` +
      '❓ Если у Вас возникли вопросы, пожалуйста, обратитесь к администратору.';

    await ctx.reply(helpText, Keyboards.getMainMenu());
  });
}

module.exports = {
  registrationWizard,
  setupRegistrationHandlers
};
