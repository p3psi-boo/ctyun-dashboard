'use strict';

import type { IncomingMessage, ServerResponse } from 'node:http';

const https = require('https') as typeof import('https');
const { readRawBody } = require('./body');
const { corsHeadersFor } = require('./cors');
const { MAX_PROXY_BODY_BYTES } = require('./limits');
const { getSessionFromReq } = require('./session');
const { jsonResponse } = require('./json');
const { canUserAccessAccount } = require('../lib/access');
const runtime = require('../runtime');

const STRIP_REQUEST_HEADERS = new Set([
  'host', 'origin', 'referer', 'content-length',
  'cookie', 'cookie2', 'authorization', 'proxy-authorization',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'upgrade', 'proxy-connection',
]);

function isAllowedCtyunTarget(parsedTarget: URL | null | undefined): boolean {
  if (!parsedTarget || parsedTarget.protocol !== 'https:') return false;
  const host = String(parsedTarget.hostname || '').toLowerCase();
  return host === 'ctyun.cn' || host.endsWith('.ctyun.cn');
}

/**
 * 天翼云桌面页同源 API 代理。
 * 必须已登录；不得把仪表盘 Cookie / Authorization 原样转发给上游。
 */
async function handleCtyunProxy(req: IncomingMessage, res: ServerResponse, parsedUrl: URL) {
  const session = getSessionFromReq(req, parsedUrl);
  if (!session) {
    jsonResponse(res, { error: '未授权：请登录后再使用云电脑代理通道' }, 401, req);
    return;
  }

  const targetUrl = parsedUrl.searchParams.get('target');
  if (!targetUrl) {
    jsonResponse(res, { error: 'Missing target' }, 400, req);
    return;
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (e) {
    jsonResponse(res, { error: 'Malformed proxy request: ' + e.message }, 400, req);
    return;
  }

  if (!isAllowedCtyunTarget(parsedTarget)) {
    jsonResponse(res, { error: 'Invalid proxy target' }, 403, req);
    return;
  }

  const accId = parsedUrl.searchParams.get('accId') || '';
  if (accId) {
    const acc = (runtime.config?.accounts || []).find((a) => a.id === accId);
    if (!acc || !canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '无权使用该云电脑代理通道' }, 403, req);
      return;
    }
  }

  let bodyBuffer;
  try {
    bodyBuffer = await readRawBody(req, MAX_PROXY_BODY_BYTES);
  } catch (err) {
    if (err && err.statusCode === 413) {
      jsonResponse(res, { error: '请求体过大', limit: MAX_PROXY_BODY_BYTES }, 413, req);
      return;
    }
    jsonResponse(res, { error: '读取代理请求失败' }, 400, req);
    return;
  }

  const outgoingHeaders: Record<string, string | number | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lk)) continue;
    outgoingHeaders[k] = v;
  }
  outgoingHeaders['host'] = parsedTarget.host;
  outgoingHeaders['origin'] = 'https://pc.ctyun.cn';
  outgoingHeaders['referer'] = 'https://pc.ctyun.cn/';
  if (bodyBuffer.length > 0) {
    outgoingHeaders['content-length'] = bodyBuffer.length;
  }

  const proxyReq = https.request(targetUrl, {
    method: req.method,
    headers: outgoingHeaders,
  }, (proxyRes) => {
    const respHeaders = { ...corsHeadersFor(req) };
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'set-cookie' || lk === 'access-control-allow-origin'
        || lk === 'access-control-allow-headers' || lk === 'access-control-allow-methods') {
        continue;
      }
      respHeaders[k] = v;
    }
    res.writeHead(proxyRes.statusCode, respHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    jsonResponse(res, { error: 'Proxy request failed: ' + err.message }, 502, req);
  });

  if (bodyBuffer.length > 0) proxyReq.write(bodyBuffer);
  proxyReq.end();
}

module.exports = {
  handleCtyunProxy,
  isAllowedCtyunTarget,
  STRIP_REQUEST_HEADERS,
};
