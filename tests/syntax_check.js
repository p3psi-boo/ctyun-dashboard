#!/usr/bin/env bun
'use strict';

/**
 * 静态语法检查：对参与运行的核心 JS 文件做解析（Bun.Transpiler / node --check）。
 * 为什么独立成脚本：不依赖 shell 的 && 连接与平台差异，Windows/Linux 行为一致。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const isBun = !!process.versions.bun;

function walkJs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, acc);
    else if (e.isFile() && e.name.endsWith('.js')) acc.push(path.relative(ROOT, p));
  }
  return acc;
}

const FILES = ['server.js', ...walkJs(path.join(ROOT, 'app'))].sort();

let failed = 0;

const REQUIRED = [
  'server.js',
  'app/lib/task_switch.js',
  'app/ctyun_client.js',
  'app/http/handler.js',
  'app/http/ctyun_proxy.js',
  'app/auth_manager.js',
  'app/ydpc/product_route.js',
  'app/ydpc/zte_cag_tls.js',
  'app/ydpc/scg_keepalive.js',
  'app/ecloud/ecloud_engine.js',
  'app/ecloud/ecloud_client.js',
];
for (const f of REQUIRED) {
  if (!FILES.includes(f)) {
    console.error(`语法闸门自检失败：关键文件未登记进 FILES —— ${f}`);
    process.exit(1);
  }
}

const transpiler = isBun ? new Bun.Transpiler({ loader: 'js' }) : null;

for (const f of FILES) {
  const abs = path.join(ROOT, f);
  let ok = false;
  let errText = '';
  if (transpiler) {
    try {
      transpiler.transformSync(fs.readFileSync(abs, 'utf8'));
      ok = true;
    } catch (e) {
      errText = String(e && e.message ? e.message : e);
    }
  } else {
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
    ok = r.status === 0;
    errText = (r.stderr || r.stdout || '').trim();
  }
  if (ok) {
    console.log(`  ok    ${f}`);
  } else {
    failed++;
    console.error(`  FAIL  ${f}`);
    console.error(errText);
  }
}

if (failed > 0) {
  console.error(`\n语法检查未通过：${failed} 个文件存在语法错误。`);
  process.exit(1);
}

console.log(`\n语法检查通过：${FILES.length} 个文件全部正常。`);
