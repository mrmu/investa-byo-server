#!/usr/bin/env node
/**
 * 產業細分類 —— BYO 端的抓取與供應
 *
 * 為什麼在這裡而不是 Investa:產業細分類的來源頁面有內容著作權(七級分類的 F 級),
 * 沒有可散布的授權。Investa 端內建它等於把別人的分類體系一起散布出去 ——
 * 所以它跟法人明細、盤中報價同一個歸屬:**使用者自己的伺服器抓、裝置直連取用**。
 *
 * 交易所的官方產業別(電子工業、化學工業…)是開放資料,Investa 仍然供應;
 * app 端的規則是「有自訂來源就用自訂來源的細分類,沒有就退回官方分類」。
 *
 * 抓法沿用 Investa 那支腳本的解析邏輯(同一個來源、同樣的兩層結構),
 * 但改成**不落檔、直接寫進資料庫**,而且不外呼 curl/iconv ——
 * 容器裡不保證有那兩支;Node 自己的 fetch + TextDecoder("big5") 就夠了。
 *
 * 一檔股票可能同時屬於多個子類(台泥:水泥、預拌混凝土、電力…),
 * 所以 label 取**第一個子類**當顯示用,完整歸屬另存 jsonb ——
 * 清單上一列只放得下一個詞,而挑第一個比擠三個好讀。
 */
const LIST_JS = "https://www.moneydj.com/z/js/IndustryListNewJS.djjs";
const SUB_PAGE = (id) => `https://www.moneydj.com/z/zh/zha/ZH00.djhtm?A=${id}`;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const DELAY_MS = 600; // 對來源客氣一點:一頁一頁慢慢拿,不要打人家
const MAX_RETRY = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBig5(url) {
  for (let i = 1; i <= MAX_RETRY; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const text = new TextDecoder("big5").decode(buf);
      if (text.length > 100) return text;
      throw new Error(`回應過短(${text.length} 字元)`);
    } catch (e) {
      if (i === MAX_RETRY) throw e;
      await sleep(1500 * i);
    }
  }
}

/** 主類/子類的樹狀結構藏在一支 js 變數裡:"C9110000 水泥類~C011010 水泥,C011011 水泥製品;..." */
function parseCategories(js) {
  const m = js.match(/NewkindIDNameStr\s*=\s*'([^']+)'/);
  if (!m) throw new Error("找不到 NewkindIDNameStr —— 來源頁面格式可能變了");
  return m[1]
    .split(";")
    .filter(Boolean)
    .map((blk) => {
      const [head, tail] = blk.split("~");
      const h = head.trim();
      const sp = h.indexOf(" ");
      const subs = (tail || "")
        .split(",")
        .filter(Boolean)
        .map((s) => {
          const t = s.trim();
          const sp2 = t.indexOf(" ");
          return { id: t.slice(0, sp2), name: t.slice(sp2 + 1) };
        });
      return { id: h.slice(0, sp), name: h.slice(sp + 1), subs };
    });
}

/** 同業列表頁裡每檔股票都是一個 Link2Stk('AS2330') 連結,顯示文字是 "2330台積電" */
function parsePeers(html) {
  const out = new Map();
  const re = /Link2Stk\('AS([A-Za-z0-9]+)'\)[^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const ticker = m[1];
    if (out.has(ticker)) continue;
    const display = m[2].trim();
    out.set(ticker, display.startsWith(ticker) ? display.slice(ticker.length) : display);
  }
  return [...out.entries()].map(([ticker, name]) => ({ ticker, name }));
}

export async function ensureIndustrySchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS byo_industry (
      ticker     text PRIMARY KEY,
      name       text,
      label      text NOT NULL,
      mains      jsonb NOT NULL DEFAULT '[]'::jsonb,
      subs       jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
}

/**
 * 重抓整份分類並覆寫。
 *
 * 失敗策略:任一子類抓失敗只記數、繼續 —— 一頁壞掉不該讓整份分類消失。
 * 但**整份都失敗就不寫**:寧可留著上一次的資料,也不要把表清空成空白。
 */
export async function refreshIndustry(pool, { limit = 0, log = console.log } = {}) {
  await ensureIndustrySchema(pool);
  const cats = parseCategories(await fetchBig5(LIST_JS));
  const totalSub = cats.reduce((n, c) => n + (limit ? Math.min(limit, c.subs.length) : c.subs.length), 0);
  log(`產業細分類:${cats.length} 個主類、${totalSub} 個子類`);

  const byTicker = new Map(); // ticker → { name, mains:Map, subs:Map }
  let done = 0;
  let failed = 0;
  for (const main of cats) {
    for (const sub of limit ? main.subs.slice(0, limit) : main.subs) {
      done++;
      try {
        for (const s of parsePeers(await fetchBig5(SUB_PAGE(sub.id)))) {
          if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, { name: s.name, mains: new Map(), subs: new Map() });
          const rec = byTicker.get(s.ticker);
          rec.mains.set(main.id, main.name);
          rec.subs.set(sub.id, sub.name);
        }
      } catch (e) {
        failed++;
        log(`  子類 ${sub.name}(${sub.id}) 抓取失敗:${e.message}`);
      }
      if (done % 100 === 0) log(`  ${done}/${totalSub}`);
      await sleep(DELAY_MS);
    }
  }
  if (byTicker.size === 0) throw new Error("一檔都沒抓到 —— 不覆寫,保留上一次的資料");

  const rows = [...byTicker.entries()].map(([ticker, v]) => {
    const mains = [...v.mains].map(([id, name]) => ({ id, name }));
    const subs = [...v.subs].map(([id, name]) => ({ id, name }));
    // 清單一列只放得下一個詞:優先用第一個子類(最細),沒有子類才退到主類
    return { ticker, name: v.name, label: subs[0]?.name ?? mains[0]?.name ?? "", mains, subs };
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(
        `INSERT INTO byo_industry (ticker, name, label, mains, subs, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb, now())
         ON CONFLICT (ticker) DO UPDATE SET
           name = EXCLUDED.name, label = EXCLUDED.label,
           mains = EXCLUDED.mains, subs = EXCLUDED.subs, updated_at = now()`,
        [r.ticker, r.name, r.label, JSON.stringify(r.mains), JSON.stringify(r.subs)],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  log(`產業細分類:寫入 ${rows.length} 檔(${failed} 個子類失敗)`);
  return { tickers: rows.length, failedSubs: failed };
}

// CLI:手動重抓(第一次建資料、或來源改版後驗證用)
//   docker compose exec byoworker node industry.mjs [--limit=2]
if (process.argv[1] && process.argv[1].endsWith("industry.mjs")) {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const limit = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || 0;
  await refreshIndustry(pool, { limit });
  await pool.end();
}
