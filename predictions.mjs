/**
 * 預測市場機率（Polymarket）—— BYO 端的抓取、快照與供應
 *
 * 為什麼在這裡而不是 Investa：Polymarket 服務條款（2026-08-11 生效）禁止
 * 「金融科技公司」「市場資料散布者」等 Capital Market Client 透過 API 存取或轉散布
 * 它的資料，除非另有書面同意。Investa 屬於那一類，所以 Investa 不抓、不存、不轉手；
 * 由使用者自己的伺服器、為自己的個人用途抓取，裝置直連取用（見 Investa 的
 * docs/DATA_INVENTORY.md 與 docs/BYO_SERVER_SPEC.md 的 /predictions 一節）。
 *
 * 來源：
 *   Gamma API  https://gamma-api.polymarket.com/events?slug=<slug>   免金鑰，事件與各選項的現價
 *   CLOB       https://clob.polymarket.com/prices-history            免金鑰，只在**首次**看到某個選項時
 *                                                                   補 30 天日線，讓走勢圖第一天就有東西
 *
 * 頻率：一天一次（加上啟動時若今天還沒有快照就補一次）。預測市場的機率盤中會動，
 * 但這裡要回答的是「市場對這件事的看法這幾週怎麼變」，日線足夠；
 * 抓更密只是對免費 API 不禮貌，畫面上也看不出差別。
 *
 * 結束的事件：保留最後一次交易中的機率（不再寫新快照），另外記下結算價，標 closed。
 * 為什麼不直接用結算價當「目前機率」：結算後價格變成 0／1，走勢圖最後一點會垂直跳到底或頂，
 * 看起來像市場在最後一天突然改變看法 —— 那是結算，不是看法。
 */

import { httpGetJson } from "./http-get.mjs";
import { PREDICTION_EVENTS, CATEGORY_ORDER } from "./predictions-config.mjs";

const GAMMA = "https://gamma-api.polymarket.com/events";
const CLOB_HISTORY = "https://clob.polymarket.com/prices-history";
const DELAY_MS = 500; // 逐個事件、逐個選項慢慢拿 —— 免費公開 API，不要並發打
const SPARK_DAYS = 30;

/**
 * 低流動性門檻（**單一選項**的層級，不是整個事件）。
 *
 * 流動性 = 掛單簿上的掛單金額；成交量 = 累計成交金額。兩者任一太低，
 * 機率就可能被一兩筆單推動，看起來像共識其實不是。
 *   - 流動性 < 3 萬美元：推動價格幾個百分點的成本很低
 *   - 成交量 < 5 萬美元：參與的人與資金太少，價格不一定經過充分交易
 * 這是刻意保守的門檻：寧可多標，讓使用者自己判斷，也不要讓薄市場看起來可信。
 */
export const LOW_LIQUIDITY_RULE = { minLiquidity: 30_000, minVolume: 50_000 };

const log = (...a) => console.log(`[byo-predictions ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 台北時間的 yyyy-mm-dd（快照以台灣的日期為單位，與其他 BYO 資料一致） */
const twDate = (d = new Date()) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

export async function ensurePredictionSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS byo_pm_event (
      slug        text PRIMARY KEY,
      event_id    text,
      title_en    text,
      end_date    timestamptz,
      closed      boolean NOT NULL DEFAULT false,
      volume      double precision,
      liquidity   double precision,
      fetched_at  timestamptz,
      last_error  text);

    CREATE TABLE IF NOT EXISTS byo_pm_market (
      market_id    text PRIMARY KEY,
      event_slug   text NOT NULL,
      question     text,
      group_title  text,
      threshold    double precision,
      outcome      text,
      token_id     text,
      end_date     timestamptz,
      closed       boolean NOT NULL DEFAULT false,
      final_prob   double precision,
      volume       double precision,
      liquidity    double precision,
      api_change_1d double precision,
      api_change_7d double precision,
      history_backfilled boolean NOT NULL DEFAULT false,
      updated_at   timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS byo_pm_market_event ON byo_pm_market (event_slug);

    -- 一個選項一天一列。volume/liquidity 在 CLOB 補回的歷史列是 NULL（那支 API 只有價格）
    CREATE TABLE IF NOT EXISTS byo_pm_snapshot (
      market_id  text NOT NULL,
      date       date NOT NULL,
      prob       double precision NOT NULL,
      volume     double precision,
      liquidity  double precision,
      PRIMARY KEY (market_id, date));
  `);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const parseArr = (v) => {
  if (Array.isArray(v)) return v;
  try {
    const a = JSON.parse(v ?? "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

/**
 * 一個選項的「機率」= Yes 那一邊的價格。
 * 非 Yes/No 的二元市場（極少見，例如 Up/Down）就取第一個結果，並把它的名稱記在 outcome。
 */
function marketProb(m) {
  const outcomes = parseArr(m.outcomes);
  const prices = parseArr(m.outcomePrices).map(Number);
  if (prices.length === 0 || !Number.isFinite(prices[0])) return { prob: null, outcome: null };
  const yes = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
  const i = yes >= 0 ? yes : 0;
  return { prob: prices[i], outcome: String(outcomes[i] ?? "Yes") };
}

/** 補 30 天日線（只在第一次看到這個選項時）。失敗不重試到死 —— 標記後就算了，之後每天自己累積 */
async function backfillHistory(pool, marketId, tokenId) {
  if (!tokenId) return 0;
  const qs = new URLSearchParams({ market: tokenId, interval: "1m", fidelity: "1440" });
  const j = await httpGetJson(`${CLOB_HISTORY}?${qs}`, { timeoutMs: 20_000 });
  const pts = (j?.history ?? [])
    .map((h) => ({ date: twDate(new Date(Number(h.t) * 1000)), p: num(h.p) }))
    .filter((h) => h.p != null);
  if (pts.length === 0) return 0;
  // 同一天多點取最後一點；ON CONFLICT DO NOTHING —— 不覆蓋 Gamma 抓到的正式快照
  const byDate = new Map(pts.map((h) => [h.date, h.p]));
  await pool.query(
    `INSERT INTO byo_pm_snapshot (market_id, date, prob)
     SELECT $1, d, p FROM UNNEST($2::date[], $3::float8[]) AS t(d, p)
     ON CONFLICT (market_id, date) DO NOTHING`,
    [marketId, [...byDate.keys()], [...byDate.values()]],
  );
  return byDate.size;
}

async function collectEvent(pool, cfg, today) {
  const arr = await httpGetJson(`${GAMMA}?${new URLSearchParams({ slug: cfg.slug })}`, { timeoutMs: 20_000 });
  const ev = Array.isArray(arr) ? arr[0] : null;
  if (!ev) throw new Error("事件不存在（slug 可能失效或已下架）");

  await pool.query(
    `INSERT INTO byo_pm_event (slug, event_id, title_en, end_date, closed, volume, liquidity, fetched_at, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),NULL)
     ON CONFLICT (slug) DO UPDATE SET event_id = EXCLUDED.event_id, title_en = EXCLUDED.title_en,
       end_date = EXCLUDED.end_date, closed = EXCLUDED.closed, volume = EXCLUDED.volume,
       liquidity = EXCLUDED.liquidity, fetched_at = now(), last_error = NULL`,
    [cfg.slug, String(ev.id ?? ""), ev.title ?? null, ev.endDate ?? null, !!ev.closed, num(ev.volume), num(ev.liquidity)],
  );

  const include = cfg.include ? new Set(cfg.include) : null;
  let snaps = 0;
  let backfilled = 0;
  for (const m of ev.markets ?? []) {
    if (include && !include.has(m.groupItemTitle)) continue;
    const id = String(m.id);
    const { prob, outcome } = marketProb(m);
    const closed = !!m.closed;
    // clobTokenIds 與 outcomes 同序 —— 取「機率那一邊」的 token 補歷史
    const outIdx = Math.max(0, parseArr(m.outcomes).map(String).indexOf(outcome ?? ""));
    const tokenId = parseArr(m.clobTokenIds)[outIdx] ?? null;

    const { rows: prev } = await pool.query(
      `SELECT closed, history_backfilled, (SELECT COUNT(*) FROM byo_pm_snapshot s WHERE s.market_id = $1)::int AS n
         FROM byo_pm_market WHERE market_id = $1`,
      [id],
    );
    const known = prev.length > 0;
    // 從沒看過、而且已經結束的選項（例如「下一次降息時點」裡早已過去的會議）—— 沒有歷史可言，直接略過
    if (!known && closed) continue;

    await pool.query(
      `INSERT INTO byo_pm_market (market_id, event_slug, question, group_title, threshold, outcome, token_id,
                                  end_date, closed, final_prob, volume, liquidity, api_change_1d, api_change_7d, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       ON CONFLICT (market_id) DO UPDATE SET
         event_slug = EXCLUDED.event_slug, question = EXCLUDED.question, group_title = EXCLUDED.group_title,
         threshold = EXCLUDED.threshold, outcome = EXCLUDED.outcome, token_id = EXCLUDED.token_id,
         end_date = EXCLUDED.end_date, closed = EXCLUDED.closed,
         final_prob = COALESCE(EXCLUDED.final_prob, byo_pm_market.final_prob),
         volume = EXCLUDED.volume, liquidity = EXCLUDED.liquidity,
         api_change_1d = EXCLUDED.api_change_1d, api_change_7d = EXCLUDED.api_change_7d, updated_at = now()`,
      [
        id, cfg.slug, m.question ?? null, m.groupItemTitle || null, num(m.groupItemThreshold), outcome, tokenId,
        m.endDate ?? null, closed, closed ? prob : null, num(m.volumeNum ?? m.volume), num(m.liquidityNum ?? m.liquidity),
        num(m.oneDayPriceChange), num(m.oneWeekPriceChange),
      ],
    );

    // 結束的選項不再寫快照 —— 保留最後一次交易中的機率（理由見檔頭）
    if (!closed && prob != null) {
      await pool.query(
        `INSERT INTO byo_pm_snapshot (market_id, date, prob, volume, liquidity) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (market_id, date) DO UPDATE SET prob = EXCLUDED.prob, volume = EXCLUDED.volume, liquidity = EXCLUDED.liquidity`,
        [id, today, prob, num(m.volumeNum ?? m.volume), num(m.liquidityNum ?? m.liquidity)],
      );
      snaps++;
    }

    // 第一次看到的選項補 30 天歷史 —— 否則走勢圖要等一個月才畫得出來
    if (!closed && !(known && prev[0].history_backfilled)) {
      try {
        await sleep(DELAY_MS);
        backfilled += await backfillHistory(pool, id, tokenId);
      } catch (e) {
        log(`${cfg.slug} 選項 ${m.groupItemTitle || id} 歷史補抓失敗（之後每日自己累積）:`, e.message);
      }
      await pool.query(`UPDATE byo_pm_market SET history_backfilled = true WHERE market_id = $1`, [id]);
    }
  }
  return { snaps, backfilled };
}

/**
 * 每日一輪：逐個事件抓（循序 + 間隔）。單一事件失敗只記錯、保留舊值，不影響其他事件。
 * 回傳 { ok, failed }；全部失敗時由呼叫端決定要不要稍後重試。
 */
export async function collectPredictions(pool) {
  await ensurePredictionSchema(pool);
  const today = twDate();
  let ok = 0;
  let failed = 0;
  let snaps = 0;
  let backfilled = 0;
  for (const cfg of PREDICTION_EVENTS) {
    try {
      const r = await collectEvent(pool, cfg, today);
      ok++;
      snaps += r.snaps;
      backfilled += r.backfilled;
    } catch (e) {
      failed++;
      log(`${cfg.slug} 失敗（保留上一次的值）:`, e.message);
      await pool
        .query(
          `INSERT INTO byo_pm_event (slug, last_error) VALUES ($1,$2)
           ON CONFLICT (slug) DO UPDATE SET last_error = EXCLUDED.last_error`,
          [cfg.slug, String(e.message).slice(0, 300)],
        )
        .catch(() => {});
    }
    await sleep(DELAY_MS);
  }
  log(`預測市場更新：事件 ${ok} 成功／${failed} 失敗，快照 ${snaps} 筆${backfilled ? `，補歷史 ${backfilled} 點` : ""}`);
  return { ok, failed, snaps };
}

/** 今天（台北）是否已經有快照 —— worker 啟動時決定要不要先跑一輪 */
export async function hasTodaySnapshot(pool) {
  await ensurePredictionSchema(pool);
  const { rows } = await pool.query(`SELECT 1 FROM byo_pm_snapshot WHERE date = $1 LIMIT 1`, [twDate()]);
  return rows.length > 0;
}

// ─── 選項名稱的通用翻譯（設定檔 labels 沒列到的才走這裡）────────────────
const MONTHS = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};
function translateLabel(s) {
  if (!s) return s;
  let m;
  // "December 31, 2026" → "2026/12/31 前"
  if ((m = s.match(/^(\w+) (\d{1,2}), (\d{4})$/)) && MONTHS[m[1]]) return `${m[3]}/${MONTHS[m[1]]}/${m[2]} 前`;
  // "December 2026 Meeting" → "2026 年 12 月會議"
  if ((m = s.match(/^(\w+) (\d{4}) Meeting$/)) && MONTHS[m[1]]) return `${m[2]} 年 ${MONTHS[m[1]]} 月會議`;
  // "3 (75 bps)" → "3 次（75bp）"；"12+ (300+ bps)" → "12 次以上（300bp+）"
  if ((m = s.match(/^(\d+)(\+?) \((\d+)\+? bps\)$/))) return `${m[1]} 次${m[2] ? "以上" : ""}（${m[3]}bp${m[2]}）`;
  if ((m = s.match(/^Above (.+)$/))) return `高於 ${m[1]}`;
  if ((m = s.match(/^↑ \$(.+)$/))) return `漲到 ${m[1]}`;
  if ((m = s.match(/^↓ \$(.+)$/))) return `跌到 ${m[1]}`;
  if (s === "Other") return "其他";
  return s;
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const ymd = (v) => (v instanceof Date ? new Date(v.getTime() + 8 * 3600_000).toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));
const round4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

/**
 * GET /predictions 的回應。
 *
 * 只回設定檔裡有的事件（設定檔刪掉的事件就算 DB 還有資料也不回 —— 設定檔是唯一真相）。
 * 機率以 0–1 回傳，變化量是「百分點 / 100」（0.03 = +3 個百分點），呼叫端自行格式化。
 */
export async function readPredictions(pool) {
  await ensurePredictionSchema(pool);
  const slugs = PREDICTION_EVENTS.map((e) => e.slug);
  const [{ rows: evRows }, { rows: mkRows }, { rows: snapRows }] = await Promise.all([
    pool.query(`SELECT * FROM byo_pm_event WHERE slug = ANY($1)`, [slugs]),
    pool.query(`SELECT * FROM byo_pm_market WHERE event_slug = ANY($1)`, [slugs]),
    pool.query(
      `SELECT s.market_id, s.date, s.prob FROM byo_pm_snapshot s
         JOIN byo_pm_market m ON m.market_id = s.market_id
        WHERE m.event_slug = ANY($1) AND s.date >= (CURRENT_DATE - ($2::int + 10))
        ORDER BY s.market_id, s.date`,
      [slugs, SPARK_DAYS],
    ),
  ]);
  const evBy = new Map(evRows.map((r) => [r.slug, r]));
  const snapsBy = new Map();
  for (const r of snapRows) {
    const arr = snapsBy.get(r.market_id) ?? [];
    arr.push({ date: ymd(r.date), p: Number(r.prob) });
    snapsBy.set(r.market_id, arr);
  }
  const mkBy = new Map();
  for (const r of mkRows) {
    const arr = mkBy.get(r.event_slug) ?? [];
    arr.push(r);
    mkBy.set(r.event_slug, arr);
  }

  let updatedAt = null;
  const events = [];
  for (const cfg of PREDICTION_EVENTS) {
    const ev = evBy.get(cfg.slug);
    if (!ev || !ev.fetched_at) continue; // 從沒抓成功過 → 不回空殼
    const fetchedAt = iso(ev.fetched_at);
    if (!updatedAt || fetchedAt > updatedAt) updatedAt = fetchedAt;

    const markets = [];
    for (const m of mkBy.get(cfg.slug) ?? []) {
      const series = snapsBy.get(m.market_id) ?? [];
      if (series.length === 0) continue;
      const last = series[series.length - 1];
      // 前一日 / 7 日前：取「該日或更早最近的一筆」—— 中間漏抓一天不該讓變化量消失
      const before = (days) => {
        const cut = new Date(new Date(last.date).getTime() - days * 86400_000).toISOString().slice(0, 10);
        for (let i = series.length - 2; i >= 0; i--) if (series[i].date <= cut) return series[i].p;
        return null;
      };
      const p1 = before(1);
      const p7 = before(7);
      const vol = m.volume == null ? null : Number(m.volume);
      const liq = m.liquidity == null ? null : Number(m.liquidity);
      const sparkCut = new Date(new Date(last.date).getTime() - SPARK_DAYS * 86400_000).toISOString().slice(0, 10);
      markets.push({
        id: m.market_id,
        label: m.group_title ? (cfg.labels?.[m.group_title] ?? translateLabel(m.group_title)) : null,
        labelEn: m.group_title ?? null,
        question: m.question,
        outcome: m.outcome,
        probability: round4(last.p),
        change1d: p1 == null ? round4(m.api_change_1d) : round4(last.p - p1),
        change7d: p7 == null ? round4(m.api_change_7d) : round4(last.p - p7),
        // [日期, 機率] 的二元組而不是物件 —— 近百個選項 × 30 天，物件鍵名會讓回應大一倍以上
        sparkline: series.filter((s) => s.date >= sparkCut).map((s) => [s.date, round4(s.p)]),
        volume: vol,
        liquidity: liq,
        lowLiquidity: (liq ?? 0) < LOW_LIQUIDITY_RULE.minLiquidity || (vol ?? 0) < LOW_LIQUIDITY_RULE.minVolume,
        endDate: iso(m.end_date),
        closed: !!m.closed,
        finalProbability: m.closed ? round4(m.final_prob) : null,
        asOf: last.date,
        _threshold: m.threshold == null ? null : Number(m.threshold),
      });
    }
    if (markets.length === 0) continue;
    if (cfg.sort === "threshold") markets.sort((a, b) => (a._threshold ?? 0) - (b._threshold ?? 0));
    else markets.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
    for (const m of markets) delete m._threshold;

    events.push({
      slug: cfg.slug,
      title: cfg.title,
      titleEn: ev.title_en,
      category: cfg.category,
      hint: cfg.hint ?? null,
      endDate: iso(ev.end_date),
      closed: !!ev.closed,
      volume: ev.volume == null ? null : Number(ev.volume),
      liquidity: ev.liquidity == null ? null : Number(ev.liquidity),
      updatedAt: fetchedAt,
      // 最近一次抓取失敗 → 顯示的是舊值，呼叫端可標「可能不是最新」
      stale: !!ev.last_error,
      markets,
    });
  }
  const order = (c) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i < 0 ? 99 : i;
  };
  events.sort((a, b) => order(a.category) - order(b.category)); // 穩定排序：同分類內維持設定檔順序

  return {
    source: "Polymarket",
    updatedAt,
    categories: CATEGORY_ORDER,
    lowLiquidityRule: LOW_LIQUIDITY_RULE,
    events,
  };
}
