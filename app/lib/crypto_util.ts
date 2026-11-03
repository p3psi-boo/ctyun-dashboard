'use strict';

const crypto = require('crypto') as typeof import('crypto');

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex').toLowerCase();
}

function sha256(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex').toLowerCase();
}

function generateDeviceCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return 'web_' + s;
}

module.exports = { md5, sha256, generateDeviceCode };
