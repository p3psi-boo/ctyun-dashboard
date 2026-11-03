'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

const PORT = parseInt(process.env.PORT, 10) || 8571;
const DATA_DIR = process.env.CTYUN_DATA_DIR || path.join(__dirname, '..', 'data');
const STATIC_DIR = path.join(__dirname, 'static');
const CONFIG_FILE = path.join(DATA_DIR, 'app_config.json');
const ACCOUNTS_JSON = path.join(DATA_DIR, 'accounts.json');
const DEVICES_DIR = path.join(DATA_DIR, 'devices');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const AUTH_SESSIONS_FILE = path.join(DATA_DIR, 'auth_sessions.json');
const MASTER_KEY_FILE = path.join(DATA_DIR, '.master.key');
const MASTER_KEY_BAK_FILE = path.join(DATA_DIR, '.master.key.bak');
const BOOT_LOG_LINES = Math.max(0, parseInt(process.env.CTYUN_LOG_BOOT_LINES, 10) || 400);

function ensureDataDirs(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DEVICES_DIR)) fs.mkdirSync(DEVICES_DIR, { recursive: true });
}

module.exports = {
  PORT,
  DATA_DIR,
  STATIC_DIR,
  CONFIG_FILE,
  ACCOUNTS_JSON,
  DEVICES_DIR,
  LOG_DIR,
  AUTH_SESSIONS_FILE,
  MASTER_KEY_FILE,
  MASTER_KEY_BAK_FILE,
  BOOT_LOG_LINES,
  ensureDataDirs,
};
