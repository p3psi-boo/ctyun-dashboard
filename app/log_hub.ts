// @ts-nocheck
'use strict';

const runtime = require('./runtime');
const { getBeijingTimeString, getBeijingDateOnly } = require('./lib/time');
const { LOG_SOURCE: ECLOUD_LOG_SOURCE } = require('./ecloud/ecloud_client');
const { BOOT_LOG_LINES } = require('./paths');

const appConfig = new Proxy({}, {
  get(_, p) { return runtime.config[p]; },
  set(_, p, v) { runtime.config[p] = v; return true; },
  ownKeys() { return Reflect.ownKeys(runtime.config || {}); },
  getOwnPropertyDescriptor(_, p) {
    return Object.getOwnPropertyDescriptor(runtime.config || {}, p);
  },
});

const logs = [];
const sseClients = new Set();
let logIdCounter = 0;
function isHeartbeatOrRoutine(source, message) {
  if (source === 'Heartbeat') return true;
  if (!message) return false;
  // 【2026-09-23】数据面保活的 progress 日志（progress hb_sent=... hb_recv=...）每 10s 一条、
  // 数字持续变化，需并入 routine 合并（只保留最新一条 + xN 计数）
  if (message.includes('progress hb_sent=')) return true;
  return message.includes('心跳') || message.includes('保活周期') || message.includes('保持长连接') || message.includes('长连接保活') || message.includes('发送保活') || message.includes('REDQ') || message.includes('103 认证') || message.includes('118 用户身份') || message.includes('118 身份');
}

/**
 * 折叠键归一化：把消息里的数字一律替换为 N。
 *
 * 【为什么需要 · 用户 2026-09-25】「progress hb_sent= 后面的不管咋变化，都属于同一种类型，
 * 不用重复日志，显示最新的，然后后面 x 几就行」。同一件事只有数字在变的日志还有很多
 * （移动公众的「累计 N 次」「累计 N 台成功」「在线时长 N小时N分N秒」），
 * 若按原文逐字比对，每一轮都会被判成"新消息"→ 每轮新增一行。
 */
function normalizeRoutineDigits(message) {
  return String(message).replace(/\d+/g, 'N');
}

/**
 * 例行日志分类：只有命中这些"周期性口头禅"的消息才允许跨条目折叠。
 * 不命中 → 返回 null，绝不参与折叠（保证异常/业务事件永不被合并掉）。
 */
const ROUTINE_MESSAGE_PATTERNS = [
  'progress hb_sent=',   // ZTE 数据面 / 控制面心跳指标（约每 10s 一条，数字必变）
  'progress slow=',      // SCG（深信服）数据面 hold 进度（约每 10s 一条，数字必变；display 状态变化会自然另起一条）
  'SCG 材料探测',         // SCG firm-auth 材料巡检（presence 布尔，材料状态变化时内容才会变）
  '账号态探针通过',        // 移动公众 L1 账号态探针
  '桌面登记成功',          // 移动公众 L2 桌面登记
  '分层巡检结果',          // 移动公众 L1/L2 汇总汇报
  '已同步桌面列表',        // 移动公众桌面同步
  '心跳', '保活周期', '保持长连接', '长连接保活', '发送保活',
  'REDQ', '103 认证', '118 用户身份', '118 身份',
];

/**
 * 计算"例行日志折叠键"：同 source + 同类型（去数字后文本一致）才得同一个键。
 * 键里**必带 source**，确保三平台日志各自成流、绝不互相折叠。
 */
function routineFoldKey(source, message) {
  if (!message) return null;
  const m = String(message);
  if (source === 'Heartbeat') return 'Heartbeat|' + normalizeRoutineDigits(m);
  for (const pattern of ROUTINE_MESSAGE_PATTERNS) {
    if (m.includes(pattern)) return source + '|' + normalizeRoutineDigits(m);
  }
  return null;
}

/**
 * 例行日志折叠索引：折叠键 → 内存里那一条日志对象。
 *
 * 【为什么不再用"向前扫 N 条" · 用户 2026-09-25 第六轮】
 * 原实现从数组末尾向前最多扫 300 条找同类条目。但一轮巡检里，多个账号的 progress / 心跳
 * 会插入成百上千条日志，一旦超过窗口，同类条目就**找不到上一轮那条** → 另起一条新的、
 * 从 x1 重新累计。真机回放里「分层巡检结果」被劈成 x190 + x37 两条，正是这个原因。
 * 改为按折叠键直接查表 ⇒ O(1) 命中上一轮那条，窗口大小不再影响正确性。
 */
const routineFoldIndex = new Map();

/** 折叠索引键：折叠键 + level + 账号（折叠键本身已含 source） */
function routineFoldIndexKey(foldKey, level, accountName) {
  return foldKey + '\u0000' + (level || 'info') + '\u0000' + (accountName || '');
}

// ---------------------------------------------------------------------------
// 【2026-09-26 用户要求】例行日志折叠计数（xN）按天清零
// ---------------------------------------------------------------------------
// 用户原话：「[ZTE样本主号] progress hb_sent=261 hb_recv=555 data=5 left=637sx4056
//            类似这样的日志，要按天清零，不然一直循环下去增加数量了。0点更新一下吧。」
//
// 折叠徽章 xN = "这条例行日志累计重复了多少次"，它此前只增不减（x4056 → x4057 …）。
// 现改为**按北京时间每天 0 点归 1**，当天内照旧累计 ⇒ 界面上的 xN 表示"今日重复次数"。
//   ① 只动**例行日志**（routineFoldKey 非空）——异常/业务条目一条都不许碰（取证红线）；
//   ② 只把 repeatCount 归 1，**不改文本、不删条目、不动磁盘原始流水**（落盘那 4000+ 条仍在）；
//   ③ 双保险：appendLog 惰性检查（进程休眠/重启后自动补上）+ 北京 0 点定时器（界面即时刷新）。
let routineFoldDay = getBeijingDateOnly();

/**
 * 跨天则把例行日志的折叠计数归 1。返回被重置的条目数（0 = 未跨天或无命中）。
 * @param {boolean} notify 是否经 SSE 立刻把归零后的条目推给前端（定时器路径用 true）。
 *   惰性路径传 false：紧接其后的那条新日志本来就会触发一次 SSE 更新，无需重复推送。
 */
function rolloverRoutineFoldCountsIfNeeded(notify) {
  const today = getBeijingDateOnly();
  if (today === routineFoldDay) return 0;
  routineFoldDay = today;
  let changed = 0;
  for (const entry of logs) {
    if (!entry || typeof entry.message !== 'string') continue;
    // ⚠️ 非例行日志（异常 / 业务事件）绝不触碰 —— 与折叠机制同一条红线
    if (!routineFoldKey(entry.source, entry.message)) continue;
    if ((entry.repeatCount || 1) <= 1) continue;
    entry.repeatCount = 1;
    changed++;
    if (!notify) continue;
    const payload = { ...entry, isUpdate: true };
    for (const client of sseClients) {
      try {
        if (canUserSeeLog(client.session, entry)) {
          client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      } catch (e) {
        sseClients.delete(client);
      }
    }
  }
  return changed;
}

/** 距下一个北京 0 点还有多少毫秒（北京无夏令时，恒 UTC+8，故可纯算术） */
function msUntilNextBeijingMidnight() {
  const OFFSET_MS = 8 * 3600 * 1000;
  const bj = Date.now() + OFFSET_MS;
  return (Math.floor(bj / 86400000) + 1) * 86400000 - bj;
}

/** 北京 0 点触发清零；**自续期**重排下一个 0 点（不做 while 轮询） */
function scheduleRoutineFoldDayRollover() {
  const timer = setTimeout(() => {
    try {
      rolloverRoutineFoldCountsIfNeeded(true);
    } catch (e) {
      // 日志维护出错绝不影响主流程，但必须留痕（不得空 catch）
      console.error(`[日志折叠] 跨天清零失败: ${e.message}`);
    }
    scheduleRoutineFoldDayRollover();
  }, msUntilNextBeijingMidnight());
  if (timer.unref) timer.unref();
}
scheduleRoutineFoldDayRollover();

// 自动日志清理维护定时器：每小时执行一次，自动清理超过 3 天的历史日志或多于 2000 条的数据
const logTrimTimer = setInterval(() => {
  if (logs.length > 1500) {
    logs.splice(0, logs.length - 1000);
  }
}, 3600 * 1000);
if (logTrimTimer.unref) logTrimTimer.unref();
function inferLogPlatform(source, platform) {
  if (source === 'SOHO' || source === 'CAG' || source === 'CSAP' || source === 'YDPc') return 'ydpc';
  // 移动公众（ecloud）走独立侧车，日志源固定为 ECLOUD —— 与移动爱家/天翼云的日志流严格分开
  if (source === ECLOUD_LOG_SOURCE || source === 'ECLOUD') return 'ecloud';
  if (source === 'Sign' || source === 'AIChat' || source === 'Hang' || source === 'Redeem') return 'ctyun';
  return platform || 'ctyun';
}

/** 构造一条原始日志条目（不做任何折叠） */
function buildLogEntry(source, message, level = 'info', accountName = '', platform = 'ctyun') {
  return {
    id: 'log_' + (++logIdCounter),
    timestamp: getBeijingTimeString(),
    source,
    message,
    level,
    accountName: accountName || '',
    platform: inferLogPlatform(source, platform),
    repeatCount: 1
  };
}

/**
 * 把一条日志并入内存日志流（重复项折叠为 xN + SSE 推送）。
 *
 * 【落盘与折叠的分工】磁盘上保留的是**原始流水**（每条 progress 心跳都在），
 * 本函数只负责内存/UI 侧的展示折叠 —— 取证信息不得因折叠而丢失。
 */
function ingestLogEntry(entry) {
  if (!entry || typeof entry.message !== 'string') return;
  const source = entry.source;
  const message = entry.message;
  const level = entry.level || 'info';
  const accountName = entry.accountName || '';
  const nowTime = entry.timestamp || getBeijingTimeString();

  // 全双工智能折叠机制：
  // 1. 同来源同内容的完全一致重复消息合并
  // 2. 心跳/周期性 routine 消息合并（只保留最新一条并叠加次数计数）

  // 【2026-09-25 用户要求·第四轮】例行日志按"折叠键"跨条目收敛。
  //
  // 旧实现只认 progress，且**遇到同 source 的非同类日志就中断向前搜索**（该逻辑已删除）。
  // 真机回放暴露了后果：一次保活里 progress 被"隧道建立 / 切片结束 / 心跳成功"等正常日志
  // 打断多次 → 每断一次就新起一条，各自累计 xN；内存里同源同账号的 progress 条目一度
  // 多达 21 条（x89 / x49 / x41 …），用户看到的正是"x11、x12、x13 … 一长串"。
  //
  // 现在改为：只要属于同类例行日志（routineFoldKey 相同），无论中间夹了什么、无论数字怎么变，
  // 一律并入**同一条** —— 只保留最新文本 + xN。异常与业务事件因 routineFoldKey 为 null
  // 而完全不参与折叠，取证信息一条不少。
  const foldKey = routineFoldKey(source, message);
  const foldIndexKey = foldKey ? routineFoldIndexKey(foldKey, level, accountName) : null;
  if (foldIndexKey) {
    const prev = routineFoldIndex.get(foldIndexKey);
    // 索引里可能是**已被淘汰出内存数组**的陈旧条目（数组有 2000 条上限），命中后先验明真身
    const at = prev ? logs.indexOf(prev) : -1;
    if (at !== -1) {
      prev.timestamp = nowTime;
      prev.message = message;
      prev.platform = entry.platform;
      prev.repeatCount = (prev.repeatCount || 1) + 1;
      // 【2026-09-24 用户要求·第三轮】折叠把该条目的时间戳推进到了"现在"，
      // 若仍留在原索引，历史回放会呈现"时间倒挂"（最新时间戳却排在中间）。
      // 因此把它移动到数组末尾 —— 保证 logs 恒为时间升序、最新一条永远在最后。
      if (at !== logs.length - 1) {
        logs.splice(at, 1);
        logs.push(prev);
      }
      const updatePayload = { ...prev, isUpdate: true };
      for (const client of sseClients) {
        try {
          if (canUserSeeLog(client.session, prev)) {
            client.res.write(`data: ${JSON.stringify(updatePayload)}\n\n`);
          }
        } catch (e) {
          sseClients.delete(client);
        }
      }
      return;
    }
    // 陈旧条目（已不在数组里）：清掉索引，等价于"本轮另起一条"
    if (prev) routineFoldIndex.delete(foldIndexKey);
  }

  // 【2026-09-25 第五轮】旧逻辑在这里还有一条「只看最后一条 + 只要两条都是例行就合并」
  // （isRoutinePair）的旁路。它有两个后果：
  //   ① 不同**类**的例行日志（progress hb_sent=… 与「心跳保持成功」）只要相邻就会互相折进去，
  //      把各自的 xN 搅在一起 —— 这正是「5 次心跳只累计出 x4」的根因；
  //   ② 它只看最后一条，跨条目场景必须靠上面的 routineFoldIndex 查表。
  // 现在例行日志的折叠**只认 routineFoldKey（键相同才合并）**；这里仅保留"完全同文本相邻重复"，
  // 用于非例行的连发重复（例如同一条错误连报两次），其判定不涉及任何"同源即兄弟"的宽松假设。
  if (logs.length > 0) {
    const last = logs[logs.length - 1];
    const sameAcc = (last.accountName || '') === (accountName || '');
    const sameSrc = last.source === source;
    const sameLvl = last.level === level;

    const isRepeat = sameAcc && sameSrc && sameLvl && last.message === message;

    if (isRepeat) {
      last.timestamp = nowTime;
      last.message = message;
      last.platform = entry.platform;
      last.repeatCount = (last.repeatCount || 1) + 1;
      // 这条"完全同文本"的重复若也属例行日志，顺手登记进折叠索引，
      // 免得下一轮心跳因为"索引里查不到"而另起一条。
      if (foldIndexKey) routineFoldIndex.set(foldIndexKey, last);

      const updatePayload = { ...last, isUpdate: true };
      for (const client of sseClients) {
        try {
          if (canUserSeeLog(client.session, last)) {
            client.res.write(`data: ${JSON.stringify(updatePayload)}\n\n`);
          }
        } catch (e) {
          sseClients.delete(client);
        }
      }
      return;
    }
  }

  // 关键事件、任务达成、异常告警或新业务：单独生成高亮条目
  logs.push(entry);
  // 例行日志登记进折叠索引：下一轮同类消息将直接命中它，不再依赖"向前扫 N 条"
  if (foldIndexKey) routineFoldIndex.set(foldIndexKey, entry);
  if (logs.length > 2000) logs.shift();

  // 推送给具备权限的 SSE 客户端
  for (const client of sseClients) {
    try {
      if (canUserSeeLog(client.session, entry)) {
        client.res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

/**
 * 记录一条日志。
 *
 * 【顺序很重要】先落盘、后折叠：
 *   磁盘上留的是**原始流水**（例如数据面 progress 每 10s 一条全部保留），
 *   内存里则折叠成一条 + xN 供界面展示。这样既能"事后取证"，界面又不会被刷屏。
 *   历史教训：日志只在内存里时，服务一重启就无法复盘"关机那一刻保活在不在跑"。
 */
function appendLog(source, message, level = 'info', accountName = '', platform = 'ctyun') {
  // 【2026-09-26】跨天则**先把例行日志的折叠计数归零**，再落这条新日志 ——
  // 保证"昨天那条"的 xN 不会在跨天后的第一条上被加成 x(N+1)（进程休眠/重启后靠这里补上）。
  rolloverRoutineFoldCountsIfNeeded(false);
  const entry = buildLogEntry(source, message, level, accountName, platform);
  const logPersister = runtime.logPersister;
  logPersister.append(entry);
  ingestLogEntry(entry);
}

/**
 * 启动时从磁盘回灌最近的日志到内存，使服务重启后控制台不至于空白。
 * 回灌只走 ingestLogEntry（折叠 + 入内存），**不再回写磁盘**，避免自我复制。
 */
function bootstrapLogsFromDisk() {
  if (BOOT_LOG_LINES <= 0) return 0;
  let rows = [];
  try {
    const logPersister = runtime.logPersister;
    rows = logPersister.loadRecent(BOOT_LOG_LINES);
  } catch (e) {
    console.error(`[日志落盘] 启动回灌失败: ${e.message}`);
    return 0;
  }
  for (const row of rows) {
    ingestLogEntry({
      id: 'log_' + (++logIdCounter),
      timestamp: row.timestamp || getBeijingTimeString(),
      source: row.source || 'System',
      message: row.message || '',
      level: row.level || 'info',
      accountName: row.accountName || '',
      platform: row.platform || 'ctyun',
      repeatCount: Math.max(1, parseInt(row.repeatCount, 10) || 1)
    });
  }
  return rows.length;
}

function canUserSeeLog(session, logEntry) {
  // 未登录完全不可见日志
  if (!session) return false;
  // 管理员可见全局所有日志
  if (session.role === 'admin') return true;
  
  // 普通用户权限严格收敛：只能看到属于自己用户账号的相关日志
  const currentUsername = session.username;

  // 1. 如果是认证或用户操作日志，只有针对该用户自己的日志才展示给该用户
  if (logEntry.source === 'Auth') {
    if (logEntry.message && logEntry.message.includes(`[${currentUsername}]`)) {
      return true;
    }
  }

  // 2. 如果是云电脑任务/心跳日志，必须严格匹配该用户自己名下的云电脑账号名称或手机号
  const ownedAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
  const ownedAccNames = ownedAccounts.map(a => a.name).filter(Boolean);
  const ownedAccUsers = ownedAccounts.map(a => a.user).filter(Boolean);
  
  if (logEntry.accountName && (ownedAccNames.includes(logEntry.accountName) || ownedAccUsers.includes(logEntry.accountName))) {
    return true;
  }
  for (const name of ownedAccNames) {
    if (logEntry.message && logEntry.message.includes(`[${name}]`)) return true;
  }
  for (const u of ownedAccUsers) {
    if (logEntry.message && logEntry.message.includes(`[${u}]`)) return true;
  }

  return false;
}

module.exports = {
  logs,
  sseClients,
  isHeartbeatOrRoutine,
  normalizeRoutineDigits,
  ROUTINE_MESSAGE_PATTERNS,
  routineFoldKey,
  routineFoldIndex,
  routineFoldIndexKey,
  rolloverRoutineFoldCountsIfNeeded,
  msUntilNextBeijingMidnight,
  scheduleRoutineFoldDayRollover,
  inferLogPlatform,
  buildLogEntry,
  ingestLogEntry,
  appendLog,
  bootstrapLogsFromDisk,
  canUserSeeLog,
};
