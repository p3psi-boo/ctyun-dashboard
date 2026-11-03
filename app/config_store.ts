// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./lib/atomic_fs');
const { encryptPassword, decryptPassword } = require('./crypto/secrets');
const { PORT, DATA_DIR, CONFIG_FILE, ACCOUNTS_JSON } = require('./paths');

let appConfigRef = null;
function bindConfig(cfg) { appConfigRef = cfg; }

function getDefaultConfig() {
  return {
    version: '1.0.0',
    settings: {
      webPort: PORT,
      keepAliveSeconds: 60,
      pulseIntervalSeconds: 30,
      allowRegistration: false, // 默认不开放注册，必须由管理员后台手动开启
      defaultQuota: 2,         // 普通用户默认配额 2 台
      cron: {
        executeTime: '01:20',
        enableSubCron: false,
        signCron: '0 2 * * *',
        aiChatCron: '0 3,20 * * *',
        cloudHangCron: '0 4,6 * * *',
        redeemCron: '0 7 * * *'
      },
      notify: {
        enabled: false,
        channel: 'webhook',
        webhookUrl: ''
      },
      systemTitle: '天翼云/移动云电脑保活签到中心',
      systemSubtitle: '多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机'
    },
    users: [],
    accounts: []
  };
}

function loadConfig() {
  const BAK_FILE = CONFIG_FILE + '.bak';
  let cfg = null;
  let loadedFromBak = false;

  // 1. 尝试从主配置文件加载
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8').trim();
      if (content) {
        cfg = JSON.parse(content);
      } else {
        console.warn('⚠️ [配置检查] 主配置文件 app_config.json 为空 (0 字节)');
      }
    } catch (e) {
      console.error('⚠️ [配置损坏] 主配置文件 app_config.json 解析失败:', e.message);
      // 保护现场：绝不直接销毁损坏文件！
      try {
        const corruptBak = path.join(DATA_DIR, `app_config.corrupt.${Date.now()}.json`);
        fs.copyFileSync(CONFIG_FILE, corruptBak);
        console.warn(`⚠️ [安全保护] 已将损坏的配置现场安全备份至: ${corruptBak}`);
      } catch (err) {}
    }
  }

  // 2. 如果主配置损坏、为空或关键数据结构缺失，尝试从自动备份文件 .bak 恢复！
  if ((!cfg || (!Array.isArray(cfg.users) && !Array.isArray(cfg.accounts))) && fs.existsSync(BAK_FILE)) {
    try {
      const bakContent = fs.readFileSync(BAK_FILE, 'utf8').trim();
      if (bakContent) {
        const bakCfg = JSON.parse(bakContent);
        if (bakCfg && (Array.isArray(bakCfg.users) || Array.isArray(bakCfg.accounts))) {
          cfg = bakCfg;
          loadedFromBak = true;
          console.log('🛡️ [容灾自愈] 检测到主配置异常，已成功从自动备份文件 (app_config.json.bak) 完美恢复全量配置！');
        }
      }
    } catch (e) {
      console.error('读取备份配置文件失败:', e);
    }
  }

  // 3. 如果成功获取到配置 (无论是主配置还是备份恢复)
  if (cfg && (cfg.settings || cfg.accounts || cfg.users)) {
    const defaultSettings = getDefaultConfig().settings;
    if (!cfg.settings) {
      cfg.settings = defaultSettings;
    } else {
      cfg.settings = { ...defaultSettings, ...cfg.settings };
    }
    if (!Array.isArray(cfg.accounts)) cfg.accounts = [];
    if (!Array.isArray(cfg.users)) cfg.users = [];

    // 兼容历史版本：将 settings.notify 自动无损同步至 admin 账号作为其私有通知，保证已有配置不丢失
    if (cfg.settings?.notify && cfg.settings.notify.enabled) {
      const adminUser = cfg.users.find(u => u.username === 'admin' || u.username === 'ADMIN' || u.role === 'admin');
      if (adminUser && !adminUser.notify) {
        adminUser.notify = { ...cfg.settings.notify };
      }
    }
    // 默认已有账号归属 admin，默认平台为 ctyun，并解密密码还原至内存
    cfg.accounts.forEach(a => {
      if (!a.ownerId) a.ownerId = 'u_admin';
      if (!a.platform) a.platform = 'ctyun';
      if (a.password) a.password = decryptPassword(a.password);
    });

    // 如果是从备份恢复的，立即原子回写主配置文件修复现场
    if (loadedFromBak) {
      saveConfig(cfg);
    } else {
      // 主配置正常，原子同步刷新备份文件
      try {
        const diskClone = JSON.parse(JSON.stringify(cfg));
        if (Array.isArray(diskClone.accounts)) {
          for (const a of diskClone.accounts) {
            if (a.password) a.password = encryptPassword(a.password);
          }
        }
        atomicWriteFileSync(BAK_FILE, JSON.stringify(diskClone, null, 2), 'utf8');
      } catch (e) {}
    }
    return cfg;
  }

  // 4. 只有在首次全新安装时（既无主配置，也无备份），才初始化默认配置
  console.log('ℹ️ [系统初始化] 未检测到已有配置文件，正在初始化全新运行环境...');
  const defaultCfg = getDefaultConfig();
  saveConfig(defaultCfg);
  return defaultCfg;
}

function saveConfig(cfg) {
  try {
    const configToSave = cfg || appConfigRef;
    
    // 安全深拷贝用于加密落盘，内存中的密码仍然由各功能使用
    const diskClone = JSON.parse(JSON.stringify(configToSave));
    if (Array.isArray(diskClone.accounts)) {
      for (const a of diskClone.accounts) {
        if (a.password) {
          a.password = encryptPassword(a.password);
        }
      }
    }

    const jsonStr = JSON.stringify(diskClone, null, 2);
    // 1. 原子写入主配置文件 (防崩溃/防断电截断)
    atomicWriteFileSync(CONFIG_FILE, jsonStr, 'utf8');

    // 2. 自动同步持久化备份文件 (app_config.json.bak)
    if (Array.isArray(diskClone.accounts) || Array.isArray(diskClone.users)) {
      try {
        const BAK_FILE = CONFIG_FILE + '.bak';
        atomicWriteFileSync(BAK_FILE, jsonStr, 'utf8');
      } catch (e) {}
    }

    // 3. accounts.json 同样加密保护并原子写入
    const active = (configToSave.accounts || [])
      .filter(a => a.enabled !== false && a.features?.keepAlive !== false)
      .map(a => ({
        name: a.name || a.user,
        user: a.user,
        password: encryptPassword(a.password),
        deviceCode: a.deviceCode
      }));
    const ctyunJson = {
      keepAliveSeconds: configToSave.settings?.keepAliveSeconds || 60,
      accounts: active
    };
    atomicWriteFileSync(ACCOUNTS_JSON, JSON.stringify(ctyunJson, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('保存配置失败:', e);
    return false;
  }
}

module.exports = { getDefaultConfig, loadConfig, saveConfig, bindConfig };
