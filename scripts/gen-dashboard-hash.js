#!/usr/bin/env node
// gen-dashboard-hash.js
//
// Generates a scrypt hash + random salt from a plaintext password.
// Run once locally to produce the values for DASHBOARD_PASSWORD_HASH
// and DASHBOARD_PASSWORD_SALT in your Railway environment:
//
//   node scripts/gen-dashboard-hash.js
//
// Then paste the printed values into Railway's environment variable settings.
// Never commit the plaintext password or the .env file.

'use strict';

const { scryptSync, randomBytes } = require('node:crypto');
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Enter new dashboard password: ', (password) => {
  rl.close();

  if (!password || password.length < 8) {
    console.error('Error: password must be at least 8 characters.');
    process.exit(1);
  }

  const salt = randomBytes(16).toString('hex'); // 32-char hex string
  const hash = scryptSync(password, salt, 64).toString('hex'); // 128-char hex string

  console.log('\n--- Copy these into Railway environment variables ---\n');
  console.log(`DASHBOARD_PASSWORD_HASH=${hash}`);
  console.log(`DASHBOARD_PASSWORD_SALT=${salt}`);
  console.log('\n----------------------------------------------------');
  console.log('The plaintext password has NOT been saved anywhere.');
});
