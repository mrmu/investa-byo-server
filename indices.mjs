/**
 * 國際指數與受限總經 —— 由這台供應，Investa 不碰
 *
 * 為什麼這些不能內建在 app 裡（2026-09-05 查證 FRED 序列原文後定案）：
 *   S&P 500「Reproduction in any form is prohibited except with prior written permission」
 *   Nasdaq Composite 主張著作權；Nikkei 225 散布前須取得許可。
 * **限制跟著指數權利人走，不跟著遞送管道走** —— 所以把 Yahoo 換成 FRED
 * 並不能解決，換誰都一樣。這正是它們必須由使用者自備的原因。
 *
 * 抓法沿用 Investa 原本的實作（Yahoo chart API），連同兩個防呆一起帶過來：
 *   1. Yahoo 收盤後常多一根與現價重複的 bar → 按日期去重，每日取最後一筆
 *   2. 最新 bar 的 close 偶爾是 null，被濾掉後「陣列最後一筆」就不是當日 ——
 *      前收會誤抓到前前日，畫面上是一個假的漲跌幅。所以最新交易日以
 *      meta.regularMarketTime 為準，而不是陣列位置。
 */

import { httpGetJson } from "./http-get.mjs";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; byo-server/1.0)" };
const YF = "https://query1.finance.yahoo.com/v8/finance/chart";
const log = (...a) => console.log(`[byo-indices ${new Date().toISOString().slice(11, 19)}]`, ...a);

/**
 * 對照表與 Investa 的 `INDEX_GROUPS` 一致 —— 兩邊的 key 必須對得起來，
 * 否則 app 拿到資料卻對不上分組，畫面仍然是空的（而且看起來像沒抓到）。
 */
/*
 * `closeUtc` = 該市場當日的**收盤時刻**（UTC 小時，可含小數）。
 *
 * 為什麼需要（2026-09-09）：`byo_indicator.date` 是 DATE，直接 toISOString()
 * 會得到當天的**午夜 UTC**，在台北顯示成「早上 8 點」——於是 09-08 收盤的美股
 * 在 app 上看起來是「09-08 早上更新」，比實際**舊了 13 小時**，使用者讀成「停更了」。
 *
 * 這是 Investa 那邊 taifexNightQuote() 踩過的同一個坑的鏡像：那邊填午夜讓資料
 * 看起來**比較新**，這邊讓資料看起來**比較舊**。兩邊的教訓一樣——
 * 這一欄是使用者判斷「資料多舊」的唯一依據，填錯就等於謊報。
 *
 * 時刻取常態收盤（不處理夏令時間與半日市，誤差 1 小時內，對「多舊」的判斷夠用）：
 *   美股 16:00 ET ≈ 20:00 UTC（夏令）｜日經 15:00 JST = 06:00 UTC
 *   KOSPI 15:30 KST = 06:30 UTC｜黃金與美元指數是連續盤，取美股收盤對齊
 */
export const SERIES = [
  { key: "DJI", symbol: "^DJI", name: "道瓊工業", group: "美股", closeUtc: 20 },
  { key: "SPX", symbol: "^GSPC", name: "S&P 500", group: "美股", closeUtc: 20 },
  { key: "IXIC", symbol: "^IXIC", name: "NASDAQ", group: "美股", closeUtc: 20 },
  { key: "SOX", symbol: "^SOX", name: "費城半導體", group: "美股", closeUtc: 20 },
  { key: "N225", symbol: "^N225", name: "日經 225", group: "亞股", closeUtc: 6 },
  { key: "KOSPI", symbol: "^KS11", name: "韓國綜合", group: "亞股", closeUtc: 6.5 },
  { key: "GOLD", symbol: "GC=F", name: "黃金", group: "原物料", closeUtc: 20 },
  /*
   * 布蘭特原油 —— **不是授權問題,是時效問題**(2026-09-10 加)。
   *
   * Investa 那邊走 FRED `DCOILBRENTEU`(EIA 現貨,授權乾淨),但那條序列
   * 本身就延遲約 9 天(實測 09-10 當天最新只到 09-01)。要當日價只能取期貨報價,
   * 而那是 E 級(ToS 灰色)—— 正是自訂資料源存在的理由。
   *
   * ⚠️ 跟其他項目不同:Investa **仍然會供應** FRED 版的布蘭特給所有人,
   * 這裡是**覆蓋**不是**填補**。沒接自訂資料源的人看得到(慢 9 天),
   * 接了的人看到當日價。不要把它加進 Investa 的 BYO_DB_SERIES ——
   * 那會讓沒接的人反而看不到本來看得到的乾淨資料。
   */
  { key: "BRENT", symbol: "BZ=F", name: "布蘭特原油", group: "原物料", closeUtc: 20 },
  { key: "DXY", symbol: "DX-Y.NYB", name: "美元指數", group: "總經", closeUtc: 20 },
];

const round2 = (n) => Math.round(n * 100) / 100;

/** 單一序列的日收盤（近三個月）。失敗回 null —— 一檔失敗不該擋掉其他檔 */
async function fetchDaily(symbol) {
  try {
    const j = await httpGetJson(`${YF}/${encodeURIComponent(symbol)}?range=3mo&interval=1d`, { headers: UA });
    const r = j.chart?.result?.[0];
    if (!r) return null;
    const ts = r.timestamp ?? [];
    const closes = r.indicators?.quote?.[0]?.close ?? [];
    // 按日期去重：Yahoo 收盤後常多一根與現價重複的 bar
    const byDate = new Map();
    ts.forEach((t, i) => {
      const c = closes[i];
      if (c != null) byDate.set(new Date(t * 1000).toISOString().slice(0, 10), c);
    });
    if (byDate.size < 2) return null;
    const price = r.meta?.regularMarketPrice ?? Array.from(byDate.values()).pop();
    // 最新交易日以 meta 為準，不是陣列位置（見檔頭第 2 點）
    const marketDate = r.meta?.regularMarketTime
      ? new Date(r.meta.regularMarketTime * 1000).toISOString().slice(0, 10)
      : Array.from(byDate.keys()).pop();
    return { days: Array.from(byDate.entries()), price, marketDate };
  } catch (e) {
    log(`${symbol} 失敗:`, e.message);
    return null;
  }
}

/** 每日抓一輪，寫進 byo_indicator */
export async function collectIndices(pool) {
  let written = 0;
  for (const s of SERIES) {
    const d = await fetchDaily(s.symbol);
    if (!d) continue;
    const rows = d.days.slice(-90);
    // 最新 bar 被 null 濾掉時補上現價，序列尾端才含最新一天
    if (rows.length > 0 && rows[rows.length - 1][0] < d.marketDate) rows.push([d.marketDate, d.price]);
    await pool.query(
      `INSERT INTO byo_indicator (key, date, value)
       SELECT * FROM UNNEST($1::text[], $2::date[], $3::float8[])
       ON CONFLICT (key, date) DO UPDATE SET value = EXCLUDED.value`,
      [rows.map(() => s.key), rows.map(([dt]) => dt), rows.map(([, v]) => round2(v))],
    );
    written += rows.length;
    await new Promise((r) => setTimeout(r, 400)); // 對 Yahoo 客氣一點
  }
  log(`指數更新 ${written} 列`);
  return written;
}

/**
 * 供顯示層取用：回「最新值 + 漲跌 + 走勢」，形狀對齊 Investa 的 index 物件，
 * app 端拿到就能直接填進原本的分組，不必再做一次轉換。
 */
/** 交易日 + 收盤時刻 → ISO 時間戳（見 SERIES.closeUtc 的註解） */
function closeAt(date, closeUtc = 0) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + closeUtc * 3600_000).toISOString();
}

export async function readIndices(pool, sparkN = 30) {
  const { rows } = await pool.query(
    `SELECT key, date, value FROM byo_indicator
      WHERE date >= (CURRENT_DATE - 180) ORDER BY key, date`,
  );
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push([r.date, Number(r.value)]);
  }
  const out = [];
  for (const s of SERIES) {
    const days = byKey.get(s.key);
    if (!days || days.length < 2) continue;
    const price = days[days.length - 1][1];
    const prevClose = days[days.length - 2][1];
    const change = price - prevClose;
    out.push({
      key: s.key,
      ticker: s.key,
      name: s.name,
      group: s.group,
      quote: {
        price: round2(price),
        change: round2(change),
        changePct: round2((change / prevClose) * 100),
        /*
         * 用資料本身的日期，不用 now() —— 前者看得出「停更了幾天」，後者永遠新鮮。
         * 但要加上該市場的**收盤時刻**，不能停在午夜：DATE 直接轉 ISO 會變成
         * 00:00 UTC（台北早上 8 點），讓美股收盤看起來比實際舊 13 小時。
         */
        updatedAt: closeAt(days[days.length - 1][0], s.closeUtc),
      },
      sparkline: days.slice(-sparkN).map(([, v]) => round2(v)),
    });
  }
  return out;
}
