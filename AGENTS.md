# CTYun Dashboard 协作规范

## 1. 项目定位与架构边界
- **天翼云/移动云电脑多账号可视化保活控制中心**：单进程 Bun 服务端（`server.ts`）+ 原生零框架前端（`app/`）+ 本地文件持久化（`data/`）。
- **设计系统与图标红线**：
  - 界面遵循 Adobe Spectrum 2 亮色优先（Light-first）桌面工作台风格。
  - **严禁使用任何 Emoji 充当界面图标**，统一使用本地 `remixicon`（`ri-*-line` / `ri-*-fill`）。
  - 交互控件优先采用自解释分段选择器与内联状态反馈，避免悬停 Tooltip 绑架与冗余确认弹窗。

## 2. 双栈监听、远端发布与 GitOps 部署
- **双栈监听**：容器与服务端默认绑定 `HOST=::`、`PORT=8787`，兼容 `cmcc-services` k3s 双栈 `ClusterIP Service`（内网域名 `http://ctyun.internal`）。
- **代码仓与镜像发布**：
  - 唯一远端：`https://github.com/p3psi-boo/ctyun-dashboard.git`（本机推送命令：`git -c credential.helper='!gh auth git-credential' push https://github.com/p3psi-boo/ctyun-dashboard.git main`）。
  - GitHub Actions 构建发布 `ghcr.io/p3psi-boo/ctyun-dashboard`，联动 `~/nixcfg` 的 `gitops/releases/ctyun-dashboard.nix` 与 `hosts/cmcc-services/services/ctyun-dashboard.nix`。

## 3. 验证与交付门禁
本机 NixOS 下运行测试与门禁需显式传入 `app/ecloud_engine/.venv` 的 Python 解释器（若缺失先执行 `uv sync --frozen --directory app/ecloud_engine`）：
```bash
ECLOUD_PYTHON="$PWD/app/ecloud_engine/.venv/bin/python" bun run typecheck
ECLOUD_PYTHON="$PWD/app/ecloud_engine/.venv/bin/python" bun run test
ECLOUD_PYTHON="$PWD/app/ecloud_engine/.venv/bin/python" bun run verify
```
