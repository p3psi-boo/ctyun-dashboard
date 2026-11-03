'use strict';

// ==========================================================
// 开关语义的单一权威入口 (暗线 A 的结构性修复)
// ----------------------------------------------------------
// 历史缺陷：keepaliveEnabled / taskEnabled / cloudHang / autoBootEnabled 四个字段
// 在多处被各自读取、语义互相渗透，导致同一个耦合在 2026-09-14 与 2026-09-21
// 被两次宣称"彻底解耦"却两次复发。
// 现在规定：
//   - 保活 (keepAlive) 只由 keepAlive + desktop.keepaliveEnabled 决定；
//   - 任务 (sign / aiChat / cloudHang) 只由 features.<task> + desktop.taskEnabled 决定；
//   - autoBoot 只决定"是否代为开机"，不参与任何"任务是否执行"的判定。
//     （移动云侧的开机守护有独立口径，见 ydpc_client.js 的 _autoBootArmed；此处仅对天翼云 desktop 仍成立。）
// 任何判定点都必须调用本函数，不得再就地读取原始字段。
// ==========================================================
const TASK_CN_NAME = {
  keepAlive: '常态保活', sign: '登录打卡', aiChat: 'AI 对话', cloudHang: '1 小时挂机',
  // 移动公众（ecloud）：分层保活，各自独立开关
  // 【2026-09-26 用户拍板】L3（SPICE 心跳）从未实现，整层删除（UI 到底层）—— 只保留 L1/L2。
  ecloudL1AccountKeep: 'L1 账号态保活', ecloudL2DesktopReg: 'L2 桌面登记保活'
};

// 【字段名映射 · 本次源审新发现 #43】历史代码里"登录打卡"的账号级开关字段名是
// autoSign（前端 toggleFeature('...','autoSign')、默认值 {keepAlive,autoSign,aiChat,cloudHang,autoRedeem}、
// 备份迁移判断都用 autoSign），而"任务类型常量"叫 'sign'。二者不一致。
// 若直接用 f[taskType] 去读，'sign' 会永远命中 undefined，导致"账号级打卡开关"彻底失效 ——
// 用户关掉打卡开关后任务仍会执行，正是"开关不起作用"类投诉的又一根源。
// 因此此处显式建立 任务类型 -> 功能字段 的映射，杜绝名称漂移。
const TASK_FEATURE_KEY = {
  keepAlive: 'keepAlive', sign: 'autoSign', aiChat: 'aiChat', cloudHang: 'cloudHang',
  // 移动公众（ecloud）分层保活：任务类型名与账号级字段名一一对应，杜绝名称漂移。
  ecloudL1AccountKeep: 'ecloudL1AccountKeep',
  ecloudL2DesktopReg: 'ecloudL2DesktopReg'
};

// 移动公众的这两层属于【保活类】而非【任务类】：单机维度看的是 keepaliveEnabled
// （与 taskEnabled 语义无关）。把它们显式列出，避免被通用分支错误地按 taskEnabled 判定。
const ECLOUD_KEEPALIVE_TASKS = new Set(['ecloudL1AccountKeep', 'ecloudL2DesktopReg']);

function resolveTaskEnabled(account, desktop, taskType) {
  const label = TASK_CN_NAME[taskType] || taskType;
  if (!account) return { enabled: false, reason: '账号不存在' };
  if (account.enabled === false) return { enabled: false, reason: '账号已停用' };

  const f = account.features || {};
  const featureKey = TASK_FEATURE_KEY[taskType] || taskType;

  if (taskType === 'keepAlive') {
    if (f.keepAlive === false) return { enabled: false, reason: '账号级【常态保活】开关已关闭' };
    if (desktop && desktop.keepaliveEnabled === false) return { enabled: false, reason: '该云电脑的【独立保活】开关已关闭' };
    return { enabled: true, reason: '' };
  }

  // 移动公众（ecloud）：三层保活同属"保活类" —— 账号级开关 + 单机 keepaliveEnabled，
  // 与 taskEnabled 无关（混用会让"关掉任务开关"误停保活）。
  if (ECLOUD_KEEPALIVE_TASKS.has(taskType)) {
    if (f[featureKey] === false) return { enabled: false, reason: `账号级【${label}】开关已关闭` };
    if (desktop && desktop.keepaliveEnabled === false) return { enabled: false, reason: '该云电脑的【独立保活】开关已关闭' };
    return { enabled: true, reason: '' };
  }

  // 所有"任务类"开关一致：只看账号级任务开关与该机任务开关，
  // 保活开关 (keepAlive / keepaliveEnabled) 对任务是否执行【零影响】。
  if (f[featureKey] === false) return { enabled: false, reason: `账号级【${label}】开关已关闭` };
  if (desktop && desktop.taskEnabled === false) return { enabled: false, reason: `该云电脑的【🎯 任务】开关已关闭，已尊重用户意图跳过${label}` };
  return { enabled: true, reason: '' };
}

function buildEcloudDefaultFeatures() {
  return {
    keepAlive: true,              // 账号级保活总开关（与另两平台同名同义，但账号存储各自独立）
    ecloudL1AccountKeep: true,    // L1 账号态保活
    ecloudL2DesktopReg: true,     // L2 桌面登记保活
    // 【2026-09-28 用户拍板】平台存在约 48 小时强制关机策略，自动开机守护**默认开启**
    // （拦不住强制关机就自动恢复）；不需要的用户可显式关闭。
    autoBoot: true
  };
}

module.exports = {
  TASK_CN_NAME,
  TASK_FEATURE_KEY,
  ECLOUD_KEEPALIVE_TASKS,
  resolveTaskEnabled,
  buildEcloudDefaultFeatures,
};
