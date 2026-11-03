'use strict';

/**
 * 运行时共享上下文。
 *
 * server.js 在完成配置加载后再注入 livable 字段；各业务模块通过本对象读取
 * 可变单例（配置、鉴权、日志），避免循环 require。方法必须在注入之后才调用。
 */
const runtime = {
  config: null,
  authManager: null,
  appendLog: () => {},
  saveConfig: () => false,
  sendAccountNotification: async () => ({ success: false, message: 'runtime 未就绪' }),
  jsonResponse: () => {},
  parseJsonBody: async () => ({}),
  getSessionFromReq: () => null,
  getClient: () => null,
  initAllKeepAlive: () => {},
  taskScheduler: null,
  logPersister: null,
};

module.exports = runtime;
