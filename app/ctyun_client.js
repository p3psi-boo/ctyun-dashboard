'use strict';

const WebSocket = require('ws');
const CtYunEncryption = require('./ctyun_encryption');
const runtime = require('./runtime');
const { getBeijingDateOnly, getBeijingTimeString, getBeijingTimeOnly } = require('./lib/time');
const { md5, sha256 } = require('./lib/crypto_util');
const { fetchWithTimeout } = require('./lib/net');
const { resolveTaskEnabled } = require('./lib/task_switch');

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

// ==========================================================
// 生产级天翼云原生客户端（纯协议实现保活心跳与会话链路）
// ==========================================================
class CtYunClient {
  constructor(account) {
    this.account = account;
    this.version = '103020001';
    this.deviceType = '60';
    this.loginInfo = account.savedLoginInfo || null;
    this.ws = null;
    this.wsAlive = false;
    this.encryptor = new CtYunEncryption();
    
    const todayStr = getBeijingDateOnly();
    const stats = account.stats || {};
    this.lastSuccessDate = stats.lastSuccessDate || todayStr;
    const initialTodayCount = (stats.lastSuccessDate === todayStr) ? (stats.todaySuccessCount || 0) : 0;

    this.metrics = {
      status: 'offline',
      currentHost: '',
      desktopName: '',
      keepAliveSeconds: appConfig.settings?.keepAliveSeconds || 60,
      cycleCountdown: 60,
      lastHeartbeatTime: '',
      lastHeartbeatResult: '未建立连接',
      successCount: initialTodayCount,
      errorCount: 0,
      officialTasks: [],
      userPoints: 0
    };

    this.workerRunning = false;
    this.loopTimer = null;
    this.countdownTimer = null;
    this.clinkPingTimer = null;
    this.endCurrentSession = null;
    this.isWebUserActive = false; // 用户是否正在通过浏览器操作云电脑
    this.webUserActiveUntil = 0;
    this.externalYieldUntil = 0; // 官方客户端抢占避让截止时间戳
    this.lastTokenRenewAt = Date.now();
    this.isTaskHanging = false; // 是否正在执行 Scheduler 精准调度的 1 小时挂机任务
    this.hangRetryTimer = null; // 挂机任务自动重试定时器 (未达标自愈续跑)
    this.hangRetryCount = 0;    // 当日挂机重试次数 (上限 24 次)
    this.hangReconnectCount = 0;      // 单次 runHangTask 内的"经证据鉴别后允许重连"次数 (上限 3)
    this.hangUnverifiedStreak = 0;    // 连续"取不到证据"的次数：达到阈值后退避更久，避免任何形式的顶人风暴
    this.signVerifyTimer = null;      // 打卡"待官方确认"复检定时器
    this.signVerifyPendingSince = null;
    this.signVerifyRound = 0;
  }

  // 检测今日挂机 1 小时任务是否已达成 (严格依据今日真实达成状态)
  // 开关语义统一入口：供本文件与 app/tasks/* 共用，杜绝各处就地读取原始字段
  resolveTask(taskType, desktop = null) {
    return resolveTaskEnabled(this.account, desktop, taskType);
  }

  isTodayHangTaskCompleted() {
    const todayStr = getBeijingDateOnly();
    // 1. 优先依据官方任务中心最新进度
    if (this.metrics.officialTasks && this.metrics.officialTasks.length > 0) {
      const hangTask = this.metrics.officialTasks.find(t => t.name.includes('使用1小时'));
      if (hangTask) {
        return hangTask.status === 2 || (hangTask.total > 0 && hangTask.current >= hangTask.total);
      }
    }
    // 2. 本地记录判定：必须是今日时间戳且达到 60 分钟
    if (this.account.stats?.lastHangTime && this.account.stats.lastHangTime.startsWith(todayStr)) {
      if ((this.account.stats.hangMinutesToday || 0) >= 60) {
        return true;
      }
    }
    return false;
  }

  // 官方 App / PC 客户端抢占自愈：后台主动让位后探测式恢复 (释放后脉冲从零重新计时)
  yieldToExternalClient(durationMinutes = 5) {
    const accName = this.account.name || this.account.user;
    this.externalYieldUntil = Date.now() + durationMinutes * 60 * 1000;
    this.metrics.status = 'online';
    this.metrics.lastHeartbeatResult = `官方客户端 (App/PC) 使用中，后台已主动让位避让 (剩余 ${durationMinutes} 分钟)`;
    appendLog('KeepAlive', `[${accName}] ⚡ 检测到官方客户端 (App/PC/网页) 正在连接使用，后台长连接立即主动让位避让 ${durationMinutes} 分钟，杜绝争抢通道！`, 'info');
    if (this.endCurrentSession) {
      this.endCurrentSession('Yield to External Client');
    }
  }

  // 挂机任务自愈重试调度：今日任务未达成时自动续跑 (尊重避让冷却与用户操作，绝不反抢)
  scheduleHangRetry(onLog = console.log) {
    const accName = this.account.name || this.account.user;
    if (this.hangRetryTimer) clearTimeout(this.hangRetryTimer);
    if (this.account.features?.cloudHang === false) return;
    if (this.account.enabled === false) return;
    if (this.hangRetryCount >= 24) {
      onLog('Hang', `[${accName}] 今日挂机自动重试已达上限 (24 次)，为避免夜间无谓重试已停止续跑，明日调度将自动执行。`, 'info');
      return;
    }

    const nowTs = Date.now();
    const yieldRemain = Math.max(this.externalYieldUntil - nowTs, 0);
    const webRemain = (this.isWebUserActive && this.webUserActiveUntil > nowTs) ? (this.webUserActiveUntil - nowTs) : 0;
    const maxRemain = Math.max(yieldRemain, webRemain);
    // 有避让冷却时按冷却结束 + 30 秒精准续跑；无冷却时默认 5 分钟后重试
    const delayMs = maxRemain > 0 ? (maxRemain + 30000) : (5 * 60 * 1000);
    this.hangRetryCount++;
    const waitMin = Math.max(1, Math.round(delayMs / 60000));
    onLog('Hang', `[${accName}] 🕓 今日挂机任务尚未达成，已安排自动重试 (第 ${this.hangRetryCount}/24 次，约 ${waitMin} 分钟后自动续跑)...`, 'info');

    this.hangRetryTimer = setTimeout(async () => {
      this.hangRetryTimer = null;
      try {
        await this.runHangTask(onLog);
      } catch (e) {
        onLog('Hang', `[${accName}] 挂机自动重试异常: ${e.message}`, 'error');
        this.scheduleHangRetry(onLog);
      }
    }, delayMs);
  }

  // 清除挂机重试定时器 (任务达成 / 用户关闭挂机开关时调用)
  clearHangRetry() {
    if (this.hangRetryTimer) {
      clearTimeout(this.hangRetryTimer);
      this.hangRetryTimer = null;
    }
    this.hangRetryCount = 0;
  }

  // ==========================================================
  // 登录打卡的"待官方确认"复检机制 (暗线 C 的结构性修复)
  // ----------------------------------------------------------
  // 历史缺陷：打卡在固定 300 秒观察窗内未获官方确认即结束，且返回 success:true，
  // 造成"日志说成功、积分实际未到"。用户实测官方落账延迟约 14 分钟，远大于 5 分钟窗口。
  // 修复原则：窗口只用于【何时释放通道】，绝不作为【成败的判定依据】。
  // 判定一律以官方任务中心为准，通过跨分钟多次复检收敛 —— 复检期间绝不重新认领，因此不会顶人。
  // ==========================================================
  isSignTaskDone() {
    const t = this.metrics.officialTasks?.find(x => x.name.includes('登录AI云电脑') || x.name.includes('登录'));
    return !!(t && (t.status === 2 || (t.total > 0 && t.current >= t.total)));
  }

  clearSignVerify() {
    if (this.signVerifyTimer) {
      clearTimeout(this.signVerifyTimer);
      this.signVerifyTimer = null;
    }
    this.signVerifyPendingSince = null;
    this.signVerifyRound = 0;
  }

  /**
   * 认领已下发、官方尚未确认时调用：安排跨分钟复检，只读官方状态，绝不再次认领。
   * @param {(src:string,msg:string,lvl:string)=>void} onLog 日志回调
   * @param {number} totalWaitMinutes 观察总时长（默认 45 分钟，覆盖实测约 14 分钟的落账延迟）
   */
  scheduleSignVerify(onLog = console.log, totalWaitMinutes = 45) {
    const accName = this.account.name || this.account.user;
    if (!this.signVerifyPendingSince) this.signVerifyPendingSince = Date.now();
    if (this.signVerifyTimer) return;

    const stepMin = 5;
    this.signVerifyRound = this.signVerifyRound || 0;
    const elapsedMin = Math.floor((Date.now() - this.signVerifyPendingSince) / 60000);

    if (elapsedMin >= totalWaitMinutes) {
      onLog('Sign', `[${accName}] ⏳ 打卡复检已满 ${totalWaitMinutes} 分钟，官方任务中心仍未确认【登录AI云电脑】达成。本次打卡判定为【未达成】——不再重试认领，等待用户客户端登录或下一次调度。`, 'warning');
      this.clearSignVerify();
      return;
    }

    this.signVerifyRound++;
    onLog('Sign', `[${accName}] 🕓 打卡认领已下发，官方尚未确认 (已等待约 ${elapsedMin} 分钟)。安排 ${stepMin} 分钟后复检官方任务中心 (第 ${this.signVerifyRound} 次，最长观察 ${totalWaitMinutes} 分钟；复检期间不重新认领，不会打扰客户端)。`, 'info');

    this.signVerifyTimer = setTimeout(async () => {
      this.signVerifyTimer = null;
      try {
        const r = await this.refreshOfficialTasks();
        if (!r || r.ok === false) {
          onLog('Sign', `[${accName}] 打卡复检未能读到官方任务中心 (${(r && r.reason) || '原因未知'})，本次不判定，稍后继续复检。`, 'warning');
          this.scheduleSignVerify(onLog, totalWaitMinutes);
          return;
        }
        if (this.isSignTaskDone()) {
          const nowStr = getBeijingTimeString();
          this.account.stats.lastSignTime = nowStr;
          saveConfig(appConfig);
          onLog('Sign', `🎉 官方任务中心已确认【登录AI云电脑】达成 (+100积分)！打卡完成时间 ${nowStr}。`, 'success');
          sendAccountNotification(this.account, `✅ 登录打卡达成 - ${accName}`, `账号【${accName}】今日登录AI云电脑任务已完成，100 积分已到账！`);
          this.clearSignVerify();
          return;
        }
        this.scheduleSignVerify(onLog, totalWaitMinutes);
      } catch (e) {
        onLog('Sign', `[${accName}] 打卡复检异常: ${e.message}，稍后继续。`, 'warning');
        this.scheduleSignVerify(onLog, totalWaitMinutes);
      }
    }, stepMin * 60 * 1000);
  }

  /**
   * 挂机中断来源证据化鉴别。
   *
   * 判定方向的不对称性是本函数的全部意义所在：
   *   - 误判为 real_client  → 代价只是我们自己多等 10 分钟 (不打扰任何人)
   *   - 误判为 false_alarm  → 代价是把正在使用云电脑的真实用户顶下线 (不可接受)
   * 因此凡"取不到可信证据"一律返回 'unverified'，并由调用方按 real_client 处理。
   * 这正是历史上"没有证据被当成没有用户"的反面。
   *
   * 【2026-09-23 用户实测调整】观察总时长 90 秒 → 5 分钟。
   * 背景：用户实测「90 秒内官方挂机计时并未增长，但人确实在用」，导致误判为无人在用而被反复顶下线。
   * 用户要求先验证"是不是 90 秒太短、不足以等到官方落账变化"，故把采样跨度拉到 5 分钟。
   * 注意：本调整**只在"官方计时为延迟落账"时有效**。若 5 分钟内仍恒定不变，
   * 则说明计时根本不随我们的协议会话推进（按官方客户端会话结算），
   * 此时延长窗口无效，须改为"取不到增长证据一律按可能有真人处理"（翻转判定方向）。
   */
  async diagnoseHangInterruption(onLog = console.log, targetName = '云电脑', preRefresh = null) {
    const accName = this.account.name || this.account.user;
    const getUsage = () => {
      const t = this.metrics.officialTasks?.find(x => x.name.includes('使用1小时'));
      return t ? (t.current || 0) : 0;
    };

    const r1 = preRefresh || await this.refreshOfficialTasks();
    if (!r1 || r1.ok === false) {
      appendLog('Hang', `[${accName}][${targetName}] 🔎 无法鉴别中断来源：官方任务中心不可读 (${(r1 && r1.reason) || '原因未知'})。取不到证据即不得重新认领，按"可能有真机用户"处理。`, 'warning');
      return 'unverified';
    }
    if (this.isTodayHangTaskCompleted()) return 'completed';

    const before = getUsage();

    // 观察参数：5 次采样 × 60 秒 = 总跨度 5 分钟（用户指定）。
    // 采样间隔仍取 60 秒，是为了覆盖官方"按分钟粒度落账"的跳变边界 ——
    // 一次性只睡 5 分钟再取值，可能恰好落在两次跳变之间而看不到增量。
    const DIAG_SAMPLES = 5;
    const DIAG_GAP_MS = 60000;
    const totalMin = Math.round((DIAG_SAMPLES * DIAG_GAP_MS) / 60000);
    onLog('Hang', `[${targetName}] 🔎 正在鉴别中断来源 (观察约 ${totalMin} 分钟，检查官方计时是否继续增长；当前 ${before}s)...`, 'info');

    let maxSeen = before;
    for (let i = 0; i < DIAG_SAMPLES; i++) {
      await new Promise(r => setTimeout(r, DIAG_GAP_MS));
      const r = await this.refreshOfficialTasks();
      if (!r || r.ok === false) {
        appendLog('Hang', `[${accName}][${targetName}] 🔎 鉴别过程第 ${i + 1} 次取值失败 (${(r && r.reason) || '原因未知'})，无法形成结论，按"可能有真机用户"处理。`, 'warning');
        return 'unverified';
      }
      if (this.isTodayHangTaskCompleted()) return 'completed';
      const seen = getUsage();
      maxSeen = Math.max(maxSeen, seen);
      appendLog('Hang', `[${accName}][${targetName}] 🔎 鉴别采样 ${i + 1}/${DIAG_SAMPLES} (第 ${(i + 1)} 分钟)：官方计时 ${seen}s (初始 ${before}s，最大 ${maxSeen}s)。`, 'info');
    }

    const delta = maxSeen - before;
    // 阈值取 30 秒：本会话此时已断开，官方计时若仍在增长即说明另有他人在使用。
    // 【已知局限】"计时未增长"是否等价于"无人在用"，尚待本次 5 分钟实测验证 ——
    // 用户曾实测 90 秒内计时不涨却确实在用，若 5 分钟仍不涨，则本条注释的前提不成立，
    // 需按上方函数注释所述翻转判定方向。

    const verdict = delta >= 30 ? 'real_client' : 'false_alarm';
    appendLog('Hang', `[${accName}][${targetName}] 中断鉴别结果: ${totalMin} 分钟内官方计时 ${before}s → ${maxSeen}s (增量 ${delta}s)，判定 = ${verdict === 'real_client' ? '真实客户端正在使用 (计时持续增长)，必须让位' : '无人在用 (计时冻结)，可安全续连'}`, 'info');
    return verdict;
  }

  // 用户点击浏览器访问云电脑时调用：立即主动断开后台保活连接，并保持避让让位
  yieldToWebUser(durationMinutes = 60) {
    const accName = this.account.name || this.account.user;
    const wasActive = this.isWebUserActive;
    this.isWebUserActive = true;
    this.webUserActiveUntil = Date.now() + durationMinutes * 60 * 1000;
    
    if (!wasActive) {
      appendLog('KeepAlive', `[${accName}] 🚀 检测到正在打开浏览器访问操作云电脑，后台长连接主动让位断开，杜绝互踢！`, 'info');
    }
    
    if (this.endCurrentSession) {
      this.endCurrentSession('Yield to Web User');
    }
  }

  // 释放避让：用户关闭页面或手动恢复
  async resumeFromWebUser() {
    const accName = this.account.name || this.account.user;
    if (!this.isWebUserActive) return;
    this.isWebUserActive = false;
    this.webUserActiveUntil = 0;

    appendLog('KeepAlive', `[${accName}] 浏览器访问已关闭，恢复后台长连接保活守护与启动监测。`, 'info');

    // 只要账号开启了保活，无论当前是运行中还是关机，一律启动持久巡检守护 (关机时自动转入 20s/10m 持久监测开机)
    if (this.account.enabled && this.account.features?.keepAlive === true) {
      if (!this.workerRunning) {
        this.startKeepAliveWorker();
      }
    }
  }

  // 手动/交互模式登录验证（提供验证码和 challengeId）
  async loginWithCaptcha(captchaCode, challengeId, challengeCode) {
    const user = this.account.user;
    const password = this.account.password;
    const deviceCode = this.account.deviceCode;

    const body = new URLSearchParams({
      userAccount: user,
      password: sha256(password + challengeCode),
      sha256Password: sha256(sha256(password) + challengeCode),
      challengeId,
      captchaCode,
      deviceCode,
      deviceName: 'Chrome浏览器',
      deviceType: this.deviceType,
      deviceModel: 'Windows NT 10.0; Win64; x64',
      appVersion: '3.2.0',
      sysVersion: 'Windows NT 10.0; Win64; x64',
      clientVersion: this.version
    });

    const loginRes = await fetch('https://desk.ctyun.cn:8810/api/auth/client/login', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
        'ctg-devicetype': this.deviceType,
        'ctg-version': this.version,
        'ctg-devicecode': deviceCode,
        'referer': 'https://pc.ctyun.cn/',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    const result = await loginRes.json();
    if (result.code === 0 && result.data) {
      this.loginInfo = result.data;
      this.account.savedLoginInfo = result.data;
      this.account.bound = !!result.data.bondedDevice;
      this.account.sessionExpired = false;
      saveConfig(appConfig);
      return { success: true, data: result.data };
    }

    return { 
      success: false, 
      error: result.msg || '登录失败，请检查验证码或密码！',
      code: result.code 
    };
  }

  // 生成单点登录/免密直通 Token (用于无感静默续期与直达操作)
  async genLoginToken(effectiveSeconds = 300) {
    if (!this.loginInfo) {
      throw new Error('账号尚未登录，无法生成登录 Token');
    }
    // 瞬态防护：单次重试 (5 秒间隔)，规避偶发的服务端并发刷新冲突
    let lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/auth/client/genLoginToken', {
        method: 'POST',
        headers: this.getSignedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ authAppModel: 34, effectiveSeconds })
      });
      const json = await res.json();
      if (json.code === 0 && json.data?.token) {
        return json.data.token;
      }
      lastErr = `${json.msg || '获取免密 Token 失败'} (Code: ${json.code})`;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    throw new Error(lastErr);
  }

  // 无感静默轮转刷新 Token (通过现有会话生成免密票据并重新登录换取全新凭据，彻底杜绝会话失效)
  async renewToken() {
    if (!this.loginInfo) {
      throw new Error('账号尚未登录，无法续期');
    }
    const dcMasked = String(this.account.deviceCode || '无').replace(/^(.{10}).*(.{4})$/, '$1****$2');
    let loginToken;
    try {
      loginToken = await this.genLoginToken(300);
    } catch (e) {
      // 环节定位①：签发 (genLoginToken) 被拒 = 官方拒绝本会话签发新免密凭据
      throw new Error(`签发免密凭据被拒: ${e.message} [设备码: ${dcMasked}, UserId: ${this.loginInfo.userId}]`);
    }
    let newInfo;
    try {
      newInfo = await this.loginByToken(loginToken);
    } catch (e) {
      // 环节定位②：消费 (tokenLogin) 被拒 = 官方拒绝用该凭据建立新会话
      throw new Error(`消费免密凭据被拒: ${e.message} [设备码: ${dcMasked}, UserId: ${this.loginInfo.userId}]`);
    }
    this.loginInfo = newInfo;
    this.account.savedLoginInfo = newInfo;
    this.account.sessionExpired = false;
    saveConfig(appConfig);
    appendLog('Auth', `[${this.account.name || this.account.user}] 🔄 天翼云会话已自动无感续期刷新！`, 'info', this.account.name, 'ctyun');
    return newInfo;
  }

  // 会话失效检测与 Webhook 告警机制
  handleSessionExpired(reason = '登录凭据失效') {
    const accName = this.account.name || this.account.user;
    if (this.account.sessionExpired) return; // 避免重复触发风暴告警
    this.account.sessionExpired = true;
    this.account.stats = this.account.stats || {};
    this.account.stats.keepAliveStatus = 'offline';
    saveConfig(appConfig);

    appendLog('Auth', `[${accName}] ⚠️ 登录会话完全失效 (${reason})，已停用自动重试并发出告警通知！`, 'error');
    sendAccountNotification(
      this.account,
      `⚠️ 天翼云账号凭据失效 - ${accName}`,
      `账号【${accName}】的登录凭据已完全过期或失效 (${reason})。系统已自动停止无效重试，请前往 Web 控制台重新验证登录。`,
      { account: accName, task: '凭据维护', status: '会话失效' }
    );
  }

  async login(maxRetries = 1) {
    if (this.loginInfo && !this.account.sessionExpired) {
      // 命中内存缓存：未产生任何真实网络登录事件 (fromCache 标记供签到等需要真实登录事件的调用方区分)
      return { success: true, data: this.loginInfo, fromCache: true };
    }
    // 优先尝试无感静默续期刷新
    if (this.loginInfo) {
      try {
        const newInfo = await this.renewToken();
        if (newInfo) {
          return { success: true, data: newInfo };
        }
      } catch (e) {}
    }
    this.handleSessionExpired('会话已过期，需要人工验证登录');
    return { success: false, error: '会话已过期，请在控制台输入验证码重新登录！' };
  }

  getSignedHeaders(customHeaders = {}) {
    if (!this.loginInfo) return {};
    const timestamp = Date.now().toString();
    const str = `${this.deviceType}${timestamp}${this.loginInfo.tenantId}${timestamp}${this.loginInfo.userId}${this.version}${this.loginInfo.secretKey}`;
    const sig = md5(str);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'ctg-devicetype': this.deviceType,
      'ctg-version': this.version,
      'ctg-devicecode': this.account.deviceCode,
      'ctg-userid': this.loginInfo.userId.toString(),
      'ctg-tenantid': this.loginInfo.tenantId.toString(),
      'ctg-timestamp': timestamp,
      'ctg-requestid': timestamp,
      'ctg-signaturestr': sig,
      'referer': 'https://pc.ctyun.cn/',
      ...customHeaders
    };
    // 协议对齐 ctyun-pro：官方会话令牌 Cookie (genLoginToken/tokenLogin 等鉴权签发类接口
    // 依赖此 Cookie 关联"当前设备会话"；缺失时官方按未知设备处理，导致免密凭据被拒)
    if (this.loginInfo.token) {
      headers['Cookie'] = `token=${this.loginInfo.token}`;
    }
    return headers;
  }

  // 智能解析云电脑硬件规格 (完全对齐 ctyun-pro parseDesktopSpec 策略)
  // 天翼云官方列表接口不直接下发 cpuCore/memoryGB 数值字段，规格一律从 flavorName / desktopName 文本中提取，
  // 提取不到时按官方套餐版本名智能映射 (旗舰版 16C32G / 尊享·精英 8C16G / 标准 4C8G / 政企 8C16G)
  static extractDesktopSpecs(item = {}, defaultFlavor = '') {
    const flavor = String(item.flavorName || item.prodGroupName || '');
    const name = String(item.desktopName || item.objName || item.poolName || '');

    // 1. 优先从 flavorName 与 desktopName 中提取显式 "4C8G / 8C16G / 4核8G" 规格
    const specMatch = flavor.match(/(\d+C\d+G)/i) || name.match(/(\d+C\d+G)/i);
    if (specMatch) {
      const spec = specMatch[1].toUpperCase(); // e.g. "8C16G"
      const cpuNum = spec.match(/^(\d+)C/)[1];
      const memNum = spec.match(/C(\d+)G/)[1];
      return {
        cpu: `${cpuNum}核`,
        memory: `${memNum}G`,
        os: 'Windows',
        flavorName: flavor || defaultFlavor,
        specStr: `${cpuNum}核/${memNum}G`
      };
    }

    // 2. 兼容 "4核8G / 4核/8G / 4vCPU 8GB" 等中文变体写法
    const cnMatch = (flavor + ' ' + name).match(/(\d+)\s*(?:核|vCPU)\s*[/]?\s*(\d+)\s*(?:G|GB|GiB)/i);
    if (cnMatch) {
      return {
        cpu: `${cnMatch[1]}核`,
        memory: `${cnMatch[2]}G`,
        os: 'Windows',
        flavorName: flavor || defaultFlavor,
        specStr: `${cnMatch[1]}核/${cnMatch[2]}G`
      };
    }

    // 3. 按官方套餐版本名智能映射 (ctyun-pro 同款策略)
    let spec = '8C16G'; // 默认为 8C16G (ctyun-pro 同款兜底)
    if (name.includes('旗舰版') || flavor.includes('旗舰版')) spec = '16C32G';
    else if (name.includes('尊享版') || flavor.includes('尊享版') || name.includes('精英版') || flavor.includes('精英版')) spec = '8C16G';
    else if (name.includes('标准版') || flavor.includes('标准版')) spec = '4C8G';
    else if (name.includes('政企') || flavor.includes('政企') || item.isPool || item.objType === 1) spec = '8C16G';

    const cpuNum = spec.match(/^(\d+)C/)[1];
    const memNum = spec.match(/C(\d+)G/)[1];

    return {
      cpu: `${cpuNum}核`,
      memory: `${memNum}G`,
      os: 'Windows',
      flavorName: flavor || defaultFlavor,
      specStr: `${cpuNum}核/${memNum}G`
    };
  }

  // 解析天翼云全形态云电脑列表 (普通独立单机、政企桌面池 POOL、抢占式桌面)
  static parseAllDesktops(data = {}) {
    const list = [];
    const seen = new Set();

    // 1. 普通单机 (公众版 / 个人独立机 / 尊享版等)
    if (Array.isArray(data.desktopList)) {
      for (const item of data.desktopList) {
        const id = String(item.desktopId || item.objId || '');
        if (id && !seen.has(id)) {
          seen.add(id);
          const spec = CtYunClient.extractDesktopSpecs(item, '公众版');
          list.push({
            desktopId: id,
            objId: String(item.objId || id),
            desktopName: item.desktopName || item.objName || '天翼云电脑',
            desktopCode: item.desktopCode || '',
            useStatusText: item.useStatusText || item.useStatus || '运行中',
            useStatus: item.useStatus,
            imageName: item.imageName || '',
            flavorName: spec.flavorName,
            cpu: spec.cpu,
            memory: spec.memory,
            os: spec.os,
            specStr: spec.specStr,
            objType: item.objType ?? 0,
            isPool: false
          });
        }
      }
    }

    // 2. 政企桌面池 (POOL)
    if (Array.isArray(data.desktopPoolList)) {
      for (const item of data.desktopPoolList) {
        const poolId = String(item.poolId || item.objId || item.desktopId || '');
        const id = String(item.desktopId || poolId);
        if (id && !seen.has(id)) {
          seen.add(id);
          const spec = CtYunClient.extractDesktopSpecs(item, '政企版');
          list.push({
            desktopId: id,
            objId: poolId,
            desktopName: item.poolName || item.desktopName || '天翼云电脑(政企桌面池)',
            desktopCode: item.desktopCode || poolId,
            useStatusText: item.useStatusText || item.useStatus || '运行中',
            useStatus: item.useStatus,
            imageName: item.imageName || '',
            flavorName: spec.flavorName,
            cpu: spec.cpu,
            memory: spec.memory,
            os: spec.os,
            specStr: spec.specStr,
            objType: item.objType ?? 1,
            isPool: true
          });
        }
      }
    }

    // 3. 抢占式云电脑 (Preemption)
    if (Array.isArray(data.preemptionDesktopList)) {
      for (const item of data.preemptionDesktopList) {
        const id = String(item.desktopId || item.objId || '');
        if (id && !seen.has(id)) {
          seen.add(id);
          const spec = CtYunClient.extractDesktopSpecs(item, '抢占式');
          list.push({
            desktopId: id,
            objId: id,
            desktopName: item.desktopName || '天翼云电脑(抢占式)',
            desktopCode: item.desktopCode || id,
            useStatusText: item.useStatusText || item.useStatus || '运行中',
            useStatus: item.useStatus,
            imageName: item.imageName || '',
            flavorName: spec.flavorName,
            cpu: spec.cpu,
            memory: spec.memory,
            os: spec.os,
            specStr: spec.specStr,
            objType: item.objType ?? 2,
            isPool: false
          });
        }
      }
    }

    return list;
  }

  // 官方扫码登录 1: 生成二维码数据
  async genQrCode() {
    const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/auth/client/qrCode/genData', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
        'ctg-devicetype': this.deviceType,
        'ctg-version': this.version,
        'ctg-devicecode': this.account.deviceCode,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const json = await res.json();
    if (json.code !== 0 || !json.data?.qrCodeId) {
      throw new Error(json.msg || '获取二维码失败');
    }
    const qrCodeId = json.data.qrCodeId;
    let qrUrl = '';
    if (json.data.qrCodeEndpoint) {
      const endpoint = json.data.qrCodeEndpoint;
      const sep = endpoint.includes('?') ? '&' : '?';
      qrUrl = `${endpoint}${sep}qrCodeId=${encodeURIComponent(qrCodeId)}&loginMode=1`;
    } else {
      qrUrl = `https://desk.ctyun.cn/selforder/#/login-confirm?qrCodeId=${encodeURIComponent(qrCodeId)}&loginMode=1`;
    }
    return { qrCodeId, qrUrl };
  }

  // 官方扫码登录 2: 轮询二维码授权状态
  async getQrCodeStatus(qrCodeId) {
    const res = await fetchWithTimeout(`https://desk.ctyun.cn:8810/api/auth/client/qrCode/getStatus?qrCodeId=${encodeURIComponent(qrCodeId)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
        'ctg-devicetype': this.deviceType,
        'ctg-version': this.version,
        'ctg-devicecode': this.account.deviceCode,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const json = await res.json();
    if (json.code !== 0 || !json.data) {
      throw new Error(json.msg || '查询扫码状态失败');
    }
    return {
      codeStatus: json.data.codeStatus,
      loginToken: json.data.loginToken || undefined
    };
  }

  // 官方扫码登录 3: 通过 Token 换取正式登录态
  async loginByToken(accessToken) {
    // 关键自愈：免密凭据与"签发会话的设备"绑定。若账号当前 deviceCode 与会话签发设备不一致
    // (常见于长期未重新验证 / 迁移部署 / 重新生成过设备码)，官方将拒绝: "不允许在当前设备使用此凭据"。
    // 因此优先提交会话自身携带的 deviceCode，保证凭据签发设备与消费设备严格一致。
    const sessionDeviceCode = this.loginInfo?.deviceCode || this.account.deviceCode;
    const baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'ctg-devicetype': this.deviceType,
      'ctg-version': this.version,
      'ctg-devicecode': sessionDeviceCode,
      'Content-Type': 'application/json'
    };
    // 核心对齐：若已有会话进行 renewToken 续期，必须使用带会话 Cookie 与签名的 headers，
    // 否则官方鉴权中心将此请求视为无上下文的裸请求，拒绝消费该免密凭据
    const reqHeaders = this.loginInfo ? this.getSignedHeaders(baseHeaders) : baseHeaders;

    const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/auth/client/tokenLogin', {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({
        accessToken,
        osType: 'Windows',
        deviceModel: 'Windows NT 10.0; Win64; x64',
        appVersion: '3.2.0',
        deviceCode: sessionDeviceCode,
        deviceName: 'Chrome浏览器',
        deviceType: this.deviceType,
        sysVersion: 'Windows NT 10.0; Win64; x64',
        clientVersion: this.version
      })
    });
    const json = await res.json();
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(`${json.msg || '登录验证失败'} (Code: ${json.code})`);
    }
    this.loginInfo = json.data;
    this.account.savedLoginInfo = json.data;
    this.account.bound = true;
    this.account.sessionExpired = false;
    // 会话设备码回写对齐：续期成功后账号设备码与会话完全一致，后续轮转永不再错配
    if (json.data.deviceCode) {
      this.account.deviceCode = json.data.deviceCode;
    } else if (this.loginInfo?.deviceCode) {
      this.account.deviceCode = this.loginInfo.deviceCode;
    }
    if (json.data.mobilephone) {
      this.account.user = json.data.mobilephone;
    }
    saveConfig(appConfig);
    return json.data;
  }

  // 获取绑定设备短信图形验证码
  async getSmsCodeCaptcha() {
    const timestamp = Date.now();
    const url = `https://desk.ctyun.cn:8810/api/auth/client/validateCode/captcha?width=120&height=40&_t=${timestamp}`;
    const res = await fetchWithTimeout(url, { headers: this.getSignedHeaders() });
    if (!res.ok) {
      throw new Error(`获取短信验证码图验失败: HTTP ${res.status}`);
    }
    const captchaKey = res.headers.get('ctg-captcha-key') || res.headers.get('CTG-CAPTCHA-KEY') || '';
    const arrayBuffer = await res.arrayBuffer();
    const base64Img = `data:image/jpeg;base64,${Buffer.from(arrayBuffer).toString('base64')}`;
    return { captchaImage: base64Img, captchaKey };
  }

  // 发送短信验证码 (官方风控要求携带 captchaCode 与 captchaCodeKey)
  async sendSmsCode(userPhone, captchaCode, captchaCodeKey = '') {
    let url = `https://desk.ctyun.cn:8810/api/cdserv/client/device/getSmsCode?mobilePhone=${encodeURIComponent(userPhone)}&captchaCode=${encodeURIComponent(captchaCode)}`;
    if (captchaCodeKey) {
      url += `&captchaCodeKey=${encodeURIComponent(captchaCodeKey)}`;
    }
    const res = await fetchWithTimeout(url, { headers: this.getSignedHeaders() });
    const smsKey = res.headers.get('ctg-sms-key') || res.headers.get('CTG-SMS-KEY') || '';
    const json = await res.json();
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '发送短信验证码失败');
    }
    return { success: true, smsKey };
  }

  // 绑定设备 (官方要求携带 verificationCode 与 smsCodeKey)
  async bindDevice(verificationCode, smsCodeKey = '') {
    const formData = new URLSearchParams();
    formData.append('verificationCode', verificationCode.trim());
    if (smsCodeKey) {
      formData.append('smsCodeKey', smsCodeKey.trim());
    }
    formData.append('deviceName', 'Chrome浏览器');
    formData.append('deviceCode', this.account.deviceCode);
    formData.append('deviceModel', 'Windows NT 10.0; Win64; x64');
    formData.append('sysVersion', 'Windows NT 10.0; Win64; x64');
    formData.append('appVersion', '3.2.0');
    formData.append('hostName', 'pc.ctyun.cn');
    formData.append('deviceInfo', 'Win32');

    const url = 'https://desk.ctyun.cn:8810/api/cdserv/client/device/binding';
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: this.getSignedHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: formData.toString()
    });

    const json = await res.json();
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '绑定设备失败');
    }
    if (this.loginInfo) {
      this.loginInfo.bondedDevice = true;
    }
    return { success: true };
  }

  async getDesktops() {
    if (!this.loginInfo) {
      return this.desktopsCache || [];
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      const mergedList = [];
      const seenIds = new Set();
      let isAuthExpired = false;

      // 1. 全规格 pageDesktop 查询云电脑 (支持独立机、池化及抢占式)
      try {
        const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/desktop/client/pageDesktop', {
          method: 'POST',
          headers: this.getSignedHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            getCnt: 50,
            desktopTypes: ['1', '2001', '2002', '2003'],
            sortType: 'createTimeV1'
          })
        });
        const json = await res.json();
        if (json.code === 0 && json.data) {
          const list1 = CtYunClient.parseAllDesktops(json.data);
          for (const d of list1) {
            const id = String(d.desktopId || d.objId || '');
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              mergedList.push(d);
            }
          }
        } else if (json.code === 40010 || String(json.msg || '').includes('登录信息已过期') || String(json.msg || '').includes('会话已过期')) {
          isAuthExpired = true;
        }
      } catch (e) {}

      // 2. 官方备用接口合并：api/desktop/client/list (覆盖所有自建、公有池与专属云电脑类型)
      try {
        const resList = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/desktop/client/list', {
          method: 'GET',
          headers: this.getSignedHeaders()
        });
        const jsonList = await resList.json();
        if (jsonList.code === 0 && jsonList.data) {
          const list2 = CtYunClient.parseAllDesktops(jsonList.data);
          for (const d of list2) {
            const id = String(d.desktopId || d.objId || '');
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              mergedList.push(d);
            }
          }
        } else if (jsonList.code === 40010 || String(jsonList.msg || '').includes('登录信息已过期') || String(jsonList.msg || '').includes('会话已过期')) {
          isAuthExpired = true;
        }
      } catch (e) {}

      if (mergedList.length > 0) {
        // 差量合并引擎 (Diff-Merge)：保留用户本地已设置的单机保活与任务偏好
        const oldMap = new Map((this.account.desktops || this.desktopsCache || []).map(d => [String(d.desktopId || d.objId), d]));
        for (const d of mergedList) {
          const dKey = String(d.desktopId || d.objId);
          const old = oldMap.get(dKey);
          if (old) {
            if (old.keepaliveEnabled !== undefined) d.keepaliveEnabled = old.keepaliveEnabled;
            if (old.taskEnabled !== undefined) d.taskEnabled = old.taskEnabled;
            if (old.autoBootEnabled !== undefined) d.autoBootEnabled = old.autoBootEnabled;
            if (old.keepaliveInterval !== undefined) d.keepaliveInterval = old.keepaliveInterval;
            if (old.lastPulseAt !== undefined) d.lastPulseAt = old.lastPulseAt;
          } else {
            if (d.keepaliveEnabled === undefined) d.keepaliveEnabled = true;
            if (d.taskEnabled === undefined) d.taskEnabled = true;
            if (d.autoBootEnabled === undefined) d.autoBootEnabled = true;
          }
        }
        this.desktopsCache = mergedList;
        this.account.desktops = mergedList;
        for (const d of mergedList) this.checkExternalPowerOn(d);
        return mergedList;
      }

      // 如果明确是会话过期错误且是第 1 次尝试，执行无感自动续期重试
      if (isAuthExpired && attempt === 1) {
        try {
          await this.renewToken();
          continue; // 用新凭据重试
        } catch (e) {
          this.handleSessionExpired('登录凭据已过期，自动续期失败');
          break;
        }
      }

      break;
    }
    return this.desktopsCache || [];
  }

  async connect(desktopId, vdCommand = '') {
    if (!this.loginInfo) {
      throw new Error('未登录');
    }

    const dIdStr = String(desktopId);

    // 1. 优先通过官方首选 status 接口获取桌面连接与证书信息 (普通单机优先)
    try {
      const statusUrl = `https://desk.ctyun.cn:8810/api/desktop/client/status?desktopId=${encodeURIComponent(dIdStr)}&specifiedCertCategory=1`;
      const sRes = await fetchWithTimeout(statusUrl, { headers: this.getSignedHeaders() });
      const sJson = await sRes.json();
      if (sJson.code === 0 && sJson.data?.desktopInfo?.clinkLvsOutHost) {
        return sJson.data.desktopInfo;
      }
      if (sJson.code === 40010 || String(sJson.msg || '').includes('登录信息已过期') || String(sJson.msg || '').includes('会话已过期')) {
        await this.renewToken().catch(() => {});
      }
    } catch (e) {}

    // 2. 备用通过 connect 接口获取 (政企桌面池 / 启动中虚拟机等)
    const connBody = new URLSearchParams({
      objId: dIdStr,
      objType: '0',
      osType: '15',
      deviceId: this.deviceType,
      vdCommand: vdCommand || '',
      ipAddress: '',
      macAddress: '',
      deviceCode: this.account.deviceCode,
      deviceName: 'Chrome浏览器',
      deviceType: this.deviceType,
      deviceModel: 'Windows NT 10.0; Win64; x64',
      desktopId: dIdStr,
      appVersion: '3.2.0',
      sysVersion: 'Windows NT 10.0; Win64; x64',
      clientVersion: this.version,
      specifiedCertCategory: '1'
    });

    const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/desktop/client/connect', {
      method: 'POST',
      headers: this.getSignedHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: connBody.toString()
    });
    const json = await res.json();
    if (json.code === 0) {
      // 若云电脑已关机，服务端返回 desktopInfo 为 null 且带有 goingRetry: true
      return json.data?.desktopInfo || null;
    }
    if (json.code === 40010 || String(json.msg || '').includes('登录信息已过期') || String(json.msg || '').includes('会话已过期')) {
      await this.renewToken().catch(() => {});
    }
    throw new Error(json.msg || '获取云电脑连接配置失败');
  }

  // 云电脑电源管理操作 (开机: operationType 1 / 唤醒: operationType 18 / 关机: operationType 2 / 重启: operationType 3)
  async controlPower(desktopId, action) {
    const accName = this.account.name || this.account.user;
    const actionLower = (action || '').toLowerCase();

    // 天翼云底层官方电源管控协议 operationType: 1=开机(ON), 18=唤醒(AWAKE), 2=关机(SHUTDOWN), 3=重启(RESET)
    let opType = 3;
    let actionCn = '重启';
    if (actionLower === 'poweron' || actionLower === 'start') {
      opType = 1;
      actionCn = '开机';
    } else if (actionLower === 'awake' || actionLower === 'wakeup' || actionLower === 'resume') {
      opType = 18;
      actionCn = '唤醒';
    } else if (actionLower === 'shutdown' || actionLower === 'poweroff') {
      opType = 2;
      actionCn = '关机';
    } else {
      opType = 3;
      actionCn = '重启';
    }

    appendLog('System', `[${accName}] 正在向天翼云下达电源控制指令: ${actionCn} (operationType: ${opType})...`, 'info');

    if (!this.loginInfo) {
      const logRes = await this.login();
      if (!logRes.success) throw new Error(logRes.error || '登录鉴权失败');
    }

    // 执行电源指令
    const sendOperate = async (targetOpType) => {
      const form = new URLSearchParams({
        desktopId: String(desktopId),
        operationType: String(targetOpType)
      });
      const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/desktop/client/operate', {
        method: 'POST',
        headers: this.getSignedHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: form.toString()
      });
      return await res.json();
    };

    // 开机/唤醒双重信令链路 (Triple Link)
    if (opType === 1 || opType === 18) {
      let lastErrMsg = '';
      
      // 1. 尝试主信令 (1 或 18)
      try {
        const data1 = await sendOperate(opType);
        if (data1.code === 0) {
          appendLog('System', `[${accName}] ✅ 云电脑【${actionCn}】指令已成功生效！`, 'success');
          return { success: true, message: `云电脑【${actionCn}】指令已成功下发！官方已确认启动。` };
        }
        lastErrMsg = data1.msg || `错误码 ${data1.code}`;
      } catch (e) {
        lastErrMsg = e.message;
      }

      // 2. 若主信令未成功，尝试互补信令 (18 ↔ 1)
      const altOpType = (opType === 1) ? 18 : 1;
      const altCn = (altOpType === 18) ? '唤醒' : '开机';
      try {
        const data2 = await sendOperate(altOpType);
        if (data2.code === 0) {
          appendLog('System', `[${accName}] ✅ 云电脑【${altCn}】互补指令已成功生效！`, 'success');
          return { success: true, message: `云电脑【${altCn}】指令已成功下发！官方已确认启动。` };
        }
        lastErrMsg = data2.msg || lastErrMsg;
      } catch (e) {
        lastErrMsg = e.message || lastErrMsg;
      }

      // 3. 通用开机信令通道：调用 connect 触发天翼云网关自动拉起虚拟机 (goingRetry: true)
      try {
        const connBody = new URLSearchParams({
          objId: String(desktopId),
          objType: '0',
          osType: '15',
          deviceId: this.deviceType,
          vdCommand: '',
          ipAddress: '',
          macAddress: '',
          deviceCode: this.account.deviceCode,
          deviceName: 'Chrome浏览器',
          deviceType: this.deviceType,
          deviceModel: 'Windows NT 10.0; Win64; x64',
          appVersion: '3.2.0',
          sysVersion: 'Windows NT 10.0; Win64; x64',
          clientVersion: this.version
        });
        const connRes = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/desktop/client/connect', {
          method: 'POST',
          headers: this.getSignedHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
          body: connBody.toString()
        });
        const connData = await connRes.json();
        if (connData.code === 0 && connData.data?.goingRetry) {
          appendLog('System', `[${accName}] ✅ 云电脑通用启动信令已触发 (goingRetry: true)，云端正在开机...`, 'success');
          return { success: true, message: '云电脑开机信令已同步触发，云端正在启动中！' };
        }
      } catch (e) {}

      // 机器已经在运行中的容错提示
      if (lastErrMsg && (lastErrMsg.includes('运行中') || lastErrMsg.includes('正在进行') || lastErrMsg.includes('已经开机'))) {
        appendLog('System', `[${accName}] 云电脑已处于开机/运行状态中。`, 'info');
        return { success: true, message: '云电脑已处于运行状态中！' };
      }

      appendLog('System', `[${accName}] ❌ 下发电源指令【${actionCn}】失败: ${lastErrMsg}`, 'error');
      return { success: false, error: lastErrMsg || '官方接口未确认开机' };
    }

    // 关机 / 重启
    try {
      const data = await sendOperate(opType);
      if (data.code === 0) {
        appendLog('System', `[${accName}] ✅ 云电脑【${actionCn}】指令已成功生效！官方返回: 成功`, 'success');
        sendAccountNotification(
          this.account,
          `⚡ 云电脑电源控制生效 - ${accName}`,
          `已成功向云电脑 [${accName}] 下达【${actionCn}】电源指令，天翼云已确认执行。`
        );
        return { success: true, message: `云电脑【${actionCn}】指令已成功下发并生效！` };
      } else {
        throw new Error(data.msg || `错误码 ${data.code}`);
      }
    } catch (e) {
      appendLog('System', `[${accName}] ❌ 下发电源指令【${actionCn}】失败: ${e.message}`, 'error');
      return { success: false, error: e.message };
    }
  }

  // 检测外部/官网/控制台开机：若之前处于关机/保活关闭，一旦检测到云电脑真正恢复运行中，自动恢复开启保活
  checkExternalPowerOn(desktop) {
    if (!desktop) return;
    const isRunning = desktop.useStatusText === '运行中' || desktop.useStatus == 25;
    if (isRunning && !this.resolveTask('keepAlive').enabled) {
      this.account.features.keepAlive = true;
      this.account.manualShutdown = false;
      this.account.stats = this.account.stats || {};
      this.account.stats.keepAliveStatus = 'online';
      saveConfig(appConfig);
      appendLog('KeepAlive', `[${this.account.name || this.account.user}] 🎉 检测到云电脑已成功开机启动，已自动恢复保活开关与后台长连接守护！`, 'success');
      this.startKeepAliveWorker();
    }
  }

  /**
   * 刷新官方任务中心与积分。
   *
   * 【为什么返回可信度】历史缺陷 (暗线 D)：本函数原先 catch(e){} 静默吞错，
   * 调用方拿到的是"过期的 officialTasks 快照"，却无法区分
   * "官方确认未达成" 与 "根本没取到数据"。此前多轮"假成功/假失败"都源于这一不可区分性。
   * 现在返回 { ok, reason }：ok=false 表示本次数据不可信，任何"判定"都必须放弃而不是猜。
   */
  async refreshOfficialTasks() {
    if (!this.loginInfo) return { ok: false, reason: '账号尚未登录，无法读取官方任务中心' };

    const statKeys = ['lastSignTime', 'lastAiChatTime', 'lastHangTime', 'hangMinutesToday', 'points'];
    const snapStats = () => JSON.stringify(statKeys.map(k => this.account?.stats?.[k] ?? null));
    const beforeStats = snapStats();

    let ok = false;
    let reason = '';

    try {
      const taskRes = await (await fetchWithTimeout('https://desk.ctyun.cn/selforder/api/marketing/userPoints/getTaskList', {
        headers: this.getSignedHeaders()
      })).json();

      if (taskRes.code === 40010 || String(taskRes.msg || '').includes('登录信息已过期') || String(taskRes.msg || '').includes('会话已过期')) {
        await this.renewToken().catch(() => {});
        reason = `凭据过期 (code=${taskRes.code || taskRes.msg})`;
      }

      if (taskRes.code === 0 && taskRes.data) {
        this.metrics.officialTasks = taskRes.data.map(t => ({
          name: t.taskDefName,
          current: t.currentProgress || 0,
          total: t.totalProgress || 1,
          status: t.status,
          points: t.pointsList?.[0]?.value || 100
        }));

        const todayStr = getBeijingDateOnly();
        const nowStr = getBeijingTimeString();

        // 1. 登录AI云电脑打卡完成时间点追踪
        const loginTask = this.metrics.officialTasks.find(t => t.name.includes('登录AI云电脑'));
        if (loginTask && (loginTask.status === 2 || loginTask.current >= loginTask.total)) {
          if (!this.account.stats.lastSignTime || !this.account.stats.lastSignTime.startsWith(todayStr)) {
            this.account.stats.lastSignTime = nowStr;
          }
        }

        // 2. AI 智能对话完成时间点追踪
        const aiTask = this.metrics.officialTasks.find(t => t.name.includes('AI对话'));
        if (aiTask && (aiTask.status === 2 || aiTask.current >= aiTask.total)) {
          if (!this.account.stats.lastAiChatTime || !this.account.stats.lastAiChatTime.startsWith(todayStr)) {
            this.account.stats.lastAiChatTime = nowStr;
          }
        }

        // 3. 挂机 1 小时完成时间点追踪
        const hangTask = this.metrics.officialTasks.find(t => t.name.includes('使用1小时'));
        if (hangTask) {
          this.account.stats.hangMinutesToday = Math.floor(hangTask.current / 60);
          if (hangTask.status === 2 || (hangTask.total > 0 && hangTask.current >= hangTask.total)) {
            if (!this.account.stats.lastHangTime || !this.account.stats.lastHangTime.startsWith(todayStr)) {
              this.account.stats.lastHangTime = nowStr;
            }
          }
        }
        ok = true;
      } else if (!reason) {
        reason = `任务中心返回异常 code=${taskRes.code} msg=${taskRes.msg || '(无)'}`;
      }

      const pointRes = await (await fetchWithTimeout('https://desk.ctyun.cn/selforder/api/marketing/userPoints/getUserPoints', {
        headers: this.getSignedHeaders()
      })).json();

      if (pointRes.code === 0 && Array.isArray(pointRes.data) && pointRes.data.length > 0) {
        // pointRes.data 数组可能包含两项，一项为 willOutDate: true 即将过期的子积分（如100分），一项为真实总积分（如900分）
        // 优先精准提取非即将过期（willOutDate != true）的主账户可用总积分项；若都无标识则取数值最大项
        const validItem = pointRes.data.find(p => !p.willOutDate && p.pointType === 1) ||
                          pointRes.data.reduce((max, cur) => ((cur.points || 0) > (max.points || 0) ? cur : max), pointRes.data[0]);
        this.metrics.userPoints = validItem ? (validItem.points || 0) : 0;
        this.account.stats.points = this.metrics.userPoints;
        ok = true;
      } else if (!reason) {
        reason = `积分接口返回异常 code=${pointRes.code}`;
      }
    } catch (e) {
      reason = `官方任务中心访问失败: ${e.message}`;
    }

    // 仅在统计字段确实发生变化时落盘 (原先每次调用都 saveConfig，在容器挂载 NAS 卷场景下为高频无效写盘)
    if (snapStats() !== beforeStats) {
      try { saveConfig(appConfig); } catch (e) { /* 落盘失败不影响本次判定 */ }
    }

    if (!ok) {
      appendLog('System', `[${this.account?.name || this.account?.user || ''}] ⚠️ 官方任务中心刷新未取得有效数据 (${reason})。本次结果不可信，系统不会据此判定任何任务成败。`, 'warning');
    }
    return { ok, reason };
  }

  async getRewards() {
    if (!this.loginInfo) await this.login();
    const res = await fetchWithTimeout('https://desk.ctyun.cn/selforder/api/selforder/prod/get?prodId=17000000&prodCode=POINTS', {
      headers: this.getSignedHeaders()
    });
    const data = await res.json();
    const rewards = [];
    if (data && data.data) {
      for (const mall of data.data) {
        for (const series of (mall.series || [])) {
          for (const sku of (series.sku || [])) {
            rewards.push({
              prodId: sku.prodId,
              prodName: sku.prodName,
              costPoints: sku.costPoints,
              prodType: sku.prodType,
              description: (sku.description || series.description || '').replace(/<[^>]+>/g, ' ')
            });
          }
        }
      }
    }
    return rewards;
  }

  startKeepAliveWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    this.runCycleLoop();
  }

  stopKeepAliveWorker() {
    this.workerRunning = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
    this.wsAlive = false;
    this.metrics.status = 'offline';
  }

  // 单台云电脑视讯通道保活会话
  async runDesktopKeepAliveSession(desktop, isHangMode = false, pulseConnectSec = 20, goalTaskName = '') {
    const accName = this.account.name || this.account.user;
    const desktopId = desktop.objId || desktop.desktopId;
    const desktopName = desktop.objName || desktop.desktopName || '云电脑';

    let desktopInfo = null;
    let lastConnError = '';
    // 挂机模式加长重试窗口 (等待开机/网关就绪)：12 次 × 10 秒 ≈ 2 分钟；脉冲模式保持轻量 4 次 × 4 秒
    const maxConnAttempts = isHangMode ? 12 : 4;
    const retryGapMs = isHangMode ? 10000 : 4000;
    for (let connAttempt = 1; connAttempt <= maxConnAttempts; connAttempt++) {
      try {
        desktopInfo = await this.connect(desktopId);
      } catch (e) {
        lastConnError = e.message || '';
      }
      if (desktopInfo && desktopInfo.clinkLvsOutHost) break;

      // 先判定【开机/启动中】：此类报错 (如"正在启动中，请稍后再试") 属于等待就绪，绝非客户端占用，绝不误判让位！
      const isBootingMsg = lastConnError.includes('启动') || lastConnError.includes('开机') || lastConnError.includes('初始化') || lastConnError.includes('唤醒');
      // 再严格判定【客户端占用】：仅明确的占用信令才视为官方客户端接入
      const isOccupiedMsg = !isBootingMsg && (
        lastConnError.includes('其他设备') || lastConnError.includes('其他地方') ||
        lastConnError.includes('正在使用') || lastConnError.includes('使用中') || lastConnError.includes('占用')
      );
      if (isOccupiedMsg) {
        appendLog('KeepAlive', `[${accName}][${desktopName}] 官方客户端可能正在使用，旁观通道将在下个周期自动重试。`, 'info');
        return { success: true, reason: 'occupied' };
      }
      if (connAttempt < maxConnAttempts) {
        if (lastConnError) {
          appendLog('KeepAlive', `[${accName}][${desktopName}] 连接暂未就绪 (${lastConnError})，${Math.round(retryGapMs / 1000)} 秒后自动重试 (${connAttempt}/${maxConnAttempts})...`, 'info');
        }
        await new Promise(r => setTimeout(r, retryGapMs));
      }
    }

    if (!desktopInfo || !desktopInfo.clinkLvsOutHost) {
      appendLog('KeepAlive', `[${accName}][${desktopName}] 视讯网关暂未分配完毕 (已重试 ${maxConnAttempts} 次)，跳过本次连接`, 'warning');
      return { success: false, reason: 'no_gateway' };
    }

    this.metrics.currentHost = desktopInfo.clinkLvsOutHost;
    const wsUrl = `wss://${desktopInfo.clinkLvsOutHost}/clinkProxy/${desktopId}/MAIN`;

    return await new Promise((resolveSession) => {
      let cycleDone = false;
      let isClosingSelf = false;
      let sessionTimeout = null;
      let hangCheckInterval = null;
      let wsConnectedAt = 0;
      let goalAchieved = false; // 目标任务 (如登录AI云电脑) 是否已获得官方确认
      let clientPresenceSignal = false; // 官方客户端在席信令 (Type 119/120/137)：收到即代表真机用户接入
      // 诊断埋点 (零行为改动)：记录会话握手阶段的关键事实，供断开时判断"真机抢占"还是"网络抖动"
      let handshakeDone = false; // 是否收到过 Type 103 并完成 118 身份上报
      let claimSent = false;     // 是否已发送 Type 112/104 独占认领
      let redqCount = 0;         // REDQ 挑战应答累计次数

      const endSession = (reason) => {
        if (cycleDone) return;
        cycleDone = true;
        isClosingSelf = true;
        this.endCurrentSession = null;
        if (sessionTimeout) clearTimeout(sessionTimeout);
        if (this.countdownTimer) clearInterval(this.countdownTimer);
        if (this.clinkPingTimer) {
          clearInterval(this.clinkPingTimer);
          this.clinkPingTimer = null;
        }
        if (hangCheckInterval) {
          clearInterval(hangCheckInterval);
          hangCheckInterval = null;
        }
        if (this.ws) {
          try { this.ws.close(); } catch (e) {}
        }
        this.wsAlive = false;
        resolveSession({ success: true, reason, goalAchieved });
      };

      this.endCurrentSession = endSession;

      this.resetCycleTimeout = (newSeconds) => {
        if (cycleDone) return;
        if (sessionTimeout) clearTimeout(sessionTimeout);
        this.metrics.keepAliveSeconds = newSeconds;
        this.metrics.cycleCountdown = newSeconds;
        sessionTimeout = setTimeout(() => {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 周期时间到 (${newSeconds}s)，强制重连刷新天翼云会话...`, 'info');
          endSession('Timeout Reset');
        }, newSeconds * 1000);
      };

      if (isHangMode) {
        // 挂机会话时长：主挂机 3600 秒，尾差补挂按传入轮次时长 (上限 3600 秒)；轻量认领脉冲 (如打卡 <=30秒) 允许精准按传入时长执行 (下限 15 秒)
        const minSec = pulseConnectSec <= 30 ? Math.max(15, pulseConnectSec) : 60;
        const maxHangTimeout = Math.min(3600, Math.max(minSec, parseInt(pulseConnectSec) || 3600));
        this.metrics.keepAliveSeconds = maxHangTimeout;
        this.metrics.cycleCountdown = maxHangTimeout;
        const timeoutLabel = goalTaskName ? '任务认领观察' : '挂机长连接看门狗';
        sessionTimeout = setTimeout(() => {
          appendLog('Heartbeat', `[${accName}][${desktopName}] ${timeoutLabel}周期到 (${maxHangTimeout}s)，平滑刷新会话...`, 'info');
          endSession(goalTaskName ? 'Sign Watchdog' : 'Hang Watchdog');
        }, maxHangTimeout * 1000);
      } else {
        const connectSec = Math.min(60, Math.max(15, pulseConnectSec));
        this.metrics.keepAliveSeconds = connectSec;
        this.metrics.cycleCountdown = connectSec;
        sessionTimeout = setTimeout(() => {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 脉冲握手完成 (${connectSec}s)，释放通道待机...`, 'info');
          endSession('Pulse Finished');
        }, connectSec * 1000);
      }

      if (this.countdownTimer) clearInterval(this.countdownTimer);
      this.countdownTimer = setInterval(() => {
        if (this.metrics.cycleCountdown > 0) {
          this.metrics.cycleCountdown--;
        }
      }, 1000);

      this.ws = new WebSocket(wsUrl, {
        headers: { Origin: 'https://pc.ctyun.cn' },
        rejectUnauthorized: false
      });

      const safeSend = (data) => {
        try {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data);
          }
        } catch (err) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 报文发送异常: ${err.message}`, 'warning');
        }
      };

      this.ws.on('open', () => {
        wsConnectedAt = Date.now();
        this.sessionConflictStreak = 0;
        this.conflictRetryUntil = 0;
        this.wsAlive = true;
        this.metrics.status = 'online';

        // 当日成功轮次按自然日 0 点重置统计
        const todayStr = getBeijingDateOnly();
        if (this.lastSuccessDate !== todayStr) {
          this.metrics.successCount = 0;
          this.lastSuccessDate = todayStr;
        }
        this.metrics.successCount++;
        this.account.stats = this.account.stats || {};
        this.account.stats.todaySuccessCount = this.metrics.successCount;
        this.account.stats.lastSuccessDate = todayStr;
        this.account.stats.keepAliveStatus = 'online';
        saveConfig(appConfig);

        appendLog('Heartbeat', `[${accName}][${desktopName}] 🟢 保活长连接就绪 (${this.metrics.currentHost})`, 'success');

        const hostParts = (desktopInfo.clinkLvsOutHost || '').split(':');
        const connectMsg = {
          type: 1,
          ssl: 1,
          host: hostParts[0],
          port: hostParts[1] || '443',
          ca: desktopInfo.caCert,
          cert: desktopInfo.clientCert,
          key: desktopInfo.clientKey,
          servername: desktopInfo.host + ':' + desktopInfo.port,
          oqs: 0
        };
        safeSend(JSON.stringify(connectMsg));

        setTimeout(() => {
          const initBuf = Buffer.from('UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA', 'base64');
          safeSend(initBuf);
          appendLog('Heartbeat', `[${accName}][${desktopName}] 已发送保活特征码报文 (UkVEUQIA...)`, 'info');
        }, 500);
      });

      this.ws.on('message', (data) => {
        try {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const hex = buf.toString('hex').toUpperCase();

          this.wsAlive = true;
          this.metrics.status = 'online';
          if (this.account.stats) this.account.stats.keepAliveStatus = 'online';

          if (hex.startsWith('52454451')) {
            const nowStr = getBeijingTimeOnly();
            redqCount++;
            appendLog('Heartbeat', `[${accName}][${desktopName}] 收到服务端保活校验 REDQ (${buf.length}B)`, 'info');

            const responseBuf = this.encryptor.execute(buf);
            safeSend(responseBuf);

            this.metrics.lastHeartbeatTime = nowStr;
            this.metrics.lastHeartbeatResult = `[${desktopName}] REDQ 校验成功，已回传 ${responseBuf.length} 字节加密应答 (${nowStr})`;
            appendLog('Heartbeat', `[${accName}][${desktopName}] -> ✅ 成功回传 RSA-OAEP 加密应答 (${responseBuf.length}B)`, 'success');
            return;
          }

          if (buf.length >= 6) {
            const type = buf.readUInt16LE(0);
            const size = buf.readUInt32LE(2);

            if (type === 4) {
              const pongBuf = Buffer.alloc(6 + Math.min(size, 12));
              pongBuf.writeUInt16LE(3, 0);
              pongBuf.writeUInt32LE(Math.min(size, 12), 2);
              if (size > 0 && buf.length >= 6 + Math.min(size, 12)) {
                buf.copy(pongBuf, 6, 6, 6 + Math.min(size, 12));
              }
              safeSend(pongBuf);
              return;
            }

            if (type === 3 && size >= 8) {
              const gen = buf.readUInt32LE(6);
              const ackBuf = Buffer.alloc(10);
              ackBuf.writeUInt16LE(1, 0);
              ackBuf.writeUInt32LE(4, 2);
              ackBuf.writeUInt32LE(gen, 6);
              safeSend(ackBuf);
              return;
            }

            if (type === 103) {
              handshakeDone = true;
              appendLog('Heartbeat', `[${accName}][${desktopName}] 收到云电脑 103 认证，正在上报 118 用户身份...`, 'info');
              const userPayload = Buffer.from(JSON.stringify({
                type: 1,
                userName: this.loginInfo.userName,
                userInfo: '',
                userId: this.loginInfo.userId
              }));

              const sendBuf = Buffer.alloc(2 + 4 + 8 + userPayload.length);
              sendBuf.writeUInt16LE(118, 0);
              sendBuf.writeInt32LE(8 + userPayload.length, 2);
              sendBuf.writeUInt32LE(userPayload.length, 6);
              sendBuf.writeUInt32LE(8, 10);
              userPayload.copy(sendBuf, 14);

              safeSend(sendBuf);
              appendLog('Heartbeat', `[${accName}][${desktopName}] -> ✅ 已回传 118 身份 (用户ID: ${this.loginInfo.userId})，在线状态已激活！`, 'success');

              if (isHangMode) {
                try {
                  const sId = desktopInfo.token || '';
                  const dType = this.deviceType ? String(this.deviceType) : '';
                  const dCode = this.account.deviceCode || '';
                  const uAcc = this.loginInfo.userName || '';

                  const sIdLen = Buffer.byteLength(sId, 'utf8') + 1;
                  const dTypeLen = Buffer.byteLength(dType, 'utf8') + 1;
                  const dCodeLen = Buffer.byteLength(dCode, 'utf8') + 1;
                  const uAccLen = Buffer.byteLength(uAcc, 'utf8') + 1;

                  const dataSize = 36 + sIdLen + dTypeLen + dCodeLen + uAccLen;
                  const dataBuf = Buffer.alloc(dataSize);
                  let offset = 0;
                  let strOffset = 36;

                  dataBuf.writeUInt32LE(Number(desktopId), offset); offset += 4;
                  dataBuf.writeUInt32LE(sIdLen, offset); offset += 4;
                  dataBuf.writeUInt32LE(strOffset, offset); offset += 4; strOffset += sIdLen;
                  dataBuf.writeUInt32LE(dTypeLen, offset); offset += 4;
                  dataBuf.writeUInt32LE(strOffset, offset); offset += 4; strOffset += dTypeLen;
                  dataBuf.writeUInt32LE(dCodeLen, offset); offset += 4;
                  dataBuf.writeUInt32LE(strOffset, offset); offset += 4; strOffset += dCodeLen;
                  dataBuf.writeUInt32LE(uAccLen, offset); offset += 4;
                  dataBuf.writeUInt32LE(strOffset, offset); offset += 4; strOffset += uAccLen;

                  dataBuf.write(sId, offset, 'utf8'); offset += sIdLen;
                  dataBuf.write(dType, offset, 'utf8'); offset += dTypeLen;
                  dataBuf.write(dCode, offset, 'utf8'); offset += dCodeLen;
                  dataBuf.write(uAcc, offset, 'utf8'); offset += uAccLen;

                  const msgBuf112 = Buffer.alloc(6 + dataSize);
                  msgBuf112.writeUInt16LE(112, 0);
                  msgBuf112.writeUInt32LE(dataSize, 2);
                  dataBuf.copy(msgBuf112, 6);

                  safeSend(msgBuf112);
                } catch (e) {}

                try {
                  const msgBuf104 = Buffer.alloc(6);
                  msgBuf104.writeUInt16LE(104, 0);
                  msgBuf104.writeUInt32LE(0, 2);
                  safeSend(msgBuf104);
                  claimSent = true;
                } catch (e) {}
              } else {
                appendLog('Heartbeat', `[${accName}][${desktopName}] 脉冲旁观者模式已激活：不认领桌面会话 (无 112/104)，官方客户端随时接入永不被踢。`, 'info');
              }

              if (this.clinkPingTimer) clearInterval(this.clinkPingTimer);
              this.clinkPingTimer = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                  const hbBuf = Buffer.alloc(6);
                  hbBuf.writeUInt16LE(7, 0);
                  hbBuf.writeUInt32LE(0, 2);
                  safeSend(hbBuf);
                }
              }, 5000);

              if (isHangMode || goalTaskName) {
                const watchTaskName = goalTaskName || '使用1小时';
                const isGoalHang = !goalTaskName; // 未指定目标 = 经典挂机 (1 小时)
                const checkGoalProgress = async () => {
                  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                  await this.refreshOfficialTasks();
                  const goalTask = this.metrics.officialTasks?.find(t => t.name.includes(watchTaskName));
                  const curSec = goalTask ? (goalTask.current || 0) : 0;
                  const totSec = goalTask ? (goalTask.total || 3600) : 3600;

                  if (goalTask && (goalTask.status === 2 || (totSec > 0 && curSec >= totSec))) {
                    if (hangCheckInterval) clearInterval(hangCheckInterval);
                    if (isGoalHang) {
                      appendLog('KeepAlive', `[${accName}][${desktopName}] 🎉 恭喜！今日使用 AI 云电脑 1 小时挂机任务已圆满达成 (+100积分)！后台长连接立即主动让位关闭，转入脉冲保活防休眠模式。`, 'success');
                      sendAccountNotification(
                        this.account,
                        `🎉 挂机1小时任务达成 - ${accName}`,
                        `账号【${accName}】今日使用 AI 云电脑达到 1 小时任务已完成，100 积分已入账！`
                      );
                      endSession('Today Hang Goal Achieved');
                    } else {
                      goalAchieved = true;
                      appendLog('Sign', `[${accName}][${desktopName}] 🎉 官方任务中心已实时确认【${watchTaskName}】达成 (+100积分)！登录打卡已真实完成！`, 'success');
                      endSession('Sign Goal Achieved');
                    }
                  } else if (isGoalHang) {
                    const curMin = Math.floor(curSec / 60);
                    const totMin = Math.floor(totSec / 60);
                    const remainSec = Math.max(0, totSec - curSec);
                    this.metrics.lastHeartbeatResult = `[${desktopName}] 挂机累加中: 已在线 ${curMin}/${totMin} 分钟 (${curSec}/${totSec}秒，剩余约 ${Math.ceil(remainSec / 60)} 分钟)`;
                    this.metrics.cycleCountdown = remainSec;
                  } else {
                    this.metrics.lastHeartbeatResult = `[${desktopName}] 桌面登录认领保持中，等待官方任务中心确认【${watchTaskName}】...`;
                    this.metrics.cycleCountdown = Math.max(0, Math.round((totSec - curSec) / 1000));
                  }
                };

                setTimeout(checkGoalProgress, 2500);
                hangCheckInterval = setInterval(checkGoalProgress, 15000);
              } else {
                this.metrics.lastHeartbeatResult = `[${desktopName}] 脉冲保活握手就绪，已向网关发送 REDQ/心跳`;
              }
            }

            if (type === 119 || type === 120 || type === 137) {
              // 官方客户端在席信令：真机用户已接入。挂机模式下若随后被断开，据此判定为真实抢占而非网络闪断
              clientPresenceSignal = true;
              appendLog('Heartbeat', `[${accName}][${desktopName}] 收到客户端在席信令 (${type})，官方客户端已接入使用。`, 'info');
              return;
            }
          }
        } catch (err) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 解析报文异常: ${err.message}`, 'warning');
        }
      });

      this.ws.on('error', (err) => {
        appendLog('Heartbeat', `[${accName}][${desktopName}] 通道异常: ${err.message || '连接受阻'}`, 'error');
        this.metrics.errorCount++;
        endSession('Socket Error');
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = String(reason || '');
        const heldSec = wsConnectedAt ? Math.floor((Date.now() - wsConnectedAt) / 1000) : 0;

        // 诊断埋点 (零行为改动)：非自身主动关闭时，完整留存判定「真机抢占 vs 网络抖动」所需的全部证据。
        // 若本行显示"在席信令=无 且 code 未达 4000"，却判定为网络抖动而重连，即为 45 秒循环踢人的直接证据。
        if (!isClosingSelf) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] [断开诊断] code=${code} reason="${reasonStr || '(空)'}" 保持=${heldSec}s | 在席信令(119/120/137)=${clientPresenceSignal ? '有' : '无'} 103握手=${handshakeDone ? '已完成' : '未完成'} 112/104认领=${claimSent ? '已发送' : '未发送'} REDQ应答=${redqCount}次 | 模式=${isHangMode ? '挂机认领' : (goalTaskName || '脉冲旁观')}`, 'warning');
        }

        if (isClosingSelf) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 保活长连接正常轮转关闭 (${code} - ${reason || '周期重连'})`, 'info');
          return;
        }

        // 证据充分：网关明确抢占 (code>=4000 / reason 含 preempt|kick|conflict)
        if (code >= 4000 || reasonStr.includes('preempt') || reasonStr.includes('kick') || reasonStr.includes('conflict')) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 收到网关抢占信令 (${code})，确认为官方客户端接入信号。`, 'info');
          endSession('Preempted by Client');
          return;
        }

        // 证据充分：断开前收到过 Type 119/120/137 在席信令 → 真机接入导致的踢线
        if (clientPresenceSignal) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 断开前收到官方客户端在席信令，判定为真机接入抢占 (状态码: ${code}，已保持 ${heldSec} 秒)。`, 'info');
          endSession('Preempted by Client');
          return;
        }

        // ── 兜底路径：断开但【没有任何】客户端在席证据 ──────────────────────────────
        // 历史缺陷 (暗线 B)：此处原先直接判定为「网络/网关抖动」，随后无条件 45 秒重连续跑，
        // 导致真实用户被反复顶掉。根因是"没有证据"被当成了"没有用户"的证据。
        // 现在改为产出中性的 'Unverified Channel Close'，由上层 runHangTask 执行证据鉴别
        // (观察官方计时是否增长) 后再决定是否允许重新认领。
        // 在席信令机制本身的可靠性早在 2026-09-09 就被确认为"常常监听不到"，
        // 因此本分支必须假定"可能有真机用户"，而不是假定"没有"。
        appendLog('Heartbeat', `[${accName}][${desktopName}] 通道被网关断开 (状态码: ${code}，已保持 ${heldSec} 秒)，但未收到任何客户端在席证据 (无 119/120/137 且 code 未达 4000)。此事不构成"无人在用"的结论，交由上层做证据鉴别后再决定是否重连。`, 'warning');
        endSession('Unverified Channel Close');
      });
    });
  }

  /**
   * 定时挂机 1 小时任务执行器 (由 Scheduler 定时精确触发，或由用户在控制台手动点击触发)
   * 职责严格隔离：仅在定时触发时临时启动独占认领会话，挂满 1 小时后自动结束；
   * 若挂机中途被用户客户端顶掉，立即主动避让 10 分钟，绝不反复重连争抢！
   */
  async runHangTask(onLog = console.log) {
    const accName = this.account.name || this.account.user;

    // 本次任务已实际执行，先清除待触发的重试定时器 (避免重影)
    if (this.hangRetryTimer) {
      clearTimeout(this.hangRetryTimer);
      this.hangRetryTimer = null;
    }

    // 0. 账号级挂机开关：统一入口判定 (暗线 A —— 保活开关对任务零影响)
    const accHangGate = this.resolveTask('cloudHang');
    if (!accHangGate.enabled) {
      this.clearHangRetry();
      onLog('Hang', `[${accName}] ${accHangGate.reason}，本次挂机任务自动跳过。`, 'info');
      return { success: true, isCompleted: false, message: accHangGate.reason };
    }

    // 0.1 与登录打卡认领会话互斥 (新发现 #33)：这两处曾可能同时下发 Type 112/104，
    //     造成互相顶掉且官方计时不累加。打卡认领进行中时挂机一律让位并稍后重试。
    if (this._signSessionActive) {
      onLog('Hang', `[${accName}] 登录打卡认领会话正在进行中，挂机任务主动让位等待，避免双认领冲突。`, 'info');
      this.scheduleHangRetry(onLog);
      return { success: true, isCompleted: false, message: '打卡认领进行中，挂机让位' };
    }

    // 1. 检查今日挂机 1 小时是否已达成
    const initRefresh = await this.refreshOfficialTasks();
    if (this.isTodayHangTaskCompleted()) {
      this.clearHangRetry();
      onLog('Hang', `[${accName}] ✅ 今日云电脑 1 小时挂机任务已达成 (+100积分)，无需重复执行。`, 'success');
      return { success: true, isCompleted: true, message: '今日挂机时长已满 60 分钟' };
    }
    // 官方状态不可读时不得盲目开抢：认领会顶掉真实用户，而"不知道是否已完成"不构成执行理由
    if (initRefresh && initRefresh.ok === false) {
      onLog('Hang', `[${accName}] 官方任务中心暂不可读 (${initRefresh.reason})，无法确认今日达成状态。为避免盲目认领抢占，本次挂机暂缓。`, 'warning');
      this.scheduleHangRetry(onLog);
      return { success: true, isCompleted: false, message: '官方状态不可读，本次挂机暂缓' };
    }

    // 2. 检查用户与客户端避让状态 (避让后自动安排续跑，绝不静默丢弃今日任务)
    if (this.isWebUserActive && Date.now() < this.webUserActiveUntil) {
      onLog('Hang', `[${accName}] 浏览器用户正在操作云电脑，本次挂机任务主动避让。`, 'info');
      this.scheduleHangRetry(onLog);
      return { success: true, isCompleted: false, message: '用户网页操作中，主动避让' };
    }
    if (Date.now() < this.externalYieldUntil) {
      const waitMin = Math.ceil((this.externalYieldUntil - Date.now()) / 60000);
      onLog('Hang', `[${accName}] 官方客户端 (App/PC) 近期正在使用，挂机任务处于避让冷却期 (剩余 ${waitMin} 分钟)，跳过本次抢占。`, 'info');
      this.scheduleHangRetry(onLog);
      return { success: true, isCompleted: false, message: '处于客户端避让冷却期' };
    }

    // 3. 标记正在执行挂机任务，让后台脉冲循环主动让位
    this.isTaskHanging = true;
    this.metrics.isTaskHanging = true;
    this.hangReconnectCount = 0; // 单次 runHangTask 内"经证据鉴别后允许重连"的次数
    if (this.endCurrentSession) {
      this.endCurrentSession('Yield to Scheduled Hang Task');
    }

    // 硬性总时长上限：确保本函数在任何分支组合下都必然返回，
    // 杜绝历史上 attempt-- 使 MAX_ROUNDS 失效后可能出现的无限运行。
    const hangDeadline = Date.now() + 100 * 60 * 1000;
    const deadlineExceeded = () => Date.now() > hangDeadline;

    try {
      // 4. 获取目标云电脑并确保开机 (优选已在运行的主机，避免挂机落空)
      const desktops = await this.getDesktops();
      if (!desktops || desktops.length === 0) {
        onLog('Hang', `[${accName}] 账号名下暂无可用云电脑，无法执行挂机任务。`, 'warning');
        this.scheduleHangRetry(onLog);
        return { success: false, isCompleted: false, message: '名下无云电脑' };
      }

      const isDesktopRunning = (d) => d && (d.useStatusText === '运行中' || d.useStatus == 25);
      // 统一开关入口：挂机是否可作用于该机，只由 cloudHang + desktop.taskEnabled 决定
      const taskOnDesktops = desktops.filter(d => this.resolveTask('cloudHang', d).enabled);
      if (taskOnDesktops.length === 0) {
        onLog('Hang', `[${accName}] 账号名下所有云电脑的挂机任务均被开关关闭，本次挂机任务自动跳过。`, 'info');
        return { success: true, isCompleted: false, message: '名下所有云电脑均已关闭挂机任务开关' };
      }

      const runningDesktops = taskOnDesktops.filter(d => isDesktopRunning(d));
      const mainDesktop = runningDesktops[0] || taskOnDesktops[0];
      const targetName = mainDesktop.objName || mainDesktop.desktopName || '云电脑';
      const targetId = String(mainDesktop.objId || mainDesktop.desktopId);

      if (!isDesktopRunning(mainDesktop)) {
        if (mainDesktop.autoBootEnabled === false) {
          onLog('Hang', `[${accName}][${targetName}] 云电脑未开机且已关闭自动开机，跳过本次挂机任务。`, 'info');
          return { success: true, isCompleted: false, message: '云电脑未开机且已关闭自动开机' };
        }
        onLog('Hang', `[${accName}][${targetName}] 云电脑未开机，正在下发开机唤醒指令...`, 'info');
        await this.controlPower(targetId, 'poweron').catch(() => {});
        // 开机就绪轮询 (最长 120 秒)：杜绝未就绪即认领导致官方计时不累加
        let bootReady = false;
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 10000));
          const fresh = await this.getDesktops().catch(() => []);
          const target = (fresh || []).find(d => String(d.objId || d.desktopId) === targetId);
          if (isDesktopRunning(target)) { bootReady = true; break; }
        }
        onLog('Hang', `[${accName}][${targetName}] 开机就绪探测: ${bootReady ? '✅ 已进入运行中状态' : '⚠️ 120 秒未确认就绪，继续尝试认领'}`, bootReady ? 'success' : 'warning');
      }

      onLog('Hang', `[${accName}][${targetName}] 🚀 定时挂机任务已启动，正在建立独占会话累加使用时长...`, 'info');

      // 5. 执行主挂机长连接 (3600 秒) + 尾差自动补挂循环：确保官方计数真正到达 60/60
      // 每一轮开始前重新校验避让状态与账号/单机开关，与多机独立纳管/客户端避让机制完全兼容：
      const USER_INTENT_STOP_REASONS = ['User Disabled Task on Active Desktop', 'User Disabled Hang Mode', 'Yield to External Client', 'Web User Active'];
      let attempt = 0;
      let lastResult = null;
      this.hangNoClaimRetries = 0; // 未建立会话 (未下发 112/104) 的快速重试计数：无顶人风险
      const MAX_ROUNDS = 4; // 1 轮主挂机 (3600s) + 最多 3 轮 10 分钟尾差补挂
      while (attempt < MAX_ROUNDS) {
        attempt++;

        // 5.0 硬性总时长上限：无论何种分支组合，本次挂机都必须在有限时间内返回
        if (deadlineExceeded()) {
          onLog('Hang', `[${accName}][${targetName}] 本次挂机已达硬性时长上限 (100 分钟)，主动收束，交回定时续跑。`, 'warning');
          this.scheduleHangRetry(onLog);
          break;
        }

        // 5.0.1 账号级挂机开关实时校验 (统一入口，暗线 A)
        const accGateNow = this.resolveTask('cloudHang');
        if (!accGateNow.enabled) {
          onLog('Hang', `[${accName}][${targetName}] ${accGateNow.reason}，挂机${attempt > 1 ? '补挂/重连' : ''}立即终止。`, 'info');
          break;
        }
        // 5.0.2 打卡认领会话进行中：让位，避免双 112/104 认领互相顶掉 (#33)
        if (this._signSessionActive) {
          onLog('Hang', `[${accName}][${targetName}] 登录打卡认领会话正在进行，挂机本轮让位终止。`, 'info');
          this.scheduleHangRetry(onLog);
          break;
        }
        // 5.1 用户浏览器正在操作云电脑：挂机立即让位终止，绝不反抢
        if (this.isWebUserActive && Date.now() < this.webUserActiveUntil) {
          onLog('Hang', `[${accName}][${targetName}] 浏览器用户正在操作云电脑，挂机${attempt > 1 ? '补挂' : ''}主动让位终止。`, 'info');
          break;
        }
        // 5.2 官方客户端避让冷却期内：终止本轮补挂 (由下一次调度再续)
        if (Date.now() < this.externalYieldUntil) {
          const waitMin = Math.ceil((this.externalYieldUntil - Date.now()) / 60000);
          onLog('Hang', `[${accName}][${targetName}] 官方客户端避让冷却期内 (剩余 ${waitMin} 分钟)，挂机${attempt > 1 ? '补挂' : ''}终止。`, 'info');
          break;
        }
        // 5.3 单机开关实时校验 (统一入口，暗线 A)
        const freshTarget = (this.account.desktops || []).find(d => String(d.objId || d.desktopId) === targetId);
        if (freshTarget) {
          const freshGate = this.resolveTask('cloudHang', freshTarget);
          if (!freshGate.enabled) {
            onLog('Hang', `[${accName}][${targetName}] ${freshGate.reason}，挂机立即终止。`, 'info');
            break;
          }
        }

        const roundSec = attempt === 1 ? 3600 : 600;
        lastResult = await this.runDesktopKeepAliveSession(mainDesktop, true, roundSec);

        const postRefresh = await this.refreshOfficialTasks();
        if (this.isTodayHangTaskCompleted()) break;

        const reasonStr = String((lastResult && lastResult.reason) || '');

        // 5.4 用户意图中断 (单机关闭/客户端避让/浏览器接入)：直接终止，不再补挂
        if (USER_INTENT_STOP_REASONS.includes(reasonStr)) {
          onLog('Hang', `[${accName}][${targetName}] 挂机会话因避让或用户操作中断 (${reasonStr})，终止补挂。`, 'info');
          break;
        }

        // 5.5 网关抢占信令 (code>=4000 / 在席信令)：官方客户端接入的确凿证据，让位 10 分钟
        if (reasonStr === 'Preempted by Client') {
          if (!this.isWebUserActive && Date.now() >= this.externalYieldUntil) {
            this.yieldToExternalClient(10);
            onLog('Hang', `[${targetName}] ⚠️ 收到网关抢占信令，确认官方客户端接入，已让位避让 10 分钟，绝不反抢！`, 'warning');
          }
          break;
        }

        // 5.6 未建立会话即未认领：从未下发 112/104，不存在顶人风险，允许有限次快速重试
        if (reasonStr === 'no_gateway') {
          this.hangNoClaimRetries = (this.hangNoClaimRetries || 0) + 1;
          if (this.hangNoClaimRetries > 3) {
            onLog('Hang', `[${targetName}] 网关迟迟未分配通道 (已尝试 ${this.hangNoClaimRetries} 次)，转入定时自动续跑。`, 'info');
            this.scheduleHangRetry(onLog);
            break;
          }
          onLog('Hang', `[${targetName}] 视讯网关尚未分配通道 (本次未认领桌面，无顶人风险)，30 秒后重试 (${this.hangNoClaimRetries}/3)...`, 'info');
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }

        // ─────────────────────────────────────────────────────────────────────
        // 5.7 统一的中断处置：凡"已被断开、可能重连"的情形，一律先做证据鉴别再决定是否认领。
        //     历史缺陷 (暗线 B)：'Closed' 与 'Socket Error' 曾被直接判定为「网络/网关抖动」，
        //     并在 45 秒后无条件重新认领 → 把真实用户反复顶下线。
        //     根因是"没有在席证据"被当成了"没有用户"。此处必须假定可能有真人。
        // ─────────────────────────────────────────────────────────────────────
        const RECONNECTABLE_REASONS = ['occupied', 'Unverified Channel Close', 'Closed', 'Socket Error'];
        if (RECONNECTABLE_REASONS.includes(reasonStr)) {
          const verdict = await this.diagnoseHangInterruption(onLog, targetName, postRefresh);
          if (verdict === 'completed') break;

          // real_client / unverified 一律不得重新认领：
          //   real_client = 有真人在使用 (官方计时仍在增长)
          //   unverified  = 取不到可信证据 → 按"可能有真人"处理 (判定方向不对称，见函数注释)
          if (verdict === 'real_client' || verdict === 'unverified') {
            if (verdict === 'unverified') {
              this.hangUnverifiedStreak++;
              if (this.hangUnverifiedStreak >= 3) {
                onLog('Hang', `[${targetName}] 已连续 ${this.hangUnverifiedStreak} 次无法取得可信证据，为杜绝任何形式的抢占，本次挂机转入长冷却 (30 分钟)。`, 'warning');
                this.yieldToExternalClient(30);
                break;
              }
            } else {
              this.hangUnverifiedStreak = 0;
            }
            if (!this.isWebUserActive && Date.now() >= this.externalYieldUntil) {
              this.yieldToExternalClient(10);
              onLog('Hang', `[${targetName}] ⚠️ ${verdict === 'real_client' ? '证据显示官方客户端正在使用 (计时仍增长)' : '取不到可信证据 (按可能存在客户端处理)'}，已让位避让 10 分钟，绝不反抢！`, 'warning');
            }
            break;
          }

          // 到此 verdict === 'false_alarm'：官方计时冻结，确认无人在用，允许重连
          this.hangUnverifiedStreak = 0;
          this.hangReconnectCount++;
          if (this.hangReconnectCount > 3) {
            onLog('Hang', `[${targetName}] 本次挂机的证据式重连已用满 3 次，转入定时续跑 (避免长尾循环)。`, 'info');
            this.scheduleHangRetry(onLog);
            break;
          }
          attempt--; // 不占用补挂轮次预算；轮次预算由 hangReconnectCount 与 100 分钟硬上限共同约束
          onLog('Hang', `[${targetName}] ✅ 证据鉴别通过：官方计时冻结，确认无客户端在用 (断开原因: ${reasonStr})，60 秒后重连续挂 (${this.hangReconnectCount}/3)...`, 'info');
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        if (attempt < MAX_ROUNDS) {
          onLog('Hang', `[${targetName}] 官方计时尚未达 60 分钟 (主挂机轮次 ${attempt} 结束)，正在自动补挂尾差...`, 'info');
        }
      }

      await this.refreshOfficialTasks();
      const isDone = this.isTodayHangTaskCompleted();
      if (isDone) {
        this.clearHangRetry();
        onLog('Hang', `[${accName}][${targetName}] 🎉 今日 1 小时挂机任务已圆满达成 (+100积分)！`, 'success');
      } else {
        // 未达标的自愈续跑：静默等待冷却后自动重试，绝不把今日任务丢给明天
        this.scheduleHangRetry(onLog);
      }
      return {
        success: true,
        isCompleted: isDone,
        message: isDone ? '今日 1 小时挂机任务已圆满达成！' : '本次挂机阶段已结束'
      };
    } finally {
      this.isTaskHanging = false;
      this.metrics.isTaskHanging = false;
    }
  }

  async runCycleLoop() {
    const accName = this.account.name || this.account.user;

    while (this.workerRunning) {
      try {
        const kaGate = this.resolveTask('keepAlive');
        if (!kaGate.enabled) {
          appendLog('KeepAlive', `[${accName}] ${kaGate.reason}，守护循环退出。`, 'info');
          this.stopKeepAliveWorker();
          break;
        }

        if (this.account.sessionExpired || !this.loginInfo) {
          this.metrics.status = 'offline';
          this.metrics.lastHeartbeatResult = '⚠️ 登录会话已过期，请在卡片点击【重新验证】输入验证码！';
          if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }

        // 如果 Scheduler 正在执行独占挂机任务，或登录打卡认领会话进行中，常态保活循环主动避让等待
        if (this.isTaskHanging || this._signSessionActive) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        if (this.isWebUserActive) {
          if (Date.now() < this.webUserActiveUntil) {
            this.metrics.status = 'online';
            this.metrics.lastHeartbeatResult = '浏览器用户操作中 (保活避让守护中)';
            await new Promise(r => setTimeout(r, 10000));
            continue;
          } else {
            this.isWebUserActive = false;
          }
        }

        // 定期主动无感续期 (每 12 小时静默轮转刷新一次 Token 凭据，确保持久常驻不失效)
        if (!this.lastTokenRenewAt || (Date.now() - this.lastTokenRenewAt > 12 * 3600 * 1000)) {
          this.renewToken().then(() => {
            this.lastTokenRenewAt = Date.now();
          }).catch(() => {});
        }

        // 1. 查询名下全部云电脑
        const desktops = await this.getDesktops();
        if (!desktops || desktops.length === 0) {
          appendLog('KeepAlive', `[${accName}] 账号名下暂无可用云电脑，60秒后重试...`, 'warning');
          this.metrics.status = 'offline';
          this.metrics.lastHeartbeatResult = '名下无云电脑';
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        // 2. 遍历名下所有云电脑，检查开机/休眠状态并自动唤醒未启动机器 (多机独立守护过滤)
        let hasWokenAny = false;
        for (const d of desktops) {
          if (!this.resolveTask('keepAlive', d).enabled) continue; // 统一入口：账号级/单机保活开关
          const isAutoBootAllowed = d.autoBootEnabled !== false;
          const isRunning = d && (d.useStatusText === '运行中' || d.useStatus == 25);
          const dId = d.objId || d.desktopId;
          const dName = d.objName || d.desktopName || '云电脑';
          if (!isRunning && isAutoBootAllowed) {
            if (!this.account.manualShutdown) {
              const isDormant = (d.useStatusText || '').includes('休眠') || (d.useStatusText || '').includes('睡眠');
              const actionTarget = isDormant ? 'awake' : 'poweron';
              const actionCn = isDormant ? '唤醒' : '开机';
              appendLog('KeepAlive', `[${accName}][${dName}] 处于 [${d.useStatusText || '未启动'}] 状态，自动下发${actionCn}指令...`, 'info');
              await this.controlPower(dId, actionTarget).catch(() => {});
              hasWokenAny = true;
            }
          }
        }
        if (hasWokenAny) {
          appendLog('KeepAlive', `[${accName}] 已为名下未启动云电脑下发唤醒开机指令，等待启动就绪 (25秒后探测)...`, 'info');
          await new Promise(r => setTimeout(r, 25000));
          continue;
        }

        // 3. 运行中云电脑常态保活 (多机高精度独立时间戳轮转引擎，100% 旁观者脉冲防休眠)
        this.bootWaitStartTime = null;
        this.metrics.status = 'online';
        if (this.account.stats) this.account.stats.keepAliveStatus = 'online';

        const defaultPulseGapSec = Math.min(3300, Math.max(10, parseInt(this.account.pulseIntervalSeconds || appConfig.settings?.pulseIntervalSeconds) || 30));
        const pulseConnectSec = Math.min(60, Math.max(15, appConfig.settings?.keepAliveSeconds || 20));

        const now = Date.now();
        for (const d of desktops) {
          if (!this.workerRunning || this.isTaskHanging) break;
          if (!this.resolveTask('keepAlive', d).enabled) continue; // 统一入口：账号级/(该机)独立保活开关

          // 获取该台天翼云电脑的独立脉冲周期 (未单独指定则继承账号/系统全局默认)
          const dIntervalSec = Math.min(3300, Math.max(10, parseInt(d.keepaliveInterval) || defaultPulseGapSec));
          const lastPulse = d.lastPulseAt || 0;
          const elapsedSec = Math.floor((now - lastPulse) / 1000);

          // 时间未到达该主机的专属脉冲周期，继续休眠跳过
          if (lastPulse > 0 && elapsedSec < dIntervalSec) {
            continue;
          }

          const isRunning = d && (d.useStatusText === '运行中' || d.useStatus == 25);
          if (isRunning) {
            this.metrics.desktopId = d.objId || d.desktopId;
            this.metrics.desktopName = d.objName || d.desktopName || '云电脑';
            appendLog('KeepAlive', `[${accName}][${this.metrics.desktopName}] 触发脉冲保活握手 (独立周期: ${dIntervalSec}秒)...`, 'info');
            await this.runDesktopKeepAliveSession(d, false, pulseConnectSec);
            d.lastPulseAt = Date.now();
          }
        }

        // 计算所有有效保活主机的最短剩余倒计时，供前端看板实时呈现
        const activeDesktops = desktops.filter(d => d.keepaliveEnabled !== false);
        if (activeDesktops.length > 0) {
          const nowTs = Date.now();
          const countdowns = activeDesktops.map(d => {
            const dInterval = Math.min(3300, Math.max(10, parseInt(d.keepaliveInterval) || defaultPulseGapSec));
            const elapsed = Math.floor((nowTs - (d.lastPulseAt || 0)) / 1000);
            return Math.max(0, dInterval - elapsed);
          });
          this.metrics.cycleCountdown = Math.min(...countdowns);
        } else {
          this.metrics.cycleCountdown = defaultPulseGapSec;
        }

        // 高精度时间轮时钟片休眠 (每 10 秒轮转一次)
        let waited = 0;
        const tickStep = 10;
        while (waited < tickStep && this.workerRunning && !this.isTaskHanging) {
          if (this.account.sessionExpired) break;
          if (this.isWebUserActive && Date.now() >= this.webUserActiveUntil) {
            this.isWebUserActive = false;
          }
          if (this.isWebUserActive && Date.now() < this.webUserActiveUntil) {
            this.metrics.lastHeartbeatResult = '浏览器用户操作中，脉冲计时已暂停';
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          await new Promise(r => setTimeout(r, 1000));
          waited += 1;
        }

        await this.refreshOfficialTasks().catch(() => {});

      } catch (err) {
        appendLog('KeepAlive', `[${accName}] 保活异常: ${err.message}，10秒后重试...`, 'error');
        this.metrics.status = 'offline';
        this.metrics.lastHeartbeatResult = `异常: ${err.message}`;
        this.account.stats.keepAliveStatus = 'offline';
        saveConfig(appConfig);

        sendAccountNotification(
          this.account,
          `⚠️ 天翼云保活中断告警 - ${accName}`,
          `账号 [${accName}] 的云电脑长连接中断: ${err.message}，守护程序正在自动拉起重试。`
        );

        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }
}

module.exports = { CtYunClient };
