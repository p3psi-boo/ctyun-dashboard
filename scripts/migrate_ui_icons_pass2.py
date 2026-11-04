#!/usr/bin/env python3
"""Second pass: remaining emoji icons in app/static/app.js."""
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app/static/app.js"


def main() -> None:
    js = APP.read_text(encoding="utf-8")
    pairs = [
        ("⚪ 全局保活已关闭", '${statusWithText("off", "全局保活已关闭")}'),
        ("⚪ 单机保活已全关", '${statusWithText("off", "单机保活已全关")}'),
        (">⚡保活:", ">${ri('flashlight-line', 'pill-icon')}保活:"),
        (">🎯任务:", ">${ri('focus-3-line', 'pill-icon')}任务:"),
        ("pKeep.innerText = `⚡保活: ${keepText}`;", "pKeep.innerHTML = pillKeepLabel(keepText);"),
        ("pTask.innerText = `🎯任务: ${taskText}`;", "pTask.innerHTML = pillTaskLabel(taskText);"),
        ("labelPrefix = '⚡保活: ';", "labelPrefix = pillKeepLabel('');".replace("''", "''") + " // prefix via pillKeepLabel"),
        ("labelPrefix = '🎯任务: ';", "labelPrefix = pillTaskLabel('');"),
        ("labelPrefix = pillGuardLabel(true).replace(/开|关$/, '');", "labelPrefix = `${ri('shield-check-line', 'pill-icon')}守护: `;"),
        ('<span style="font-size:14px;">${isDone ? \'✅\' : \'⏳\'}</span>',
         '<span style="font-size:14px;">${isDone ? ri("checkbox-circle-line") : ri("loader-4-line")}</span>'),
        ("${isDone ? `🕒 ${escapeHtml(t.completedAt || '今日已达成')}`",
         "${isDone ? `${ri('time-line')} ${escapeHtml(t.completedAt || '今日已达成')}`"),
        ('>🎯 <b style="color:var(--text-main);"',
         '>${ri("focus-3-line")} <b style="color:var(--text-main);"'),
        ("${isDone ? '✅ 已达成' : '⏳ ' + progressText}",
         "${isDone ? riLabel('checkbox-circle-line', '已达成') : riLabel('loader-4-line', progressText)}"),
        ('title="点击直接修改备注">✏️</span>', 'title="点击直接修改备注">${ri("edit-line")}</span>'),
        ('title="编辑移动公众账号">✏️</button>', 'title="编辑移动公众账号">${ri("edit-line")}</button>'),
        ('title="编辑移动爱家账号">✏️</button>', 'title="编辑移动爱家账号">${ri("edit-line")}</button>'),
        ('title="编辑账号与重新验证">✏️</button>', 'title="编辑账号与重新验证">${ri("edit-line")}</button>'),
        ('onclick="launchWebDesktop', 'onclick="launchWebDesktop'),  # noop anchor
        ('>🚀 打开</button>', ">${riLabel('rocket-line', '打开')}</button>"),
        ('📡 移动公众 保活监视', "${riLabel('broadcast-line', '移动公众 保活监视')}"),
        ('>⚙️ 分层自动化保活开关</span>', ">${riLabel('settings-3-line', '分层自动化保活开关')}</span>"),
        ('>⚡ 账号级保活总开关</span>', ">${riLabel('flashlight-line', '账号级保活总开关')}</span>"),
        (
            "${_ydpcAllScg ? '📡 移动爱家 SCG 数据面监视' : '📡 移动爱家 ZTEC 握手与心跳监视'}",
            "${_ydpcAllScg ? riLabel('broadcast-line', '移动爱家 SCG 数据面监视') : riLabel('broadcast-line', '移动爱家 ZTEC 握手与心跳监视')}",
        ),
        ('>⚙️ 自动化保活开关', ">${riLabel('settings-3-line', '自动化保活开关')}"),
        (
            "${_ydpcMixedBase ? '🛡️ 自动开机守护（CAG/CEM 通道 · 按底座自动分流）' : (_ydpcAllScg ? '🛡️ 自动开机守护（CEM 通道）' : '🛡️ 自动开机守护（CAG 通道）')}",
            "${_ydpcMixedBase ? riLabel('shield-check-line', '自动开机守护（CAG/CEM 通道 · 按底座自动分流）') : (_ydpcAllScg ? riLabel('shield-check-line', '自动开机守护（CEM 通道）') : riLabel('shield-check-line', '自动开机守护（CAG 通道）'))}",
        ),
        (
            "${_ydpcAllScg ? '📡 数据面保活（SCG · trunk+SPICE）' : (_ydpcAllZte ? '📡 数据面保活（raw ZTEC / TLS+SPICE · 真保活）' : '📡 数据面保活（原生协议 · 逐台判定）')}",
            "${_ydpcAllScg ? riLabel('broadcast-line', '数据面保活（SCG · trunk+SPICE）') : (_ydpcAllZte ? riLabel('broadcast-line', '数据面保活（raw ZTEC / TLS+SPICE · 真保活）') : riLabel('broadcast-line', '数据面保活（原生协议 · 逐台判定）'))}",
        ),
        (
            "${_ydpcAllScg ? '🔄 控制面保活（SOHO 心跳 · SCG 无 CAG 握手）' : '🔄 控制面保活（CAG 握手 + SOHO 心跳）'}",
            "${_ydpcAllScg ? riLabel('refresh-line', '控制面保活（SOHO 心跳 · SCG 无 CAG 握手）') : riLabel('refresh-line', '控制面保活（CAG 握手 + SOHO 心跳）')}",
        ),
        ('<span>📡 官方 MQTT 3.1.1 链路长连保活</span>', '<span>${riLabel("broadcast-line", "官方 MQTT 3.1.1 链路长连保活")}</span>'),
        ("${!acc.password ? '⚠️ 待扫码授权' : '⚠️ 会话失效'}", "${riLabel('error-warning-line', !acc.password ? '待扫码授权' : '会话失效')}"),
        ('>⚠️ 待绑定</span>', ">${riLabel('error-warning-line', '待绑定')}</span>"),
        ('>📡 状态与心跳监视</span>', ">${riLabel('broadcast-line', '状态与心跳监视')}</span>"),
        ('<span style="color: #b45309; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">🏆 官方任务进度',
         '<span style="color: #b45309; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${ri("trophy-line")} 官方任务进度'),
        ('>⚙️ 自动化任务与保活开关</span>', ">${riLabel('settings-3-line', '自动化任务与保活开关')}</span>"),
        ('>📡 启用云电脑保活</span>', ">${riLabel('broadcast-line', '启用云电脑保活')}</span>"),
        ('>📅 每日自动签到打卡</span>', ">${riLabel('calendar-line', '每日自动签到打卡')}</span>"),
        ('>🤖 AI 智能对话任务 (每日100分)</span>', ">${riLabel('robot-2-line', 'AI 智能对话任务 (每日100分)')}</span>"),
        ('>🎁 自动兑换/抽奖', ">${riLabel('gift-line', '自动兑换/抽奖')}"),
        ('>⚙️ 奖品设置</button>', ">${riLabel('settings-3-line', '奖品设置')}</button>"),
        (
            "${!acc.password ? '📱 重新扫码授权' : '🔑 重新验证登录'}",
            "${!acc.password ? riLabel('smartphone-line', '重新扫码授权') : riLabel('key-line', '重新验证登录')}",
        ),
        ('>🔄 一键同步任务</button>', ">${riLabel('refresh-line', '一键同步任务')}</button>"),
        ('>⚡ 电源管理</button>', ">${riLabel('flashlight-line', '电源管理')}</button>"),
        ('>🎁 积分商城</button>', ">${riLabel('gift-line', '积分商城')}</button>"),
        ('>📲 短信二次安全绑定</button>', ">${riLabel('message-2-line', '短信二次安全绑定')}</button>"),
        ('<div style="font-size: 40px; margin-bottom: 12px;">🔒</div>', '<div style="font-size: 40px; margin-bottom: 12px;">${ri("lock-line")}</div>'),
        ('>🔑 立即登录</button>', ">${riLabel('key-line', '立即登录')}</button>"),
        ('>✨ 免费注册新用户</button>', ">${riLabel('sparkling-line', '免费注册新用户')}</button>"),
        ('>➕ 立即添加云电脑</button>', ">${riLabel('add-line', '立即添加云电脑')}</button>"),
        ("'♾️ 永久'", "'永久'"),
    ]
    for old, new in pairs:
        if old.startswith("labelPrefix = pillKeepLabel"):
            continue
        js = js.replace(old, new)

    js = js.replace(
        "labelPrefix = '⚡保活: ';",
        "labelPrefix = `${ri('flashlight-line', 'pill-icon')}保活: `;",
    )
    js = js.replace(
        "labelPrefix = '🎯任务: ';",
        "labelPrefix = `${ri('focus-3-line', 'pill-icon')}任务: `;",
    )
    js = js.replace(
        "labelPrefix = pillGuardLabel(true).replace(/开|关$/, '');",
        "labelPrefix = `${ri('shield-check-line', 'pill-icon')}守护: `;",
    )

    # Toasts: strip leading emoji (keep message text)
    toast_strip = [
        "🎉 ", "🔄 ", "📲 ", "📱 ", "⚠️ ", "❌ ", "🟢 ", "💓 ", "✅ ", "🔍 ",
    ]
    for e in toast_strip:
        js = js.replace(f'showToast("{e}', 'showToast("')
        js = js.replace(f"showToast(`{e}", "showToast(`")

    APP.write_text(js, encoding="utf-8")
    print("pass2 done")


if __name__ == "__main__":
    main()
