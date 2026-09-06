#!/usr/bin/env bash
# 一鍵啟動：產生設定 → 起服務 → 簽第一把金鑰
#
# 設計成可重複執行：已存在的 .env 不會被覆蓋，金鑰每次都會多簽一把
# （舊的仍有效，可以用 --list / --revoke 管理）。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  # 密碼自動產生 —— 讓人手填只會得到一個弱密碼
  PW=$(openssl rand -hex 20)
  sed -i.bak "s/^BYO_DB_PASSWORD=.*/BYO_DB_PASSWORD=${PW}/" .env && rm -f .env.bak
  echo "已建立 .env 並產生資料庫密碼。"
  echo "請填入 BYO_FINMIND_TOKEN 後再執行一次 ./setup.sh"
  exit 0
fi

if ! grep -q '^BYO_FINMIND_TOKEN=.\+' .env; then
  echo "請先在 .env 填入 BYO_FINMIND_TOKEN" >&2
  exit 1
fi

COMPOSE="docker compose --env-file .env"
if grep -q '^BYO_HOST=.\+' .env; then
  COMPOSE="$COMPOSE -f docker-compose.yml -f docker-compose.proxy.yml"
  echo "偵測到 BYO_HOST，使用 nginx-proxy 模式"
fi

$COMPOSE up -d --build
echo "等待資料庫就緒…"
until $COMPOSE exec -T byodb pg_isready -U postgres >/dev/null 2>&1; do sleep 2; done

echo
echo "簽發 API 金鑰（明文只會顯示這一次）："
$COMPOSE exec -T byo node server.mjs --mint "$(hostname)-$(date +%Y%m%d)"

echo
echo "服務已啟動。worker 會在背景自動補歷史 —— 首次可能要好幾天配額才補得完，"
echo "期間資料會逐步變多，不必重跑。進度："
echo "  docker logs -f investa-byo-worker"
