#!/bin/sh
# Docker 入口：保证 data 卷可写，并在可能时从 root 降权到 PUID/PGID。
# 群晖 / 飞牛 / 绿联把 PUID/PGID 设成共享文件夹属主即可；对不齐时回退 root，避免容器起不来。
set -eu

DATA_DIR="${CTYUN_DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR" || true

drop_and_exec() {
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all -- "$@"
}

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"

  if setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- sh -c "test -w \"$DATA_DIR\""; then
    drop_and_exec "$@"
  fi

  if chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null; then
    if setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- sh -c "test -w \"$DATA_DIR\""; then
      drop_and_exec "$@"
    fi
  fi

  echo "⚠️  数据目录 ${DATA_DIR} 对 PUID=${PUID} 不可写，回退以 root 运行。" >&2
  echo "    群晖/飞牛/绿联请把 PUID/PGID 设为共享文件夹属主，或 chmod 该目录。" >&2
  exec "$@"
fi

exec "$@"
