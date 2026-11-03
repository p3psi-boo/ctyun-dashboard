'use strict';

/**
 * ============================================================================
 * 进程日志（stdout / stderr）统一格式
 * ============================================================================
 *
 * 本模块只负责**进程级**日志：启动、配置、密钥、落盘故障、未捕获异常。
 * 业务流水（保活 / 任务 / 心跳）仍走 server.js 的 appendLog
 * （内存折叠 + JSONL 落盘 + SSE），两条通道不要混用。
 *
 * 标准行（北京时间，无表情符号、无 `[!]` / `[*]` 装饰前缀）：
 *
 *   YYYY-MM-DD HH:mm:ss LEVEL [COMPONENT] message
 *
 * 例：
 *   2026-11-03 22:18:00 INFO  [System] 控制台服务已就绪
 *   2026-11-03 22:18:01 ERROR [Crypto] 主密钥文件异常，已从备份恢复
 *
 * 级别只允许 debug / info / warn / error。
 * 环境变量 CTYUN_LOG_LEVEL 控制最低输出级别（默认 info）。
 *
 * 零依赖（只用 process.stdout / stderr），可被回归测试直接 require。
 */

const LEVELS = Object.freeze({
  debug: { rank: 10, label: 'DEBUG' },
  info: { rank: 20, label: 'INFO' },
  warn: { rank: 30, label: 'WARN' },
  error: { rank: 40, label: 'ERROR' }
});

const LABEL_WIDTH = 5;
const COMPONENT_MAX = 24;

const UI_LEVELS = Object.freeze(['debug', 'info', 'success', 'warning', 'error']);

function parseMinLevel() {
  const raw = String(process.env.CTYUN_LOG_LEVEL || 'info').toLowerCase().trim();
  return LEVELS[raw] ? raw : 'info';
}

function beijingTimestamp(d = new Date()) {
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/** 界面日志级别归一：把 warn/ok 等别名收束到固定集合，未知值一律 info。 */
function normalizeUiLevel(level) {
  const l = String(level == null ? 'info' : level).toLowerCase().trim();
  if (l === 'error' || l === 'err' || l === 'fatal') return 'error';
  if (l === 'warning' || l === 'warn') return 'warning';
  if (l === 'success' || l === 'ok') return 'success';
  if (l === 'debug' || l === 'trace') return 'debug';
  if (l === 'info' || l === 'information' || l === 'notice') return 'info';
  return 'info';
}

/** 界面展示用的短标签（固定宽度语义：INFO / WARN / ERROR / OK / DEBUG） */
function uiLevelLabel(level) {
  switch (normalizeUiLevel(level)) {
    case 'error': return 'ERROR';
    case 'warning': return 'WARN';
    case 'success': return 'OK';
    case 'debug': return 'DEBUG';
    default: return 'INFO';
  }
}

function normalizeMessage(message, err) {
  let msg;
  let errorObj = err;
  if (message instanceof Error && err == null) {
    errorObj = message;
    msg = message.message;
  } else {
    msg = message == null ? '' : String(message);
  }
  if (errorObj instanceof Error) {
    if (!msg) msg = errorObj.message;
    else if (msg !== errorObj.message) msg = `${msg}: ${errorObj.message}`;
  } else if (errorObj != null && errorObj !== '') {
    const extra = String(errorObj);
    if (!msg) msg = extra;
    else msg = `${msg}: ${extra}`;
  }
  return String(msg).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatProcessLog(rec) {
  const level = rec && LEVELS[rec.level] ? rec.level : 'info';
  const meta = LEVELS[level];
  const time = (rec && rec.ts) || beijingTimestamp();
  const lvl = meta.label.padEnd(LABEL_WIDTH, ' ');
  const rawComp = String((rec && rec.component) || 'System').replace(/[\r\n\[\]]/g, '');
  const comp = rawComp.slice(0, COMPONENT_MAX) || 'System';
  const message = rec && rec.message != null ? String(rec.message) : '';
  return `${time} ${lvl} [${comp}] ${message}`;
}

function shouldEmit(level) {
  const min = LEVELS[parseMinLevel()] || LEVELS.info;
  const cur = LEVELS[level] || LEVELS.info;
  return cur.rank >= min.rank;
}

function writeLine(level, line) {
  const stream = (level === 'warn' || level === 'error') ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

function emit(component, level, message, err) {
  if (!LEVELS[level]) level = 'info';
  if (!shouldEmit(level)) return null;
  const rec = {
    ts: beijingTimestamp(),
    level,
    component: component || 'System',
    message: normalizeMessage(message, err)
  };
  writeLine(level, formatProcessLog(rec));
  if (err instanceof Error && err.stack && level === 'error') {
    process.stderr.write(err.stack + '\n');
  } else if (message instanceof Error && message.stack && level === 'error') {
    process.stderr.write(message.stack + '\n');
  }
  return rec;
}

function createLogger(component) {
  const c = component || 'System';
  return {
    debug: (msg, err) => emit(c, 'debug', msg, err),
    info: (msg, err) => emit(c, 'info', msg, err),
    warn: (msg, err) => emit(c, 'warn', msg, err),
    error: (msg, err) => emit(c, 'error', msg, err)
  };
}

module.exports = {
  LEVELS,
  UI_LEVELS,
  LABEL_WIDTH,
  COMPONENT_MAX,
  beijingTimestamp,
  normalizeUiLevel,
  uiLevelLabel,
  normalizeMessage,
  formatProcessLog,
  createLogger
};
