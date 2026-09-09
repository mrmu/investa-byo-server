#!/usr/bin/env bash
#
# 部署到這台機器：git pull → 重建容器 → 驗收
#
#   ssh root@linode-audi-inv 'cd /var/docker-www/byo-server && ./deploy.sh'
#
# 這台跟 Investa 的部署流程**不一樣**：Investa 走 GHA build → ghcr → pull image，
# 這台是 `build: .` 在機器上直接建。原因是這台只有一個使用者、一台機器，
# 為它養一條 CI 沒有意義；代價是 build 會吃這台的 CPU 約一分鐘。
#
# ── 兩個踩過的坑，腳本會擋 ──────────────────────────────────
#
# 1. **正式機上直接改檔／直接 commit**（2026-09-09 發現）
#    fce8b96「產業細分類」那個 commit 只存在這台機器上，從沒 push 過，
#    而當時 remote 還是 HTTPS 沒憑證 → push/pull 兩邊都不通，
#    最後得用 git bundle 雙向搬才把三邊接回來。
#    所以：工作區髒的、或有未推送的 commit，一律停下來，不要繼續蓋。
#
# 2. **docker-compose.override.yml 不見了**（2026-09-07 的教訓，寫在該檔開頭）
#    少了它，容器會被重建成「只在 byo_internal 上、沒有 VIRTUAL_HOST」，
#    nginx-proxy 把 byo.audilu.com 的 vhost 整段拿掉 —— 手機端連不上，
#    畫面上只是「美股/亞股沒資料」，**完全看不出跟一次容器重建有關**。
#    那個檔是未追蹤的（每台機器不同），所以 git 不會幫你把它救回來。
set -euo pipefail
cd "$(dirname "$0")"

say() { echo "[deploy] $*"; }
die() { echo "[deploy] ✗ $*" >&2; exit 1; }

# ── 前置檢查 ────────────────────────────────────────────────
[ -f docker-compose.override.yml ] || die "缺少 docker-compose.override.yml —— 直接重建會讓 vhost 消失（見檔頭說明）"

if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "工作區有未提交的改動。在正式機上改檔會造成三邊分歧，先 commit + push 或 checkout 掉。"
fi

git fetch -q origin
AHEAD=$(git rev-list --count origin/main..HEAD)
[ "$AHEAD" -eq 0 ] || die "本機有 $AHEAD 個未推送的 commit —— 先 push（見坑 1）"

BEFORE=$(git rev-parse --short HEAD)
git merge --ff-only origin/main
AFTER=$(git rev-parse --short HEAD)
[ "$BEFORE" = "$AFTER" ] && say "已是最新（$AFTER），仍重建以套用可能的環境變更" || say "$BEFORE → $AFTER"

# ── 重建 ────────────────────────────────────────────────────
say "重建容器…"
docker compose up -d --build

# ── 驗收 ────────────────────────────────────────────────────
sleep 6
say "驗收："
HTTP=$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://byo.audilu.com/health || echo 000)
[ "$HTTP" = "200" ] || die "health 回 $HTTP（服務沒起來，或 vhost 掉了）"
say "  health 200 ✓"

AUTH=$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://byo.audilu.com/indices || echo 000)
[ "$AUTH" = "401" ] || die "/indices 未帶金鑰回 $AUTH，應為 401（金鑰驗證沒生效）"
say "  /indices 未授權回 401 ✓"

docker inspect investa-byo --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^VIRTUAL_HOST=' \
  || die "容器少了 VIRTUAL_HOST —— override 沒吃到（見坑 2）"
say "  VIRTUAL_HOST ✓"

docker inspect investa-byo --format '{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | grep -q '^wp-proxy$' \
  || die "容器沒接上 wp-proxy 網路 —— override 沒吃到（見坑 2）"
say "  wp-proxy 網路 ✓"

say "完成（$AFTER）"
