// @ts-nocheck
'use strict';

const runtime = require('./runtime');
const { CtYunClient } = require('./ctyun_client');
const { YdpcClient } = require('./ydpc/ydpc_client');
const { EcloudClient } = require('./ecloud/ecloud_client');
const { resolveTaskEnabled, buildEcloudDefaultFeatures } = require('./lib/task_switch');

const appendLog = (...args) => runtime.appendLog(...args);
const saveConfig = () => runtime.saveConfig(runtime.config);
const sendAccountNotification = (...args) => runtime.sendAccountNotification(...args);
const appConfig = new Proxy({}, {
  get(_, p) { return runtime.config[p]; },
  set(_, p, v) { runtime.config[p] = v; return true; },
  ownKeys() { return Reflect.ownKeys(runtime.config || {}); },
  getOwnPropertyDescriptor(_, p) {
    return Object.getOwnPropertyDescriptor(runtime.config || {}, p);
  },
});

const clientInstances = new Map();

// ----------------------------------------------------------
// 移动公众「两段式登录」的待定会话表
// ----------------------------------------------------------
// 移动公众登录可能要求短信验证码（设备信任 / 双因素 / 增强短信），后台无法代答。
// 这里暂存"已登录一半"的会话（会话本体在 Python 侧车内），等验证码回来接着完成。
const pendingEcloudLogins = new Map();
const ECLOUD_PENDING_TTL_MS = 15 * 60 * 1000;

function registerPendingEcloudLogin(id, entry) {
  const now = Date.now();
  for (const [k, v] of pendingEcloudLogins) {
    if (now - v.createdAt > ECLOUD_PENDING_TTL_MS) {
      try { v.client.stop(v.force === true); } catch (e) { /* 过期清理不抛 */ }
      pendingEcloudLogins.delete(k);
    }
  }
  pendingEcloudLogins.set(id, { ...entry, createdAt: now });
}

/**
 * 把"已通过认证的草稿账号"正式落库，并**复用**已经建立会话的客户端实例
 * （若重新 getClient 会拉起第二个侧车进程，会话就丢了 → 又要重新登录并可能再要验证码）。
 */
function finalizeEcloudAccount(acc, client) {
  appConfig.accounts.push(acc);
  client.account = acc;
  client.sessionId = acc.id;
  clientInstances.set(acc.id, client);
  saveConfig(appConfig);
  client.startKeepAliveWorker();
  return acc;
}

function getClient(acc) {
  if (!clientInstances.has(acc.id)) {
    let client;
    if (acc.platform === 'ecloud') {
      // 移动公众：独立侧车（Python 协议内核）托管，与另两平台的保活实现零共享
      client = new EcloudClient(acc, {
        appendLog,
        sendNotification: sendAccountNotification,
        saveConfig: () => saveConfig(appConfig),
        // 开关判定转发到本文件的权威入口，ecloud 侧不自己解释 features（避免第二套真相）
        resolveTaskEnabled: (account, desktop, taskType) => resolveTaskEnabled(account, desktop, taskType)
      });
      // 首次接入：尝试恢复/建立会话并同步桌面列表（失败不阻塞进程启动）
      client.refreshDesktops().catch(() => {});
    } else if (acc.platform === 'ydpc') {
      client = new YdpcClient(acc, {
        appendLog,
        sendNotification: sendAccountNotification,
        saveConfig: () => saveConfig(appConfig)
      });
      client.refreshVms().catch(() => {});
    } else {
      client = new CtYunClient(acc);
      // 立即执行一次官方任务与积分及云电脑硬件规格列表的精准拉取
      client.getDesktops().catch(() => {});
      client.refreshOfficialTasks().catch(() => {});
    }
    clientInstances.set(acc.id, client);
  } else {
    clientInstances.get(acc.id).account = acc;
  }
  return clientInstances.get(acc.id);
}

function initAllKeepAlive() {
  for (const acc of appConfig.accounts) {
    if (acc.enabled && acc.features?.keepAlive !== false) {
      const client = getClient(acc);
      if (acc.platform === 'ydpc') {
        client.refreshVms().then(() => client.startKeepAliveWorker()).catch(() => {});
      } else if (acc.platform === 'ecloud') {
        client.refreshDesktops().then(() => client.startKeepAliveWorker()).catch(() => {});
      } else {
        client.startKeepAliveWorker();
      }
    }
  }
}

module.exports = {
  clientInstances,
  pendingEcloudLogins,
  ECLOUD_PENDING_TTL_MS,
  registerPendingEcloudLogin,
  finalizeEcloudAccount,
  getClient,
  initAllKeepAlive,
  buildEcloudDefaultFeatures,
};
