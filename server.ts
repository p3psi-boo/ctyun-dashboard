'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

// 全局优先使用 IPv4，彻底根治 Docker 容器及宿主机双栈网络下因 IPv6 无外网网关导致的 10 秒超时假死
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const runtime = require('./app/runtime');
const {
  PORT, DATA_DIR, AUTH_SESSIONS_FILE, LOG_DIR, ensureDataDirs,
} = require('./app/paths');
ensureDataDirs();

const { LogPersister } = require('./app/persist_log');
const { createLogger } = require('./app/lib/logger');
const { AuthManager } = require('./app/auth_manager');

const sysLog = createLogger('System');
const persistLog = createLogger('PersistLog');
const { TaskScheduler } = require('./app/tasks/scheduler');
const { atomicWriteFileSync } = require('./app/lib/atomic_fs');
const { loadConfig, saveConfig, bindConfig } = require('./app/config_store');
const {
  TASK_CN_NAME, TASK_FEATURE_KEY, ECLOUD_KEEPALIVE_TASKS, resolveTaskEnabled, buildEcloudDefaultFeatures,
} = require('./app/lib/task_switch');
const { inferLogPlatform, appendLog, bootstrapLogsFromDisk } = require('./app/log_hub');
const { sendNotification, sendAccountNotification } = require('./app/notify');
const { getClient, initAllKeepAlive, clientInstances } = require('./app/clients');
const { CtYunClient } = require('./app/ctyun_client');
const { handleRequest } = require('./app/http/handler');

const logPersister = new LogPersister({
  dir: LOG_DIR,
  retentionDays: parseInt(process.env.CTYUN_LOG_RETENTION_DAYS, 10) || 7,
  onError: (msg) => persistLog.error(msg)
});
logPersister.init();
runtime.logPersister = logPersister;
runtime.appendLog = appendLog;
runtime.sendAccountNotification = sendAccountNotification;

sysLog.info('内核已启动（HTTP/WebSocket 原生协议）');

// 全局异常拦截看门狗 (确保守护服务长期稳定运行不宕机)
process.on('uncaughtException', (err: any) => {
  sysLog.error('未捕获异常已拦截（进程继续运行）', err);
  try { appendLog('System', `⚠️ 未捕获异常已拦截（进程继续运行）: ${(err && err.message) || err}`, 'error'); } catch (e) { /* 日志不可用则仅进程日志 */ }
});
process.on('unhandledRejection', (reason: any) => {
  sysLog.error('未处理 Promise 拒绝已拦截', reason);
  try { appendLog('System', `⚠️ 未处理 Promise 拒绝已拦截: ${(reason && reason.message) || reason}`, 'error'); } catch (e) { /* 同上 */ }
});
process.on('exit', (code) => {
  try {
    appendLog('System', `⚠️ 主进程即将退出 (code=${code})${code === 0 ? '' : ' —— 非零退出码，请对照上一条异常/信号日志'}`, code === 0 ? 'warning' : 'error');
  } catch (e) { /* 退出路径尽力而为 */ }
});

const appConfig = loadConfig();
bindConfig(appConfig);
runtime.config = appConfig;
runtime.saveConfig = (cfg) => saveConfig(cfg || runtime.config);

const authSessionStore = {
  load: () => {
    try { return JSON.parse(fs.readFileSync(AUTH_SESSIONS_FILE, 'utf8')); } catch (e) { return null; }
  },
  save: (obj) => {
    try {
      if (!obj || Object.keys(obj).length === 0) {
        if (fs.existsSync(AUTH_SESSIONS_FILE)) fs.unlinkSync(AUTH_SESSIONS_FILE);
        return;
      }
      atomicWriteFileSync(AUTH_SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf8', 0o600);
    } catch (e) { /* 磁盘不可写时仅内存生效 */ }
  }
};
const authManager = new AuthManager({
  get config() { return runtime.config; },
  saveConfig: () => saveConfig(runtime.config),
  sessionStore: authSessionStore
});
runtime.authManager = authManager;

const taskScheduler = new TaskScheduler({
  getAccounts: () => runtime.config.accounts,
  getSettings: () => runtime.config.settings,
  getClient: (acc) => getClient(acc),
  appendLog: (src, msg, lvl) => appendLog(src, msg, lvl),
  sendNotification: (target, title, content, extraVars = {}) => {
    if (target && target.ownerId) {
      return sendAccountNotification(target, title, content, extraVars);
    }
    const userMap = new Map();
    for (const acc of runtime.config.accounts || []) {
      const ownerId = acc.ownerId || 'u_admin';
      if (!userMap.has(ownerId)) userMap.set(ownerId, []);
      userMap.get(ownerId).push(acc);
    }
    for (const [ownerId, accList] of userMap.entries()) {
      const owner = (runtime.config.users || []).find(u => u.id === ownerId);
      let targetNotify = owner?.notify;
      if ((!targetNotify || !targetNotify.enabled) && owner?.role === 'admin') {
        targetNotify = runtime.config.settings?.notify;
      }
      if (targetNotify && targetNotify.enabled) {
        sendNotification({ notify: targetNotify }, title, content, extraVars).catch(() => {});
      }
    }
  },
  saveConfig: () => saveConfig(runtime.config)
});
runtime.taskScheduler = taskScheduler;
runtime.getClient = getClient;
runtime.initAllKeepAlive = initAllKeepAlive;

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch((err: any) => {
    sysLog.error('handleRequest 拒绝', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '服务器内部错误' }));
    }
  });
});

function gracefulShutdown(signal: string) {
  if ((gracefulShutdown as any)._once) return;
  (gracefulShutdown as any)._once = true;
  try { appendLog('System', `收到 ${signal}，主进程即将退出`, 'warning'); } catch (e) { /* 同上 */ }
  try {
    if (server.listening) server.close();
  } catch (e) { /* 退出路径尽力而为 */ }
  try {
    for (const client of clientInstances.values()) {
      try { if (typeof client.stopKeepAliveWorker === 'function') client.stopKeepAliveWorker(); } catch (e) { /* 同上 */ }
      try {
        if (typeof client.stop === 'function') {
          const p = client.stop(true);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (e) { /* 同上 */ }
    }
  } catch (e) { /* 同上 */ }
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT (Ctrl+C)'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

if (require.main === module) {
  setTimeout(initAllKeepAlive, 2000);
  setTimeout(() => taskScheduler.start(), 3000);
  server.listen(PORT, '0.0.0.0', () => {
    const isDockerEnv = fs.existsSync('/.dockerenv') || process.env.CTYUN_DATA_DIR === '/app/data';
    sysLog.info(`控制台服务已就绪 listen=http://127.0.0.1:${PORT}`);
    sysLog.info(`dataDir=${DATA_DIR} env=${isDockerEnv ? 'docker' : 'host'}`);
    if (isDockerEnv) {
      try {
        const canary = path.join(DATA_DIR, '.volume_check');
        if (!fs.existsSync(canary)) {
          fs.writeFileSync(canary, `persisted_test=${new Date().toISOString()}\n`, 'utf8');
        }
      } catch (err) {
        sysLog.error(`数据目录写入异常，请检查宿主机挂载卷权限 dataDir=${DATA_DIR}`, err);
      }
    }
    const restoredLogs = bootstrapLogsFromDisk();
    if (restoredLogs > 0) persistLog.info(`已从磁盘回灌 ${restoredLogs} 条历史日志 path=${LOG_DIR}`);
    appendLog('System', `控制台服务已就绪，当前加载 ${appConfig.accounts.length} 个账号（回灌历史日志 ${restoredLogs} 条）`, 'success');
  });
}

module.exports = {
  CtYunClient,
  appConfig,
  server,
  taskScheduler,
  initAllKeepAlive,
  resolveTaskEnabled,
  TASK_FEATURE_KEY,
  TASK_CN_NAME,
  ECLOUD_KEEPALIVE_TASKS,
  buildEcloudDefaultFeatures,
  inferLogPlatform
};
