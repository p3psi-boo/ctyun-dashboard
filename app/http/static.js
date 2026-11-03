'use strict';

const fs = require('fs');
const runtime = require('../runtime');

function serveStatic(res, filePath, contentType) {
  const appConfig = runtime.config || {};
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('File Not Found');
    } else {
      let content = data;
      // 若返回 HTML，动态将当前最新的系统主标题与副标题注入模板，杜绝页面刷新时回跳闪烁！
      if (contentType.includes('text/html')) {
        let htmlStr = data.toString('utf8');
        const currentTitle = appConfig.settings?.systemTitle || '天翼云/移动云电脑保活签到中心';
        const currentSubtitle = appConfig.settings?.systemSubtitle || '多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机';
        htmlStr = htmlStr.replace(/<h1 id="main-system-title">[^<]*<\/h1>/, `<h1 id="main-system-title">${currentTitle}<\/h1>`);
        htmlStr = htmlStr.replace(/(<p style="font-size: 13px; color: var\(--text-muted\); margin-top: 2px;">)[^<]*(<\/p>)/, `$1${currentSubtitle}$2`);
        htmlStr = htmlStr.replace(/<title>[^<]*<\/title>/, `<title>${currentTitle} - 多账号保活控制台<\/title>`);
        content = Buffer.from(htmlStr, 'utf8');
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, must-revalidate'
      });
      res.end(content);
    }
  });
}

module.exports = { serveStatic };
