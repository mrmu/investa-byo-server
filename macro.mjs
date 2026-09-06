/**
 * 受限總經指標 —— 由這台供應，Investa 不碰
 *
 * 四項：
 *   FEAR_GREED  CNN 恐懼與貪婪指數   FinMind（D 級契約約束）
 *   USDTWD      美元/台幣匯率        FinMind
 *   TW_LIGHT    台灣景氣燈號         FinMind
 *   DXY         美元指數             Yahoo（E 級；已由 indices.mjs 抓進 byo_indicator）
 *
 * 門檻與燈號判定是從 Investa 的 `worker/lib/macro-shared.ts` 移植的。
 * 為什麼判定要放這裡而不是回原始值讓 Investa 算：Investa 拿不到這些值 ——
 * 資料是裝置直連取得的，不經過我方伺服器。把值送去給它算，就等於讓資料
 * 經過我方，那正是整個架構要避免的事。
 *
 * ⚠️ 門檻數字要與 Investa 的那份保持一致。不一致的話同一個指標在
 * 開／關自訂資料源時會顯示不同的燈號 —— 而使用者只會覺得「怪怪的」，
 * 不會知道是兩份門檻在打架。
 */

import { httpGetJson } from "./http-get.mjs";

const FINMIND = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_TOKEN = process.env.FINMIND_TOKEN || "";
const log = (...a) => console.log(`[byo-macro ${new Date().toISOString().slice(11, 19)}]`, ...a);

/** 與 Investa 的 MACRO_INDICATORS 對齊（2026-09-06 移植） */
export const MACRO = {
  FEAR_GREED: {
    label: "恐懼與貪婪指數",
    unit: "",
    freq: "日更",
    maxLagDays: 4,
    evaluate: (v) => (v <= 25 ? "RED" : v <= 45 ? "YELLOW" : "GREEN"),
  },
  DXY: {
    label: "美元指數 DXY",
    unit: "",
    freq: "日更",
    maxLagDays: 4,
    // 校正為 ICE DX-Y.NYB 規模（歷史 95-115 區間；>100 強勢）
    evaluate: (v) => (v >= 106 ? "RED" : v >= 100 ? "YELLOW" : "GREEN"),
  },
  USDTWD: {
    label: "美元/台幣匯率",
    unit: "TWD",
    freq: "日更",
    maxLagDays: 6,
    evaluate: (v, prev) =>
      v >= 33 ? "RED" : v >= 32 || (prev && (v - prev) / prev > 0.01) ? "YELLOW" : "GREEN",
  },
  TW_LIGHT: {
    label: "台灣景氣燈號",
    unit: "分",
    freq: "月更・次月27日發布",
    maxLagDays: 90,
    // 兩端都算 YELLOW：過熱與過冷都是風險
    evaluate: (v) => (v <= 16 ? "RED" : v <= 22 || v >= 38 ? "YELLOW" : "GREEN"),
  },
};

async function finmind(dataset, params) {
  const qs = new URLSearchParams({ dataset, ...params, token: FINMIND_TOKEN });
  const j = await httpGetJson(`${FINMIND}?${qs}`);
  // 配額耗盡必須與「沒有資料」分開 —— 混在一起會讓缺口靜默形成
  if (j.status === 402 || /upper limit/i.test(String(j.msg ?? ""))) {
    const e = new Error(`FinMind 配額已用盡:${j.msg}`);
    e.quotaExhausted = true;
    throw e;
  }
  if (j.status !== 200) throw new Error(`FinMind ${dataset}: ${j.msg ?? "?"}`);
  return j.data ?? [];
}

/** 每日一輪：抓三個 FinMind 序列寫進 byo_indicator（DXY 由 indices.mjs 負責） */
export async function collectMacro(pool) {
  const since = new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 10);
  const jobs = [
    ["USDTWD", "TaiwanExchangeRate", { data_id: "USD", start_date: since },
      (d) => ({ date: d.date, value: d.cash_buy || d.spot_buy })],
    ["FEAR_GREED", "CnnFearGreedIndex", { start_date: since },
      (d) => ({ date: d.date, value: d.fear_greed })],
    // 景氣燈號是月更,要往回拉兩年才看得到趨勢
    ["TW_LIGHT", "TaiwanBusinessIndicator",
      { start_date: new Date(Date.now() - 730 * 86400_000).toISOString().slice(0, 10) },
      (d) => ({ date: d.date, value: d.monitoring })],
  ];

  let total = 0;
  for (const [key, dataset, params, map] of jobs) {
    try {
      const rows = (await finmind(dataset, params))
        .map(map)
        .filter((r) => r.date && Number.isFinite(Number(r.value)) && Number(r.value) > 0);
      if (rows.length === 0) {
        log(`${key}: 無資料`);
        continue;
      }
      await pool.query(
        `INSERT INTO byo_indicator (key, date, value)
         SELECT * FROM UNNEST($1::text[], $2::date[], $3::float8[])
         ON CONFLICT (key, date) DO UPDATE SET value = EXCLUDED.value`,
        [rows.map(() => key), rows.map((r) => r.date), rows.map((r) => Number(r.value))],
      );
      total += rows.length;
    } catch (e) {
      if (e.quotaExhausted) {
        log("配額已用盡,本輪停止(下輪自動接續)");
        return total;
      }
      log(`${key} 失敗:`, e.message);
    }
  }
  log(`總經更新 ${total} 列`);
  return total;
}

/**
 * 供顯示層取用：形狀對齊 Investa 的 MacroIndicator，
 * app 端拿到直接併進原本的清單即可。
 */
export async function readMacro(pool) {
  const keys = Object.keys(MACRO);
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (key) key, date, value FROM byo_indicator
      WHERE key = ANY($1) ORDER BY key, date DESC`,
    [keys],
  );
  const prevRows = await pool.query(
    `SELECT key, date, value FROM byo_indicator WHERE key = ANY($1) ORDER BY key, date DESC`,
    [keys],
  );
  const prevBy = new Map();
  for (const r of prevRows.rows) {
    const arr = prevBy.get(r.key) ?? [];
    if (arr.length < 2) arr.push(Number(r.value));
    prevBy.set(r.key, arr);
  }

  const out = [];
  for (const r of rows) {
    const cfg = MACRO[r.key];
    if (!cfg) continue;
    const value = Number(r.value);
    const prev = (prevBy.get(r.key) ?? [])[1] ?? null;
    const sig = cfg.evaluate(value, prev);
    const asOf = new Date(r.date).toISOString().slice(0, 10);
    const lagDays = (Date.now() - new Date(r.date).getTime()) / 86400_000;
    const v = Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(2).replace(/\.?0+$/, "");
    out.push({
      key: r.key.toLowerCase(),
      name: cfg.label,
      value: cfg.unit === "%" ? `${v}%` : `${v}${cfg.unit ? ` ${cfg.unit}` : ""}`,
      status: sig === "RED" ? "danger" : sig === "YELLOW" ? "watch" : "ok",
      asOf,
      freq: cfg.freq,
      // stale = 超過該序列的合理發布延遲 → 這才是「排程可能掛了」的訊號，
      // 而不是把制度性延遲（景氣燈號次月才發布）也標成異常
      staleness: lagDays > cfg.maxLagDays ? "stale" : "fresh",
    });
  }
  return out;
}
