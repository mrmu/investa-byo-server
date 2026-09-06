/**
 * 加權／櫃買指數的**完整**日 K 歷史 —— 由這台供應
 *
 * 為什麼在這裡而不是 Investa：來源是證交所／櫃買的**網站端點**
 * （B 級官方非開放），不是政府資料開放平臺登記的資料集。
 *   加權 www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=YYYYMM01
 *   櫃買 www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=民國年/月
 * 兩者都按**月**回一整個月，所以歷史拿得回來。
 *
 * Investa 那邊改成只累積 data.gov.tw 登記的開放版本（每天 4 筆，無法回溯），
 * 圖會從短慢慢變長。這台則從 2018 補起 —— 這正是自訂資料源存在的意義：
 * **開放授權的集合本來就有缺口，由使用者自己的伺服器補完整。**
 *
 * ⚠️ 連打幾十個月會被 rwd 限流，而限流回的是**空殼而不是錯誤**
 * （`stat` 不是 OK、data 為空）。不特別處理的話會靜默寫入 0 列，
 * 看起來就像「那個月沒有交易日」。所以空回應要當失敗、要重試。
 */

import { httpGetJson } from "./http-get.mjs";

const UA = { "User-Agent": "Mozilla/5.0 (byo-worker)" };
const log = (...a) => console.log(`[byo-index-hist ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MONTH_GAP_MS = 1200; // 對 rwd 客氣一點；太快就會拿到空殼

const numOf = (s) => {
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 民國 "115/09/04" → "2026-09-04" */
function rocToIso(s) {
  const m = String(s).trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}

async function fetchTaiexMonth(ym) {
  const url = `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${ym.replace("-", "")}01&response=json`;
  const j = await httpGetJson(url, { headers: UA });
  if (j.stat !== "OK" || !Array.isArray(j.data) || j.data.length === 0) {
    // 空殼 = 多半是限流。丟例外讓呼叫端重試，不要當成「該月無資料」
    throw new Error(`加權 ${ym} 空回應(stat=${j.stat ?? "?"})，疑似限流`);
  }
  const out = [];
  for (const r of j.data) {
    const iso = rocToIso(r[0]);
    const [o, h, l, c] = [numOf(r[1]), numOf(r[2]), numOf(r[3]), numOf(r[4])];
    if (iso && o && h && l && c) out.push({ iso, open: o, high: h, low: l, close: c });
  }
  return out;
}

async function fetchTpexMonth(ym) {
  const [y, m] = ym.split("-");
  const url = `https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=${Number(y) - 1911}/${m}&response=json`;
  const j = await httpGetJson(url, { headers: UA });
  const rows = j.tables?.[0]?.data ?? [];
  if (rows.length === 0) throw new Error(`櫃買 ${ym} 空回應，疑似限流`);
  const out = [];
  for (const r of rows) {
    // 櫃買這支回的是西元 yyyy/mm/dd，與加權的民國格式不同
    const mm = String(r[0]).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    const [o, h, l, c] = [numOf(r[1]), numOf(r[2]), numOf(r[3]), numOf(r[4])];
    if (mm && o && h && l && c) out.push({ iso: `${mm[1]}-${mm[2]}-${mm[3]}`, open: o, high: h, low: l, close: c });
  }
  return out;
}

function monthsBack(n) {
  const out = [];
  const now = new Date(Date.now() + 8 * 3600_000);
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out; // 由新到舊
}

/**
 * @param months 往回抓幾個月（預設 96 ≈ 8 年）
 * @param onlyMissing 只抓「還沒有資料」的月份（每日更新用；回補用 false）
 */
export async function collectIndexHistory(pool, { months = 96, onlyMissing = true, maxPerRun = 12 } = {}) {
  const { rows: have } = await pool.query(
    `SELECT index_code, to_char(date, 'YYYY-MM') AS ym, count(*) AS n
       FROM byo_index_history GROUP BY 1, 2`,
  );
  const haveBy = new Set(have.map((r) => `${r.index_code}|${r.ym}`));

  let written = 0;
  let done = 0;
  // 由新到舊 —— 中斷時手上永遠是一段「到今天為止」的連續區間
  for (const ym of monthsBack(months)) {
    for (const [code, fn] of [["TAIEX", fetchTaiexMonth], ["TPEX", fetchTpexMonth]]) {
      // 當月一定要重抓（月中每天都在長）；其餘月份有了就跳過
      const isCurrent = ym === monthsBack(1)[0];
      if (onlyMissing && !isCurrent && haveBy.has(`${code}|${ym}`)) continue;
      if (done >= maxPerRun) return { written, done, more: true };
      try {
        const bars = await fn(ym);
        if (bars.length > 0) {
          await pool.query(
            `INSERT INTO byo_index_history (index_code, date, open, high, low, close)
             SELECT * FROM UNNEST($1::text[], $2::date[], $3::float8[], $4::float8[], $5::float8[], $6::float8[])
             ON CONFLICT (index_code, date) DO UPDATE SET
               open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close`,
            [
              bars.map(() => code),
              bars.map((b) => b.iso),
              bars.map((b) => b.open),
              bars.map((b) => b.high),
              bars.map((b) => b.low),
              bars.map((b) => b.close),
            ],
          );
          written += bars.length;
        }
      } catch (e) {
        log(`${code} ${ym}:`, e.message);
      }
      done++;
      await sleep(MONTH_GAP_MS);
    }
  }
  log(`指數歷史寫入 ${written} 列（處理 ${done} 個月份）`);
  return { written, done, more: false };
}

/** 供顯示層取用：單一指數的日 K */
export async function readIndexHistory(pool, code, days = 520) {
  const { rows } = await pool.query(
    `SELECT date, open, high, low, close FROM byo_index_history
      WHERE index_code = $1 ORDER BY date DESC LIMIT $2`,
    [String(code || "").toUpperCase(), Math.min(Math.max(Number(days) || 520, 30), 2600)],
  );
  return rows
    .map((r) => ({
      t: new Date(r.date).toISOString().slice(0, 10),
      o: Number(r.open),
      h: Number(r.high),
      l: Number(r.low),
      c: Number(r.close),
      v: 0, // 這兩支官方端點不含成交金額；給 0 而不是 null，圖表的量能軸自然不畫
    }))
    .reverse();
}
