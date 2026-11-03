# syntax=docker/dockerfile:1
# Bun 1.4.4 作为包管理器与 runtime；最终镜像非 root、无 shell。
# Python 侧车用 uv sync --frozen 装进独立 venv；tini 作 PID 1 回收侧车僵尸进程。

FROM oven/bun:1.4.4-debian AS bun-bin

FROM oven/bun:1.4.4-debian AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile \
    && rm -rf /root/.bun/install/cache \
              node_modules/**/README.md \
              node_modules/**/CHANGELOG.md \
              node_modules/**/.github \
              node_modules/**/test \
              node_modules/**/tests \
              node_modules/**/examples

# 运行阶段基于 Debian slim：需要 Python 侧车，同时拷入 bun 单二进制。
FROM python:3.12-slim-bookworm

COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv

WORKDIR /app

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8571 \
    HOME=/app \
    CTYUN_DATA_DIR=/app/data \
    ECLOUD_PYTHON=/opt/ctyun-ecloud/.venv/bin/python \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/ctyun-ecloud/.venv \
    PATH="/opt/ctyun-ecloud/.venv/bin:/usr/local/bin:$PATH" \
    ECLOUD_CRED_FILE=/app/data/ecloud_credentials.json \
    ECLOUD_SESSION_FILE=/app/data/ecloud_sessions.json \
    ECLOUD_LOGIN_RATE_LIMIT_FILE=/app/data/ecloud_login_rate_limit.json

# 国内构建默认走清华 PyPI；可用 --build-arg 覆盖。
ARG UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV UV_DEFAULT_INDEX=$UV_INDEX_URL

COPY app/ecloud_engine/pyproject.toml app/ecloud_engine/uv.lock /opt/ctyun-ecloud/

# ca-certificates：天翼云 HTTPS
# tini：作 PID 1 回收 Python 侧车僵尸进程，并转发 SIGTERM
# python 3.12：移动公众协议侧车解释器，由 uv 按 uv.lock 装进独立 venv
# uv：作为镜像内 Python 环境管理器保留
# tzdata：Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone && \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates tzdata tini && \
    uv sync --frozen --no-dev --no-cache --python python3 \
        --directory /opt/ctyun-ecloud && \
    groupadd -r -g 10001 app && \
    useradd -r -u 10001 -g app -d /app -M -s /usr/sbin/nologin app && \
    mkdir -p /app/data && \
    chown -R 10001:10001 /opt/ctyun-ecloud && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache /root/.local

COPY --from=deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --chown=10001:10001 package.json bun.lock tsconfig.json ./
COPY --chown=10001:10001 app ./app
COPY --chown=10001:10001 server.ts ./

RUN find /app/app/ecloud_engine -name '__pycache__' -type d -prune -exec rm -rf {} + || true && \
    chown -R 10001:10001 /app && \
    rm -f /bin/sh /bin/bash /bin/dash /usr/bin/sh /usr/bin/bash /usr/bin/dash

USER 10001:10001

EXPOSE 8571

VOLUME ["/app/data"]

# 无鉴权探活：只表示 HTTP 已在听端口，不泄露账号数据。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8571)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["tini", "--", "/usr/local/bin/bun"]
CMD ["/app/server.ts"]
