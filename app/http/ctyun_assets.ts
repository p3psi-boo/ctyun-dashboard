// @ts-nocheck
'use strict';

const { corsHeadersFor } = require('./cors');
const { createLogger } = require('../logger');

const sysLog = createLogger('System');

const ctyunStaticCache = new Map();
let cachedCtyunIndexHtml = '';
let cachedCtyunIndexTime = 0;

async function getCtyunIndexHtml() {
  const now = Date.now();
  if (cachedCtyunIndexHtml && (now - cachedCtyunIndexTime < 3600 * 1000)) {
    return cachedCtyunIndexHtml;
  }
  try {
    const res = await fetch('https://pc.ctyun.cn/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0'
      }
    });
    if (res.ok) {
      cachedCtyunIndexHtml = await res.text();
      cachedCtyunIndexTime = now;
      return cachedCtyunIndexHtml;
    }
  } catch (e) {
    sysLog.warn('拉取 pc.ctyun.cn 首页失败', e);
  }
  return cachedCtyunIndexHtml || '<!doctype html><html><head><title>天翼量子AI云电脑</title></head><body><div id="app"></div></body></html>';
}

async function proxyStaticAsset(res, targetUrl, req = null) {
  const extraCors = req ? corsHeadersFor(req) : { Vary: 'Origin' };
  if (ctyunStaticCache.has(targetUrl)) {
    const cached = ctyunStaticCache.get(targetUrl);
    res.writeHead(200, {
      'Content-Type': cached.contentType,
      'Cache-Control': 'public, max-age=86400',
      ...extraCors
    });
    res.end(cached.buffer);
    return;
  }

  try {
    const upstreamRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
        'Referer': 'https://pc.ctyun.cn/'
      }
    });
    if (!upstreamRes.ok) {
      res.writeHead(upstreamRes.status, { 'Content-Type': 'text/plain' });
      res.end('Upstream error: ' + upstreamRes.status);
      return;
    }
    const arrayBuf = await upstreamRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    let contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
    if (targetUrl.endsWith('.wasm')) contentType = 'application/wasm';
    else if (targetUrl.endsWith('.js')) contentType = 'application/javascript; charset=utf-8';
    else if (targetUrl.endsWith('.css')) contentType = 'text/css; charset=utf-8';
    else if (targetUrl.endsWith('.png')) contentType = 'image/png';
    else if (targetUrl.endsWith('.ico')) contentType = 'image/x-icon';

    if (buffer.length < 20 * 1024 * 1024) {
      ctyunStaticCache.set(targetUrl, { buffer, contentType });
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      ...extraCors
    });
    res.end(buffer);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Failed to proxy static asset: ' + err.message);
  }
}

module.exports = { getCtyunIndexHtml, proxyStaticAsset, ctyunStaticCache };
