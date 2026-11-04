// @ts-nocheck
'use strict';

import type { IncomingMessage, ServerResponse } from 'node:http';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const crypto = require('crypto') as typeof import('crypto');
const runtime = require('../runtime');
const { jsonResponse: jsonResponseWithReq, sendPayloadTooLarge } = require('./json');
const { parseJsonBody } = require('./body');
const { getSessionFromReq } = require('./session');
const { corsHeadersFor } = require('./cors');
const { serveStatic } = require('./static');
const { getCtyunIndexHtml, proxyStaticAsset } = require('./ctyun_assets');
const { handleCtyunProxy } = require('./ctyun_proxy');
const { MAX_JSON_BODY_BYTES, MAX_IMPORT_BODY_BYTES, PayloadTooLargeError } = require('./limits');
const { canUserAccessAccount } = require('../lib/access');
const { createLogger } = require('../lib/logger');
const { generateDeviceCode } = require('../lib/crypto_util');
const { STATIC_DIR } = require('../paths');
const {
  clientInstances, pendingEcloudLogins, registerPendingEcloudLogin,
  finalizeEcloudAccount, getClient, initAllKeepAlive, buildEcloudDefaultFeatures,
} = require('../clients');
const { logs, sseClients, appendLog, canUserSeeLog } = require('../log_hub');
const { sendNotification, sendAccountNotification } = require('../notify');
const { EcloudClient, LOG_SOURCE: ECLOUD_LOG_SOURCE, INTERACTIVE_BRANCHES } = require('../ecloud/ecloud_client');
const { SohoClient } = require('../ydpc/soho_client');

const httpLog = createLogger('Http');
const saveConfig = (cfg) => runtime.saveConfig(cfg || runtime.config);

const appConfig = new Proxy({}, {
  get(_, p) { return runtime.config[p]; },
  set(_, p, v) { runtime.config[p] = v; return true; },
  ownKeys() { return Reflect.ownKeys(runtime.config || {}); },
  getOwnPropertyDescriptor(_, p) {
    return Object.getOwnPropertyDescriptor(runtime.config || {}, p);
  },
});

const authManager = new Proxy({}, {
  get(_, p) {
    const v = runtime.authManager[p];
    return typeof v === 'function' ? v.bind(runtime.authManager) : v;
  },
});

const taskScheduler = new Proxy({}, {
  get(_, p) {
    const v = runtime.taskScheduler[p];
    return typeof v === 'function' ? v.bind(runtime.taskScheduler) : v;
  },
});

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    await dispatchRequest(req, res);
  } catch (err) {
    if (err && ((err as any).statusCode === 413 || err instanceof PayloadTooLargeError)) {
      sendPayloadTooLarge(res, req, err);
      return;
    }
    httpLog.error('未处理异常', err);
    jsonResponseWithReq(res, { error: '服务器内部错误' }, 500, req);
  }
}

async function dispatchRequest(req: IncomingMessage, res: ServerResponse) {
  const jsonResponse = (r, data, statusCode = 200) => jsonResponseWithReq(r, data, statusCode, req);
  const parseJsonBodyLimited = (request, limit) => parseJsonBody(request, limit || MAX_JSON_BODY_BYTES);

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeadersFor(req));
    res.end();
    return;
  }

  // Docker / 编排探活：无鉴权、不泄露账号数据。只表示 HTTP 进程已在监听。
  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/api/healthz')) {
    jsonResponse(res, { ok: true });
    return;
  }

  // 判断商品是否需要绑定云电脑
function rewardNeedsDesktop(prodId, prodType) {
  const pId = Number(prodId);
  if ([17023101, 17023111, 17024101, 17026101, 17026111].includes(pId)) {
    return true;
  }
  const typeLower = String(prodType || '').toLowerCase().trim();
  if (typeLower === 'pointstplupgrade' || typeLower === 'pointsdiskupgrade') {
    return true;
  }
  return false;
}
  if (pathname === '/desktop-view') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3 style="font-family:sans-serif;padding:20px;">未授权：请先在仪表盘登录后再访问云电脑</h3>');
      return;
    }

    const accId = parsedUrl.searchParams.get('accId');
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3 style="font-family:sans-serif;padding:20px;">云电脑账号不存在</h3>');
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3 style="font-family:sans-serif;padding:20px;">权限不足：无权访问该云电脑</h3>');
      return;
    }

    const client = getClient(acc);
    try {
      if (!client.loginInfo) {
        await client.login();
      }
      const desktops = await client.getDesktops();
      if (!desktops || desktops.length === 0) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h3 style="font-family:sans-serif;padding:20px;">未检测到名下可用云电脑</h3>');
        return;
      }
      const requestedDesktopId = parsedUrl.searchParams.get('desktopId');
      let desktop = desktops[0];
      if (requestedDesktopId) {
        const matched = desktops.find(d => String(d.objId || d.desktopId) === String(requestedDesktopId));
        if (matched) desktop = matched;
      }
      const objId = desktop.objId || desktop.desktopId;
      const b64Id = Buffer.from(String(objId)).toString('base64');

      // 核心避让机制：用户准备打开浏览器独立操作云电脑，后台长连接保活自动断开让位
      // 杜绝“AI云电脑在其他地方登录，您已被强制下线”的互踢冲突！
      client.yieldToWebUser(60);

      const authDataObj = {
        ...client.loginInfo,
        logined: true,
        userId: client.loginInfo?.userId,
        userName: client.loginInfo?.userName,
        userEid: client.loginInfo?.userEid || '',
        userAccount: client.loginInfo?.userAccount || '',
        mobilephone: client.loginInfo?.mobilephone || acc.user,
        tenantId: client.loginInfo?.tenantId,
        secretKey: client.loginInfo?.secretKey,
        deviceType: client.deviceType,
        bondedDevice: true,
        commonLoginReqHeader: client.loginInfo?.commonLoginReqHeader || '',
        timestamp: Date.now()
      };

      let html = await getCtyunIndexHtml();

      const injectScript = `
<script>
(function() {
  // 1. 自动免密注入天翼官方认证凭据至 localStorage
  const authData = ${JSON.stringify(authDataObj)};
  const deviceCode = ${JSON.stringify(acc.deviceCode)};
  const expiredAt = ${JSON.stringify(String(Date.now() + 72 * 3600 * 1000))};
  try {
    localStorage.setItem('web_device_code', deviceCode);
    localStorage.setItem('authExpiredAt', expiredAt);
    localStorage.setItem('authData', JSON.stringify(authData));
    localStorage.setItem('judgeUserEId', authData.userEid || '');
    localStorage.setItem('loginAt', Date.now().toString());
    sessionStorage.setItem('authExpiredAt', expiredAt);
    sessionStorage.setItem('authData', JSON.stringify(authData));
    sessionStorage.setItem('user_name', authData.userName || '');
    sessionStorage.setItem('userId', String(authData.userId || ''));
  } catch (e) {
    console.error('Failed to set localStorage', e);
  }

  // 2. API 请求代理拦截器 (规避跨域与 Origin 防盗链)
  const proxyBase = '/api/ctyun-proxy?target=';
  function rewriteUrl(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.startsWith(proxyBase)) return u;
    if (u.includes('.ctyun.cn:8810') || u.includes('.ctyun.cn:8816') || u.includes('-deskmgr.ctyun.cn')) {
      return proxyBase + encodeURIComponent(u);
    }
    return u;
  }

  const origFetch = window.fetch;
  window.fetch = function(resource, init) {
    if (typeof resource === 'string') {
      resource = rewriteUrl(resource);
    } else if (resource && resource.url) {
      const newUrl = rewriteUrl(resource.url);
      resource = new Request(newUrl, resource);
    }
    return origFetch.call(this, resource, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    url = rewriteUrl(url);
    return origOpen.call(this, method, url, ...args);
  };

  // 4. 路由直接锁定进入云电脑操作界面
  const targetHash = '#/desktop?id=' + ${JSON.stringify(encodeURIComponent(b64Id))};
  if (!window.location.hash || window.location.hash.includes('/login') || window.location.hash.includes('/desktop-list')) {
    window.location.hash = targetHash;
  }

  // 5. 拦截 Web Worker 构造函数，自动重定向至代理网关，确保 bbenc 解码器正常通信
  const OrigWorker = window.Worker;
  window.Worker = function(scriptUrl, options) {
    if (typeof scriptUrl === 'string' && scriptUrl.includes('bbenc.worker.js')) {
      scriptUrl = '/workers/bbenc.worker.js';
    }
    return new OrigWorker(scriptUrl, options);
  };

  // 6. 移动端横屏沉浸式全屏视图注入 (CSS + 屏幕旋转自适应与触控手势防阻断)
  const isMobileView = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
  if (isMobileView) {
    const mobileStyle = document.createElement('style');
    mobileStyle.innerHTML = \`
      html, body {
        width: 100vw !important;
        height: 100vh !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: #000000 !important;
        touch-action: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
      }
      #app, .desktop-container, canvas, video {
        width: 100vw !important;
        height: 100vh !important;
        max-width: 100vw !important;
        max-height: 100vh !important;
        object-fit: contain !important;
      }
    \`;
    document.head.appendChild(mobileStyle);

    // 请求全屏与横屏锁定 (若移动端浏览器支持)
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  }

  // 7. 前台网页生命周期与心跳保活双向感知感知探针
  // 打开页面每 5 秒发送心跳证明用户正在操作；页面关闭/离开时立即通知后台恢复保活守护
  const accId = ${JSON.stringify(acc.id)};
  const token = ${JSON.stringify(session.token || '')};
  function sendWebHeartbeat() {
    fetch('/api/accounts/' + accId + '/web-active?token=' + encodeURIComponent(token), { method: 'POST' }).catch(() => {});
  }
  sendWebHeartbeat();
  const webHbTimer = setInterval(sendWebHeartbeat, 5000);

  window.addEventListener('beforeunload', function() {
    clearInterval(webHbTimer);
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/accounts/' + accId + '/web-close?token=' + encodeURIComponent(token));
    } else {
      fetch('/api/accounts/' + accId + '/web-close?token=' + encodeURIComponent(token), { method: 'POST', keepalive: true }).catch(() => {});
    }
  });
})();
</script>
`;

      html = html.replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"><title>天翼云电脑 - ' + (acc.name || acc.user) + '</title>' + injectScript);
      html = html.replace(/src="static\//g, 'src="/ctyun-static/static/');
      html = html.replace(/src="\.\/static\//g, 'src="/ctyun-static/static/');
      html = html.replace(/href="\.\/static\//g, 'href="/ctyun-static/static/');
      html = html.replace(/href="\.\/manifest\.json"/g, 'href="/ctyun-static/manifest.json"');

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3 style="font-family:sans-serif;padding:20px;">连接云电脑服务异常: ' + err.message + '</h3>');
    }
    return;
  }

  // 代理天翼云 Web Worker 解码器与组件 (解决“当前浏览器版本过低，无法正常显示画面”问题)
  if (pathname.startsWith('/workers/') || pathname.includes('bbenc.worker.js')) {
    if (!getSessionFromReq(req, parsedUrl)) {
      jsonResponse(res, { error: '未授权' }, 401);
      return;
    }
    const filename = pathname.split('/').pop() || 'bbenc.worker.js';
    const targetUrl = 'https://pc.ctyun.cn/workers/' + filename;
    await proxyStaticAsset(res, targetUrl, req);
    return;
  }

  // 代理天翼云 WASM 解码器组件
  if (pathname.includes('bbEncDecoder') || pathname.endsWith('.wasm')) {
    if (!getSessionFromReq(req, parsedUrl)) {
      jsonResponse(res, { error: '未授权' }, 401);
      return;
    }
    const filename = pathname.split('/').pop();
    const targetUrl = 'https://pc.ctyun.cn/static/common/' + filename;
    await proxyStaticAsset(res, targetUrl, req);
    return;
  }

  // 代理天翼云静态资源
  if (pathname.startsWith('/ctyun-static/')) {
    if (!getSessionFromReq(req, parsedUrl)) {
      jsonResponse(res, { error: '未授权' }, 401);
      return;
    }
    const relPath = pathname.substring(13).replace(/^\/+/, '');
    const targetUrl = 'https://pc.ctyun.cn/' + relPath;
    await proxyStaticAsset(res, targetUrl, req);
    return;
  }

  // 天翼云 API 反向代理通道：必须登录，且不得转发 Cookie / Authorization
  if (pathname === '/api/ctyun-proxy') {
    await handleCtyunProxy(req, res, parsedUrl);
    return;
  }

  // 1. 静态资源
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(res, path.join(STATIC_DIR, 'index.html'), 'text/html');
    return;
  }
  if (pathname.startsWith('/static/')) {
    const rel = pathname.substring(8);
    const file = path.join(STATIC_DIR, rel);
    if (fs.existsSync(file)) {
      let type = 'text/plain';
      if (rel.endsWith('.css')) type = 'text/css; charset=utf-8';
      else if (rel.endsWith('.js')) type = 'application/javascript; charset=utf-8';
      else if (rel.endsWith('.html')) type = 'text/html; charset=utf-8';
      else if (rel.endsWith('.woff2')) type = 'font/woff2';
      else if (rel.endsWith('.woff')) type = 'font/woff';
      serveStatic(res, file, type);
    } else {
      const targetUrl = 'https://pc.ctyun.cn' + pathname;
      await proxyStaticAsset(res, targetUrl, req);
    }
    return;
  }

  // 2. 实时日志 SSE 流与历史日志获取 (权限严格隔离：未登录完全不可看，普通用户仅看自己账号)
  if (pathname === '/api/logs' && req.method === 'GET') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, []);
      return;
    }
    const filtered = logs.filter(l => canUserSeeLog(session, l)).slice(-200);
    jsonResponse(res, filtered);
    return;
  }

  // 一键清空持久化历史日志 API
  if (pathname === '/api/logs/clear' && req.method === 'POST') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    if (session.role === 'admin') {
      logs.length = 0;
    } else {
      // 普通用户只清除自身可见日志
      for (let i = logs.length - 1; i >= 0; i--) {
        if (canUserSeeLog(session, logs[i])) {
          logs.splice(i, 1);
        }
      }
    }

    appendLog('System', `用户 [${session.username}] 执行了一键清空历史日志`, 'info');
    jsonResponse(res, { success: true, message: '历史日志已彻底清空！' });
    return;
  }

  if (pathname === '/api/logs/stream') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeadersFor(req)
    });
    // 立即下发初始心跳
    res.write(': connected\n\n');

    const recent = logs.filter(l => canUserSeeLog(session, l)).slice(-80);
    for (const log of recent) {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    }
    const clientObj = { res, session };
    sseClients.add(clientObj);

    // 每 15 秒主动下发一次 SSE 注释保持活跃，防止浏览器因静默判定连接超时
    const pingTimer = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (e) {
        clearInterval(pingTimer);
        sseClients.delete(clientObj);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(pingTimer);
      sseClients.delete(clientObj);
    });
    return;
  }

  // 3. 用户系统 (登录、注册、修改个人密码、当前用户状态)
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await parseJsonBodyLimited(req);
    const remember = body.remember === true; // "30 天内免登录"勾选 ⇒ 会话落盘 + 前端持久存储
    const result = authManager.login(body.username, body.password, remember);
    if (result.success) {
      appendLog('Auth', `用户 [${body.username}] 登录成功${remember ? '（已勾选 30 天内免登录）' : ''}`, 'info');
      jsonResponse(res, result);
    } else {
      jsonResponse(res, result, 400);
    }
    return;
  }

  // 登出：显式销毁会话（免登录会话必须同时从磁盘清除，否则重启后仍有效）。
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const session = getSessionFromReq(req);
    if (session && session.token) {
      authManager.destroySession(session.token);
      appendLog('Auth', `用户 [${session.username}] 已退出登录（会话已吊销）`, 'info');
    }
    jsonResponse(res, { success: true, message: '已退出登录' });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const body = await parseJsonBodyLimited(req);
    const result = authManager.register(body.username, body.password);
    if (result.success) {
      appendLog('Auth', `新用户 [${body.username}] 注册成功 (默认配额: ${result.user.maxQuota}台)`, 'success');
      jsonResponse(res, result, 201);
    } else {
      jsonResponse(res, result, 400);
    }
    return;
  }

  // 个人修改密码
  if (req.method === 'POST' && pathname === '/api/auth/change-password') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未登录' }, 401);
      return;
    }
    const body = await parseJsonBodyLimited(req);
    const newPwd = (body.newPassword || '').trim();
    if (!newPwd || newPwd.length < 5) {
      jsonResponse(res, { error: '新密码长度至少5位' }, 400);
      return;
    }
    authManager.updateUserPassword(session.userId, newPwd);
    appendLog('Auth', `用户 [${session.username}] 修改了自己的登录密码`, 'info');
    jsonResponse(res, { success: true, message: '密码修改成功' });
    return;
  }

  // 个人修改头像
  if (req.method === 'POST' && pathname === '/api/auth/change-avatar') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未登录' }, 401);
      return;
    }
    const body = await parseJsonBodyLimited(req);
    const newAvatar = (body.avatar || '').trim();
    if (!newAvatar) {
      jsonResponse(res, { error: '头像内容不能为空' }, 400);
      return;
    }
    const ok = authManager.updateUserAvatar(session.userId, newAvatar);
    if (ok) {
      appendLog('Auth', `用户 [${session.username}] 更新了个性化头像: ${newAvatar}`, 'info');
      jsonResponse(res, { success: true, avatar: newAvatar });
    } else {
      jsonResponse(res, { error: '用户不存在' }, 404);
    }
    return;
  }

  // 管理员修改自身用户名
  if (req.method === 'POST' && pathname === '/api/auth/change-username') {
    const session = getSessionFromReq(req);
    if (!session || session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅管理员可修改用户名' }, 403);
      return;
    }
    const body = await parseJsonBodyLimited(req);
    const newUsername = (body.newUsername || '').trim();
    const oldUsername = session.username;
    const updateRes = authManager.updateAdminUsername(oldUsername, newUsername);
    if (updateRes.success) {
      appendLog('Auth', `管理员用户名已从 [${oldUsername}] 修改为 [${newUsername}]`, 'warning');
      jsonResponse(res, updateRes);
    } else {
      jsonResponse(res, updateRes, 400);
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const session = getSessionFromReq(req);
    if (session) {
      const user = authManager.getUserById(session.userId);
      const accountsCount = appConfig.accounts.filter(a => a.ownerId === session.userId).length;
      jsonResponse(res, {
        isLoggedIn: true,
        systemTitle: appConfig.settings?.systemTitle || '天翼云/移动云电脑保活签到中心',
        systemSubtitle: appConfig.settings?.systemSubtitle || '多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          maxQuota: user.maxQuota,
          avatar: user.avatar || '',
          accountsCount
        }
      });
    } else {
      // 默认提供全局未登录或 admin 访客视图
      jsonResponse(res, {
        isLoggedIn: false,
        allowRegistration: appConfig.settings?.allowRegistration === true,
        defaultQuota: appConfig.settings?.defaultQuota || 2,
        systemTitle: appConfig.settings?.systemTitle || '天翼云/移动云电脑保活签到中心',
        systemSubtitle: appConfig.settings?.systemSubtitle || '多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机'
      });
    }
    return;
  }

  // 5. 管理员用户管理 API
  if (pathname.startsWith('/api/admin/users')) {
    const session = getSessionFromReq(req);
    // 严格鉴权：未登录返回 401，非管理员返回 403
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    if (session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅管理员可访问' }, 403);
      return;
    }

    if (req.method === 'GET') {
      jsonResponse(res, authManager.getUsers());
      return;
    }

    if (req.method === 'PUT' && pathname.includes('/quota')) {
      const userId = pathname.split('/')[4];
      const body = await parseJsonBodyLimited(req);
      const ok = authManager.updateUserQuota(userId, body.maxQuota);
      if (ok) {
        appendLog('Admin', `管理员调整了用户 [${userId}] 的云电脑添加配额为 ${body.maxQuota} 台`, 'info');
        jsonResponse(res, { success: true });
      } else {
        jsonResponse(res, { error: '用户不存在' }, 404);
      }
      return;
    }

    // 管理员重置或修改任意用户密码
    if (req.method === 'PUT' && pathname.includes('/password')) {
      const userId = pathname.split('/')[4];
      const body = await parseJsonBodyLimited(req);
      const newPwd = (body.newPassword || '').trim();
      if (!newPwd || newPwd.length < 5) {
        jsonResponse(res, { error: '新密码长度至少5位' }, 400);
        return;
      }
      const ok = authManager.updateUserPassword(userId, newPwd);
      if (ok) {
        appendLog('Admin', `管理员修改了用户 [${userId}] 的登录密码`, 'warning');
        jsonResponse(res, { success: true, message: '用户密码已更新' });
      } else {
        jsonResponse(res, { error: '用户不存在' }, 404);
      }
      return;
    }

    if (req.method === 'DELETE') {
      const userId = pathname.split('/')[4];
      const ok = authManager.deleteUser(userId);
      if (ok) {
        appendLog('Admin', `管理员删除了用户: ${userId}`, 'warning');
        jsonResponse(res, { success: true });
      } else {
        jsonResponse(res, { error: '删除失败或不允许删除管理员' }, 400);
      }
      return;
    }
  }

  // 6. 统计状态
  if (req.method === 'GET' && pathname === '/api/status') {
    const session = getSessionFromReq(req);
    // 未登录访客不暴露账号统计数据
    if (!session) {
      jsonResponse(res, {
        accountsTotal: 0,
        onlineKeepAlive: 0,
        signedToday: 0,
        currentTime: new Date().toISOString().replace('T', ' ').substring(0, 19),
        isGuest: true
      });
      return;
    }

    let visibleAccounts = appConfig.accounts;
    if (session.role !== 'admin') {
      visibleAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
    }
    const total = visibleAccounts.length;
    const online = visibleAccounts.filter(a => a.stats?.keepAliveStatus === 'online').length;
    const today = getBeijingDateOnly();
    const signed = visibleAccounts.filter(a => a.stats?.lastSignTime && a.stats.lastSignTime.startsWith(today)).length;
    // 汇总该用户可见账号的今日已获得总积分 (仅统计天翼云电脑账号，移动云无积分体系)
    let totalTodayEarned = 0;
    const pointsDetails = [];

    for (const a of visibleAccounts) {
      // 严格过滤：移动云电脑 / 移动公众均无积分与任务中心，直接跳过积分统计与明细展示
      if (a.platform === 'ydpc' || a.platform === 'ecloud') continue;

      const client = clientInstances.get(a.id);
      const tasks = client?.metrics?.officialTasks || [];
      let accTodayPoints = 0;
      const completedTasks = [];

      for (const t of tasks) {
        let completedAt = '';
        if (t.name.includes('登录AI云电脑')) {
          completedAt = a.stats?.lastSignTime || '';
        } else if (t.name.includes('AI对话')) {
          completedAt = a.stats?.lastAiChatTime || '';
        } else if (t.name.includes('使用1小时')) {
          completedAt = a.stats?.lastHangTime || '';
        }

        const isDone = t.status === 2 || (t.total > 0 && t.current >= t.total);
        if (isDone) {
          const val = t.points || 100;
          accTodayPoints += val;
          completedTasks.push({
            name: t.name,
            points: val,
            completed: true,
            completedAt: completedAt || `${today} 08:00:00`
          });
        } else {
          completedTasks.push({
            name: t.name,
            points: 0,
            completed: false,
            progress: `${t.current}/${t.total}`,
            completedAt: ''
          });
        }
      }

      totalTodayEarned += accTodayPoints;
      pointsDetails.push({
        accountId: a.id,
        accountName: a.name || a.user,
        todayPoints: accTodayPoints,
        totalPoints: (client && client.metrics.userPoints) ? client.metrics.userPoints : (a.stats?.points || 0),
        tasks: completedTasks
      });
    }

    jsonResponse(res, {
      accountsTotal: total,
      onlineKeepAlive: online,
      signedToday: signed,
      totalEarnedPoints: totalTodayEarned,
      pointsDetails: pointsDetails,
      currentTime: getBeijingTimeString(),
      isGuest: false
    });
    return;
  }

  // 7. 账号列表（按多用户权限隔离过滤 + 附加实时运行态指标）
  if (req.method === 'GET' && pathname === '/api/accounts') {
    const session = getSessionFromReq(req);
    // 未登录访客直接返回空列表，禁止窥探任何云电脑信息！
    if (!session) {
      jsonResponse(res, []);
      return;
    }

    let userAccounts = appConfig.accounts;
    if (session.role !== 'admin') {
      userAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
    }

    // 智能状态同步：确保运行态指标状态准确反映长连接和机器实际状态
    for (const acc of userAccounts) {
      const client = getClient(acc);
      if (client.lastSuccessDate) {
        const todayStr = getBeijingDateOnly();
        if (client.lastSuccessDate !== todayStr) {
          client.metrics.successCount = 0;
          client.lastSuccessDate = todayStr;
          if (acc.stats) {
            acc.stats.todaySuccessCount = 0;
            acc.stats.lastSuccessDate = todayStr;
          }
        }
      }

      if (acc.features?.keepAlive === false || acc.manualShutdown === true) {
        client.stopKeepAliveWorker();
        client.metrics.status = 'offline';
        client.metrics.cycleCountdown = client.metrics.keepAliveSeconds || 60;
      } else if (acc.enabled && acc.features?.keepAlive === true) {
        if (!client.workerRunning) {
          client.startKeepAliveWorker();
        }
        if (client.wsAlive) {
          client.metrics.status = 'online';
        }
      }
    }

    const enriched = userAccounts.map(acc => {
      const client = getClient(acc);
      if (acc.platform === 'ecloud') {
        // 移动公众：逐台**序列化时现算**保活视图（倒计时/最近动作必须现算才新鲜），
        // 因此不落盘、不缓存；计算异常时静默回落到原始字段。
        const ecloudDesktops = (client.metrics?.desktops || acc.desktops || []).map(d => {
          let keepAliveView = null;
          try {
            if (typeof client.describeDesktopKeepAlive === 'function') {
              keepAliveView = client.describeDesktopKeepAlive(d);
            }
          } catch (e) { keepAliveView = null; }
          return keepAliveView ? { ...d, keepAliveView } : { ...d };
        });
        return {
          ...acc,
          platform: 'ecloud',
          desktops: ecloudDesktops,
          vms: ecloudDesktops,
          engineState: client.engine ? client.engine.state : 'unknown',
          liveMetrics: client.metrics
        };
      }
      if (acc.platform === 'ydpc') {
        // 【2026-09-23 按主机维度】一个移动云账号下可以挂多台云电脑，各机状态（运行/关机/
        // 时长耗尽/单机保活开关/独立周期/数据面是否在场）可以完全不同 —— 账号级单行文案
        // 表达不了。这里在**序列化时**实时计算每台主机的状态视图（倒计时/是否到期必须
        // 现算才新鲜），因此不落盘、不缓存；计算异常时静默回落到原始 vm 字段。
        const ydpcVms = (client.metrics?.vms || acc.vms || []).map(vm => {
          let keepAliveView = null;
          try {
            if (typeof client.describeVmKeepAlive === 'function') {
              keepAliveView = client.describeVmKeepAlive(vm);
            }
          } catch (e) { keepAliveView = null; }
          return keepAliveView ? { ...vm, keepAliveView } : { ...vm };
        });
        return {
          ...acc,
          platform: 'ydpc',
          vms: ydpcVms,
          desktops: ydpcVms,
          liveMetrics: client.metrics
        };
      }
      const ctyunDesktops = ((client.desktopsCache && client.desktopsCache.length > 0) ? client.desktopsCache : (acc.desktops || [])).map(d => {
        const spec = CtYunClient.extractDesktopSpecs(d, d.flavorName || '公众版');
        return {
          ...d,
          cpu: d.cpu || spec.cpu,
          memory: d.memory || spec.memory,
          specStr: d.specStr || spec.specStr,
          flavorName: d.flavorName || spec.flavorName
        };
      });

      return {
        ...acc,
        platform: 'ctyun',
        desktops: ctyunDesktops,
        pulseIntervalSeconds: parseInt(appConfig.settings?.pulseIntervalSeconds) || 30,
        liveMetrics: client.metrics
      };
    });
    jsonResponse(res, enriched);
    return;
  }

  // 7.4 账号自由拖拽排序持久化 API
  if (req.method === 'POST' && pathname === '/api/accounts/reorder') {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未授权' }, 401); return; }
    const body = await parseJsonBodyLimited(req);
    const orderedIds = body.orderedIds;
    if (Array.isArray(orderedIds)) {
      const userAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
      const otherAccounts = appConfig.accounts.filter(a => a.ownerId !== session.userId);
      const reordered = [];
      for (const id of orderedIds) {
        const found = userAccounts.find(a => a.id === id);
        if (found) reordered.push(found);
      }
      for (const a of userAccounts) {
        if (!reordered.includes(a)) reordered.push(a);
      }
      appConfig.accounts = [...otherAccounts, ...reordered];
      saveConfig(appConfig);
      jsonResponse(res, { success: true });
      return;
    }
    jsonResponse(res, { error: '参数错误' }, 400);
    return;
  }

  // 7.5 移动云图形验证码获取 API
  if (req.method === 'GET' && pathname === '/api/ydpc/captcha') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录' }, 401);
      return;
    }
    try {
      const soho = new SohoClient({});
      const vcodeData = await soho.getVerificationCode();
      jsonResponse(res, {
        success: true,
        image: vcodeData.image,
        randomCode: vcodeData.randomCode
      });
    } catch (e) {
      jsonResponse(res, { error: e.message || '获取移动云验证码失败' }, 500);
    }
    return;
  }

  // 7.6 移动云测试登录并拉取云电脑列表 API
  if (req.method === 'POST' && pathname === '/api/ydpc/test-login') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录后再操作' }, 401);
      return;
    }
    const body = await parseJsonBodyLimited(req);
    const user = (body.user || '').trim();
    const pwd = (body.password || '').trim();
    const accountType = body.accountType || 'main';
    const verificationCode = (body.verificationCode || '').trim();
    const randomCode = (body.randomCode || '').trim();

    if (!user || !pwd) {
      jsonResponse(res, { error: '手机号/账号与密码不能为空' }, 400);
      return;
    }

    try {
      const soho = new SohoClient({ accountType });
      const loginData = await soho.login(user, pwd, accountType, verificationCode, randomCode);
      const vms = await soho.listCloudPcs();
      jsonResponse(res, {
        success: true,
        userId: loginData.userId,
        vmsCount: vms.length,
        vms
      });
    } catch (e) {
      jsonResponse(res, { success: false, error: e.message || '移动云鉴权失败' }, 400);
    }
    return;
  }

  // 7.7 添加移动云电脑账号 API
  if (req.method === 'POST' && pathname === '/api/accounts/ydpc/add') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录或注册账号后再添加云电脑！' }, 401);
      return;
    }

    const currentOwnerId = session.userId;
    const currentUser = authManager.getUserById(currentOwnerId);
    if (currentUser && currentUser.role !== 'admin') {
      const currentOwned = appConfig.accounts.filter(a => a.ownerId === currentOwnerId).length;
      const userMax = currentUser.maxQuota || 2;
      if (currentOwned >= userMax) {
        jsonResponse(res, {
          error: `已达到云电脑添加配额上限（当前配额: ${userMax}台），无法继续添加！请联系管理员提高配额。`
        }, 400);
        return;
      }
    }

    const body = await parseJsonBodyLimited(req);
    const user = (body.user || '').trim();
    const pwd = (body.password || '').trim();
    const name = (body.name || user).trim();
    const accountType = body.accountType || 'main';
    // 【2026-09-22】移动云账号创建时不显式写入 autoBoot（自动开机守护）：
    // 由账号级 + 单机双开关独立判定，省略即按默认口径（见 ydpc_client.js 的 _autoBootArmed）。
    const keepaliveInterval = parseInt(body.keepaliveInterval) || 600;
    const verificationCode = (body.verificationCode || '').trim();
    const randomCode = (body.randomCode || '').trim();

    if (!user || !pwd) {
      jsonResponse(res, { error: '账号和密码不能为空' }, 400);
      return;
    }

    if (appConfig.accounts.some(a => a.platform === 'ydpc' && a.user === user && a.ownerId === currentOwnerId)) {
      jsonResponse(res, { error: `移动云账号 ${user} 已存在，请勿重复添加！` }, 400);
      return;
    }

    try {
      const soho = new SohoClient({ accountType });
      await soho.login(user, pwd, accountType, verificationCode, randomCode);
      const vms = await soho.listCloudPcs();

      const newAcc = {
        id: 'yd_' + crypto.randomUUID().substring(0, 8),
        platform: 'ydpc',
        ownerId: currentOwnerId,
        name,
        user,
        password: pwd,
        accountType,
        keepaliveInterval,
        enabled: true,
        features: {
          keepAlive: true,
          controlPlaneKeepalive: true,
          mqttKeepAlive: true,
          dataPlaneKeepalive: true
          // autoBoot 走账号级/单机独立判定，省略即按默认口径（见 ydpc_client.js 的 _autoBootArmed）
        },
        vms,
        stats: {
          keepAliveStatus: 'online',
          lastKeepAliveTime: getBeijingTimeString(),
          vmStatus: vms[0]?.vmStatus || '未知',
          durationMode: vms[0]?.durationMode || 'permanent',
          remainHours: vms[0]?.remainHours || 0,
          remainText: vms[0]?.remainText || '♾️ 永久使用'
        },
        createdAt: new Date().toISOString()
      };

      appConfig.accounts.push(newAcc);
      saveConfig(appConfig);

      const client = getClient(newAcc);
      client.startKeepAliveWorker();

      appendLog('SOHO', `[${name}] 移动云账号添加成功，发现 ${vms.length} 台云主机，已自动启动保活守护`, 'success', name, 'ydpc');
      jsonResponse(res, { success: true, account: newAcc }, 201);
    } catch (e) {
      jsonResponse(res, { error: e.message || '移动云认证失败' }, 400);
    }
    return;
  }

  // 7.9 添加移动公众（ecloud）账号
  // ---------------------------------------------------------------
  // 与移动爱家/天翼云的添加流程**各自独立实现**（用户明令：三平台机制不重叠），
  // 也不共用 SOHO 或天翼云的登录客户端 —— 走的是移动公众自己的协议侧车。
  //
  // 移动公众登录可能是多步的（设备信任 / 双因素 / 增强短信），后台无法代答验证码，
  // 因此这里采用「先建临时待定登录、验证码回来后再落库」的两段式：
  //   POST /api/accounts/ecloud/add   → 直接成功则落库；需要短信则返回 pendingId
  //   POST /api/accounts/ecloud/login → 带 pendingId + code 完成并落库
  if (req.method === 'POST' && pathname === '/api/accounts/ecloud/add') {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未授权：请先登录或注册账号后再添加云电脑！' }, 401); return; }

    const currentOwnerId = session.userId;
    const currentUser = authManager.getUserById(currentOwnerId);
    if (currentUser && currentUser.role !== 'admin') {
      const currentOwned = appConfig.accounts.filter(a => a.ownerId === currentOwnerId).length;
      const userMax = currentUser.maxQuota || 2;
      if (currentOwned >= userMax) {
        jsonResponse(res, { error: `已达到云电脑添加配额上限（当前配额: ${userMax}台），无法继续添加！请联系管理员提高配额。` }, 400);
        return;
      }
    }

    const body = await parseJsonBodyLimited(req);
    const user = (body.user || '').trim();
    const pwd = (body.password || '').trim();
    const name = (body.name || user).trim();
    const keepaliveInterval = Math.max(60, parseInt(body.keepaliveInterval) || 300);

    if (!user || !pwd) { jsonResponse(res, { error: '移动公众账号与密码不能为空' }, 400); return; }
    if (appConfig.accounts.some(a => a.platform === 'ecloud' && a.user === user && a.ownerId === currentOwnerId)) {
      jsonResponse(res, { error: `移动公众账号 ${user} 已存在，请勿重复添加！` }, 400);
      return;
    }

    const accId = 'ec_' + crypto.randomUUID().substring(0, 8);
    const draftAcc = {
      id: accId,
      platform: 'ecloud',
      ownerId: currentOwnerId,
      name,
      user,
      password: pwd,
      keepaliveInterval,
      enabled: true,
      ecloudDeviceUid: crypto.randomUUID(),
      features: buildEcloudDefaultFeatures(),
      desktops: [],
      stats: { keepAliveStatus: 'offline', lastKeepAliveTime: '' },
      createdAt: new Date().toISOString()
    };

    try {
      const draftClient = new EcloudClient(draftAcc, {
        appendLog,
        sendNotification: sendAccountNotification,
        saveConfig: () => saveConfig(appConfig),
        resolveTaskEnabled: (account, desktop, taskType) => resolveTaskEnabled(account, desktop, taskType)
      });
      const r = await draftClient.loginInteractive(null, '');
      const status = r && r.status;

      if (status === 'success') {
        const desktops = await draftClient.refreshDesktops().catch(() => []);
        finalizeEcloudAccount(draftAcc, draftClient);
        appendLog(ECLOUD_LOG_SOURCE, `[${name}] 移动公众账号添加成功，发现 ${desktops.length} 台云电脑，已启动独立保活守护`, 'success', name, 'ecloud');
        jsonResponse(res, { success: true, account: draftAcc, desktops }, 201);
        return;
      }

      if (INTERACTIVE_BRANCHES.has(status)) {
        // 需要短信验证码：保留这次会话（含侧车内的登录中间态），等验证码回来再落库。
        draftClient.account = draftAcc;
        const mobile = (r && r.mobile) || '';
        registerPendingEcloudLogin(accId, { acc: draftAcc, client: draftClient, branch: status, mobile });
        appendLog(ECLOUD_LOG_SOURCE, `[${name}] 移动公众登录需要短信验证（分支 ${status}），正在下发验证码…`, 'warning', name, 'ecloud');

        // ⚠️ 必须真正发码：服务端**不会**因为密码登录要求二次验证就替我们发短信，
        // 官方客户端是在拿到 mobile 后自己再打一次发码接口。这里绝不"假定已发送"——
        // 发送结果如实回给前端，失败也要把原因说清楚（否则就是"界面让你输码但手机收不到"）。
        let smsSent = false;
        let smsError = '';
        try {
          await draftClient.loginSendSms(status, mobile);
          smsSent = true;
          appendLog(ECLOUD_LOG_SOURCE, `[${name}] 验证码已下发，等待用户输入（分支 ${status}）`, 'info', name, 'ecloud');
        } catch (smsErr) {
          smsError = smsErr.message || String(smsErr);
          appendLog(ECLOUD_LOG_SOURCE, `[${name}] 短信验证码下发失败: ${smsError}`, 'error', name, 'ecloud');
        }

        jsonResponse(res, {
          needVerification: true,
          pendingId: accId,
          branch: status,
          mobile,
          smsSent,
          smsError,
          message: smsSent
            ? '已下发短信验证码，请输入收到的验证码完成绑定。'
            : '账号需要短信验证，但验证码下发失败，请点击「重新发送验证码」重试。'
        }, 202);
        return;
      }

      // locked / failed
      jsonResponse(res, { error: (r && r.error) || `移动公众登录未成功（${status || '未知'}）` }, 400);
    } catch (e) {
      appendLog(ECLOUD_LOG_SOURCE, `[${name}] 添加移动公众账号失败: ${e.message}`, 'error', name, 'ecloud');
      jsonResponse(res, { error: e.message || '移动公众认证失败' }, 400);
    }
    return;
  }

  // 7.10 完成移动公众的短信验证并落库
  if (req.method === 'POST' && pathname === '/api/accounts/ecloud/login') {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未授权' }, 401); return; }

    const body = await parseJsonBodyLimited(req);
    const pendingId = (body.pendingId || '').trim();
    const code = (body.code || '').trim();
    const entry = pendingEcloudLogins.get(pendingId);
    if (!entry) { jsonResponse(res, { error: '待定登录已过期或不存在，请重新添加账号' }, 400); return; }
    if (entry.acc.ownerId !== session.userId) { jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403); return; }

    try {
      const r = await entry.client.loginInteractive(entry.branch, code, {
        mobile: body.mobile || entry.mobile,
        isTemporary: !!body.isTemporary
      });
      if (r && r.status === 'success') {
        pendingEcloudLogins.delete(pendingId);
        const desktops = await entry.client.refreshDesktops().catch(() => []);
        finalizeEcloudAccount(entry.acc, entry.client);
        appendLog(ECLOUD_LOG_SOURCE, `[${entry.acc.name}] 短信验证通过，移动公众账号添加成功（${desktops.length} 台云电脑）`, 'success', entry.acc.name, 'ecloud');
        jsonResponse(res, { success: true, account: entry.acc, desktops }, 201);
        return;
      }
      jsonResponse(res, { error: (r && r.error) || `验证未通过（${r && r.status}）` }, 400);
    } catch (e) {
      jsonResponse(res, { error: e.message || '短信验证失败' }, 400);
    }
    return;
  }

  // 7.10b 重新下发移动公众短信验证码
  //   验证码过期/未收到时的**唯一出路**：若让用户"删号重加"，会再走一次密码登录，
  //   而交互登录有 10 分钟 / 3 次限流（login_rate_limit），很容易把自己锁在门外。
  if (req.method === 'POST' && pathname === '/api/accounts/ecloud/resend') {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未授权' }, 401); return; }

    const body = await parseJsonBodyLimited(req);
    const pendingId = (body.pendingId || '').trim();
    const entry = pendingEcloudLogins.get(pendingId);
    if (!entry) { jsonResponse(res, { error: '待定登录已过期或不存在，请重新添加账号' }, 400); return; }
    if (entry.acc.ownerId !== session.userId) { jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403); return; }

    const mobile = (body.mobile || entry.mobile || '').trim();
    try {
      await entry.client.loginSendSms(entry.branch, mobile);
      if (mobile) entry.mobile = mobile;
      jsonResponse(res, { success: true, mobile: entry.mobile || '', branch: entry.branch });
    } catch (e) {
      appendLog(ECLOUD_LOG_SOURCE, `[${entry.acc.name}] 重新下发验证码失败: ${e.message}`, 'error', entry.acc.name, 'ecloud');
      jsonResponse(res, { error: e.message || '验证码下发失败' }, 400);
    }
    return;
  }

  // 7.11 手动触发一次移动公众保活（与自动巡检走同一条代码路径，便于排障）
  if (req.method === 'POST' && pathname === '/api/accounts/ecloud/keepalive') {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未授权' }, 401); return; }
    const body = await parseJsonBodyLimited(req).catch(() => ({}));
    const acc = appConfig.accounts.find(a => a.id === body.accountId && a.platform === 'ecloud');
    if (!acc) { jsonResponse(res, { error: '未找到该移动公众账号' }, 404); return; }
    if (!canUserAccessAccount(session, acc)) { jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403); return; }
    const client = getClient(acc);
    try {
      const out = await client.runKeepAliveOnce();
      jsonResponse(res, { success: true, result: out, liveMetrics: client.metrics });
    } catch (e) {
      jsonResponse(res, { error: e.message || '移动公众保活执行失败' }, 400);
    }
    return;
  }

  // 8. 添加天翼云账号（包含：必须登录 + 强配额限制 + 真实登录校验）
  if (req.method === 'POST' && pathname === '/api/accounts') {
    const session = getSessionFromReq(req);
    // 未登录访客严禁添加云电脑！
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录或注册账号后再添加云电脑！' }, 401);
      return;
    }

    const currentOwnerId = session.userId;
    const currentUser = authManager.getUserById(currentOwnerId);

    // 配额限制判断：普通用户受配额上限约束，管理员无限制
    if (currentUser && currentUser.role !== 'admin') {
      const currentOwned = appConfig.accounts.filter(a => a.ownerId === currentOwnerId).length;
      const userMax = currentUser.maxQuota || 2;
      if (currentOwned >= userMax) {
        jsonResponse(res, {
          error: `已达到云电脑添加配额上限（当前配额: ${userMax}台），无法继续添加！请联系管理员提高配额。`
        }, 400);
        return;
      }
    }

    const body = await parseJsonBodyLimited(req);
    const user = (body.user || '').trim();
    const pwd = (body.password || '').trim();
    const name = (body.name || user).trim();
    const devCode = (body.deviceCode || '').trim() || generateDeviceCode();

    const captchaCode = (body.captchaCode || '').trim();
    const challengeId = (body.challengeId || '').trim();
    const challengeCode = (body.challengeCode || '').trim();

    if (!user || !pwd) {
      jsonResponse(res, { error: '账号和密码不能为空' }, 400);
      return;
    }

    if (!captchaCode || !challengeId || !challengeCode) {
      jsonResponse(res, { error: '图形验证码已失效或未填写，请刷新验证码后重试！' }, 400);
      return;
    }

    appendLog('Auth', `正在严格校验天翼云账号密码真实性: ${user} ...`, 'info');

    const tempAccount = { user, password: pwd, deviceCode: devCode, platform: 'ctyun' };
    const tempClient = new CtYunClient(tempAccount);
    const logRes = await tempClient.loginWithCaptcha(captchaCode, challengeId, challengeCode);

    if (!logRes.success) {
      appendLog('Auth', `[${name}] 登录校验被拒绝: ${logRes.error}`, 'error');
      jsonResponse(res, { error: logRes.error || '验证码或账号密码错误，请检查！' }, 400);
      return;
    }

    const loginData = logRes.data;
    const isBound = !!loginData.bondedDevice;
    appendLog('Auth', `[${name}] 🎉 真实登录校验通过！用户ID: ${loginData.userId}，设备绑定: ${isBound ? '已就绪' : '待短信验证'}`, 'success');

    const id = crypto.randomUUID().substring(0, 8);
    const newAcc = {
      id,
      platform: 'ctyun',
      ownerId: currentOwnerId,
      name,
      user,
      password: pwd,
      deviceCode: devCode,
      savedLoginInfo: loginData,
      displayConfig: {
        width: 2560,
        height: 1440,
        scale: 150
      },
      enabled: true,
      bound: isBound,
      sessionExpired: false,
      features: {
        keepAlive: true,
        autoSign: true,
        aiChat: true,
        cloudHang: false,
        autoRedeem: false,
        // 2026-09-28：移动云自动开机守护默认开启（用户拍板）；关闭请显式关开关。
        autoBoot: true
      },
      redeemConfig: {
        enabled: false,
        targetType: 'redeem',
        desktopId: '',
        desktopName: '',
        prodId: 17023101,
        prodName: '8C16G升配包1天 (500积分)',
        prodType: 'pointstplupgrade',
        costPoints: 500,
        maxRedeemTimes: 0,
        scheduleType: 'monthly_days',
        monthlyDays: [-1],
        intervalDays: 1,
        lastRedeemDate: ''
      },
      stats: {
        lastSignTime: '',
        lastAiChatTime: '',
        lastHangTime: '',
        hangMinutesToday: 0,
        points: 0,
        keepAliveStatus: 'online',
        lastError: ''
      }
    };

    appConfig.accounts.push(newAcc);
    saveConfig(appConfig);

    const client = getClient(newAcc);
    client.loginInfo = loginData;
    client.startKeepAliveWorker();

    jsonResponse(res, newAcc, 201);
    return;
  }

  // 8.8 单台云电脑独立特性开关切换 API (支持移动云 VM 与天翼云 Desktop 独立保活与开机控制)
  if (req.method === 'PUT' && pathname.match(/^\/api\/accounts\/([^\/]+)\/vm-feature$/)) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    const match = pathname.match(/^\/api\/accounts\/([^\/]+)\/vm-feature$/);
    const accId = match[1];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (session.role !== 'admin' && acc.ownerId !== session.userId) {
      jsonResponse(res, { error: '权限不足：无法操作属于其他用户的云电脑' }, 403);
      return;
    }

    const body = await parseJsonBodyLimited(req);
    const vmKey = String(body.vmId || body.desktopId || body.userServiceId || '');
    const featureName = body.feature; // 'keepaliveEnabled' | 'autoBootEnabled' | 'taskEnabled' | 'keepaliveInterval'
    // （数据面保活是账号级 features.dataPlaneKeepalive，在「自动化保活开关」区，不走单机 toggle）

    if (!vmKey || !['keepaliveEnabled', 'autoBootEnabled', 'taskEnabled', 'keepaliveInterval'].includes(featureName)) {
      jsonResponse(res, { error: '参数错误：必须提供有效的 vmId 与 feature' }, 400);
      return;
    }

    // 【2026-09-23 修订】移动云【自动开机守护】开关已恢复放行。
    // 开机能力改走 CAG HTTPS 干净通道（app/ydpc/cag_boot.js）：账号自有 firm-auth 凭据、
    // RSA 公钥动态获取、保留 TLS 证书校验，不伪造客户端身份。
    // 伪造身份 / 硬编码第三方凭据 / 关证书 等红线仍由回归组 7 机械拦截。

    let finalValue = body.value;
    if (featureName === 'keepaliveInterval') {
      const num = parseInt(body.value);
      finalValue = (!isNaN(num) && num > 0) ? num : null;
    } else {
      finalValue = body.value !== false;
    }

    let updatedTarget = null;
    if (acc.platform === 'ydpc') {
      acc.vms = acc.vms || [];
      const targetVm = acc.vms.find(v => String(v.userServiceId) === vmKey);
      if (targetVm) {
        targetVm[featureName] = finalValue;
        updatedTarget = targetVm;
      }
    } else if (acc.platform === 'ecloud') {
      // 移动公众的每台云电脑以 instanceId 为主键（与 ydpc 的 userServiceId 各自独立）
      acc.desktops = acc.desktops || [];
      const targetDesktop = acc.desktops.find(d => String(d.instanceId) === vmKey);
      if (targetDesktop) {
        targetDesktop[featureName] = finalValue;
        updatedTarget = targetDesktop;
      }
    } else {
      acc.desktops = acc.desktops || [];
      const targetDesktop = acc.desktops.find(d => String(d.desktopId || d.objId) === vmKey);
      if (targetDesktop) {
        targetDesktop[featureName] = finalValue;
        updatedTarget = targetDesktop;
      }
    }

    saveConfig(appConfig);
    const client = getClient(acc);
    if (acc.platform === 'ydpc' && client && client.account) {
      client.account.vms = acc.vms;
    } else if (acc.platform === 'ecloud' && client && client.account) {
      client.account.desktops = acc.desktops;
    } else if (client && client.account) {
      client.account.desktops = acc.desktops;
    }

    // 若当前正在执行该主机的挂机任务且用户关闭了任务开关，立即安全释放当前长连接
    if (featureName === 'taskEnabled' && finalValue === false && client && client.isTaskHanging) {
      if (String(client.metrics?.desktopId) === String(vmKey)) {
        if (client.endCurrentSession) {
          client.endCurrentSession('User Disabled Task on Active Desktop');
        }
      }
    }

    let featureCn = '单机属性';
    if (featureName === 'keepaliveEnabled') featureCn = '独立保活';
    else if (featureName === 'taskEnabled') featureCn = '自动化任务';
    else if (featureName === 'autoBootEnabled') featureCn = '自动开机';
    else if (featureName === 'keepaliveInterval') featureCn = `独立保活周期 (${finalValue ? Math.round(finalValue/60) + '分钟' : '继承账号默认'})`;

    appendLog('System', `[${acc.name}] 已将云主机 [${vmKey}] 的【${featureCn}】更新为: ${finalValue ? (typeof finalValue === 'boolean' ? '开启' : finalValue + '秒') : '关闭/继承'}`, 'info');
    jsonResponse(res, { success: true, target: updatedTarget, account: acc });
    return;
  }

  // 9. 更新账号
  if (req.method === 'PUT' && pathname.startsWith('/api/accounts/')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权修改该云电脑账号' }, 403);
      return;
    }

    const body = await parseJsonBodyLimited(req);
    if (body.name) acc.name = body.name;
    if (body.user) acc.user = body.user;
    if (body.password) acc.password = body.password;
    if (body.accountType) acc.accountType = body.accountType;
    if (body.keepaliveInterval) acc.keepaliveInterval = body.keepaliveInterval;
    if (body.deviceCode) acc.deviceCode = body.deviceCode;
    if (body.displayConfig) acc.displayConfig = { ...acc.displayConfig, ...body.displayConfig };
    if (typeof body.enabled === 'boolean') acc.enabled = body.enabled;
    if (typeof body.bound === 'boolean') acc.bound = body.bound;
    if (body.features) acc.features = { ...acc.features, ...body.features };
    if (body.redeemConfig) acc.redeemConfig = { ...acc.redeemConfig, ...body.redeemConfig };
    if (body.stats) acc.stats = { ...acc.stats, ...body.stats };

    // 移动云电脑：重新同步云主机列表与时长状态
    if (acc.platform === 'ydpc') {
      const client = getClient(acc);
      if (body.accountType) client.sohoClient.accountType = body.accountType;
      await client.refreshVms().catch(() => {});
    }

    // 移动公众：重新同步桌面列表（会话失效时会尝试恢复/重登，需短信验证时如实上报）
    if (acc.platform === 'ecloud') {
      const client = getClient(acc);
      await client.refreshDesktops().catch(() => {});
    }

    // 用户在界面上明确手动开启了保活开关：解除 manualShutdown 关机阻断
    if (body.features && body.features.keepAlive === true) {
      acc.manualShutdown = false;
    }

    // 支持输入验证码重新激活登录
    if (body.captchaCode && body.challengeId && body.challengeCode) {
      appendLog('Auth', `[${acc.name}] 正在提交用户输入的验证码重新校验天翼云登录态...`, 'info');
      const client = getClient(acc);
      const logRes = await client.loginWithCaptcha(body.captchaCode, body.challengeId, body.challengeCode);
      if (!logRes.success) {
        jsonResponse(res, { error: logRes.error || '验证码或密码校验失败' }, 400);
        return;
      }
      acc.bound = !!logRes.data.bondedDevice;
      acc.sessionExpired = false;
      appendLog('Auth', `[${acc.name}] 🎉 重新验证登录成功，凭证已刷新！`, 'success');
      // 立即同步官方任务中心与积分，确保前端看板即时呈现
      await client.refreshOfficialTasks();
    }

    saveConfig(appConfig);
    appendLog('System', `已更新账号配置: ${acc.name}`, 'info');

    const client = getClient(acc);

    // 如果用户关闭了挂机开关，若当前正处于挂机长连接会话中，立即主动断开并转入脉冲休眠
    if (body.features && body.features.cloudHang === false) {
      if (client.endCurrentSession) {
        client.endCurrentSession('User Disabled Hang Mode');
      }
      if (client.clearHangRetry) {
        client.clearHangRetry();
      }
    }

    if (acc.enabled && acc.features?.keepAlive === true) {
      if (!client.workerRunning) client.startKeepAliveWorker();
    } else {
      client.stopKeepAliveWorker();
    }

    jsonResponse(res, acc);
    return;
  }

  // 10. 管理员手动触发全量定时调度流程 API (立即以当前开关状态跑一遍)
  if (req.method === 'POST' && pathname === '/api/scheduler/trigger') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    if (session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅管理员可手动触发全局调度流程' }, 403);
      return;
    }

    if (taskScheduler) {
      taskScheduler.runAllAccounts('manual_trigger');
      jsonResponse(res, { success: true, message: '全局定时任务流程已触发启动，请在控制台查看执行输出' });
    } else {
      jsonResponse(res, { error: '调度器实例未初始化' }, 500);
    }
    return;
  }

  // 10. 删除账号
  if (req.method === 'DELETE' && pathname.startsWith('/api/accounts/')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权删除该云电脑账号' }, 403);
      return;
    }

    const idx = appConfig.accounts.findIndex(a => a.id === accId);
    if (idx >= 0) {
      const deleted = appConfig.accounts.splice(idx, 1)[0];
      const client = clientInstances.get(accId);
      if (client) client.stopKeepAliveWorker();
      clientInstances.delete(accId);

      saveConfig(appConfig);
      appendLog('System', `已删除账号: ${deleted.name}`, 'warning');
      jsonResponse(res, { success: true });
    } else {
      jsonResponse(res, { error: '账号不存在' }, 404);
    }
    return;
  }

  // 10.5 代理获取天翼云官方图形验证码与挑战数据 (人工输码模式)
  if (req.method === 'GET' && pathname.startsWith('/api/captcha/')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const phone = pathname.split('/')[3] || '';
    const deviceCode = (parsedUrl.searchParams.get('deviceCode') || '').trim() || generateDeviceCode();

    try {
      // 1. 获取 Challenge Code
      const chalRes = await fetch('https://desk.ctyun.cn:8810/api/auth/client/genChallengeData', {
        method: 'POST',
        headers: {
          'ctg-devicetype': '60',
          'ctg-version': '103020001',
          'ctg-devicecode': deviceCode,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      const chalData = await chalRes.json();
      if (chalData.code !== 0) throw new Error(chalData.msg || '获取验证码挑战失败');

      const { challengeCode, challengeId } = chalData.data;

      // 2. 拉取官方图形验证码图片流并转为 Base64
      const capUrl = `https://desk.ctyun.cn:8810/api/auth/client/captcha?height=36&width=85&userInfo=${encodeURIComponent(phone)}&mode=auto&_t=${Date.now()}`;
      const capRes = await fetch(capUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
          'ctg-devicetype': '60',
          'ctg-version': '103020001',
          'ctg-devicecode': deviceCode,
          'referer': 'https://pc.ctyun.cn/'
        }
      });
      const imgBuf = Buffer.from(await capRes.arrayBuffer());
      const base64Img = `data:image/jpeg;base64,${imgBuf.toString('base64')}`;

      jsonResponse(res, {
        success: true,
        challengeCode,
        challengeId,
        deviceCode,
        captchaImage: base64Img
      });
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 10.6 生成天翼云官方 App 扫码登录二维码 API
  if (req.method === 'POST' && pathname === '/api/account/qrcode/generate') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录后再操作' }, 401);
      return;
    }

    const devCode = generateDeviceCode();
    const tempClient = new CtYunClient({ deviceCode: devCode, user: 'qrcode_temp' });
    try {
      const qrData = await tempClient.genQrCode();
      jsonResponse(res, {
        success: true,
        deviceCode: devCode,
        qrCodeId: qrData.qrCodeId,
        qrUrl: qrData.qrUrl
      });
    } catch (e) {
      jsonResponse(res, { error: e.message || '生成官方二维码失败' }, 500);
    }
    return;
  }

  // 10.7 轮询天翼云官方 App 扫码状态 API
  if (req.method === 'GET' && pathname === '/api/account/qrcode/status') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录后再操作' }, 401);
      return;
    }

    const qrCodeId = parsedUrl.searchParams.get('qrCodeId');
    const deviceCode = parsedUrl.searchParams.get('deviceCode') || generateDeviceCode();
    const accountName = (parsedUrl.searchParams.get('accountName') || '').trim();
    const targetAccId = parsedUrl.searchParams.get('accId');

    if (!qrCodeId) {
      jsonResponse(res, { error: '缺少 qrCodeId 参数' }, 400);
      return;
    }

    const tempClient = new CtYunClient({ deviceCode, user: 'qrcode_temp' });
    try {
      const statusRes = await tempClient.getQrCodeStatus(qrCodeId);
      if (statusRes.codeStatus === 'authorize' && statusRes.loginToken) {
        appendLog('Auth', `[扫码登录] 手机端已授权确认，正在换取正式登录凭据...`, 'info');
        const loginData = await tempClient.loginByToken(statusRes.loginToken);
        const userPhone = loginData.mobilephone || loginData.userName || '已扫码账号';
        const finalName = accountName || `天翼账号_${userPhone.slice(-4)}`;
        const currentOwnerId = session.userId;

        // 检查是否为已有账号重新扫码授权 (通过 accId 指定或同用户同手机号)
        let existingAcc = null;
        if (targetAccId) {
          existingAcc = appConfig.accounts.find(a => a.id === targetAccId && a.ownerId === currentOwnerId);
        }
        if (!existingAcc) {
          existingAcc = appConfig.accounts.find(a => (a.user === userPhone || a.user === userPhone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')) && a.ownerId === currentOwnerId && a.platform !== 'ydpc');
        }

        if (existingAcc) {
          existingAcc.user = userPhone;
          existingAcc.deviceCode = deviceCode;
          existingAcc.savedLoginInfo = loginData;
          existingAcc.sessionExpired = false;
          existingAcc.bound = true;
          if (accountName) existingAcc.name = accountName;
          saveConfig(appConfig);

          const client = getClient(existingAcc);
          client.loginInfo = loginData;
          client.account.sessionExpired = false;
          client.startKeepAliveWorker();

          appendLog('Auth', `[${existingAcc.name}] 🎉 官方扫码重新授权成功！已恢复在线保活。`, 'success', existingAcc.name, 'ctyun');
          jsonResponse(res, {
            success: true,
            codeStatus: 'authorize',
            account: existingAcc,
            isReAuth: true
          });
          return;
        }

        // 新建账号前检查普通用户配额
        const currentUser = authManager.getUserById(currentOwnerId);
        if (currentUser && currentUser.role !== 'admin') {
          const currentOwned = appConfig.accounts.filter(a => a.ownerId === currentOwnerId).length;
          const userMax = currentUser.maxQuota || 2;
          if (currentOwned >= userMax) {
            jsonResponse(res, {
              error: `已达到云电脑添加配额上限（当前配额: ${userMax}台），无法继续添加！请联系管理员提高配额。`
            }, 400);
            return;
          }
        }

        const id = 'ct_' + crypto.randomUUID().substring(0, 8);
        const newAcc = {
          id,
          platform: 'ctyun',
          ownerId: currentOwnerId,
          name: finalName,
          user: userPhone,
          password: '',
          deviceCode,
          savedLoginInfo: loginData,
          displayConfig: { width: 2560, height: 1440, scale: 150 },
          enabled: true,
          bound: true,
          sessionExpired: false,
          features: {
            keepAlive: true,
            autoSign: true,
            aiChat: true,
            cloudHang: false,
            autoRedeem: false,
            // 2026-09-28：移动云自动开机守护默认开启（用户拍板）
            autoBoot: true
          },
          redeemConfig: {
            enabled: false,
            targetType: 'redeem',
            desktopId: '',
            desktopName: '',
            prodId: 17023101,
            prodName: '8C16G升配包1天 (500积分)',
            prodType: 'pointstplupgrade',
            costPoints: 500,
            maxRedeemTimes: 0,
            scheduleType: 'monthly_days',
            monthlyDays: [-1],
            intervalDays: 1,
            lastRedeemDate: ''
          },
          stats: {
            lastSignTime: '',
            lastAiChatTime: '',
            lastHangTime: '',
            hangMinutesToday: 0,
            points: 0,
            keepAliveStatus: 'online',
            lastError: ''
          }
        };

        appConfig.accounts.push(newAcc);
        saveConfig(appConfig);

        const client = getClient(newAcc);
        client.loginInfo = loginData;
        client.startKeepAliveWorker();

        appendLog('Auth', `[${finalName}] 🎉 官方扫码授权成功！已绑定并上线保活。`, 'success');
        jsonResponse(res, {
          success: true,
          codeStatus: 'authorize',
          account: newAcc
        });
        return;
      }

      jsonResponse(res, {
        success: true,
        codeStatus: statusRes.codeStatus
      });
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 11. 生成设备码
  if (req.method === 'POST' && pathname === '/api/device/generate') {
    jsonResponse(res, { deviceCode: generateDeviceCode() });
    return;
  }

  // 12.1 获取设备绑定短信流程的图形验证码 (严格对齐官方 /api/auth/client/validateCode/captcha 链路)
  if (req.method === 'GET' && pathname.match(/^\/api\/accounts\/[^\/]+\/sms-captcha$/)) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }
    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该云电脑账号' }, 403);
      return;
    }

    const client = getClient(acc);
    try {
      const timestamp = Date.now();
      const capUrl = `https://desk.ctyun.cn:8810/api/auth/client/validateCode/captcha?width=120&height=40&_t=${timestamp}`;
      const capRes = await fetch(capUrl, { headers: client.getSignedHeaders() });
      if (!capRes.ok) throw new Error(`获取短信图验失败: HTTP ${capRes.status}`);
      const captchaKey = capRes.headers.get('ctg-captcha-key') || capRes.headers.get('CTG-CAPTCHA-KEY') || '';
      const imgBuf = Buffer.from(await capRes.arrayBuffer());
      const base64Img = `data:image/jpeg;base64,${imgBuf.toString('base64')}`;
      jsonResponse(res, { success: true, captchaImage: base64Img, captchaKey });
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 12. 发送短信验证码 (需先通过官方图形验证码校验，并透传 ctg-sms-key)
  if (req.method === 'POST' && pathname.includes('/send-sms')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该云电脑账号' }, 403);
      return;
    }

    const body = await parseJsonBodyLimited(req);
    const captchaCode = (body.captchaCode || '').trim();
    const captchaCodeKey = (body.captchaKey || '').trim();
    if (!captchaCode) {
      jsonResponse(res, { error: '请先输入图形验证码后再获取短信验证码！' }, 400);
      return;
    }

    const client = getClient(acc);
    try {
      appendLog('Auth', `[${acc.name}] 正在请求天翼云下发设备绑定验证码...`, 'info');
      let url = `https://desk.ctyun.cn:8810/api/cdserv/client/device/getSmsCode?mobilePhone=${acc.user}&captchaCode=${encodeURIComponent(captchaCode)}`;
      if (captchaCodeKey) {
        url += `&captchaCodeKey=${encodeURIComponent(captchaCodeKey)}`;
      }
      const resSms = await fetch(url, { headers: client.getSignedHeaders() });
      const dataSms = await resSms.json();
      const smsKey = resSms.headers.get('ctg-sms-key') || resSms.headers.get('CTG-SMS-KEY') || '';
      if (dataSms.code === 0 || dataSms.code === 200) {
        if (smsKey) {
          acc._smsCodeKey = smsKey;
          saveConfig(appConfig);
        }
        appendLog('Auth', `[${acc.name}] 短信验证码已发送至手机 ${acc.user}`, 'success');
        jsonResponse(res, { success: true, message: '验证码发送成功' });
      } else {
        appendLog('Auth', `[${acc.name}] 发送短信失败: ${dataSms.msg}`, 'error');
        jsonResponse(res, { error: dataSms.msg || '发送短信失败' }, 400);
      }
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 13. 绑定短信验证码
  if (req.method === 'POST' && pathname.includes('/bind-sms')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该云电脑账号' }, 403);
      return;
    }

    const body = await parseJsonBodyLimited(req);
    const code = (body.verificationCode || '').trim();
    if (!code) {
      jsonResponse(res, { error: '验证码不能为空' }, 400);
      return;
    }
    const client = getClient(acc);
    try {
      const smsCodeKey = (body.smsCodeKey || acc._smsCodeKey || '').trim();
      const form = new URLSearchParams({
        verificationCode: code,
        deviceName: 'Chrome浏览器',
        deviceCode: acc.deviceCode || '',
        deviceModel: 'Windows NT 10.0; Win64; x64',
        sysVersion: 'Windows NT 10.0; Win64; x64',
        appVersion: '3.2.0',
        hostName: 'pc.ctyun.cn',
        deviceInfo: 'Win32'
      });
      if (smsCodeKey) {
        form.append('smsCodeKey', smsCodeKey);
      }
      const bindRes = await fetch('https://desk.ctyun.cn:8810/api/cdserv/client/device/binding', {
        method: 'POST',
        headers: { ...client.getSignedHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      });
      const bindData = await bindRes.json();
      if (bindData.code === 0 || bindData.code === 200) {
        acc.bound = true;
        delete acc._smsCodeKey;
        // 同步会话态：官方已信任本设备，免密凭据 (genLoginToken/tokenLogin) 与静默续期自此恢复可用
        if (client.loginInfo) {
          client.loginInfo.bondedDevice = true;
        }
        saveConfig(appConfig);
        appendLog('Auth', `[${acc.name}] 恭喜！新设备验证通过，设备码永久信任！每日签到与静默续期已全面恢复。`, 'success');
        client.startKeepAliveWorker();
        jsonResponse(res, { success: true, message: '设备绑定成功！' });
      } else {
        appendLog('Auth', `[${acc.name}] 设备绑定失败: ${bindData.msg}`, 'error');
        jsonResponse(res, { error: bindData.msg || '绑定失败' }, 400);
      }
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 14. 手动执行真实任务 (真机自动化无头执行)
  if (req.method === 'POST' && pathname.includes('/run/')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const parts = pathname.split('/');
    const accId = parts[3];
    const taskType = parts[5];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该云电脑账号' }, 403);
      return;
    }

    const client = getClient(acc);

    try {
      if (taskType === 'sign') {
        executeNativeSign(client, acc, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async (signRes) => {
            // 只有官方任务中心确认达成，才更新完成时间并推送成功通知，绝不虚报
            if (signRes && signRes.isCompleted) {
              await client.refreshOfficialTasks();
              saveConfig(appConfig);
              sendAccountNotification(
                acc,
                `✅ 登录打卡达成 - ${acc.name}`,
                `账号【${acc.name}】今日登录AI云电脑任务已完成，100 积分已到账！`
              );
            } else if (signRes && signRes.pendingVerify) {
              appendLog('Sign', `[${acc.name}] 打卡认领已下发，官方尚未确认。已安排跨分钟复检 (期间不会重复认领，不会打扰客户端)。`, 'info');
            }
          })
          .catch(err => appendLog('Sign', `[${acc.name}] 打卡执行异常: ${err.message}`, 'error'));

        // 中性返回：认领下发 ≠ 任务达成。原先此处直接回"指令已下发"并被前端渲染为成功，
        // 是历史上"页面显示成功、实际没有积分"的直接来源。
        jsonResponse(res, { message: `[${acc.name}] 打卡流程已启动：认领后需等待官方任务中心确认，系统会自动复检。请稍后刷新查看结果。` });
        return;

      } else if (taskType === 'aiChat') {
        executeNativeAiChat(client, acc, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async () => {
            const r = await client.refreshOfficialTasks();
            const t = (client.metrics.officialTasks || []).find(x => x.name.includes('AI对话'));
            const done = !!(t && (t.status === 2 || (t.total > 0 && t.current >= t.total)));
            if (done) {
              saveConfig(appConfig);
              sendAccountNotification(
                acc,
                `🤖 AI对话任务达成 - ${acc.name}`,
                `账号【${acc.name}】今日AI智能对话任务已完成，100 积分已入账！`
              );
            } else if (r && r.ok === false) {
              appendLog('AIChat', `[${acc.name}] ⚠️ AI 对话请求已发出，但官方任务中心不可读 (${r.reason})，无法核对是否计入。请稍后手动刷新确认。`, 'warning');
            } else {
              appendLog('AIChat', `[${acc.name}] ⚠️ AI 对话请求已发出，但官方任务中心暂未显示达成 (落账可能有延迟)。本次不判定为完成。`, 'warning');
            }
          })
          .catch(err => appendLog('AIChat', `[${acc.name}] AI 对话任务异常: ${err.message}`, 'error'));

        jsonResponse(res, { message: `[${acc.name}] AI 对话已启动，结果以官方任务中心为准，请稍后刷新查看。` });
        return;

      } else if (taskType === 'hang') {
        executeNativeHang(client, acc, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async () => {
            const r = await client.refreshOfficialTasks();
            const t = (client.metrics.officialTasks || []).find(x => x.name.includes('使用1小时'));
            const done = !!(t && (t.status === 2 || (t.total > 0 && t.current >= t.total)));
            const curMin = t ? Math.floor((t.current || 0) / 60) : 0;
            if (done) {
              saveConfig(appConfig);
              appendLog('Hang', `[${acc.name}] ✅ 官方任务中心已确认今日挂机 1 小时达成。`, 'success');
              sendAccountNotification(
                acc,
                `🎉 挂机1小时任务达成 - ${acc.name}`,
                `账号【${acc.name}】今日使用 AI 云电脑达到 1 小时任务已完成，100 积分已入账！`
              );
            } else if (r && r.ok === false) {
              appendLog('Hang', `[${acc.name}] ⚠️ 官方任务中心不可读 (${r.reason})，无法核对挂机进度。本次不判定。`, 'warning');
            } else {
              // 原先此处无条件写入 lastHangTime，导致数据模型虚报"今日已执行挂机"
              appendLog('Hang', `[${acc.name}] 本次挂机阶段结束，官方进度 ${curMin}/60 分钟，尚未达成。已按其自愈机制安排续跑。`, 'info');
            }
          })
          .catch(err => appendLog('Hang', `[${acc.name}] 挂机守护异常: ${err.message}`, 'error'));

        jsonResponse(res, { message: `[${acc.name}] 挂机守护已启动，进度以官方任务中心为准，请稍后刷新查看。` });
        return;

      } else if (taskType === 'redeem') {
        appendLog('Redeem', `[${acc.name}] 正在拉取天翼云商城最新真实奖品...`, 'info');
        const list = await client.getRewards();
        appendLog('Redeem', `[${acc.name}] 商城连通正常，获取到 ${list.length} 种最新可兑换商品`, 'success');
        jsonResponse(res, { message: `[${acc.name}] 商城查询成功，当前共有 ${list.length} 种商品` });
        return;
      }
    } catch (e) {
      appendLog('Task', `[${acc.name}] 任务执行失败: ${e.message}`, 'error');
      jsonResponse(res, { error: e.message }, 500);
      return;
    }
  }

  // 14. 前台网页操作云电脑生命周期与心跳探活接口
  if (req.method === 'POST' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/web-active')) {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, { error: '未授权' }, 401);
      return;
    }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (acc && canUserAccessAccount(session, acc)) {
      const client = getClient(acc);
      // 保持避让：只要前台网页还在打开操作，每次心跳刷新避让有效期 (延长 15 秒)
      client.yieldToWebUser(0.25);
      jsonResponse(res, { success: true, active: true });
    } else {
      jsonResponse(res, { error: '账号不存在或无权访问' }, 404);
    }
    return;
  }

  // 前台网页关闭时触发的恢复接口
  if (req.method === 'POST' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/web-close')) {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, { error: '未授权' }, 401);
      return;
    }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (acc && canUserAccessAccount(session, acc)) {
      const client = getClient(acc);
      client.resumeFromWebUser();
      jsonResponse(res, { success: true, resumed: true });
    } else {
      jsonResponse(res, { error: '账号不存在或无权访问' }, 404);
    }
    return;
  }

  // 15. 获取真实商品列表
  if (req.method === 'GET' && pathname === '/api/rewards') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    let dynamicRewards = null;
    let allowedAccounts = appConfig.accounts;
    if (session.role !== 'admin') {
      allowedAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
    }

    for (const acc of allowedAccounts) {
      try {
        const client = getClient(acc);
        const list = await client.getRewards();
        if (list && list.length > 0) {
          dynamicRewards = list;
          break;
        }
      } catch (e) {}
    }

    if (dynamicRewards && dynamicRewards.length > 0) {
      jsonResponse(res, dynamicRewards);
      return;
    }

    const fallback = [
      { prodId: 17023101, prodName: '8C16G升配包1天', costPoints: 500, prodType: 'pointstplupgrade', description: '可将AI云电脑升配至8C16G，最多支持兑换365天；月末兑换可维持长期8C16G' },
      { prodId: 17023111, prodName: '16C32G升配包1天', costPoints: 1000, prodType: 'pointstplupgrade', description: '可将AI云电脑（政企版）升配至16C32G，最多支持兑换365天' },
      { prodId: 17020101, prodName: 'AI应用中心高级版 (1个月)', costPoints: 1000, prodType: 'cpcai', description: '权益：支持DeepSeek满血版、专属智库等，有效期1个月' },
      { prodId: 17010101, prodName: '专属智库1G存储空间', costPoints: 1000, prodType: 'cpcai', description: '基于当前AI应用中心存储空间，叠加1G存储空间，每月限兑5次' },
      { prodId: 17024101, prodName: '1G数据盘永久扩容', costPoints: 1200, prodType: 'pointsdiskupgrade', description: '兑换后，将自动创建1个新数据盘，最大不超过500GB' }
    ];
    jsonResponse(res, fallback);
    return;
  }

  // 16. 获取云电脑列表
  if (req.method === 'GET' && pathname.includes('/desktops')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权查看该云电脑设备' }, 403);
      return;
    }

    const client = getClient(acc);
    try {
      const list = await client.getDesktops();
      const formatted = list.map(d => ({
        desktopId: d.objId || d.desktopId,
        desktopName: d.objName || d.desktopName || '云电脑',
        prodInstId: d.prodInstId || '',
        useStatusText: d.useStatusText || '运行中'
      }));
      jsonResponse(res, formatted);
    } catch (e) {
      jsonResponse(res, []);
    }
    return;
  }

  // 获取云电脑 Web 直达访问参数 API (包括目标页面 URL、设备码与免密凭证信息)
  if (req.method === 'GET' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/web-launch')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权访问该账号' }, 403);
      return;
    }

    const client = getClient(acc);
    try {
      // 确保已登录并拿到天翼云认证凭据
      if (!client.loginInfo) {
        await client.login();
      }
      const desktops = await client.getDesktops();
      if (!desktops || desktops.length === 0) {
        jsonResponse(res, { error: '未检测到可用云电脑' }, 400);
        return;
      }
      const requestedDesktopId = parsedUrl.searchParams.get('desktopId');
      let desktop = desktops[0];
      if (requestedDesktopId) {
        const matched = desktops.find(d => String(d.objId || d.desktopId) === String(requestedDesktopId));
        if (matched) desktop = matched;
      }
      const objId = desktop.objId || desktop.desktopId;
      const b64Id = Buffer.from(String(objId)).toString('base64');
      const targetUrl = `https://pc.ctyun.cn/#/desktop?id=${encodeURIComponent(b64Id)}`;

      const displayCfg = acc.displayConfig || { width: 2560, height: 1440, scale: 150 };
      const sessionToken = getSessionFromReq(req)?.token || (parsedUrl.searchParams.get('token') || '');

      // 直通操作页面入口 URL (带授权 Token 和云电脑 ID)
      const directViewUrl = `/desktop-view?accId=${accId}&token=${encodeURIComponent(sessionToken || '')}&desktopId=${encodeURIComponent(objId)}`;

      // 构造免密直达认证包 (localStorage.authData + web_device_code + authExpiredAt)
      const authDataObj = {
        ...client.loginInfo,
        logined: true,
        userId: client.loginInfo?.userId,
        userName: client.loginInfo?.userName,
        userEid: client.loginInfo?.userEid || '',
        userAccount: client.loginInfo?.userAccount || '',
        mobilephone: client.loginInfo?.mobilephone || acc.user,
        tenantId: client.loginInfo?.tenantId,
        secretKey: client.loginInfo?.secretKey,
        deviceType: client.deviceType,
        bondedDevice: true,
        commonLoginReqHeader: client.loginInfo?.commonLoginReqHeader || '',
        timestamp: Date.now()
      };

      jsonResponse(res, {
        success: true,
        user: acc.user,
        password: acc.password,
        deviceCode: acc.deviceCode,
        authData: authDataObj,
        authExpiredAt: String(Date.now() + 72 * 3600 * 1000),
        targetUrl,
        directViewUrl,
        desktopUrl: `https://pc.ctyun.cn/#/desktop-list`,
        desktopName: desktop.objName || desktop.desktopName || '云电脑',
        displayConfig: displayCfg
      });
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 手动下单兑换/抽奖接口
  if (req.method === 'POST' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/order')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403);
      return;
    }

    const body = await parseJsonBodyLimited(req);
    const prodId = parseInt(body.prodId);
    const prodName = body.prodName || '商品';
    const prodType = body.prodType || 'pointstplupgrade';
    const costPoints = parseInt(body.costPoints) || 0;
    const times = Math.max(1, parseInt(body.times) || 1);

    if (!prodId || costPoints <= 0) {
      jsonResponse(res, { error: '商品参数无效' }, 400);
      return;
    }

    const client = getClient(acc);
    try {
      // 下单前零预热：直接使用内存缓存数据，杜绝下单前一刻的连环查询触发风控请求指纹
      const cachedPts = client.metrics.userPoints || acc.stats?.points || 0;
      const totalCost = costPoints * times;
      if (cachedPts > 0 && cachedPts < totalCost) {
        jsonResponse(res, { error: `积分不足：当前拥有 ${cachedPts} 积分，本次兑换需要 ${totalCost} 积分！` }, 400);
        return;
      }

      // 目标云电脑判定
      const needsDesktop = rewardNeedsDesktop(prodId, prodType);
      const targetDesktopId = parseInt(body.desktopId) || parseInt(client.metrics.desktopId) || parseInt(acc.stats?.desktopId) || 0;
      if (needsDesktop && !targetDesktopId) {
        jsonResponse(res, { error: '该商品（升配/数据盘扩容）必须选择绑定的目标云电脑！' }, 400);
        return;
      }

      appendLog('Redeem', `[${acc.name}] 正在向天翼云发起真实下单: ${prodName} x${times}，总计 ${totalCost} 积分 (商品类型: ${prodType})...`, 'info');

      const placeOrderUrl = 'https://desk.ctyun.cn/selforder/api/selforder/paas/placeOrder';
      let success = false;
      let lastError = '';
      let isRisk = false;

      // 报文属性构建
      const orderAttrs = [];
      if (needsDesktop) {
        orderAttrs.push({ attrKey: 'bindDesktopId', attrVal: Number(targetDesktopId) });
      } else {
        orderAttrs.push({ attrKey: 'mobilephone' });
      }

      // 原子总积分下单：单笔请求直传总积分 points = costPoints * times
      // 天翼云 PaaS 将在云端一次性合并处理，直接生成 xN 扩容工单，彻底规避连续发单导致的扩容中锁定冲突！
      const orderPayload = {
        busiChannel: '010',
        orderType: 1,
        pointType: Number(body.pointType) || 1,
        points: Number(totalCost),
        sku: [{
          execSort: 1,
          prodId: Number(prodId),
          prodType,
          attrs: orderAttrs
        }]
      };

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) {
            appendLog('Redeem', `[${acc.name}] 正在进行第 ${attempt}/3 次自动重试...`, 'info');
            await new Promise(r => setTimeout(r, 3000));
          }

          const orderRes = await fetch(placeOrderUrl, {
            method: 'POST',
            headers: client.getSignedHeaders({ 'Content-Type': 'application/json;charset=UTF-8' }),
            body: JSON.stringify(orderPayload)
          });
          const orderData = await orderRes.json();

          if (orderData.code === 0) {
            success = true;
            appendLog('Redeem', `[${acc.name}] ✅ 成功一次性完成【${prodName}】x${times} 兑换，共扣除 ${totalCost} 积分！`, 'success');
            break;
          }

          lastError = orderData.msg || `错误码 ${orderData.code}`;
          
          const isFatal = 
            lastError.includes('积分不足') || 
            lastError.includes('点数不足') || 
            lastError.includes('余额不足') ||
            lastError.includes('风控') || 
            lastError.includes('频繁') || 
            lastError.includes('异常操作') ||
            lastError.includes('超过最大') ||
            lastError.includes('上限');

          if (isFatal) {
            if (lastError.includes('风控') || lastError.includes('频繁') || lastError.includes('异常操作')) {
              isRisk = true;
            }
            appendLog('Redeem', `[${acc.name}] 下单触发限制 (${lastError})，终止重试。`, 'warning');
            break;
          }

          appendLog('Redeem', `[${acc.name}] 第 ${attempt} 次下单未成功: ${lastError}`, 'warning');
        } catch (e) {
          lastError = e.message;
          appendLog('Redeem', `[${acc.name}] 第 ${attempt} 次网络异常: ${lastError}`, 'warning');
        }
      }

      if (success) {
        sendAccountNotification(
          acc,
          `🎉 天翼云积分兑换成功 - ${acc.name}`,
          `账号 [${acc.name}] 成功兑换 [${prodName}] x${times}，共扣除 ${totalCost} 积分。`
        );
      }

      // 下单动作已全部结束，此时再同步官方积分与任务状态（安全窗口）
      await client.refreshOfficialTasks();

      if (success) {
        jsonResponse(res, { success: true, message: `🎉 兑换成功！已成功兑换 ${prodName} x${times}，共消耗 ${totalCost} 积分，剩余 ${client.metrics.userPoints || 0} 积分` });
      } else {
        let errorReason = '';
        const msg = lastError || '';
        if (isRisk || msg.includes('风控')) {
          errorReason = '【触发天翼云反欺诈风控】已被临时拦截，已自动停止重试防止加重。请使用官方手机 App 正常操作一次（或短信验证）即可自动解除！';
        } else if (msg.includes('unknow instType') || msg.includes('add subsku')) {
          errorReason = '【商品属性不匹配】该商品为独立发放型商品，无法作为云电脑子配置绑定。';
        } else if (msg.includes('目标资源不存在')) {
          errorReason = '【目标资源不存在】未找到有效绑定的云电脑，请确认设备在线后再试。';
        }
        appendLog('Redeem', `[${acc.name}] 兑换失败: ${msg}${errorReason ? ' -> ' + errorReason : ''}`, 'error');
        jsonResponse(res, {
          error: `兑换失败: ${msg || '未成功'}`,
          reason: errorReason || '天翼云服务接口返回异常',
          rawMsg: msg
        }, 400);
      }
    } catch (e) {
      jsonResponse(res, { error: `下单请求异常: ${e.message}` }, 500);
    }
    return;
  }

  // 云电脑电源管理操作 API (开机 / 重启 / 关机) —— 支持天翼云与移动云
  if (req.method === 'POST' && (pathname.startsWith('/api/accounts/') || pathname.startsWith('/api/ydpc/')) && (pathname.includes('/power/') || pathname.includes('/boot'))) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const parts = pathname.split('/');
    const accId = parts[3];
    const action = parts[5] || 'poweron'; // poweron / reboot / shutdown
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403);
      return;
    }

    const body = await parseJsonBodyLimited(req).catch(() => ({}));
    const client = getClient(acc);
    try {
      const actionLower = (action || '').toLowerCase();
      let desktopId = parsedUrl.searchParams.get('desktopId') || body.userServiceId || body.desktopId || '';

      // 移动云电脑电源管理分支
      if (acc.platform === 'ydpc') {
        const targetUsid = desktopId || acc.vms?.[0]?.userServiceId || acc.desktops?.[0]?.userServiceId;
        const resPower = await client.controlPower(targetUsid, actionLower);
        jsonResponse(res, resPower);
        return;
      }

      // 移动公众（ecloud）：电源控制走平台官方 operate 通道（2026-09-28 接入，真机验证可受理）。
      // 协议取值来自官方 asar 客户端逆向：available=开机（后端不认识 startup/powerOn）/ shutdown / restart。
      // 措辞纪律：成功只报"平台已受理"，受理 ≠ 已生效；最终状态以平台状态刷新为准。
      if (acc.platform === 'ecloud') {
        const targetInstance = desktopId || acc.desktops?.[0]?.instanceId || '';
        if (!targetInstance) {
          jsonResponse(res, { error: '未指定云电脑（缺少 instanceId），请先「同步桌面」' }, 400);
          return;
        }
        const opMap = {
          poweron: 'available', boot: 'available', start: 'available', awake: 'available',
          shutdown: 'shutdown', poweroff: 'shutdown', reboot: 'restart', restart: 'restart',
        };
        const operate = opMap[actionLower];
        if (!operate) {
          jsonResponse(res, { error: `不支持的电源操作: ${actionLower}（仅 poweron/shutdown/reboot）` }, 400);
          return;
        }
        const resPower = await client.powerDesktop(targetInstance, operate);
        jsonResponse(res, resPower);
        return;
      }

      // 天翼云电脑电源管理分支
      if (!desktopId) {
        try {
          const desktops = await client.getDesktops();
          if (desktops && desktops.length > 0) {
            desktopId = desktops[0].objId || desktops[0].desktopId;
          }
        } catch (e) {}
      }

      if (!desktopId) {
        desktopId = client.metrics.desktopId || acc.stats?.desktopId || '';
      }

      if (!desktopId && actionLower !== 'poweron') {
        jsonResponse(res, { error: '未检测到可用云电脑' }, 400);
        return;
      }

      const resPower = await client.controlPower(desktopId, action);
      if (resPower.success) {
        // 核心联动：如果是用户在电源管理主动关机，自动关闭保活开关并打上主动关机标记
        if (actionLower === 'shutdown' || actionLower === 'poweroff') {
          acc.features = acc.features || {};
          acc.features.keepAlive = false;
          acc.manualShutdown = true;
          acc.stats = acc.stats || {};
          acc.stats.keepAliveStatus = 'offline';
          saveConfig(appConfig);
          client.stopKeepAliveWorker();
          appendLog('System', `[${acc.name}] 用户主动关机，已自动关闭保活开关，机器将维持关机。`, 'info');
        } else if (actionLower === 'poweron' || actionLower === 'start' || actionLower === 'awake') {
          acc.features = acc.features || {};
          acc.features.keepAlive = true;
          acc.manualShutdown = false;
          acc.stats = acc.stats || {};
          acc.stats.keepAliveStatus = 'online';
          saveConfig(appConfig);
          client.startKeepAliveWorker();
          appendLog('System', `[${acc.name}] 用户主动开机，已自动恢复保活开关与长连接守护。`, 'info');
        }

        jsonResponse(res, { ...resPower, features: acc.features });
      } else {
        jsonResponse(res, resPower, 400);
      }
    } catch (e) {
      jsonResponse(res, { error: e.message }, 400);
    }
    return;
  }

  // 独立状态验证：用独立轮询判定"保活是否真的有效"（旁路核验，不复用保活动作的结论）
  if (req.method === 'POST' && pathname.startsWith('/api/ydpc/') && pathname.includes('/verify-keepalive')) {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未登录' }, 401); return; }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc || !canUserAccessAccount(session, acc)) { jsonResponse(res, { error: '账号不存在或无权操作' }, 403); return; }
    const body = await parseJsonBodyLimited(req);
    const client = getClient(acc);
    try {
      const durationSec = Math.min(600, Math.max(15, parseInt(body.durationSec) || 60));
      const intervalSec = Math.min(120, Math.max(5, parseInt(body.intervalSec) || 15));
      const report = await client.verifyKeepAliveEffect(durationSec, intervalSec);
      jsonResponse(res, report);
    } catch (e) {
      jsonResponse(res, { error: e.message }, 400);
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/ydpc/') && pathname.includes('/cag-ping')) {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未登录' }, 401); return; }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc || !canUserAccessAccount(session, acc)) { jsonResponse(res, { error: '账号不存在或无权操作' }, 403); return; }
    const body = await parseJsonBodyLimited(req);
    const client = getClient(acc);
    try {
      const result = await client.pingCag(body.userServiceId, 3);
      jsonResponse(res, result);
    } catch (e) {
      jsonResponse(res, { error: e.message }, 400);
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/ydpc/') && pathname.includes('/heartbeat')) {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未登录' }, 401); return; }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc || !canUserAccessAccount(session, acc)) { jsonResponse(res, { error: '账号不存在或无权操作' }, 403); return; }
    const body = await parseJsonBodyLimited(req);
    const client = getClient(acc);
    try {
      const result = await client.sendHeartbeat(body.userServiceId);
      jsonResponse(res, result);
    } catch (e) {
      jsonResponse(res, { error: e.message }, 400);
    }
    return;
  }

  // 17. 系统全局设置（仅管理员可访问与修改）
  if (req.method === 'GET' && pathname === '/api/settings') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    if (session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅超级管理员可查看全局系统设置' }, 403);
      return;
    }
    jsonResponse(res, appConfig.settings || {});
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/settings') {
    const session = getSessionFromReq(req);
    // 严格鉴权：必须是已登录且角色为 admin，访客(未登录)返回 401，非管理员返回 403
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再修改全局系统设置' }, 401);
      return;
    }
    if (session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅超级管理员可修改全局系统设置' }, 403);
      return;
    }

    const body = await parseJsonBodyLimited(req);
    
    // SSRF 防御校验：检查 Webhook 地址合法性
    if (body.notify && body.notify.webhookUrl) {
      const targetUrl = String(body.notify.webhookUrl).trim();
      const channel = body.notify.channel || 'webhook';
      if (body.notify.enabled && !isValidWebhookTarget(channel, targetUrl)) {
        jsonResponse(res, { error: '安全拦截：禁止设置内网/私有IP或目标格式非法！' }, 400);
        return;
      }
    }

    appConfig.settings = { ...appConfig.settings, ...body };
    saveConfig(appConfig);
    appendLog('System', '全局设置已更新，定时调度与配置已即时热重载生效', 'info');

    // 联动热更新：重新装载定时调度器的触发时间点
    if (taskScheduler) {
      taskScheduler.scheduleNextRun();
      taskScheduler.checkStartupCatchup();
    }

    // 联动热更新：更新正在运行中所有云电脑客户端的保活重连周期并即时重设倒计时
    const newKeepSeconds = appConfig.settings.keepAliveSeconds || 60;
    for (const [id, client] of clientInstances.entries()) {
      if (client.resetCycleTimeout) {
        client.resetCycleTimeout(newKeepSeconds);
      } else {
        client.metrics.keepAliveSeconds = newKeepSeconds;
        client.metrics.cycleCountdown = newKeepSeconds;
      }
    }

    if (appConfig.settings.notify?.enabled) {
      sendNotification(
        appConfig.settings,
        '天翼云控制中心 - 通知配置成功',
        '您的 Webhook / 推送通知配置已成功生效！'
      );
    }

    jsonResponse(res, appConfig.settings);
    return;
  }

  // 17.5 个人通知偏好设置 API (所有登录用户可用，包含普通用户和管理员)
  if (req.method === 'GET' && pathname === '/api/user/notify') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    const userNotify = authManager.getUserNotify(session.userId) || {
      enabled: false,
      channel: 'webhook',
      webhookUrl: '',
      customTitleTemplate: '',
      customContentTemplate: ''
    };
    jsonResponse(res, userNotify);
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/user/notify') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    const body = await parseJsonBodyLimited(req);
    const channel = body.channel || 'webhook';
    const webhookUrl = String(body.webhookUrl || '').trim();
    if (body.enabled && webhookUrl && !isValidWebhookTarget(channel, webhookUrl)) {
      jsonResponse(res, { error: '安全拦截：禁止设置内网/私有IP或目标格式非法！' }, 400);
      return;
    }
    const ok = authManager.updateUserNotify(session.userId, body);
    if (ok) {
      appendLog('Auth', `用户 [${session.username}] 更新了个人消息通知配置`, 'info');
      if (session.role === 'admin') {
        appConfig.settings.notify = { ...body };
        saveConfig(appConfig);
      }
      jsonResponse(res, { success: true, notify: authManager.getUserNotify(session.userId) });
    } else {
      jsonResponse(res, { error: '用户不存在' }, 404);
    }
    return;
  }

  // 17.6 个人通知推送测试 API (所有登录用户可用)
  if (req.method === 'POST' && pathname === '/api/user/notify/test') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    const body = await parseJsonBodyLimited(req);
    const channel = body.channel || 'webhook';
    const testUrl = (body.webhookUrl || '').trim();
    if (!isValidWebhookTarget(channel, testUrl)) {
      jsonResponse(res, { success: false, message: '安全拦截：目标地址为内网/私有IP或格式非法，已被系统拒绝！' }, 400);
      return;
    }
    const testSettings = {
      notify: {
        enabled: true,
        channel: channel,
        webhookUrl: testUrl,
        secret: body.secret || '',
        customTitleTemplate: body.customTitleTemplate || '',
        customContentTemplate: body.customContentTemplate || ''
      }
    };
    const resNotify = await sendNotification(
      testSettings,
      `天翼云控制中心 - [${session.username}] 个人测试推送`,
      '这是一条即时测试消息，证明您的专属消息推送通道已成功联通！',
      { account: '个人专属测试', task: '推送联通测试', status: '成功', points: '100' }
    );
    jsonResponse(res, resNotify);
    return;
  }

  // 18. 测试通知推送 API (严格要求必须登录且为管理员，并做 SSRF 强校验)
  if (req.method === 'POST' && pathname === '/api/notify/test') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再测试推送' }, 401);
      return;
    }
    if (session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅超级管理员可测试推送' }, 403);
      return;
    }

    const body = await parseJsonBodyLimited(req);
    const channel = body.channel || appConfig.settings?.notify?.channel || 'webhook';
    const testUrl = (body.webhookUrl || appConfig.settings?.notify?.webhookUrl || '').trim();
    if (!isValidWebhookTarget(channel, testUrl)) {
      jsonResponse(res, { success: false, message: '安全拦截：目标地址为内网/本地私有地址或格式非法，已被系统拒绝！' }, 400);
      return;
    }

    const testSettings = {
      notify: {
        enabled: true,
        channel: body.channel || appConfig.settings?.notify?.channel,
        webhookUrl: testUrl,
        customTitleTemplate: body.customTitleTemplate || appConfig.settings?.notify?.customTitleTemplate,
        customContentTemplate: body.customContentTemplate || appConfig.settings?.notify?.customContentTemplate
      }
    };
    const resNotify = await sendNotification(
      testSettings,
      '天翼云自动化控制中心 - 测试推送',
      '这是一条即时测试消息，证明您的推送通道与自定义模板已成功配置并联通！',
      { account: '测试账号', task: '签到打卡', status: '成功', points: '1000' }
    );
    jsonResponse(res, resNotify);
    return;
  }

  // 19. 配置导出与备份接口 (导出当前用户或管理员所有账号与设置)
  if (req.method === 'GET' && pathname === '/api/config/export') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再导出配置' }, 401);
      return;
    }

    let exportAccounts = appConfig.accounts;
    if (session.role !== 'admin') {
      exportAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
    }

    const exportData = {
      exportVersion: '2.1.3',
      exportTime: getBeijingTimeString(),
      exportedBy: session.username,
      role: session.role,
      settings: session.role === 'admin' ? appConfig.settings : undefined,
      accounts: exportAccounts.map(a => {
        if (a.platform === 'ecloud') {
          // 移动公众标准化导出（与 ydpc / ctyun 各自独立的分支，绝不混用字段语义）
          return {
            platform: 'ecloud',
            name: a.name || a.user,
            user: a.user,
            password: a.password || '',
            ecloudDeviceUid: a.ecloudDeviceUid || '',
            keepaliveInterval: parseInt(a.keepaliveInterval) || 300,
            enabled: a.enabled !== false,
            features: a.features || buildEcloudDefaultFeatures(),
            desktops: a.desktops || []
          };
        }
        const isYd = a.platform === 'ydpc' || !!a.accountType;
        if (isYd) {
          // 移动云电脑标准化导出 (明确标注 platform: ydpc，区分 main 和家亲主账号 / sub 独立子账号)
          return {
            platform: 'ydpc',
            accountType: a.accountType || 'main',
            name: a.name || a.user,
            user: a.user,
            password: a.password || '',
            deviceCode: a.deviceCode || '',
            keepaliveInterval: parseInt(a.keepaliveInterval) || 600,
            enabled: a.enabled !== false,
            features: a.features || { controlPlaneKeepalive: true, keepAlive: true },
            vms: a.vms || []
          };
        } else {
          // 天翼云电脑标准化导出 (明确标注 platform: ctyun，区分 qrcode 扫码绑定 / password 账密绑定)
          const isQr = !a.password;
          return {
            platform: 'ctyun',
            authMode: isQr ? 'qrcode' : 'password',
            name: a.name || a.user,
            user: a.user,
            password: a.password || '',
            deviceCode: a.deviceCode || '',
            displayConfig: a.displayConfig || { width: 2560, height: 1440, scale: 150 },
            enabled: a.enabled !== false,
            bound: a.bound !== false,
            features: a.features || { keepAlive: true, autoSign: true, aiChat: true, cloudHang: true, autoRedeem: false, autoBoot: true },
            redeemConfig: a.redeemConfig || { enabled: false, targetType: 'redeem' },
            desktops: a.desktops || []
          };
        }
      })
    };

    appendLog('System', `用户 [${session.username}] 导出了 ${exportAccounts.length} 个账号的配置备份`, 'info');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ctyun_config_backup_${Date.now()}.json"`,
      ...corsHeadersFor(req)
    });
    res.end(JSON.stringify(exportData, null, 2));
    return;
  }

  // 20. 配置导入与恢复接口 (支持追加或覆盖，导入后自动平滑重载保活长连接)
  if (req.method === 'POST' && pathname === '/api/config/import') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再导入配置' }, 401);
      return;
    }

    const body = await parseJsonBodyLimited(req, MAX_IMPORT_BODY_BYTES);
    const importAccounts = Array.isArray(body.accounts) ? body.accounts : [];
    if (importAccounts.length === 0) {
      jsonResponse(res, { error: '导入失败：未在 JSON 文件中解析到合法的 accounts 数组' }, 400);
      return;
    }

    const mode = body.mode || 'merge'; // merge (合并新增) 或 overwrite (覆盖当前名下)
    const targetOwnerId = session.userId;
    const currentUser = authManager.getUserById(targetOwnerId);

    // 配额计算
    if (currentUser && currentUser.role !== 'admin') {
      const currentOwned = mode === 'overwrite' ? 0 : appConfig.accounts.filter(a => a.ownerId === targetOwnerId).length;
      if (currentOwned + importAccounts.length > (currentUser.maxQuota || 2)) {
        jsonResponse(res, {
          error: `导入失败：导入后账号数量 (${currentOwned + importAccounts.length}) 超出允许配额上限 (${currentUser.maxQuota}台)！`
        }, 400);
        return;
      }
    }

    if (mode === 'overwrite') {
      // 停止并清理当前用户原有保活
      const oldOwned = appConfig.accounts.filter(a => a.ownerId === targetOwnerId);
      oldOwned.forEach(o => {
        const cl = clientInstances.get(o.id);
        if (cl) cl.stopKeepAliveWorker();
        clientInstances.delete(o.id);
      });
      appConfig.accounts = appConfig.accounts.filter(a => a.ownerId !== targetOwnerId);
    }

    let importedCount = 0;
    for (const item of importAccounts) {
      if (!item.user) continue;

      // ── 平台归属判定 (第一优先级：显式 platform 标签绝对优先，绝不篡改) ──
      let isYdpc = false;
      let isEcloud = false;
      if (item.platform === 'ecloud') {
        isEcloud = true;
      } else if (item.platform === 'ydpc') {
        isYdpc = true;
      } else if (item.platform === 'ctyun') {
        isYdpc = false;
      } else {
        // 第二优先级：仅针对缺失 platform 字段的历史老版本备份，按特征严格判定
        const hasYdpcFeatures = item.features && (
          item.features.cagKeepAlive === true || item.features.sohoHeartbeat === true ||
          item.features.controlPlaneKeepalive === true || item.features.mqttKeepAlive === true
        );
        const hasCtyunFeatures = item.features && (item.features.autoSign !== undefined || item.features.aiChat !== undefined || item.features.cloudHang !== undefined || item.redeemConfig !== undefined);

        if (item.accountType === 'sub' || item.accountType === 'main') {
          isYdpc = true;
        } else if (hasYdpcFeatures && !hasCtyunFeatures) {
          isYdpc = true;
        } else if (Array.isArray(item.vms) && item.vms.length > 0) {
          isYdpc = true;
        } else if (typeof item.name === 'string' && item.name.includes('移动') && !item.name.includes('天翼')) {
          isYdpc = true;
        } else {
          isYdpc = false; // 默认天翼云
        }
      }

      const platformStr = isEcloud ? 'ecloud' : (isYdpc ? 'ydpc' : 'ctyun');

      // ── 天翼云登录模式判定 (authMode === 'qrcode' 或密码为空均视为扫码绑定) ──
      const isQrAccount = !isYdpc && (item.authMode === 'qrcode' || !item.password);

      // 如果是 merge，检查手机号/账号名是否已存在同平台账号
      const existing = appConfig.accounts.find(a => a.user === item.user && a.ownerId === targetOwnerId && (a.platform || 'ctyun') === platformStr);
      if (existing) {
        existing.name = item.name || existing.name;
        if (item.password) existing.password = item.password;
        if (isYdpc && item.accountType) existing.accountType = item.accountType;
        if (isYdpc && item.keepaliveInterval) existing.keepaliveInterval = item.keepaliveInterval;
        if (item.deviceCode) existing.deviceCode = item.deviceCode;
        if (isEcloud && item.ecloudDeviceUid) existing.ecloudDeviceUid = item.ecloudDeviceUid;
        if (isEcloud && item.keepaliveInterval) existing.keepaliveInterval = item.keepaliveInterval;
        if (item.displayConfig) existing.displayConfig = { ...existing.displayConfig, ...item.displayConfig };
        if (item.features) existing.features = { ...existing.features, ...item.features };
        if (item.redeemConfig) existing.redeemConfig = { ...existing.redeemConfig, ...item.redeemConfig };
        if (isYdpc && Array.isArray(item.vms) && item.vms.length > 0) existing.vms = item.vms;
        if (!isYdpc && Array.isArray(item.desktops) && item.desktops.length > 0) existing.desktops = item.desktops;
        importedCount++;
        continue;
      }

      const id = (isYdpc ? 'yd_' : (isEcloud ? 'ec_' : 'ct_')) + crypto.randomUUID().substring(0, 8);
      const newAcc = {
        id,
        platform: platformStr,
        ownerId: targetOwnerId,
        accountType: isYdpc ? (item.accountType || 'main') : undefined,
        name: item.name || item.user,
        user: item.user,
        password: item.password || '',
        deviceCode: item.deviceCode || generateDeviceCode(),
        ecloudDeviceUid: isEcloud ? (item.ecloudDeviceUid || crypto.randomUUID()) : undefined,
        keepaliveInterval: isYdpc ? (parseInt(item.keepaliveInterval) || 600) : (isEcloud ? (parseInt(item.keepaliveInterval) || 300) : undefined),
        displayConfig: item.displayConfig || { width: 2560, height: 1440, scale: 150 },
        enabled: item.enabled !== false,
        bound: isYdpc ? true : (item.bound !== false),
        sessionExpired: isQrAccount ? true : false,
        features: item.features || (isEcloud ? buildEcloudDefaultFeatures() : (isYdpc ? {
          keepAlive: true,
          controlPlaneKeepalive: true,
          dataPlaneKeepalive: true
        } : {
          keepAlive: true,
          autoSign: true,
          aiChat: true,
          cloudHang: true,
          autoRedeem: false,
          // 2026-09-28：移动云自动开机守护默认开启（用户拍板）
          autoBoot: true
        })),
        redeemConfig: item.redeemConfig || {
          enabled: false,
          targetType: 'redeem',
          desktopId: '',
          desktopName: '',
          prodId: 17023101,
          prodName: '8C16G升配包1天 (500积分)',
          prodType: 'pointstplupgrade',
          costPoints: 500,
          maxRedeemTimes: 0,
          scheduleType: 'monthly_days',
          monthlyDays: [-1],
          intervalDays: 1,
          lastRedeemDate: ''
        },
        vms: isYdpc ? (item.vms || []) : [],
        desktops: !isYdpc ? (item.desktops || []) : [],
        stats: item.stats || {
          lastSignTime: '',
          lastAiChatTime: '',
          lastHangTime: '',
          hangMinutesToday: 0,
          points: 0,
          keepAliveStatus: isYdpc ? 'online' : (isQrAccount ? 'offline' : 'online'),
          lastError: ''
        }
      };
      appConfig.accounts.push(newAcc);
      importedCount++;

      // 自动唤醒长连接保活
      const client = getClient(newAcc);
      if (isYdpc) {
        client.refreshVms().then(() => {
          if (newAcc.enabled && newAcc.features?.keepAlive !== false) {
            client.startKeepAliveWorker();
          }
        }).catch(() => {});
      } else if (newAcc.password && newAcc.enabled && newAcc.features?.keepAlive !== false) {
        client.startKeepAliveWorker();
      }
    }

    // 管理员导入时若带 settings 则一并更新
    if (session.role === 'admin' && body.settings && typeof body.settings === 'object') {
      appConfig.settings = { ...appConfig.settings, ...body.settings };
      appendLog('System', `⚠️ 备份文件包含系统设置，已一并还原 (保活周期: ${appConfig.settings.keepAliveSeconds}s / 脉冲间隔: ${(appConfig.settings.pulseIntervalSeconds || (appConfig.settings.pulseIntervalMinutes || 45) * 60)}秒 / 触发时间: ${appConfig.settings.cron?.executeTime || '01:20'})。如与预期不符，请前往「系统设置」核对调整。`, 'warning');
    }

    saveConfig(appConfig);
    appendLog('System', `用户 [${session.username}] 成功导入/恢复了 ${importedCount} 个云电脑配置`, 'success');
    jsonResponse(res, { success: true, importedCount, message: `成功导入 ${importedCount} 个账号配置并自动上线保活！` });
    return;
  }

  // 21. 重启保活守护
  if (req.method === 'POST' && pathname === '/api/keeper/restart') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session || session.role !== 'admin') {
      jsonResponse(res, { error: '未授权：仅管理员可重启保活守护' }, 401);
      return;
    }
    appendLog('Keeper', '收到重启指令，正在重置所有保活周期...', 'warning');
    for (const [id, client] of clientInstances.entries()) {
      client.stopKeepAliveWorker();
    }
    setTimeout(initAllKeepAlive, 1500);
    jsonResponse(res, { message: '所有保活守护通道已重新初始化' });
    return;
  }

  jsonResponse(res, { error: 'Not Found' }, 404);
}

module.exports = { handleRequest };
