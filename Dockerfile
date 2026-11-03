FROM node:22-bookworm-slim AS builder

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmmirror.com

COPY package.json package-lock.json ./

# 安装纯净精简生产依赖 (仅需原生 ws 协议库，彻底剔除 C++ 二进制 ONNX/图像框架)
RUN npm config set registry "$NPM_REGISTRY" && \
    npm ci --omit=dev --no-audit && \
    rm -rf /root/.npm \
           node_modules/**/README.md \
           node_modules/**/CHANGELOG.md \
           node_modules/**/.github \
           node_modules/**/test \
           node_modules/**/tests \
           node_modules/**/examples

# -------------------------------------------------------------
# 运行环境：精简至极致 (压缩后传输仅约 20MB)
# -------------------------------------------------------------
FROM node:22-bookworm-slim

WORKDIR /app

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8571 \
    CTYUN_DATA_DIR=/app/data \
    PUID=1000 \
    PGID=1000 \
    ECLOUD_PYTHON=/opt/ctyun-ecloud/.venv/bin/python \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/ctyun-ecloud/.venv \
    PATH="/opt/ctyun-ecloud/.venv/bin:$PATH" \
    ECLOUD_CRED_FILE=/app/data/ecloud_credentials.json \
    ECLOUD_SESSION_FILE=/app/data/ecloud_sessions.json \
    ECLOUD_LOGIN_RATE_LIMIT_FILE=/app/data/ecloud_login_rate_limit.json

# 国内构建默认走清华 PyPI；可用 --build-arg 覆盖。
ARG UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV UV_DEFAULT_INDEX=$UV_INDEX_URL

# ca-certificates：天翼云 HTTPS
# tini：作 PID 1 回收 Python 侧车僵尸进程，并转发 SIGTERM
# python3（bookworm = 3.11）：移动公众协议侧车解释器，由 uv 装进独立 venv
# uv：按 uv.lock 做 uv sync --frozen，作为镜像内 Python 环境管理器保留
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv
COPY app/ecloud_engine/pyproject.toml app/ecloud_engine/uv.lock /opt/ctyun-ecloud/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone && \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates python3 tini && \
    uv sync --frozen --no-dev --no-cache --python /usr/bin/python3 \
        --directory /opt/ctyun-ecloud && \
    chmod +x /usr/local/bin/docker-entrypoint.sh && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache /root/.local

# 从构建阶段拷贝极速轻量 node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY app ./app
COPY server.js ./

# 侧车源码不携带任何 Python 字节码缓存，保持镜像干净
RUN find /app/app/ecloud_engine -name '__pycache__' -type d -prune -exec rm -rf {} + || true

EXPOSE 8571

VOLUME ["/app/data"]

# 无鉴权探活：只表示 HTTP 已在听端口，不泄露账号数据。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:'+(process.env.PORT||8571)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
