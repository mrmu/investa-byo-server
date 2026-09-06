# Investa 自訂資料源（BYO Server）

一台**你自己的**伺服器，提供台股裡沒有開放授權、因此不內建於 Investa app 的資料。

```
docker compose 起來 → 自動補三年歷史 → 在 app 設定頁填網址與金鑰 → 完成
```

---

## 這是什麼，為什麼要分開

Investa 上架版只內建**可再散布的開放資料**（政府資料開放平臺，OGDL 授權）。
上市三大法人明細、上市外資持股、個股借券餘額這些沒有免費可散布的授權，
Investa 不持有、不抓取、不轉手 —— 由使用者自備。

**這個 repo 不屬於 Investa 服務的一部分。** 它獨立進版控、獨立部署，
就是為了讓那條界線在結構上成立，而不只是寫在文件裡。

資料路徑也是分開的：app 是**直接**連到這台，金鑰只存在你的裝置上，
從不經過 Investa 的伺服器。所以這台掛了只影響你自己。

| | 誰負責 |
|---|---|
| 開放資料（日 K、融資融券、上櫃籌碼…） | Investa 內建 |
| 上市三大法人明細、上市外資持股、借券餘額 | **這台** |

---

## 快速開始

```bash
git clone <this-repo> byo-server && cd byo-server
./setup.sh                 # 產生 .env 與資料庫密碼
vi .env                    # 填入 BYO_FINMIND_TOKEN（其他可先不動）
./setup.sh                 # 起服務，並印出第一把 API 金鑰
```

金鑰**只會顯示這一次** —— 資料庫只存 SHA-256 雜湊，能重新查出明文的系統等於明文儲存。
弄丟就再簽一把（`--mint`），舊的可以撤銷（`--revoke`）。

啟動後 worker 會在背景自動補歷史（預設三年）。FinMind 免費方案有每日配額，
首次可能要好幾天才補得完 —— **會自己接續，不必重跑**。進度：

```bash
docker logs -f investa-byo-worker
```

### 要對外提供 https

app 送的是明文金鑰，走 http 等於公開它。若你已經有 nginx-proxy + Let's Encrypt：

```bash
# .env 填入 BYO_HOST 與 BYO_EMAIL 後
docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d
```

`setup.sh` 偵測到 `BYO_HOST` 會自動用這個模式。
其他反向代理（Caddy／Traefik／Cloudflare Tunnel）也可以，把 `8088` 轉進去即可。

⚠️ 對外網址**不能填 Investa 的網址** —— 那是 Investa 的伺服器，
指過去等於「我的自訂資料源就是 Investa 自己」，循環且失去意義。

---

## 金鑰管理

```bash
docker compose exec byo node server.mjs --mint  <標籤>   # 簽發
docker compose exec byo node server.mjs --list           # 列出（含最後使用時間）
docker compose exec byo node server.mjs --revoke <id>    # 撤銷
```

`--list` 的「最後使用時間」是用來判斷哪一把還在用、可以安全撤銷的。

---

## 端點

| 端點 | 用途 |
|---|---|
| `GET /capabilities` | 宣告這台實際提供哪些能力（逐項，不是全有全無） |
| `POST /match` | 給一個積木條件與期間，回**符合的鍵值**（不是原始資料） |
| `POST /series` | 單檔的整段序列（K 線副圖、籌碼分析用） |
| `POST /quote` | 一批股票的最新一日籌碼（籌碼速覽用） |
| `GET /health` | 健康檢查（免金鑰） |

`/match` 回鍵值而不是回資料，是刻意的：三年區間的原始明細有 336 萬列，
但「外資連買 ≥3 天」的命中鍵值只有 9.2 萬（6.5%）—— **傳條件不傳資料，
原始明細不離開這台機器**，傳輸量小 30 倍。

`coverage` 是必填欄位：這台只有一年歷史時，app 會據此縮短回測期並在畫面標示，
而不是假裝有三年。

完整契約見 Investa 的 `docs/BYO_SERVER_SPEC.md`。
你可以自己實作這幾個端點，不一定要用這份參考實作 ——
那也是這個設計的用意：任何人只要實作那幾個端點，就能把自己的資料接進訊號引擎。

---

## 運維

```bash
docker compose exec byo node server.mjs --list        # 金鑰
docker logs -f investa-byo-worker                     # 抓取狀況
docker compose exec byodb psql -U postgres -d byo     # 查資料
```

**備份**：資料在 named volume `byo-server_byodata`。

```bash
docker compose exec -T byodb pg_dump -U postgres --no-owner byo | gzip > byo-$(date +%F).sql.gz
```

⚠️ `docker-compose.yml` 裡的 `name: byo-server` **不要改**。
compose 預設拿目錄名當專案名，volume 就叫 `<目錄名>_byodata`；
改了之後會接到一個空的新 volume，看起來像資料全部不見了（實際上只是接錯）。

---

## 疑難排解

| 症狀 | 多半是 |
|---|---|
| app 連線測試回「連不上，或未開放跨來源存取」 | 瀏覽器把 CORS 失敗也報成連線失敗。確認 `BYO_ALLOWED_ORIGINS`，以及走的是 https |
| 未帶金鑰仍回得出資料 | 檢查是否有反向代理把 `X-API-Key` 標頭吃掉了 |
| 資料一直是空的 | 看 worker log。多半是 FinMind 配額用盡（會自己等重置後接續）或 token 沒填 |
| 連買天數與別處對不上 | 「當天沒有法人進出」的日子必須算成淨額 0；跳過那些日子會把連買接起來 |
