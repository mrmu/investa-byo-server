/**
 * 盤中 1 分 K 收集 —— TWSE MIS 快照聚合
 *
 * MIS（mis.twse.com.tw）是官方盤中揭示系統，約每 5 秒一個快照。
 * 它**明確受規範**（七級分類的 C 級：即時揭示需授權或延遲 ≥20 分鐘），
 * 所以不能內建在可散布的 app 裡 —— 這也是它出現在這台伺服器而不是 Investa 的原因。
 *
 * 這份實作是從 Investa 的 `worker/jobs/collect-intraday.ts` 移植過來的，
 * 連同那邊累積的實測教訓一起帶過來。重寫一份「乾淨版」會把這些全部丟掉：
 *
 *   1. z（最新成交價）多數輪次是 "-" —— 單一快照只有約三成的檔有值，
 *      因為 MIS 是逐 5 秒揭示窗，該窗沒撮合就沒有成交價。
 *   2. 因此多數 bar 只能從五檔推導，而「買一賣一中價」在價差一檔時
 *      正好落在**市場上不存在的價位**（2330 落庫 2397.5，法定檔位是 5）。
 *      2026-09-03 當日盤中 K 有 61% 是非法檔位價。→ 一律 alignToTick。
 *   3. 漲跌停鎖死時，空的那一側五檔會回 "0" 佔位。0 不是有效價 ——
 *      一根 low=0 會把整張圖的 Y 軸壓扁（2026-08-30，3406 漲停日）。
 *   4. 「五檔尚未越過最後成交價」時，最後成交價仍然有效（看盤軟體的行為：
 *      最新價黏著直到有新成交）。沿用它可大幅提高真實價比例，且不增加請求量。
 *
 * ⚠️ **盤中資料無法事後回補。** 今天沒收到的分鐘 K，明天就永遠拿不回來。
 * 所以「一列都沒收到」必須在盤中就叫出來，不能等收盤後的新鮮度檢查。
 * Investa 那邊踩過：HTTP client 對 MIS 一律 ECONNRESET，批次迴圈把例外
 * catch 成 warning，job 每分鐘「正常完成」，整個交易日 40 萬列就這樣沒了。
 */

import { httpGetJson } from "./http-get.mjs";

const MIS_BASE = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const UA = { "User-Agent": "Mozilla/5.0 (byo-worker)" };
const BATCH = 80;
const SAMPLES = 2; // 每分鐘取樣次數
const SAMPLE_GAP_MS = 12_000;
const BATCH_GAP_MS = 500;
const EMPTY_ALERT_ROUNDS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[byo-intraday ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ─── 檔位（從 Investa 的 src/lib/tick-size.ts 移植）─────────────
//
// 檔位表以官方日收盤價回推驗證（2026-08 全市場）：
//   普通股 <10:0.01 / 10-50:0.05 / 50-100:0.1 / 100-500:0.5 / 500-1000:1 / >=1000:5
//   ETF（受益憑證）<50:0.01 / >=50:0.05  ← 與普通股不同，不可共用同一張表

const isEtfCode = (bare) => /^00/.test(bare);

function tickSize(price, isEtf) {
  if (isEtf) return price < 50 ? 0.01 : 0.05;
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}

const round4 = (v) => Math.round(v * 10000) / 10000;

/**
 * 把推導價對齊到最近的合法檔位。
 * anchor 只在「正好卡在兩檔正中間」時用來決定取哪一側（價差一檔時中價的情形）；
 * 無 anchor 則固定取下緣以保持決定性。
 */
function alignToTick(price, isEtf, anchor) {
  if (!Number.isFinite(price) || price <= 0) return price;
  const t = tickSize(price, isEtf);
  // 先洗掉浮點雜訊，否則 17.35/0.05 = 346.99999... 會 floor 成錯的一格
  const u = Math.round((price / t) * 1e6) / 1e6;
  const lo = round4(Math.floor(u) * t);
  const hi = round4(Math.ceil(u) * t);
  if (lo === hi) return lo;
  const dLo = price - lo;
  const dHi = hi - price;
  const eps = t * 1e-6;
  if (dLo < dHi - eps) return lo;
  if (dHi < dLo - eps) return hi;
  if (anchor != null && Number.isFinite(anchor)) {
    return Math.abs(anchor - lo) <= Math.abs(anchor - hi) ? lo : hi;
  }
  return lo;
}

// ─── 股票池 ────────────────────────────────────────────────────
//
// 這台沒有 Investa 的 Stock 表，所以自己建池。
// 用的是**開放資料**的兩支當日行情端點（政府資料開放平臺登記的資源）——
// 這台抓開放資料沒有問題，它要避免的是把非開放資料交給 Investa，不是反過來。
//
// 必須知道 tse/otc：MIS 的 ex_ch 前綴錯了就查不到那一檔，而且不會報錯，
// 只是那檔從此沒有資料 —— 又一個靜默失敗。
const TWSE_QUOTES = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const TPEX_QUOTES = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes";

let poolCache = { day: "", codes: [] };

export async function buildPool(twDay) {
  if (poolCache.day === twDay && poolCache.codes.length > 0) return poolCache.codes;
  const codes = [];
  for (const [url, prefix, key] of [
    [TWSE_QUOTES, "tse", "Code"],
    [TPEX_QUOTES, "otc", "SecuritiesCompanyCode"],
  ]) {
    try {
      for (const r of await httpGetJson(url, { headers: UA })) {
        const c = String(r[key] ?? "").trim();
        // 只收 4–6 碼的股票／ETF；權證等不在 MIS 主板也用不到
        if (/^[0-9]{4,6}[A-Z]?$/.test(c)) codes.push(`${prefix}_${c}.tw`);
      }
    } catch (e) {
      log(`建池失敗（${prefix}）:`, e.message);
    }
  }
  const uniq = Array.from(new Set(codes));
  // 建不出池就沿用昨天的，不要回空陣列 —— 回空會讓整輪靜默跳過，
  // 而那正是「盤中沒收到資料」最難察覺的形式
  if (uniq.length === 0) return poolCache.codes;
  poolCache = { day: twDay, codes: uniq };
  log(`股票池 ${uniq.length} 檔`);
  return uniq;
}

// ─── 快照 ──────────────────────────────────────────────────────

const lastReal = new Map();
let lastRealDate = "";
let emptyRounds = 0;

async function fetchSnapshots(misCodes, anchorBy) {
  const out = [];
  for (let i = 0; i < misCodes.length; i += BATCH) {
    const chunk = misCodes.slice(i, i + BATCH);
    try {
      // ⚠️ 用 node:https 而不是 fetch —— undici 對 MIS 一律 ECONNRESET（見 http-get.mjs）
      const data = await httpGetJson(`${MIS_BASE}?ex_ch=${chunk.join("|")}&json=1&delay=0`, { headers: UA });
      for (const r of data.msgArray ?? []) {
        const ok = (v) => Number.isFinite(v) && v > 0;
        // 五檔取「第一個有效價」：鎖死時空側首檔是 "0" 佔位，真價在後
        const firstValid = (s0) => {
          for (const seg of String(s0 ?? "").split("_")) {
            const n = Number(seg);
            if (ok(n)) return n;
          }
          return NaN;
        };
        let price = Number(r.z);
        if (!ok(price)) price = Number(r.pz);
        let real = ok(price);
        if (real) {
          lastReal.set(r.c, price);
        } else {
          const bid = firstValid(r.b);
          const ask = firstValid(r.a);
          const lr = lastReal.get(r.c);
          if (ok(bid) && ok(ask) && lr != null && lr >= bid && lr <= ask) {
            price = lr; // 五檔尚未越過最後成交價 → 它仍然有效
            real = true;
          } else if (ok(bid) && ok(ask)) {
            const anchor = anchorBy.get(r.c) ?? (ok(Number(r.y)) ? Number(r.y) : null);
            price = alignToTick((bid + ask) / 2, isEtfCode(r.c), anchor);
          } else if (ok(bid)) price = bid;
          else if (ok(ask)) price = ask;
          else price = NaN;
        }
        const cumLots = Number(r.v); // 當日累計成交量（張）
        if (!r.c || !ok(price) || !Number.isFinite(cumLots)) continue;
        out.push({ ticker: r.c, price, cumLots, real });
      }
    } catch (e) {
      log("MIS batch error:", e.message);
    }
    if (i + BATCH < misCodes.length) await sleep(BATCH_GAP_MS);
  }
  return out;
}

// ─── 每分鐘一輪 ────────────────────────────────────────────────

/**
 * @param pool  pg Pool
 * @returns {written, realPct} 或 null（非盤中時段）
 */
export async function collectIntraday(pool) {
  const tw = new Date(Date.now() + 8 * 3600_000);
  const hm = tw.toISOString().slice(11, 16);
  const date = tw.toISOString().slice(0, 10);
  const dow = tw.getUTCDay();
  // 盤中時段守門。13:31~13:33 收最後一根與收盤撮合
  if (dow === 0 || dow === 6) return null;
  if (hm < "09:00" || hm > "13:33") return null;

  if (date !== lastRealDate) {
    lastReal.clear(); // 跨日：昨天的成交價不可沿用
    lastRealDate = date;
  }

  const codes = await buildPool(date);
  if (codes.length === 0) return null;

  // 當日各檔最新一根：cumVolume 當量能差分基準、close 當檔位對齊的 anchor。
  // 必須在取樣**之前**查，anchor 才餵得進 fetchSnapshots。
  const { rows: prev } = await pool.query(
    `SELECT DISTINCT ON (ticker) ticker, cum_volume, close, minute
       FROM byo_intraday WHERE date = $1::date ORDER BY ticker, minute DESC`,
    [date],
  );
  const anchorBy = new Map(prev.map((p) => [p.ticker, Number(p.close)]));
  // 量能差分只認「更早的分鐘」，避免同分鐘重跑時拿自己當基準
  const prevCum = new Map(prev.filter((p) => p.minute < hm).map((p) => [p.ticker, Number(p.cum_volume)]));

  const bars = new Map();
  let nSnap = 0;
  let nReal = 0;
  for (let s = 0; s < SAMPLES; s++) {
    for (const snap of await fetchSnapshots(codes, anchorBy)) {
      nSnap++;
      if (snap.real) nReal++;
      anchorBy.set(snap.ticker, snap.price);
      const a = bars.get(snap.ticker);
      if (!a) {
        bars.set(snap.ticker, {
          open: snap.price, high: snap.price, low: snap.price, close: snap.price, cumLots: snap.cumLots,
        });
      } else {
        a.high = Math.max(a.high, snap.price);
        a.low = Math.min(a.low, snap.price);
        a.close = snap.price;
        a.cumLots = Math.max(a.cumLots, snap.cumLots);
      }
    }
    if (s < SAMPLES - 1) await sleep(SAMPLE_GAP_MS);
  }

  if (bars.size === 0) {
    emptyRounds++;
    log(`${hm} 一列都沒收到（連續第 ${emptyRounds} 輪）`);
    if (emptyRounds === EMPTY_ALERT_ROUNDS) {
      // 盤中資料無法事後回補,所以這行必須大聲。沒有寄信管道就至少讓 log 明顯,
      // 別讓它混在一般 warning 裡
      log(`⚠️⚠️ 已連續 ${emptyRounds} 分鐘收不到盤中資料。盤中資料無法事後回補，請立即檢查。`);
    }
    return { written: 0, realPct: 0 };
  }
  emptyRounds = 0;

  const entries = Array.from(bars.entries());
  await pool.query(
    `INSERT INTO byo_intraday (ticker, date, minute, open, high, low, close, volume, cum_volume)
     SELECT * FROM UNNEST($1::text[], $2::date[], $3::text[], $4::float8[], $5::float8[],
                          $6::float8[], $7::float8[], $8::float8[], $9::float8[])
     ON CONFLICT (ticker, date, minute) DO UPDATE SET
       high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
       volume = EXCLUDED.volume, cum_volume = EXCLUDED.cum_volume`,
    [
      entries.map(([t]) => t),
      entries.map(() => date),
      entries.map(() => hm),
      entries.map(([, a]) => a.open),
      entries.map(([, a]) => a.high),
      entries.map(([, a]) => a.low),
      entries.map(([, a]) => a.close),
      entries.map(([t, a]) => Math.max(0, a.cumLots - (prevCum.get(t) ?? 0))),
      entries.map(([, a]) => a.cumLots),
    ],
  );

  // realPct = 真實成交價佔比，盤中價品質的監控指標。
  // 掉下來就代表又在大量猜價（2026-09-03 事故前等同 0%）
  const realPct = nSnap > 0 ? Math.round((nReal / nSnap) * 1000) / 10 : 0;
  log(`${date} ${hm} pool=${codes.length} bars=${entries.length} realPct=${realPct}%`);
  return { written: entries.length, realPct };
}

/**
 * 單檔即時報價 —— 直接打 MIS，不從落庫的分 K 取。
 *
 * 分 K 是每分鐘聚合一次的結果，拿它當「即時」最多會落後一分鐘；
 * 而使用者盯著頁首報價時，一分鐘的落後看起來就像「不會動」。
 * 單檔一次請求，成本可以忽略。
 *
 * 需要 tse/otc 前綴，所以先查池；池裡沒有就兩種都試一次
 * （新上市當天可能還不在池裡 —— 這種時候回「查不到」比回錯的市場好，
 *  但兩種都試的成本只有一次請求，值得）。
 */
export async function fetchLive(ticker) {
  const bare = String(ticker ?? "").replace(/\.(TW|TWO)$/i, "").trim();
  if (!bare) return null;
  const codes = poolCache.codes;
  const known = codes.find((c) => c.endsWith(`_${bare}.tw`));
  const tries = known ? [known] : [`tse_${bare}.tw`, `otc_${bare}.tw`];
  for (const ex of tries) {
    try {
      const data = await httpGetJson(`${MIS_BASE}?ex_ch=${ex}&json=1&delay=0`, { headers: UA });
      const m = (data.msgArray ?? [])[0];
      if (!m) continue;
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      // 與分 K 同一套價格推導:z 常是 "-",退回五檔並對齊檔位
      let price = num(m.z) ?? num(m.pz);
      let real = price != null;
      if (!real) {
        const first = (s0) => {
          for (const seg of String(s0 ?? "").split("_")) {
            const n = Number(seg);
            if (Number.isFinite(n) && n > 0) return n;
          }
          return null;
        };
        const bid = first(m.b);
        const ask = first(m.a);
        if (bid && ask) price = alignToTick((bid + ask) / 2, isEtfCode(bare), num(m.y));
        else price = bid ?? ask ?? null;
      }
      if (price == null) continue;
      const prevClose = num(m.y);
      /*
       * `date` 是必要欄位,不是附帶資訊。
       * 呼叫端用它判斷「這筆報價是不是今天的」以及要不要疊到日 K 的最後一根上;
       * 少了它,那些判斷會靜默走進 fallback —— 畫面看起來只是「沒有即時更新」,
       * 完全看不出是缺一個欄位(2026-09-07 開盤實測)。
       * MIS 的 d 是西元 yyyymmdd;沒有就用台北日期補。
       */
      const d8 = String(m.d ?? "").trim();
      const date = /^\d{8}$/.test(d8)
        ? `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`
        : new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      return {
        ticker: bare,
        date,
        price,
        open: num(m.o),
        high: num(m.h),
        low: num(m.l),
        prevClose,
        change: prevClose ? Math.round((price - prevClose) * 100) / 100 : null,
        changePct: prevClose ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : null,
        volLots: Number(m.v) || 0,
        time: m.t ?? null,
        // 讓呼叫端知道這是真成交價還是推導價 —— 兩者品質不同,不該長得一樣
        real,
      };
    } catch {
      // 換下一個前綴再試
    }
  }
  return null;
}
