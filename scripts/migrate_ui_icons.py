#!/usr/bin/env python3
"""Replace emoji UI icons in app/static/app.js with Remix Icon helpers."""
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app/static/app.js"


def migrate_app(js: str) -> str:
    js = js.replace(
        "const YDPC_TONE_DOTS = {\n  ok: '🟢', idle: '🔵', warn: '🟠', off: '⚪', error: '🔴'\n};",
        "function ydpcToneDot(tone) {\n  return statusDot(tone || 'off');\n}",
    )
    js = js.replace(
        "const ECLOUD_TONE_DOTS = {\n  ok: '🟢', idle: '🔵', warn: '🟠', off: '⚪', error: '🔴', unknown: '🟣'\n};",
        "function ecloudToneDot(tone) {\n  return statusDot(tone || 'off');\n}",
    )
    js = js.replace("${running ? '🟢' : '⚪'}", "${statusDot(running ? 'ok' : 'off')}")
    js = js.replace("const dot = YDPC_TONE_DOTS[view.tone] || '⚪';", "const dot = ydpcToneDot(view.tone);")
    js = js.replace("const dot = ECLOUD_TONE_DOTS[tone] || '⚪';", "const dot = ecloudToneDot(tone);")
    js = js.replace(
        '<span style="flex-shrink: 0;">🟣</span>',
        '<span style="flex-shrink: 0;">${statusDot("unknown")}</span>',
    )

    js = js.replace(
        'btn.textContent = theme === "dark" ? "🌙 深色" : "☀️ 浅色";',
        'btn.innerHTML = theme === "dark" ? riLabel("moon-line", "深色") : riLabel("sun-line", "浅色");',
    )
    js = js.replace(
        'if (headerAvatar) headerAvatar.innerText = avatarText;',
        'renderUserAvatar(headerAvatar, avatarText, (currentUser.username || "A")[0].toUpperCase());',
    )
    js = js.replace(
        'menuChangePwd.innerText = isAdmin ? "🔒 修改密码/用户名" : "🔒 修改密码";',
        'menuChangePwd.innerHTML = isAdmin ? riLabel("lock-line", "修改密码/用户名") : riLabel("lock-line", "修改密码");',
    )
    js = js.replace(
        'authBtn.innerText = "🔑 立即登录";',
        'setButtonIconLabel(authBtn, "key-line", "立即登录");',
    )

    for old, new in [
        (
            'ecMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;',
            'ecMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">${statusWithText("ok", "全量多机保活已激活")}</span>`;',
        ),
        (
            'ecMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;',
            'ecMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">${statusWithText("warn", "按单机策略保活中")}</span>`;',
        ),
        (
            'ydpcMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;',
            'ydpcMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">${statusWithText("ok", "全量多机保活已激活")}</span>`;',
        ),
        (
            'ydpcMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;',
            'ydpcMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">${statusWithText("warn", "按单机策略保活中")}</span>`;',
        ),
        (
            'ctyunMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;',
            'ctyunMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">${statusWithText("ok", "全量多机保活已激活")}</span>`;',
        ),
        (
            'ctyunMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;',
            'ctyunMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">${statusWithText("warn", "按单机策略保活中")}</span>`;',
        ),
        (
            'multiStatusEl.innerHTML = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;',
            'multiStatusEl.innerHTML = `<span style="color: #10b981; font-weight: 600;">${statusWithText("ok", "全量多机保活已激活")}</span>`;',
        ),
        (
            'multiStatusEl.innerHTML = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;',
            'multiStatusEl.innerHTML = `<span style="color: #0284c7; font-weight: 600;">${statusWithText("warn", "按单机策略保活中")}</span>`;',
        ),
    ]:
        js = js.replace(old, new)

    js = js.replace('🛡️守护:', "${ri('shield-check-line', 'pill-icon')}守护:")
    js = js.replace('>🖥️ 开机</button>', ">${riLabel('computer-line', '开机')}</button>")
    js = js.replace('>🖥️开机</button>', ">${riLabel('computer-line', '开机')}</button>")
    js = js.replace(
        '<button class="btn btn-sm btn-danger" onclick="deleteAccount(\'${acc.id}\')" title="删除账号">🗑️</button>',
        '<button class="btn btn-sm btn-danger btn-icon-only" onclick="deleteAccount(\'${acc.id}\')" title="删除账号">${ri("delete-bin-line")}</button>',
    )
    js = js.replace("pAuto.innerText = `🛡️守护: ${on ? '开' : '关'}`;", "pAuto.innerHTML = pillGuardLabel(on);")
    js = js.replace("pAutoBoot.innerText = `🛡️守护: ${on ? '开' : '关'}`;", "pAutoBoot.innerHTML = pillGuardLabel(on);")

    js = js.replace(
        '<span style="font-size:14px; font-weight:700; color:var(--text-main);">🖥️ ${escapeHtml(acc.accountName)}</span>',
        '<span style="font-size:14px; font-weight:700; color:var(--text-main);" class="icon-label">${ri("computer-line")}<span>${escapeHtml(acc.accountName)}</span></span>',
    )
    for old, new in [
        ('<span>🖥️ ${desktopsCountText}</span>', '<span class="icon-label">${ri("computer-line")}<span>${desktopsCountText}</span></span>'),
        ('<span>🖥️ ${vmsCountText}</span>', '<span class="icon-label">${ri("computer-line")}<span>${vmsCountText}</span></span>'),
        (
            '<span>🖥️ 名下云主机 (${dList.length}台)</span>',
            '<span class="icon-label">${ri("computer-line")}<span>名下云主机 (${dList.length}台)</span></span>',
        ),
    ]:
        js = js.replace(old, new)

    js = js.replace(
        "statusEl.innerHTML = `<span style=\"color: ${isRunning ? '#16a34a' : '#d97706'}; font-weight:700;\">${isRunning ? '🟢 ' : '⚪ '}${st}</span>`;",
        'statusEl.innerHTML = `<span class="status-with-text" style="color: ${isRunning ? \'#16a34a\' : \'#d97706\'}; font-weight:700;">${statusDot(isRunning ? "ok" : "off")}<span>${st}</span></span>`;',
    )
    js = js.replace(
        "opt.innerText = `🖥️ ${d.desktopName || '云电脑'}${flavor} - (${d.useStatusText || '运行中'})`;",
        "opt.textContent = `${d.desktopName || '云电脑'}${flavor} - (${d.useStatusText || '运行中'})`;",
    )
    js = js.replace(
        "preview.innerText = val ? val.slice(0, 2) : ((currentUser?.username || \"A\")[0].toUpperCase());",
        'renderUserAvatar(preview, val, (currentUser?.username || "A")[0].toUpperCase());',
    )
    js = js.replace(
        "if (headerAvatar) headerAvatar.innerText = customAvatar.slice(0, 2);",
        'renderUserAvatar(headerAvatar, customAvatar, (currentUser?.username || "A")[0].toUpperCase());',
    )

    # Feature row labels (account cards)
    feature_replacements = [
        ('>🛡️ 自动开机守护</span>', ">${riLabel('shield-check-line', '自动开机守护')}</span>"),
        ('>🧩 L1 账号态保活</span>', ">${riLabel('puzzle-line', 'L1 账号态保活')}</span>"),
        ('>🧩 L2 桌面登记保活</span>', ">${riLabel('puzzle-line', 'L2 桌面登记保活')}</span>"),
        ('>💓 立即保活</button>', ">${riLabel('heart-pulse-line', '立即保活')}</button>"),
        ('>🔄 同步桌面</button>', ">${riLabel('refresh-line', '同步桌面')}</button>"),
        ('>📄 看本平台日志</button>', ">${riLabel('file-text-line', '看本平台日志')}</button>"),
        ('>🔄 CAG 握手</button>', ">${riLabel('refresh-line', 'CAG 握手')}</button>"),
        ('>💓 发送心跳</button>', ">${riLabel('heart-pulse-line', '发送心跳')}</button>"),
        ('>🔍 独立验证</button>', ">${riLabel('search-line', '独立验证')}</button>"),
    ]
    for old, new in feature_replacements:
        js = js.replace(old, new)

    # Monitor section titles
    js = js.replace(
        '📡 移动公众 保活监视',
        "${riLabel('broadcast-line', '移动公众 保活监视')}",
    )
    js = js.replace(
        "'📡 移动爱家 SCG 数据面监视'",
        "riLabel('broadcast-line', '移动爱家 SCG 数据面监视')",
    )
    js = js.replace(
        "'📡 移动爱家 ZTEC 握手与心跳监视'",
        "riLabel('broadcast-line', '移动爱家 ZTEC 握手与心跳监视')",
    )

    return js


def main() -> None:
    text = APP.read_text(encoding="utf-8")
    APP.write_text(migrate_app(text), encoding="utf-8")
    print("app.js migrated")


if __name__ == "__main__":
    main()
