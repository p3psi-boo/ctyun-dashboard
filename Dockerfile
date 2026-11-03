# syntax=docker/dockerfile:1
# Bun 1.4.4 作为包管理器与 runtime；最终镜像非 root、无 shell。

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

WORKDIR /app

ENV TZ=Asia/Shanghai \
    PORT=8571 \
    HOME=/app \
    CTYUN_DATA_DIR=/app/data \
    ECLOUD_PYTHON=/usr/bin/python3 \
    ECLOUD_CRED_FILE=/app/data/ecloud_credentials.json \
    ECLOUD_SESSION_FILE=/app/data/ecloud_sessions.json \
    ECLOUD_LOGIN_RATE_LIMIT_FILE=/app/data/ecloud_login_rate_limit.json

# ca-certificates：天翼云 HTTPS
# python3 + requests + pycryptodome：移动公众协议侧车
# tzdata：Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone && \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates tzdata && \
    pip3 install --no-cache-dir --break-system-packages \
        -i https://pypi.tuna.tsinghua.edu.cn/simple \
        requests pycryptodome && \
    groupadd -r -g 10001 app && \
    useradd -r -u 10001 -g app -d /app -M -s /usr/sbin/nologin app && \
    mkdir -p /app/data && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache

COPY --from=deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --chown=10001:10001 package.json bun.lock ./
COPY --chown=10001:10001 app ./app
COPY --chown=10001:10001 server.js ./

RUN find /app/app/ecloud_engine -name '__pycache__' -type d -prune -exec rm -rf {} + || true && \
    chown -R 10001:10001 /app && \
    rm -f /bin/sh /bin/bash /bin/dash /usr/bin/sh /usr/bin/bash /usr/bin/dash

USER 10001:10001

EXPOSE 8571

VOLUME ["/app/data"]

ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["/app/server.js"]
