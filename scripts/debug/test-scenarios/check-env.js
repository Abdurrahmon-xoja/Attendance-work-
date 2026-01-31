#!/usr/bin/env node
/**
 * Quick script to check which environment is currently active
 * Run: node check-env.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 CURRENT ENVIRONMENT CONFIGURATION');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Check if .env exists
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.log('❌ No .env file found!');
  console.log('\nRun one of these commands first:');
  console.log('  npm run prod   (for production)');
  console.log('  npm run test   (for test)\n');
  process.exit(1);
}

// Load environment variables
const NODE_ENV = process.env.NODE_ENV || 'unknown';
const BOT_TOKEN = process.env.BOT_TOKEN || 'not set';
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || 'not set';
const PORT = process.env.PORT || 'not set';

// Determine which environment based on NODE_ENV and BOT_TOKEN
let environment = 'UNKNOWN';
let environmentIcon = '❓';

if (NODE_ENV === 'production' && BOT_TOKEN.startsWith('8592139001')) {
  environment = 'PRODUCTION';
  environmentIcon = '🔴';
} else if (NODE_ENV === 'development' || NODE_ENV === 'test') {
  environment = 'TEST';
  environmentIcon = '🟢';
} else if (NODE_ENV === 'production') {
  environment = 'PRODUCTION (?)';
  environmentIcon = '🟡';
}

console.log(`${environmentIcon} Environment: ${environment}`);
console.log(`📝 NODE_ENV: ${NODE_ENV}`);
console.log(`🤖 Bot Token: ${BOT_TOKEN.substring(0, 15)}...`);
console.log(`📊 Google Sheet: ${GOOGLE_SHEETS_ID.substring(0, 25)}...`);
console.log(`🔌 Port: ${PORT}`);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Check which source files exist
console.log('\n📁 Available configuration files:');
const prodExists = fs.existsSync(path.join(__dirname, '.env.production'));
const testExists = fs.existsSync(path.join(__dirname, '.env.test'));

console.log(`  ${prodExists ? '✅' : '❌'} .env.production`);
console.log(`  ${testExists ? '✅' : '❌'} .env.test`);

console.log('\n💡 To switch environments:');
console.log('  npm run prod   → Switch to PRODUCTION');
console.log('  npm run test   → Switch to TEST\n');

// Show comparison
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 ENVIRONMENT COMPARISON');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('Aspect          Production              Test');
console.log('─────────────────────────────────────────────────');
console.log('Bot Token       8592139001:AAE...       Your test token');
console.log('Google Sheet    Production sheet        Test sheet copy');
console.log('Port            3000                    3001');
console.log('Auto-reload     No                      Yes (nodemon)');
console.log('Log Level       info                    debug');
console.log('NODE_ENV        production              development');
console.log('\n');
