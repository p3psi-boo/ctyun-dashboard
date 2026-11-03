'use strict';

const fs = require('fs');
const path = require('path');

function atomicWriteFileSync(filePath, content, encoding = 'utf8', mode = undefined) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`);
  const opts = mode ? { encoding, mode } : { encoding };
  fs.writeFileSync(tmpPath, content, opts);
  try {
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      fs.copyFileSync(tmpPath, filePath);
      try { fs.unlinkSync(tmpPath); } catch (e) { /* 临时文件清理失败不影响主写入 */ }
    }
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { /* 尽力清理 */ }
    throw err;
  }
}

module.exports = { atomicWriteFileSync };
