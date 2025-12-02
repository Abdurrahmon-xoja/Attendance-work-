/**
 * Test script for caring absence messages
 * Shows what employees will see for different absence reasons
 */

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function displayMessage(reason, reasonText, message) {
  log(`\n${'='.repeat(70)}`, colors.bright);
  log(`Absence Reason: ${reason}`, colors.bright + colors.cyan);
  log('='.repeat(70), colors.bright);

  const fullMessage = `✅ Ваше отсутствие зафиксировано.\n📋 Причина: ${reasonText}\n\n${message}`;

  log(`\n${fullMessage}`, colors.green);
  log('\n' + '='.repeat(70) + '\n', colors.bright);
}

log('\n' + '='.repeat(70), colors.bright);
log('CARING ABSENCE MESSAGES - PREVIEW', colors.bright + colors.magenta);
log('='.repeat(70) + '\n', colors.bright);

log('When employees report absence, they will receive warm, caring messages:\n', colors.cyan);

// Test all predefined reasons
const reasons = {
  'sick': {
    text: 'Болею',
    message: '🤒 Выздоравливайте скорее!\n\n💊 Берегите себя, отдыхайте и не волнуйтесь о работе.\n❤️ Желаем вам скорейшего выздоровления!'
  },
  'family': {
    text: 'Семейные обстоятельства',
    message: '👨‍👩‍👧 Семья - самое важное!\n\n❤️ Надеемся, что у всех всё хорошо.\n🤗 Берегите друг друга, мы вас ждём!'
  },
  'business_trip': {
    text: 'Командировка',
    message: '✈️ Удачной командировки!\n\n🌟 Желаем продуктивной поездки и новых достижений.\n🔙 До скорой встречи в офисе!'
  },
  'personal': {
    text: 'Личные дела',
    message: '🧭 Хорошего дня!\n\n🌟 Иногда нужно время для себя.\n😊 Надеемся скоро увидеть вас!'
  }
};

Object.entries(reasons).forEach(([code, data]) => {
  displayMessage(code.toUpperCase(), data.text, data.message);
});

// Test custom reasons with keyword detection
log('\n' + '='.repeat(70), colors.bright);
log('CUSTOM REASONS (with smart keyword detection)', colors.bright + colors.yellow);
log('='.repeat(70) + '\n', colors.bright);

const customReasons = [
  { input: 'Болею, температура 38', detected: 'Sick' },
  { input: 'Семейные обстоятельства', detected: 'Family' },
  { input: 'Командировка в Самарканд', detected: 'Business trip' },
  { input: 'Личные дела', detected: 'Personal' },
  { input: 'У врача', detected: 'Generic' }
];

customReasons.forEach(test => {
  const reasonLower = test.input.toLowerCase();
  let caringMessage = '🌟 Хорошего дня! Надеемся скоро увидеть вас!';
  let detectedType = 'Generic';

  if (reasonLower.includes('болею') || reasonLower.includes('больн') || reasonLower.includes('температур') || reasonLower.includes('простуд')) {
    caringMessage = '🤒 Выздоравливайте скорее!\n\n💊 Берегите себя, отдыхайте и не волнуйтесь о работе.\n❤️ Желаем вам скорейшего выздоровления!';
    detectedType = 'Sick';
  } else if (reasonLower.includes('семь') || reasonLower.includes('родст') || reasonLower.includes('родител')) {
    caringMessage = '👨‍👩‍👧 Семья - самое важное!\n\n❤️ Надеемся, что у всех всё хорошо.\n🤗 Берегите друг друга, мы вас ждём!';
    detectedType = 'Family';
  } else if (reasonLower.includes('команд') || reasonLower.includes('поезд') || reasonLower.includes('дело')) {
    caringMessage = '✈️ Удачной поездки!\n\n🌟 Желаем продуктивного времени.\n🔙 До скорой встречи!';
    detectedType = 'Business trip';
  } else if (reasonLower.includes('личн') || reasonLower.includes('дел')) {
    caringMessage = '🧭 Хорошего дня!\n\n🌟 Иногда нужно время для себя.\n😊 Надеемся скоро увидеть вас!';
    detectedType = 'Personal';
  }

  log(`\nUser types: "${test.input}"`, colors.cyan);
  log(`Detected as: ${detectedType}`, colors.yellow);
  displayMessage('CUSTOM', test.input, caringMessage);
});

log('\n' + '='.repeat(70), colors.bright);
log('SUMMARY', colors.bright + colors.magenta);
log('='.repeat(70), colors.bright);

log('\n✅ Features:', colors.green);
log('  • 4 predefined reasons with caring messages', colors.green);
log('  • Smart keyword detection for custom reasons', colors.green);
log('  • Contextual emoji and warm language', colors.green);
log('  • Shows empathy and understanding', colors.green);

log('\n🎯 Impact:', colors.blue);
log('  • Employees feel valued and cared for', colors.blue);
log('  • Reduces stress about taking time off', colors.blue);
log('  • Builds positive company culture', colors.blue);
log('  • Professional yet warm communication', colors.blue);

log('\n' + '='.repeat(70) + '\n', colors.bright);

process.exit(0);
