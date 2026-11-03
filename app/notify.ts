// @ts-nocheck
'use strict';

const crypto = require('crypto') as typeof import('crypto');
const runtime = require('./runtime');
const { getBeijingTimeString } = require('./lib/time');
const { isValidWebhookTarget } = require('./lib/net');

const appendLog = (...args) => runtime.appendLog(...args);
const appConfig = new Proxy({}, {
  get(_, p) { return runtime.config[p]; },
  set(_, p, v) { runtime.config[p] = v; return true; },
  ownKeys() { return Reflect.ownKeys(runtime.config || {}); },
  getOwnPropertyDescriptor(_, p) {
    return Object.getOwnPropertyDescriptor(runtime.config || {}, p);
  },
});

// Webhook 通知服务（支持完全自定义标题与内容模板及参数替换，集成 SSRF 防护）
async function sendNotification(settings, title, content, extraVars = {}) {
  const notify = settings?.notify;
  if (!notify || !notify.enabled) return { success: false, message: '通知未开启' };

  const channel = notify.channel || 'webhook';

  // SSRF 安全防御与有效性校验
  if (notify.webhookUrl && !isValidWebhookTarget(channel, notify.webhookUrl)) {
    appendLog('Notify', `[安全拦截] 拒绝向私有/内网或非法协议地址发送 Webhook: ${notify.webhookUrl}`, 'error');
    return { success: false, message: '安全拦截：禁止向内网/本地私有地址或非法格式发送推送' };
  }
  
  // 模板变量替换
  let finalTitle = notify.customTitleTemplate || title;
  let finalContent = notify.customContentTemplate || content;

  const vars = {
    '{title}': title,
    '{content}': content,
    '{time}': getBeijingTimeString(),
    '{account}': extraVars.account || '云电脑',
    '{task}': extraVars.task || '',
    '{status}': extraVars.status || '',
    '{points}': extraVars.points || ''
  };

  for (const [k, v] of Object.entries(vars)) {
    finalTitle = finalTitle.split(k).join(v);
    finalContent = finalContent.split(k).join(v);
  }

  appendLog('Notify', `触发 [${channel}] 推送: ${finalTitle}`, 'info');

  try {
    if (channel === 'webhook' && notify.webhookUrl) {
      const res = await fetch(notify.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: finalTitle, content: finalContent, time: vars['{time}'] })
      });
      return { success: res.ok, message: `HTTP ${res.status}` };
    } else if (channel === 'qywx' && notify.webhookUrl) {
      // 企业微信机器人 Webhook (支持 markdown 格式)
      const qywxPayload = {
        msgtype: 'markdown',
        markdown: {
          content: `### ${finalTitle}\n\n${finalContent}\n\n> 触发时间: ${vars['{time}']}`
        }
      };
      const res = await fetch(notify.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(qywxPayload)
      });
      const qywxData = await res.json().catch(() => ({}));
      return { success: res.ok && qywxData.errcode === 0, message: qywxData.errmsg || `HTTP ${res.status}` };
    } else if (channel === 'dingtalk' && notify.webhookUrl) {
      let dingUrl = notify.webhookUrl.trim();
      let dingSecret = (notify.secret || '').trim();

      // 1. 如果用户输入的是纯 access_token，自动补全官方 Webhook 基础前缀
      if (/^[a-zA-Z0-9_\-]{32,128}$/.test(dingUrl)) {
        dingUrl = `https://oapi.dingtalk.com/robot/send?access_token=${dingUrl}`;
      }

      // 2. 支持从 URL 中智能提取加签密钥: 如 https://oapi.dingtalk.com/robot/send?access_token=xxx&secret=SECxxx 或 url@SECxxx
      if (dingUrl.includes('@SEC')) {
        const parts = dingUrl.split('@');
        dingUrl = parts[0].trim();
        dingSecret = dingSecret || parts[1].trim();
      } else if (dingUrl.includes('secret=')) {
        try {
          const u = new URL(dingUrl);
          const s = u.searchParams.get('secret');
          if (s) {
            dingSecret = dingSecret || s;
            u.searchParams.delete('secret');
            dingUrl = u.toString();
          }
        } catch (e) {}
      }

      // 3. 如果开启或提供了加签密钥 (SEC...)，严格按照钉钉官方标准计算 HmacSHA256 签名并追加到 URL
      if (dingSecret) {
        const timestamp = Date.now();
        const stringToSign = `${timestamp}\n${dingSecret}`;
        const sign = crypto.createHmac('sha256', dingSecret).update(stringToSign).digest('base64');
        const sep = dingUrl.includes('?') ? '&' : '?';
        dingUrl = `${dingUrl}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
      }

      // 4. 钉钉 Markdown 负载 (首屏 title 必须为纯文本，剔除特殊字符)
      const cleanTitle = finalTitle.replace(/[#*`_~\[\]()]/g, '').trim() || '云电脑通知';
      const dingPayload = {
        msgtype: 'markdown',
        markdown: {
          title: cleanTitle,
          text: `### ${finalTitle}\n\n${finalContent}\n\n> 触发时间: ${vars['{time}']}`
        }
      };
      const res = await fetch(dingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dingPayload)
      });
      const dingData = await res.json().catch(() => ({}));
      let errMsg = dingData.errmsg || `HTTP ${res.status}`;
      if (dingData.errcode === 310000) {
        if (errMsg.includes('sign not match')) {
          errMsg = '【加签校验失败】您的钉钉机器人开启了加签安全设置，请在设置中填写以 SEC 开头的加签密钥 (Secret)！';
        } else if (errMsg.includes('keywords not in content')) {
          errMsg = '【关键词不匹配】您的钉钉机器人设置了自定义关键词，通知内容中必须包含您在钉钉设定的关键词！';
        } else if (errMsg.includes('IP')) {
          errMsg = '【IP未在白名单】您的钉钉机器人设置了IP白名单，当前服务器IP未在白名单中！';
        }
      } else if (dingData.errcode === 300001) {
        errMsg = '【Token无效】钉钉 access_token 无效或机器人已被删除，请核对 Webhook 地址！';
      }
      return { success: res.ok && dingData.errcode === 0, message: errMsg };
    } else if (channel === 'feishu' && notify.webhookUrl) {
      let feishuUrl = notify.webhookUrl.trim();
      let feishuSecret = (notify.secret || '').trim();

      // 支持从 URL 提取 secret: url@secret
      if (feishuUrl.includes('@')) {
        const parts = feishuUrl.split('@');
        feishuUrl = parts[0].trim();
        feishuSecret = feishuSecret || parts[1].trim();
      }

      const feishuPayload = {
        msg_type: 'interactive',
        card: {
          header: {
            title: {
              tag: 'plain_text',
              content: finalTitle
            },
            template: 'blue'
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `${finalContent}\n\n**触发时间**: ${vars['{time}']}`
              }
            }
          ]
        }
      };

      if (feishuSecret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const stringToSign = `${timestamp}\n${feishuSecret}`;
        const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64');
        feishuPayload.timestamp = timestamp;
        feishuPayload.sign = sign;
      }
      const res = await fetch(notify.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feishuPayload)
      });
      const feishuData = await res.json().catch(() => ({}));
      const isOk = res.ok && (feishuData.code === 0 || feishuData.StatusCode === 0 || feishuData.code === undefined);
      return { success: isOk, message: feishuData.msg || feishuData.StatusMessage || `HTTP ${res.status}` };
    } else if (channel === 'serverchan' && notify.webhookUrl) {
      const url = `https://sctapi.ftqq.com/${notify.webhookUrl}.send`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title: finalTitle, desp: finalContent }).toString()
      });
      return { success: res.ok, message: `HTTP ${res.status}` };
    } else if (channel === 'pushplus' && notify.webhookUrl) {
      const res = await fetch('http://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: notify.webhookUrl, title: finalTitle, content: finalContent })
      });
      return { success: res.ok, message: `HTTP ${res.status}` };
    } else if (channel === 'bark' && notify.webhookUrl) {
      const base = notify.webhookUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/${encodeURIComponent(finalTitle)}/${encodeURIComponent(finalContent)}`);
      return { success: res.ok, message: `HTTP ${res.status}` };
    } else if (channel === 'telegram' && notify.webhookUrl) {
      const [botToken, chatId] = notify.webhookUrl.split('@');
      if (botToken && chatId) {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `*${finalTitle}*\n\n${finalContent}`, parse_mode: 'Markdown' })
        });
        return { success: res.ok, message: `HTTP ${res.status}` };
      }
    }
  } catch (err) {
    appendLog('Notify', `通知发送异常: ${err.message}`, 'error');
    return { success: false, message: err.message };
  }
  return { success: false, message: '未配置推送目标或通道无效' };
}

// 针对特定账号的定向通知分发（优先使用云电脑所属用户的专属 Webhook，未配置或系统级事件兜底使用管理员/系统通知）
async function sendAccountNotification(account, title, content, extraVars = {}) {
  try {
    const ownerId = account?.ownerId || 'u_admin';
    const owner = (appConfig.users || []).find(u => u.id === ownerId);
    let targetNotify = owner?.notify;

    // 若用户未配置且所属用户为 admin，允许回退到 appConfig.settings?.notify（向下兼容）
    if (!targetNotify || !targetNotify.enabled) {
      if (owner?.role === 'admin' && appConfig.settings?.notify?.enabled) {
        targetNotify = appConfig.settings.notify;
      }
    }

    if (targetNotify && targetNotify.enabled) {
      return await sendNotification(
        { notify: targetNotify },
        title,
        content,
        { ...extraVars, account: account?.name || account?.user || extraVars.account || '云电脑' }
      );
    }
    return { success: false, message: '该账号所属用户未开启消息推送' };
  } catch (err) {
    appendLog('Notify', `定向推送发生异常(已安全隔离): ${err.message}`, 'warning');
    return { success: false, message: err.message };
  }
}

module.exports = { sendNotification, sendAccountNotification };
