#!/usr/bin/env node
/**
 * 自訂資料源參考實作（BYO Server）
 *
 * 這是「使用者自備伺服器」的最小可用版本，用來驗證 docs/BYO_SERVER_SPEC.md 的契約。
 * **它不屬於 Investa 服務的一部分**：它持有沒有開放授權的資料（上市三大法人明細、
 * 上市外資持股、個股借券餘額、盤中即時），由使用者自己運行、自己承擔合規責任。
 *
 * 設計上刻意只做三件事，不做回測：
 *   GET  /capabilities  宣告這台提供哪些能力
 *   POST /match         給一個積木條件與期間，回傳符合的 (ticker, date) 鍵值
 *   POST /quote         給一批股票代號，回傳最新一日的籌碼數值（顯示層用）
 *
 * 為什麼是「回鍵值」而不是「回資料」：三年區間的原始明細有 336 萬列，
 * 但「外資連買≥3天」的命中鍵值只有 9.2 萬（6.5%）—— 傳條件不傳資料，
 * 原始明細不離開這台機器，傳輸量小 30 倍。實測數字見規格文件第 3 節。
 */
import { createServer } from "node:http";
import pg from "pg";
import { ensureIndustrySchema } from "./industry.mjs";
import crypto from "node:crypto";
import { readIndices } from "./indices.mjs";
import { readNightFutures } from "./futures.mjs";
import { readMacro } from "./macro.mjs";
import { fetchLive } from "./intraday.mjs";
import { readIndexHistory } from "./index-history.mjs";

const PORT = Number(process.env.PORT || 8088);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

/**
 * 金鑰管理
 *
 * 只存**雜湊**,不存明文 —— 資料庫被看到也拿不到可用的金鑰。
 * 支援多把(換金鑰時可先發新的、確認 app 換好再撤舊的)與撤銷。
 *
 * 明文只在 `node server.mjs --mint <標籤>` 產生時輸出一次,之後無法再取得。
 * 這是刻意的:能重新查出明文的系統,等於明文儲存。
 */
const KEY_TABLE = "byo_api_key";
const sha = (v) => crypto.createHash("sha256").update(v, "utf8").digest("hex");

async function ensureKeyTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${KEY_TABLE} (
      id          serial PRIMARY KEY,
      label       text NOT NULL,
      key_hash    text NOT NULL UNIQUE,
      created_at  timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at  timestamptz
    )`);
}

async function mintKey(label) {
  await ensureKeyTable();
  const plain = crypto.randomBytes(24).toString("base64url");
  await pool.query(`INSERT INTO ${KEY_TABLE} (label, key_hash) VALUES ($1, $2)`, [label, sha(plain)]);
  return plain;
}

/** 驗證並順手記錄使用時間(用來判斷哪把還在用、可以安全撤銷) */
async function verifyKey(plain) {
  if (!plain) return false;
  const { rowCount } = await pool.query(
    `UPDATE ${KEY_TABLE} SET last_used_at = now()
      WHERE key_hash = $1 AND revoked_at IS NULL`,
    [sha(plain)],
  );
  return rowCount > 0;
}

/**
 * 支援的積木 → SQL 條件。
 *
 * ⚠️ 欄位名寫死在這裡，**不接受呼叫端傳欄位名** —— 呼叫端只能送 block/op/value，
 * 其餘都是這份對照表決定的。這是唯一安全的做法。
 */
const BLOCKS = {
  foreign_streak: { col: "foreignBuyStreak" },
  trust_streak: { col: "trustBuyStreak" },
  foreign_net: { col: (n) => (Number(n) === 20 ? "foreignNet20D" : "foreignNet5D"), arg: "n" },
  trust_net: { col: (n) => (Number(n) === 20 ? "trustNet20D" : "trustNet5D"), arg: "n" },
  foreign_hold: { col: "foreignHoldPct" },
  foreign_hold_chg20: { col: "foreignHoldChg20Pp" },
  lending_chg5: { col: "lendingChg5" },
};
const OPS = { gte: ">=", lte: "<=", gt: ">", lt: "<" };
const MAX_KEYS = 200000;

const CAPABILITIES = [
  { id: "institutional_twse", label: "上市三大法人明細" },
  { id: "foreign_holding_twse", label: "上市外資持股比例" },
  { id: "securities_lending", label: "個股借券餘額" },
  { id: "intraday_mis", label: "盤中 1 分 K（MIS）" },
  { id: "indices", label: "國際指數與美元指數（美股／亞股／黃金／DXY）" },
  { id: "futures", label: "台指期夜盤" },
  { id: "macro", label: "受限總經（恐懼貪婪／美元台幣／景氣燈號／DXY）" },
  { id: "live_quote", label: "個股即時報價（MIS）" },
  { id: "index_history", label: "加權／櫃買指數完整日 K" },
  { id: "industry_taxonomy", label: "產業細分類" },
];

/** pg 會把 date 欄位轉成 JS Date;String(Date) 會給 "Wed Aug 05" 這種格式,必須明確轉 ISO */
const ymd = (v) =>
  v instanceof Date
    ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    : String(v ?? "").slice(0, 10);

/**
 * CORS —— 讓**瀏覽器**也能直連,不只手機 app。
 *
 * 網頁版必須與 app 一致:瀏覽器就是那個「裝置」,金鑰存在瀏覽器、直接連這台,
 * 不經過 Investa 伺服器(見 docs/BYO_SERVER_SPEC.md 第 4b 節)。
 * 少了 CORS,瀏覽器會在送出前就擋下來 —— 只有 app 能連,網頁版就得繞回
 * 「金鑰送到 Investa 代取」那條被否決的路。
 *
 * 預設 `*` 是安全的:驗證靠的是 X-API-Key **標頭**而不是 cookie,
 * 瀏覽器不會自動附帶,所以放寬來源並不會讓別的網站冒用你的身分。
 * 真正的憑證是金鑰本身。要收緊就設 BYO_ALLOWED_ORIGINS(逗號分隔)。
 */
const ALLOWED_ORIGINS = (process.env.BYO_ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allow = ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : null;
  if (!allow) return {};
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-api-key",
    "access-control-max-age": "86400",
    ...(allow === "*" ? {} : { vary: "Origin" }),
  };
}

function json(res, code, body, req) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s),
    ...(req ? corsHeaders(req) : {}),
  });
  res.end(s);
}

async function authed(req) {
  return verifyKey(String(req.headers["x-api-key"] || ""));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return null;
  }
}

/** 這台實際有資料的期間 —— 呼叫端據此縮短回測期，而不是假裝有三年 */
async function coverage() {
  const { rows } = await pool.query(
    `SELECT MIN(date) AS from, MAX(date) AS to FROM byo_feature WHERE "foreignBuyStreak" IS NOT NULL`,
  );
  return { from: ymd(rows[0]?.from), to: ymd(rows[0]?.to) };
}

async function handleMatch(body) {
  const spec = BLOCKS[body?.block];
  if (!spec) return { error: `不支援的積木:${body?.block}` };
  const op = OPS[body?.op];
  if (!op) return { error: `不支援的運算子:${body?.op}（僅 gte/lte/gt/lt）` };
  const v = Number(body?.params?.value);
  if (!Number.isFinite(v)) return { error: "params.value 必須是數字" };

  const col = typeof spec.col === "function" ? spec.col(body?.params?.[spec.arg]) : spec.col;
  const from = body?.from ?? "1900-01-01";
  const to = body?.to ?? "2999-12-31";

  const { rows } = await pool.query(
    `SELECT ticker, date
       FROM byo_feature
      WHERE date >= $1::date AND date <= $2::date AND "${col}" ${op} $3
      ORDER BY date
      LIMIT ${MAX_KEYS + 1}`,
    [from, to, v],
  );
  // 超過上限就明說被截斷 —— 靜默截斷會讓呼叫端以為結果完整
  const truncated = rows.length > MAX_KEYS;
  return {
    keys: rows.slice(0, MAX_KEYS).map((r) => [r.ticker, ymd(r.date)]),
    coverage: await coverage(),
    truncated,
  };
}

/**
 * 口徑與 Investa 一致（`src/lib/institutional-flows.ts`）:
 *   外資   = Foreign_Investor + Foreign_Dealer_Self
 *   投信   = Investment_Trust
 *   自營商 = Dealer_self + Dealer_Hedging
 *
 * ⚠️ 自營商**不能**用 `name LIKE 'Dealer%'`:資料裡同時存在 Dealer、Dealer_self、
 * Dealer_Hedging，而 Dealer 是前兩者的合計 —— 全部加起來會剛好多算一倍，
 * 而且看起來完全正常（正負號、量級都合理），不會有人發現。
 */
const NET_COLS = `
  (COALESCE(SUM(CASE WHEN i.name IN ('Foreign_Investor','Foreign_Dealer_Self') THEN i.buy - i.sell END), 0) / 1000.0)::float8 AS "foreignNet",
  (COALESCE(SUM(CASE WHEN i.name = 'Investment_Trust' THEN i.buy - i.sell END), 0) / 1000.0)::float8 AS "trustNet",
  (COALESCE(SUM(CASE WHEN i.name IN ('Dealer_self','Dealer_Hedging') THEN i.buy - i.sell END), 0) / 1000.0)::float8 AS "dealerNet"`;

async function handleQuote(body) {
  const tickers = Array.isArray(body?.tickers) ? body.tickers.slice(0, 500) : [];
  if (tickers.length === 0) return { rows: [] };
  // 與 /series 一樣附上當日原始淨額 —— 「籌碼速覽」要顯示的是今天買賣超多少，
  // 不是 5 日累計。少了它呼叫端只能拿累計值硬湊，數字會對不上任何一處。
  const { rows } = await pool.query(
    `WITH latest AS (SELECT MAX(date) AS d FROM byo_feature),
     daily AS (
       SELECT i.ticker, ${NET_COLS}
         FROM byo_institutional i, latest
        WHERE i.ticker = ANY($1) AND i.date = latest.d
        GROUP BY i.ticker
     )
     SELECT f.ticker, f.date, d."foreignNet", d."trustNet", d."dealerNet",
            f."foreignNet5D", f."trustNet5D",
            f."foreignBuyStreak", f."trustBuyStreak", f."foreignHoldPct", f."lendingChg5"
       FROM byo_feature f
       JOIN latest ON f.date = latest.d
       LEFT JOIN daily d ON d.ticker = f.ticker
      WHERE f.ticker = ANY($1)`,
    [tickers],
  );
  return { rows: rows.map((r) => ({ ...r, date: ymd(r.date) })) };
}

/**
 * 產業細分類 —— 整份回傳(約 2 千檔,幾十 KB)。
 *
 * 不做 tickers 過濾:呼叫端要的是「畫面上這一批的產業」,而畫面一直在換;
 * 整份給它快取一次,比每頁一次往返省。附 updatedAt 讓呼叫端自己決定要不要重取。
 */
async function handleIndustry() {
  // worker 還沒跑過時表可能不存在 —— 建好空表回空集合,不要 500
  await ensureIndustrySchema(pool);
  const { rows } = await pool.query(
    `SELECT ticker, label, updated_at FROM byo_industry WHERE label <> ''`,
  );
  const industries = {};
  let updatedAt = null;
  for (const r of rows) {
    industries[r.ticker] = r.label;
    const t = r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at);
    if (!updatedAt || t > updatedAt) updatedAt = t;
  }
  return { industries, count: rows.length, updatedAt };
}

// CLI:產生金鑰。明文只在此輸出一次。
if (process.argv[2] === "--mint") {
  const label = process.argv[3] || "unnamed";
  const plain = await mintKey(label);
  console.log(`已產生金鑰(${label}),請立刻複製,之後無法再取得:\n\n${plain}\n`);
  await pool.end();
  process.exit(0);
}
if (process.argv[2] === "--list") {
  await ensureKeyTable();
  const { rows } = await pool.query(
    `SELECT id, label, created_at, last_used_at, revoked_at FROM ${KEY_TABLE} ORDER BY id`,
  );
  console.table(rows);
  await pool.end();
  process.exit(0);
}
if (process.argv[2] === "--revoke") {
  await ensureKeyTable();
  await pool.query(`UPDATE ${KEY_TABLE} SET revoked_at = now() WHERE id = $1`, [Number(process.argv[3])]);
  console.log("已撤銷 #" + process.argv[3]);
  await pool.end();
  process.exit(0);
}

await ensureKeyTable();

/**
 * 一檔股票的整段序列（K 線副圖用）。
 *
 * 為什麼 /quote 不夠：它只回最新一日，補得了「籌碼速覽」的數值，
 * 補不了副圖需要的時間序列。副圖畫的是趨勢，一個點沒有意義。
 *
 * 為什麼限單檔：副圖一次只看一檔，而放寬到多檔會讓回應量以「檔數 × 天數」成長，
 * 那正是我們避免的整包拉資料。
 */

async function handleSeries(body) {
  const ticker = String(body?.ticker ?? "").replace(/\.(TW|TWO)$/i, "").trim();
  if (!ticker) return { error: "缺少 ticker" };
  const from = body?.from ?? "1900-01-01";
  const to = body?.to ?? "2999-12-31";

  /*
   * 除了衍生特徵，也回**每日原始值**。
   *
   * 只回特徵的話，呼叫端畫「每日法人買賣超」時只能拿 5 日累計去除以 5 當近似
   * （手機版原本就是這樣做的），那不是當日淨額 —— 柱狀圖的形狀會整個走樣，
   * 而且看起來像是有資料，不會被當成錯誤。
   *
   * 這仍然沒有違反「原始明細不離開這台機器」：離開的是**單檔**的每日合計
   * （三個數字 × 天數），不是三大法人的逐列明細，量級與第 3 節要避免的整包拉資料差很遠。
   */
  const { rows } = await pool.query(
    /*
     * ⚠️ 兩邊都必須**先各自篩到這一檔**再 join。
     * 把 `f.ticker = $1` 寫進 FULL JOIN 的 ON 裡不會過濾 —— 那只是 join 條件，
     * 配不上的列會以「右側單獨列」全部保留下來，結果混進**其他股票**的特徵值
     * （實測 2330 查出 foreignHoldPct 0.85，那是別檔的數字）。
     * 同一天出現兩列、數值卻各自合理，看起來完全不像壞掉。
     */
    `WITH daily AS (
       SELECT i.date, ${NET_COLS}
         FROM byo_institutional i
        WHERE i.ticker = $1 AND i.date >= $2::date AND i.date <= $3::date
        GROUP BY i.date
     ),
     feat AS (
       SELECT date, "foreignNet5D", "trustNet5D", "foreignBuyStreak", "trustBuyStreak",
              "foreignHoldPct", "foreignHoldChg20Pp", "lendingChg5"
         FROM byo_feature
        WHERE ticker = $1 AND date >= $2::date AND date <= $3::date
     )
     SELECT COALESCE(d.date, f.date) AS date,
            d."foreignNet", d."trustNet", d."dealerNet",
            h.holding_ratio AS "holdingRatio", l.volume AS "lendingVolume",
            f."foreignNet5D", f."trustNet5D", f."foreignBuyStreak", f."trustBuyStreak",
            f."foreignHoldPct", f."foreignHoldChg20Pp", f."lendingChg5"
       FROM daily d
       FULL JOIN feat f ON f.date = d.date
       LEFT JOIN byo_foreign_holding h ON h.ticker = $1 AND h.date = COALESCE(d.date, f.date)
       LEFT JOIN byo_lending l ON l.ticker = $1 AND l.date = COALESCE(d.date, f.date)
      ORDER BY 1
      LIMIT 2000`,
    [ticker, from, to],
  );
  return { ticker, rows: rows.map((r) => ({ ...r, date: ymd(r.date) })), coverage: await coverage() };
}

/**
 * 盤中 1 分 K（MIS，C 級明確受規範 —— 這正是它在這台而不是 Investa 的原因）。
 *
 * 只回 1 分 K，不做重取樣：呼叫端本來就有重取樣邏輯，
 * 而在這裡多做一份等於同一件事有兩個實作，遲早對不上。
 *
 * 預設回**最近有資料的那一天**，而不是「今天」：
 * 假日或盤前查詢時，「今天」會回空陣列，而空陣列跟「壞掉」長得一模一樣。
 * 回最近一個交易日並附上 date，呼叫端才知道自己看的是哪一天。
 */
async function handleIntraday(body) {
  const ticker = String(body?.ticker ?? "").replace(/\.(TW|TWO)$/i, "").trim();
  if (!ticker) return { error: "缺少 ticker" };

  /*
   * 回**最近 N 個交易日**，不是只有一天。
   *
   * 只回一天的話，60 分週期一整個交易日只有約 4.5 根 —— 呼叫端若要求
   * 「至少 10 根才算就緒」就永遠到不了，畫面會一直停在「資料收集中」，
   * 而且看起來像收集失敗，實際上是視窗太短（2026-09-07 開盤實測）。
   *
   * 每一根都帶自己的日期：跨日的桶必須分開，否則不同天的同一時刻會疊在一起。
   */
  const days = Math.min(Math.max(Number(body?.days) || 10, 1), 30);
  const { rows: dr } = await pool.query(
    body?.date
      ? `SELECT $2::date AS d`
      : `SELECT DISTINCT date AS d FROM byo_intraday WHERE ticker = $1 ORDER BY d DESC LIMIT ${days}`,
    body?.date ? [ticker, body.date] : [ticker],
  );
  if (dr.length === 0) return { ticker, date: null, bars: [] };
  const dates = dr.map((r) => r.d);
  const { rows } = await pool.query(
    `SELECT date, minute, open, high, low, close, volume
       FROM byo_intraday WHERE ticker = $1 AND date = ANY($2::date[])
      ORDER BY date, minute`,
    [ticker, dates],
  );
  return {
    ticker,
    date: ymd(dates[0]), // 最新交易日
    bars: rows.map((r) => ({ ...r, date: ymd(r.date) })),
  };
}

/** 個股即時報價(MIS)。查不到回 live:null 而不是錯誤 —— 停牌與代號錯誤都會走到這 */
async function handleLive(body) {
  const ticker = String(body?.ticker ?? "").trim();
  if (!ticker) return { error: "缺少 ticker" };
  return { live: await fetchLive(ticker) };
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  // 預檢請求在驗證**之前**回 —— 瀏覽器的 preflight 不帶 X-API-Key,
  // 放在驗證後面會被 401 擋掉,實際請求就永遠送不出去。
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (url.pathname === "/health") return json(res, 200, { ok: true }, req);
  if (!(await authed(req))) return json(res, 401, { error: "X-API-Key 不正確或已撤銷" }, req);

  try {
    if (req.method === "GET" && url.pathname === "/capabilities") {
      return json(res, 200, { capabilities: CAPABILITIES, coverage: await coverage() }, req);
    }
    if (req.method === "POST" && url.pathname === "/match") {
      const body = await readJson(req);
      const out = await handleMatch(body);
      return json(res, out.error ? 400 : 200, out, req);
    }
    if (req.method === "POST" && url.pathname === "/series") {
      const out = await handleSeries(await readJson(req));
      return json(res, out.error ? 400 : 200, out, req);
    }
    if (req.method === "POST" && url.pathname === "/quote") {
      return json(res, 200, await handleQuote(await readJson(req)), req);
    }
    if (req.method === "GET" && url.pathname === "/industry") {
      return json(res, 200, await handleIndustry(), req);
    }
    if (req.method === "POST" && url.pathname === "/index-candles") {
      const b = await readJson(req);
      const code = String(b?.symbol ?? "").toUpperCase();
      if (!["TAIEX", "TPEX"].includes(code)) return json(res, 400, { error: "symbol 只支援 TAIEX / TPEX" }, req);
      /*
       * 附上今日即時棒:日 K 歷史最快也要收盤後才有當天,
       * 而使用者盤中點進指數頁看到的就是「停在昨天」——
       * 那看起來像資料沒更新,實際上是還沒收盤。
       */
      const candles = await readIndexHistory(pool, code, b?.days);
      const live = await fetchLive(code);
      if (live && candles.length > 0 && live.date > candles[candles.length - 1].t) {
        candles.push({
          t: live.date,
          o: live.open ?? live.price,
          h: live.high ?? live.price,
          l: live.low ?? live.price,
          c: live.price,
          v: 0, // 指數的即時報價不含成交金額
        });
      }
      return json(res, 200, { symbol: code, candles, live }, req);
    }
    if (req.method === "GET" && url.pathname === "/macro") {
      return json(res, 200, { macro: await readMacro(pool) }, req);
    }
    if (req.method === "POST" && url.pathname === "/live") {
      const out = await handleLive(await readJson(req));
      return json(res, out.error ? 400 : 200, out, req);
    }
    if (req.method === "GET" && url.pathname === "/indices") {
      return json(res, 200, { indices: [...(await readIndices(pool)), ...(await readNightFutures(pool))] }, req);
    }
    if (req.method === "POST" && url.pathname === "/intraday") {
      const out = await handleIntraday(await readJson(req));
      return json(res, out.error ? 400 : 200, out, req);
    }
    return json(res, 404, { error: "不支援的路徑" }, req);
  } catch (e) {
    console.error("[byo]", e);
    return json(res, 500, { error: String(e?.message ?? e) }, req);
  }
}).listen(PORT, () => console.log(`[byo] listening on :${PORT}`));
