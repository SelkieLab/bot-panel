#!/usr/bin/env bash
# /opt/bots/bin/backup.sh —— 每日备份（systemd timer 驱动）
# 设计取舍：
#   - 只备“不可再生”的数据：AstrBot 数据库/插件/配置、QQ 登录态、网关 data、面板自身。
#   - 排除 temp/（聊天媒体缓存 400M+，可再生）与 QQ 的 Cache/Code Cache（浏览器缓存）。
#   - sqlite 用 .backup 在线备份，保证 WAL 下也能得到一致快照。
#   - 打包后 gzip，保留最近 7 天 + 每周日单独留 4 份。
set -uo pipefail

BASE=${BASE:-/opt/bots}   # 部署根目录，可用环境变量覆盖
BDIR=$BASE/backups
STAGE=$BDIR/.stage
STAMP=$(date +%Y%m%d-%H%M%S)
DAY=$(date +%u)
LOG=$BDIR/backup.log

mkdir -p "$BDIR"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
fail() { log "ERROR: $*"; echo "ERROR: $*" >&2; exit 1; }

trap 'rm -rf "$STAGE"' EXIT
rm -rf "$STAGE"; mkdir -p "$STAGE"

# ---------- 1) AstrBot：配置 + 数据库（在线快照）+ 插件/插件数据 ----------
mkdir -p "$STAGE/astrbot"
cp -a /opt/bots/astrbot/data/cmd_config.json "$STAGE/astrbot/" 2>/dev/null || log "warn: cmd_config 缺失"
cp -a /opt/bots/astrbot/data/plugins.json   "$STAGE/astrbot/" 2>/dev/null || true
for f in data_v4.db; do
  if [ -f "/opt/bots/astrbot/data/$f" ]; then
    python3 - "$f" "$STAGE/astrbot/$f" <<'PY' || log "warn: sqlite 备份失败 $f"
import sqlite3, sys
src = "/opt/bots/astrbot/data/" + sys.argv[1]
dst = sys.argv[2]
s = sqlite3.connect("file:%s?mode=ro" % src, uri=True)
d = sqlite3.connect(dst)
with d:
    s.backup(d)
d.close(); s.close()
PY
  fi
done
tar czf "$STAGE/astrbot-plugins.tgz" -C /opt/bots/astrbot/data plugins plugin_data knowledge_base 2>/dev/null \
  || log "warn: 插件目录打包失败"

# ---------- 2) QQ 登录态（断线重扫二维码的代价很高，值得备） ----------
QQCFG=/var/lib/docker/volumes/qq-client-config/_data
if [ -d "$QQCFG" ]; then
  # 只留登录态与账号配置。Emoji/Pic/avatar 是表情与图片缓存（实测 384M+），
  # 删了 QQ 会自动重新下载，不值得每天备份。
  tar czf "$STAGE/qq-login.tgz" -C "$QQCFG" \
      --exclude='QQ/Cache' --exclude='QQ/Code Cache' --exclude='QQ/GPUCache' \
      --exclude='QQ/Shared Dictionary' --exclude='QQ/Trust Tokens' \
      --exclude='QQ/log' --exclude='*.log' \
      --exclude='*/Emoji' --exclude='*/Emoji/*' \
      --exclude='*/Pic' --exclude='*/Video' --exclude='*/avatar' \
      --exclude='*/PokeFace' --exclude='*/WeatherBgCache' \
      --exclude='*/nt_temp' --exclude='*/log-cache' --exclude='*/nt_data/log' \
      QQ 2>/dev/null || log "warn: QQ 登录态打包失败"
fi
QQGW=/var/lib/docker/volumes/qq-gateway-data/_data
[ -d "$QQGW" ] && { tar czf "$STAGE/qq-gateway.tgz" -C "$QQGW" . 2>/dev/null || log "warn: 网关打包失败"; }

# ---------- 3) 面板自身（代码+配置+知识库） ----------
tar czf "$STAGE/panel.tgz" -C /opt/bots/panel \
    --exclude='cache' --exclude='downloads' --exclude='__pycache__' --exclude='audit.log' \
    . 2>/dev/null || log "warn: 面板打包失败"

# ---------- 4) 系统侧配置（出事后能照着恢复） ----------
tar czf "$STAGE/system.tgz" \
    /etc/systemd/system/bot-panel.service \
    /etc/systemd/system/bot-novnc-forward.service \
    /etc/systemd/system/acme-web.service \
    /opt/bots/novnc-forward.py /opt/bots/acme-web.py 2>/dev/null || true

# ---------- 5) 汇总 + 校验 ----------
NAME="bots-$STAMP.tgz"
tar czf "$BDIR/$NAME" -C "$STAGE" . || fail "打包失败"
SIZE=$(du -h "$BDIR/$NAME" | cut -f1)
sha256sum "$BDIR/$NAME" >"$BDIR/$NAME.sha256" 2>/dev/null || true

# 周日单独留档
if [ "$DAY" = "7" ]; then cp -a "$BDIR/$NAME" "$BDIR/weekly-$NAME"; fi

# ---------- 6) 保留策略 ----------
find "$BDIR" -maxdepth 1 -name 'bots-*.tgz' -mtime +7 -delete 2>/dev/null
find "$BDIR" -maxdepth 1 -name 'bots-*.tgz.sha256' -mtime +7 -delete 2>/dev/null
find "$BDIR" -maxdepth 1 -name 'weekly-bots-*.tgz' -mtime +28 -delete 2>/dev/null

# 日志自身限长
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 1048576 ]; then
  tail -c 262144 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

COUNT=$(find "$BDIR" -maxdepth 1 -name 'bots-*.tgz' | wc -l)
TOTAL=$(du -sh "$BDIR" 2>/dev/null | cut -f1)
log "OK $NAME ($SIZE) 保留 $COUNT 份，共 $TOTAL"
echo "OK $NAME ($SIZE)"
