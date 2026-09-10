/**
 * 台指期夜盤收盤快照 —— 期交所 MIS 行情
 *
 * 為什麼在 BYO(2026-09-10):開放資料(dataset 11319)標記日 D 的檔案要等 D 的
 * **日盤收完**才發布,而標記 D 的夜盤是 D-1 15:00 ~ D 05:00 —— 早盤前拿得到的
 * 永遠是「前一晚的前一晚」,固定落後一個時段(Investa `fetch-futures-open` 的
 * docblock 有完整實測)。夜盤的全部價值就在「開盤前看昨夜」,慢一天等於沒有價值。
 * MIS 即時行情不在開放授權內、不可散布 —— 正是自訂資料源的定位。
 *
 * 使用情境只有一個:開盤前看昨夜收盤。所以**每天 06:00 後抓一次**就夠,
 * 不在夜盤時段輪詢。抓取窗口限 06:00–14:59 台北:過了 15:00 新夜盤已開始交易,
 * MarketType=1 回的是進行中的新時段,再抓會把「昨夜收盤」蓋成盤中價。
 *
 * 漲跌口徑:MIS 的 CDiff/CDiffRate 是相對 CRefPrice(前一日盤結算的參考價),
 * 與看盤軟體顯示的夜盤漲跌一致。**不能**改拿前一夜收盤自己算 —— 那是另一個口徑,
 * 數字會對不上任何看盤軟體,而且看起來完全正常。
 */

const MIS_URL = "https://mis.taifex.com.tw/futures/api/getQuoteList";
const log = (...a) => console.log(`[byo-futures ${new Date().toISOString().slice(11, 19)}]`, ...a);

const round2 = (n) => Math.round(n * 100) / 100;

async function fetchMisNight() {
  const res = await fetch(MIS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0",
      referer: "https://mis.taifex.com.tw/futures/",
    },
    body: JSON.stringify({
      MarketType: "1", // 盤後(夜盤)時段
      SymbolType: "F",
      MarketCode: "0",
      KindID: "1",
      CID: "TXF",
      ExpireMonth: "",
      RowSize: "全部",
      PageNo: "",
      SortColumn: "",
      AscDesc: "A",
    }),
  });
  const j = await res.json();
  if (String(j.RtCode) !== "0") throw new Error(`MIS RtCode ${j.RtCode}: ${j.RtMsg}`);
  const list = (j.RtData?.QuoteList ?? []).filter(
    // 排除「臺指現貨」參考列(TXF-P);近月 = 成交量最大的那口。
    // 不用到期月碼推算 —— 結算日前後誰是近月的規則比一個 max 髒得多。
    (q) => String(q.SymbolID).startsWith("TXF") && !String(q.SymbolID).includes("-P") && Number(q.CLastPrice) > 0,
  );
  const near = list.sort((a, b) => Number(b.CTotalVolume || 0) - Number(a.CTotalVolume || 0))[0];
  if (!near) throw new Error("MIS 回應裡沒有可用的 TXF 合約");
  return near;
}

/** 每天一次:寫收盤快照(漲跌用 MIS 口徑)+ 累積日收盤(sparkline 用) */
export async function collectNightFutures(pool) {
  const q = await fetchMisNight();
  const d = String(q.CDate); // yyyymmdd,夜盤標記為「次一交易日」
  const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  // CDate/CTime 是最後成交的台北時間;收盤後抓到的就是收盤那筆
  const t = String(q.CTime || "050000").padStart(6, "0");
  const quoteAt = `${date}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+08:00`;

  await pool.query(
    `INSERT INTO byo_futures_quote (key, price, change, change_pct, quote_at, fetched_at)
     VALUES ('TX_AH', $1, $2, $3, $4, now())
     ON CONFLICT (key) DO UPDATE SET
       price = EXCLUDED.price, change = EXCLUDED.change, change_pct = EXCLUDED.change_pct,
       quote_at = EXCLUDED.quote_at, fetched_at = now()`,
    [Number(q.CLastPrice), Number(q.CDiff), Number(q.CDiffRate), quoteAt],
  );
  // 日收盤也留一份 —— sparkline 從零開始逐日累積(開放資料的舊歷史在 Investa 那邊,
  // 兩邊資料庫刻意分離,不搬)
  await pool.query(
    `INSERT INTO byo_indicator (key, date, value) VALUES ('TX_AH', $1, $2)
     ON CONFLICT (key, date) DO UPDATE SET value = EXCLUDED.value`,
    [date, round2(Number(q.CLastPrice))],
  );
  log(`夜盤快照:${q.SymbolID} 收 ${q.CLastPrice}(${q.CDiff} / ${q.CDiffRate}%),時點 ${quoteAt}`);
}

/**
 * 顯示層:形狀對齊 app 端 ByoIndex,併進 /indices 回應。
 * `group` 必須逐字等於 app 分組標題「台股」—— app 是字串完全比對後
 * 再按 ticker 覆蓋佔位項,寫錯就是靜默失敗。還沒抓到之前回空陣列。
 */
export async function readNightFutures(pool, sparkN = 30) {
  const { rows } = await pool.query(`SELECT price, change, change_pct, quote_at FROM byo_futures_quote WHERE key = 'TX_AH'`);
  if (rows.length === 0 || rows[0].price == null) return [];
  const r = rows[0];
  const { rows: hist } = await pool.query(
    `SELECT value FROM byo_indicator WHERE key = 'TX_AH' ORDER BY date DESC LIMIT $1`,
    [sparkN],
  );
  return [
    {
      key: "TX_AH",
      ticker: "TX_AH",
      name: "台指期夜盤",
      group: "台股",
      quote: {
        price: r.price,
        change: r.change,
        changePct: r.change_pct,
        updatedAt: r.quote_at instanceof Date ? r.quote_at.toISOString() : String(r.quote_at ?? ""),
      },
      sparkline: hist.map((h) => Number(h.value)).reverse(),
    },
  ];
}
