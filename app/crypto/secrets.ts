// @ts-nocheck
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { atomicWriteFileSync } = require('../lib/atomic_fs');
const { MASTER_KEY_FILE, MASTER_KEY_BAK_FILE } = require('../paths');
const { createLogger } = require('../logger');

const cryptoLog = createLogger('Crypto');

function getOrCreateMasterKey() {
  // 1. 优先从主密钥文件读取
  if (fs.existsSync(MASTER_KEY_FILE)) {
    try {
      const raw = fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
      if (raw.length === 64) {
        // 同步刷新备份密钥
        try { atomicWriteFileSync(MASTER_KEY_BAK_FILE, raw, 'utf8', 0o600); } catch (e) {}
        return Buffer.from(raw, 'hex');
      }
    } catch (e) {}
  }

  // 2. 主密钥损坏或丢失时，自动从备份密钥恢复
  if (fs.existsSync(MASTER_KEY_BAK_FILE)) {
    try {
      const raw = fs.readFileSync(MASTER_KEY_BAK_FILE, 'utf8').trim();
      if (raw.length === 64) {
        try { atomicWriteFileSync(MASTER_KEY_FILE, raw, 'utf8', 0o600); } catch (e) {}
        cryptoLog.warn('主密钥文件异常，已从备份密钥 .master.key.bak 恢复');
        return Buffer.from(raw, 'hex');
      }
    } catch (e) {}
  }

  // 3. 首次全新初始化：生成 32 字节主密钥并双写持久化
  const newKey = crypto.randomBytes(32);
  const hexKey = newKey.toString('hex');
  try {
    atomicWriteFileSync(MASTER_KEY_FILE, hexKey, 'utf8', 0o600);
    atomicWriteFileSync(MASTER_KEY_BAK_FILE, hexKey, 'utf8', 0o600);
  } catch (e) {}
  return newKey;
}

const masterKey = getOrCreateMasterKey();

function encryptPassword(plainText) {
  if (!plainText || typeof plainText !== 'string') return '';
  if (plainText.startsWith('ENC:')) return plainText; // 避免重复加密
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    let enc = cipher.update(plainText, 'utf8', 'hex');
    enc += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return 'ENC:' + iv.toString('hex') + ':' + authTag + ':' + enc;
  } catch (e) {
    return plainText;
  }
}

function decryptPassword(cipherText) {
  if (!cipherText || typeof cipherText !== 'string') return '';
  if (!cipherText.startsWith('ENC:')) return cipherText; // 兼容历史明文
  try {
    const parts = cipherText.split(':');
    if (parts.length !== 4) return cipherText;
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encrypted = parts[3];
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(authTag);
    let dec = decipher.update(encrypted, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch (e) {
    return cipherText;
  }
}

module.exports = { getOrCreateMasterKey, encryptPassword, decryptPassword, masterKey };
