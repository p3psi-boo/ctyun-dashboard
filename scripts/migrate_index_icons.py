#!/usr/bin/env python3
"""Replace leading emoji icons in index.html with Remix Icon markup."""
import re
from pathlib import Path

INDEX = Path(__file__).resolve().parents[1] / "app/static/index.html"


def L(icon: str, text: str) -> str:
    return f'<span class="icon-label"><i class="ri-{icon}" aria-hidden="true"></i><span>{text}</span></span>'


def I(icon: str) -> str:
    return f'<i class="ri-{icon}" aria-hidden="true"></i>'


REPL = [
    (">☀️ 浅色<", f">{L('sun-line', '浅色')}<"),
    (">🔑 立即登录<", f">{L('key-line', '立即登录')}<"),
    (">➕ 添加云电脑<", f">{L('add-line', '添加云电脑')}<"),
    (">⚙️ 系统管理 ▾<", f">{L('settings-3-line', '系统管理 ▾')}<"),
    (">⚙️ 全局系统与平台调度<", f">{L('settings-3-line', '全局系统与平台调度')}<"),
    (">👥 用户与配额管理<", f">{L('group-line', '用户与配额管理')}<"),
    (">🔄 重启保活<", f">{L('refresh-line', '重启保活')}<"),
    (">📦 备份与还原 (JSON)<", f">{L('archive-line', '备份与还原 (JSON)')}<"),
    (">🔔 个人消息通知设置<", f">{L('notification-3-line', '个人消息通知设置')}<"),
    (">🔒 修改密码<", f">{L('lock-line', '修改密码')}<"),
    (">🚪 退出登录<", f">{L('logout-box-r-line', '退出登录')}<"),
    ('<div class="stat-icon">👥</div>', f'<div class="stat-icon">{I("group-line")}</div>'),
    ('<div class="stat-icon">📡</div>', f'<div class="stat-icon">{I("broadcast-line")}</div>'),
    ('<div class="stat-icon">📅</div>', f'<div class="stat-icon">{I("calendar-line")}</div>'),
    ('<div class="stat-icon">🎁</div>', f'<div class="stat-icon">{I("gift-line")}</div>'),
    ("<span>📋</span>", f"<span>{I('file-list-3-line')}</span>"),
    (">🌐 全部设备<", f">{L('global-line', '全部设备')}<"),
    (">☁️ 天翼云电脑<", f">{L('cloud-line', '天翼云电脑')}<"),
    (">🏠 移动爱家<", f">{L('home-4-line', '移动爱家')}<"),
    (">📡 移动公众<", f">{L('broadcast-line', '移动公众')}<"),
    (">🔄 刷新列表<", f">{L('refresh-line', '刷新列表')}<"),
    (">🌐 全部<", f">{L('global-line', '全部')}<"),
    (">☁️ 天翼云<", f">{L('cloud-line', '天翼云')}<"),
    (">📄 全部<", f">{L('file-text-line', '全部')}<"),
    (">📡 心跳保活<", f">{L('broadcast-line', '心跳保活')}<"),
    (">🎯 任务<", f">{L('focus-3-line', '任务')}<"),
    (">📱 手机 App 扫码一键登录 (推荐)<", f">{L('smartphone-line', '手机 App 扫码一键登录 (推荐)')}<"),
    (">🔑 手机号密码登录<", f">{L('key-line', '手机号密码登录')}<"),
    ('<option value="main">👑 和家亲主账号', '<option value="main">和家亲主账号'),
    ('<option value="sub">👤 独立分配子账号', '<option value="sub">独立分配子账号'),
    (
        '<span style="font-size: 15px; line-height: 1.2;">📡</span>',
        f'<span style="font-size: 15px; line-height: 1.2;">{I("broadcast-line")}</span>',
    ),
    (">📲 短信验证码", f">{L('message-2-line', '短信验证码')}"),
    (
        ">📱 手机 App 扫码一键信任设备 (免短信 · 推荐)",
        f">{L('smartphone-line', '手机 App 扫码一键信任设备 (免短信 · 推荐)')}",
    ),
    ("<h3>🎁 自动兑换与抽奖配置</h3>", f"<h3>{L('gift-line', '自动兑换与抽奖配置')}</h3>"),
    (
        "<h3>📊 每日已获得积分详细明细 (天翼云)</h3>",
        f"<h3>{L('bar-chart-box-line', '每日已获得积分详细明细 (天翼云)')}</h3>",
    ),
    ("<h3>⚡ 云电脑电源管理</h3>", f"<h3>{L('flashlight-line', '云电脑电源管理')}</h3>"),
    (
        ">🖥️ 选择操作目标云电脑</label>",
        f">{L('computer-line', '选择操作目标云电脑')}</label>",
    ),
    (
        'id="power-desktop-status" style="font-weight: 700; color: var(--success);">🟢 运行中',
        'id="power-desktop-status" style="font-weight: 700; color: var(--success);"><span class="status-with-text"><span class="status-dot status-dot--ok" aria-hidden="true"></span><span>运行中</span></span>',
    ),
    (
        ">🟢 开机 / 唤醒</button>",
        f">{L('checkbox-circle-line', '开机 / 唤醒')}</button>".replace('checkbox-circle', 'play-circle'),
    ),
]

# fix boot button - use play-circle-line
REPL[-1] = (
    ">🟢 开机 / 唤醒</button>",
    f">{L('play-circle-line', '开机 / 唤醒')}</button>",
)


def main() -> None:
    html = INDEX.read_text(encoding="utf-8")
    for old, new in REPL:
        html = html.replace(old, new)
    # More modal / footer replacements
    more = [
        (">🔄 重启云电脑<", f">{L('refresh-line', '重启云电脑')}<"),
        (">🔴 关机<", f">{L('stop-circle-line', '关机')}<"),
        ("<h3>🎁 手动积分兑换 / 幸运抽奖</h3>", f"<h3>{L('gift-line', '手动积分兑换 / 幸运抽奖')}</h3>"),
        (
            "<h3>⚙️ 全局系统与平台调度设置</h3>",
            f"<h3>{L('settings-3-line', '全局系统与平台调度设置')}</h3>",
        ),
        (
            ">⏰ 精准时间点自动化调度",
            f">{L('time-line', '精准时间点自动化调度 (北京时间，零空转超低功耗模式)')}",
        ),
        (">🏷️ 平台与品牌个性化", f">{L('price-tag-3-line', '平台与品牌个性化')}"),
        (">👥 多用户开放注册", f">{L('group-line', '多用户开放注册与默认配额')}"),
        (
            "<h3>🔔 个人消息通知推送设置</h3>",
            f"<h3>{L('notification-3-line', '个人消息通知推送设置')}</h3>",
        ),
        (">📨 立即测试推送<", f">{L('mail-send-line', '立即测试推送')}<"),
        (
            "<h3>📦 配置导出与备份还原</h3>",
            f"<h3>{L('archive-line', '配置导出与备份还原')}</h3>",
        ),
        (">📥 导出配置备份 (JSON)</h4>", f">{L('download-line', '导出配置备份 (JSON)')}</h4>"),
        (">⬇️ 导出并下载配置文件<", f">{L('download-2-line', '导出并下载配置文件')}<"),
        (">📤 导入还原配置 (JSON)</h4>", f">{L('upload-line', '导入还原配置 (JSON)')}</h4>"),
        (">📂 选择并上传 JSON 文件<", f">{L('folder-open-line', '选择并上传 JSON 文件')}<"),
        (
            "<h3>🔒 个人账号与安全设置</h3>",
            f"<h3>{L('lock-line', '个人账号与安全设置')}</h3>",
        ),
        ("<h3>🔑 修改指定用户密码</h3>", f"<h3>{L('key-line', '修改指定用户密码')}</h3>"),
        (
            "<h3>👥 平台用户与云电脑配额管理</h3>",
            f"<h3>{L('group-line', '平台用户与云电脑配额管理')}</h3>",
        ),
        ("📌 当前版本:", f"{L('pushpin-line', '当前版本: v2.3.1')}"),
        ("<h3>🚀 版本更新说明 (v2.3.1)</h3>", f"<h3>{L('rocket-line', '版本更新说明 (v2.3.1)')}</h3>"),
    ]
    for old, new in more:
        html = html.replace(old, new)

    presets = [
        ("👨‍💻", "user-smile-line"),
        ("🤖", "robot-2-line"),
        ("👑", "vip-crown-line"),
        ("🚀", "rocket-line"),
        ("⚡", "flashlight-line"),
        ("🐱", "emotion-happy-line"),
        ("🦊", "emotion-laugh-line"),
        ("🛡️", "shield-check-line"),
        ("🌟", "star-line"),
    ]
    for emoji, icon in presets:
        html = html.replace(
            f"selectPresetAvatar('{emoji}')\">{emoji}",
            f"selectPresetAvatar('ri-{icon}')\"><i class=\"ri-{icon}\" aria-hidden=\"true\"></i>",
        )
    html = html.replace(
        'placeholder="自定义文字或 Emoji (例如 🌟 或 鹏)"',
        'placeholder="自定义文字或 Remix 图标类名 (例如 ri-star-line 或 鹏)"',
    )
    INDEX.write_text(html, encoding="utf-8")
    print("index.html migrated")


if __name__ == "__main__":
    main()
