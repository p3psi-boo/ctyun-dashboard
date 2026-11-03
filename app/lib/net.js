'use strict';

const net = require('net');

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isPrivateIpOrHost(hostname) {
  const h = (hostname || '').toLowerCase().trim();
  if (!h) return true;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;

  if (net.isIPv4(h)) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 0) return true;
  }

  if (net.isIPv6(h)) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80:')) return true;
    if (h.startsWith('fc00:') || h.startsWith('fd00:')) return true;
  }

  return false;
}

function isValidWebhookTarget(channel, rawTarget) {
  if (!rawTarget || typeof rawTarget !== 'string') return false;
  const target = rawTarget.trim();
  if (!target) return false;

  const ch = channel || 'webhook';
  if (ch === 'serverchan' || ch === 'pushplus') {
    return /^[\w\-]{6,128}$/.test(target);
  }
  if (ch === 'telegram') {
    return /^[\w\-:]+@[\w\-]+$/.test(target);
  }

  if (ch === 'dingtalk' && /^[a-zA-Z0-9_\-]{32,128}$/.test(target)) {
    return true;
  }

  try {
    const checkUrl = target.split('@SEC')[0].trim();
    const u = new URL(checkUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isPrivateIpOrHost(u.hostname)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function isValidWebhookUrl(rawUrl) {
  return isValidWebhookTarget('webhook', rawUrl);
}

module.exports = {
  fetchWithTimeout,
  isPrivateIpOrHost,
  isValidWebhookTarget,
  isValidWebhookUrl,
};
