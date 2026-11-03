'use strict';

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * CORS：默认仅放行同源（Origin 的 host 与请求 Host 一致）。
 * 跨站调用必须通过 CORS_ORIGINS（逗号分隔的完整 Origin，如 https://panel.example.com）显式放行。
 * 绝不回显 `*`，避免任意网站读取接口响应。
 */
function parseAllowlist(): string[] {
  return String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isOriginAllowed(req: IncomingMessage, origin: string | undefined): boolean {
  if (!origin) return false;
  const allowlist = parseAllowlist();
  if (allowlist.includes(origin)) return true;
  try {
    const u = new URL(origin);
    const host = String(req.headers.host || '').split(',')[0].trim();
    if (!host) return false;
    return u.host === host;
  } catch (e) {
    return false;
  }
}

function corsHeadersFor(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin && isOriginAllowed(req, origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

function writeCors(res: ServerResponse, req: IncomingMessage, extra: Record<string, string | undefined> = {}) {
  const headers = { ...corsHeadersFor(req), ...extra };
  for (const [k, v] of Object.entries(headers)) {
    if (v != null) res.setHeader(k, v);
  }
}

module.exports = {
  parseAllowlist,
  isOriginAllowed,
  corsHeadersFor,
  writeCors,
};
