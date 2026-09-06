#!/usr/bin/env node
/**
 * BYO Server 的資料抓取 worker
 *
 * 為什麼要有這支：只把資料庫隔開、抓取仍留在 Investa，等於 Investa 仍在取得
 * 那些沒有開放授權的資料 —— 隔離就沒有意義。要成立，BYO 端必須是**對等的完整機制**：
 * 自己的排程、自己的抓取、自己的資料庫、自己的金鑰。
 *
 * 抓什麼：只抓「沒有開放授權、Investa 不該碰」的那些。
 * 開放資料（政府資料開放平臺）由 Investa 自己抓，這裡不重複。
 *
 * 排程：自己算時間，不引外部排程套件 —— 這支要做的事很少（每天幾次），
 * 引一個 cron 套件反而多一層要維護的東西。以「今天有沒有跑過」為準而不是計時器，
 * 容器重啟才不會漏掉或重複。
 */
import pg from "pg";
import { collectIntraday } from "./intraday.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const FINMIND_TOKEN = process.env.FINMIND_TOKEN || "";
const FINMIND = "https://api.finmindtrade.com/api/v4/data";

const log = (...a) => console.log(`[byo-worker ${new Date().toISOString().slice(11, 19)}]`, ...a);

/** 台北時間的 yyyy-mm-dd */
const twDate = (d = new Date()) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS byo_institutional (
      ticker text NOT NULL, date date NOT NULL, name text NOT NULL,
      buy bigint NOT NULL DEFAULT 0, sell bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (ticker, date, name));
    CREATE INDEX IF NOT EXISTS byo_inst_date ON byo_institutional (date);

    CREATE TABLE IF NOT EXISTS byo_foreign_holding (
      ticker text NOT NULL, date date NOT NULL, holding_ratio double precision,
      PRIMARY KEY (ticker, date));

    CREATE TABLE IF NOT EXISTS byo_lending (
      ticker text NOT NULL, date date NOT NULL, volume double precision,
      PRIMARY KEY (ticker, date));

    CREATE TABLE IF NOT EXISTS byo_job_run (
      job text PRIMARY KEY, last_date date, last_ok_at timestamptz, last_error text);

    -- 回補進度:一天一列。有「抓過但那天沒資料」這種結果,所以不能用
    -- 「資料表裡有沒有那天」當進度 —— 否則非交易日會被無限重試。
    -- 盤中 1 分 K（MIS，C 級明確受規範）
    CREATE TABLE IF NOT EXISTS byo_intraday (
      ticker text NOT NULL, date date NOT NULL, minute text NOT NULL,
      open double precision, high double precision, low double precision, close double precision,
      volume double precision, cum_volume double precision,
      PRIMARY KEY (ticker, date, minute));
    CREATE INDEX IF NOT EXISTS byo_intraday_date ON byo_intraday (date, ticker);

    CREATE TABLE IF NOT EXISTS byo_backfill_day (
      day date PRIMARY KEY, rows_written int NOT NULL DEFAULT 0, done_at timestamptz NOT NULL DEFAULT now());
  `);
}

async function fetchFinMind(dataset, params) {
  const qs = new URLSearchParams({ dataset, ...params });
  const res = await fetch(`${FINMIND}?${qs}`, {
    headers: FINMIND_TOKEN ? { Authorization: `Bearer ${FINMIND_TOKEN}` } : {},
  });
  const j = await res.json();
  /**
   * ⚠️ 配額耗盡(402)必須與「那天沒有資料」分開處理。
   *
   * 實測:回補跑到一半撞到 FinMind 上限,之後每天都回 0 列,
   * 而 0 列被當成「這天沒交易」略過 —— 結果三週的缺口悄悄形成,
   * 直到比對特徵值才發現(5 日累計累的是不連續的日子)。
   * 靜默的缺口比明顯的失敗危險得多。
   */
  if (j.status === 402 || /upper limit/i.test(String(j.msg ?? ""))) {
    const e = new Error(`FinMind 配額已用盡:${j.msg}`);
    e.quotaExhausted = true;
    throw e;
  }
  if (j.status !== 200) throw new Error(`FinMind ${dataset}: ${j.msg ?? res.status}`);
  return j.data ?? [];
}

/**
 * 批次寫入。
 *
 * 用 UNNEST 傳「每欄一個陣列」，而不是每列展開成佔位符：
 *  - 四千列 × 五欄 = 兩萬個佔位符，會撞到 pg 協定的參數上限
 *   （實測錯誤:bind message has 24067 parameter formats but 0 parameters）
 *  - 參數數量固定為欄數，與列數無關
 *
 * 同時**先去重**：同一批裡出現重複主鍵時，ON CONFLICT DO UPDATE 會報
 * "cannot affect row a second time"（實測於借券資料）。後出現的覆蓋先出現的。
 */
async function bulkUpsert(table, cols, types, keyCols, rows) {
  if (rows.length === 0) return 0;
  const seen = new Map();
  for (const r of rows) seen.set(keyCols.map((i) => r[i]).join("|"), r);
  const uniq = Array.from(seen.values());

  const arrays = cols.map((_, i) => uniq.map((r) => r[i]));
  const src = cols.map((_, i) => `$${i + 1}::${types[i]}[]`).join(", ");
  const set = cols
    .filter((_, i) => !keyCols.includes(i))
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");
  await pool.query(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")})
     SELECT * FROM UNNEST(${src})
     ON CONFLICT (${keyCols.map((i) => `"${cols[i]}"`).join(",")}) DO UPDATE SET ${set}`,
    arrays,
  );
  return uniq.length;
}

/**
 * 只留真正的股票代號。
 *
 * FinMind 這個資料集含**權證** —— 實測單日 21,985 檔裡有 19,884 檔是 6 碼權證，
 * 佔九成資料量卻完全用不到（app 不顯示權證，訊號也不篩它）。
 * 台股代號是 4 碼，ETF／TDR 有 5 碼；6 碼以上是權證。
 */
const isStock = (t) => /^[0-9]{4,5}[A-Z]?$/.test(String(t ?? "")) && String(t).length <= 5;

/** 三大法人買賣超（BYO 級：上市明細沒有開放資料版本） */
async function fetchInstitutional(day) {
  const rows = (await fetchFinMind("TaiwanStockInstitutionalInvestorsBuySell", { start_date: day, end_date: day })).filter((r) => isStock(r.stock_id));
  return bulkUpsert(
    "byo_institutional",
    ["ticker", "date", "name", "buy", "sell"],
    ["text", "date", "text", "bigint", "bigint"],
    [0, 1, 2],
    rows.map((r) => [r.stock_id, r.date, r.name, Math.round(Number(r.buy) || 0), Math.round(Number(r.sell) || 0)]),
  );
}

async function fetchForeignHolding(day) {
  const rows = (await fetchFinMind("TaiwanStockShareholding", { start_date: day, end_date: day })).filter((r) => isStock(r.stock_id));
  return bulkUpsert(
    "byo_foreign_holding",
    ["ticker", "date", "holding_ratio"],
    ["text", "date", "float8"],
    [0, 1],
    rows.map((r) => [r.stock_id, r.date, Number(r.ForeignInvestmentSharesRatio) || null]),
  );
}

async function fetchLending(day) {
  const rows = (await fetchFinMind("TaiwanStockSecuritiesLending", { start_date: day, end_date: day })).filter((r) => isStock(r.stock_id));
  return bulkUpsert(
    "byo_lending",
    ["ticker", "date", "volume"],
    ["text", "date", "float8"],
    [0, 1],
    rows.map((r) => [r.stock_id, r.date, Number(r.volume) || null]),
  );
}

/**
 * 由原始表重算特徵。
 *
 * 全部用 SQL 視窗函數算，不拉回 Node ——「外資連買天數」這種累積量在
 * 一百多萬列上逐列處理會慢得離譜，而 SQL 一次掃描就能算完。
 *
 * 只重算最近 N 天：早期的資料不會再變，每次全表重算是浪費。
 * 但連買天數需要更早的歷史才能接續，所以計算視窗比寫入視窗寬。
 */
async function rebuildFeatures(days = 30) {
  const { rowCount } = await pool.query(
    `
    /*
     * 交易日網格 —— 必須先補齊「沒有法人進出的日子」再算視窗。
     *
     * FinMind 對當天完全沒有法人進出的個股**不出列**。直接對現有列開視窗的話，
     * 「5 日累計」會橫跨更多日曆天，「連買天數」更會把空白日直接接起來
     * （實測 1324：接起來算 3 天，實際只有 1 天）。空白日不是「沒發生」，
     * 是「當天淨額 0」—— 那會讓連買中斷，語意完全相反。
     *
     * 交易日直接取資料裡出現過的日期，不必另外維護行事曆；
     * 每檔只從自己第一次出現的日子起算，避免替尚未上市的個股補出假的 0。
     */
    WITH trading_days AS (
      SELECT DISTINCT date FROM byo_institutional
       WHERE date >= (SELECT MAX(date) FROM byo_institutional) - ($1::int + 60)
    ),
    tickers AS (
      SELECT ticker, MIN(date) AS first_seen FROM byo_institutional
       WHERE date >= (SELECT MAX(date) FROM byo_institutional) - ($1::int + 60)
       GROUP BY ticker
    ),
    daily AS (
      SELECT t.ticker, d.date,
             COALESCE(SUM(CASE WHEN i.name LIKE '%Foreign%' OR i.name LIKE '%外資%' THEN i.buy - i.sell END), 0) / 1000.0 AS f_net,
             COALESCE(SUM(CASE WHEN i.name LIKE '%Investment_Trust%' OR i.name LIKE '%投信%' THEN i.buy - i.sell END), 0) / 1000.0 AS t_net
        FROM tickers t
        JOIN trading_days d ON d.date >= t.first_seen
        LEFT JOIN byo_institutional i ON i.ticker = t.ticker AND i.date = d.date
       GROUP BY t.ticker, d.date
    ),
    signed AS (
      SELECT ticker, date, f_net, t_net,
             SIGN(f_net)::int AS f_sign, SIGN(t_net)::int AS t_sign,
             SUM(f_net) OVER w5  AS f5,  SUM(f_net) OVER w20 AS f20,
             SUM(t_net) OVER w5  AS t5,  SUM(t_net) OVER w20 AS t20
        FROM daily
      WINDOW w5  AS (PARTITION BY ticker ORDER BY date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
             w20 AS (PARTITION BY ticker ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
    ),
    lagged AS (
      -- LAG 必須先算在自己的層級 —— Postgres 不允許視窗函數巢狀
      -- (實測:window function calls cannot be nested)
      SELECT s.*,
             LAG(f_sign) OVER wall AS f_prev,
             LAG(t_sign) OVER wall AS t_prev
        FROM signed s
      WINDOW wall AS (PARTITION BY ticker ORDER BY date)
    ),
    grouped AS (
      -- 連續同號分組:方向一改變就開新組。組內序號即為連續天數
      SELECT l.*,
             SUM(CASE WHEN f_sign IS DISTINCT FROM f_prev THEN 1 ELSE 0 END) OVER wall AS f_grp,
             SUM(CASE WHEN t_sign IS DISTINCT FROM t_prev THEN 1 ELSE 0 END) OVER wall AS t_grp
        FROM lagged l
      WINDOW wall AS (PARTITION BY ticker ORDER BY date)
    ),
    streaks AS (
      -- ⚠️ 連買天數是**帶正負號**的(對齊 Investa 的 signStreak):
      -- 正 N = 連買 N 天、負 N = 連賣 N 天、0 = 當天持平。
      -- 只算連買、非買進日回 0 的話,「連賣」這類條件會完全失效。
      SELECT g.*,
             f_sign * ROW_NUMBER() OVER (PARTITION BY ticker, f_grp ORDER BY date) AS f_streak,
             t_sign * ROW_NUMBER() OVER (PARTITION BY ticker, t_grp ORDER BY date) AS t_streak
        FROM grouped g
    ),
    hold AS (
      SELECT ticker, date, holding_ratio,
             holding_ratio - LAG(holding_ratio, 20) OVER (PARTITION BY ticker ORDER BY date) AS chg20
        FROM byo_foreign_holding
       WHERE date >= (SELECT MAX(date) FROM byo_foreign_holding) - ($1::int + 60)
    ),
    lend AS (
      SELECT ticker, date, volume,
             volume - LAG(volume, 5) OVER (PARTITION BY ticker ORDER BY date) AS chg5
        FROM byo_lending
       WHERE date >= (SELECT MAX(date) FROM byo_lending) - ($1::int + 60)
    )
    INSERT INTO byo_feature (ticker, date, "foreignNet5D", "foreignNet20D", "trustNet5D", "trustNet20D",
                             "foreignBuyStreak", "trustBuyStreak", "foreignHoldPct", "foreignHoldChg20Pp", "lendingChg5")
    SELECT s.ticker, s.date, s.f5, s.f20, s.t5, s.t20, s.f_streak, s.t_streak,
           h.holding_ratio, h.chg20, l.chg5
      FROM streaks s
      LEFT JOIN hold h ON h.ticker = s.ticker AND h.date = s.date
      LEFT JOIN lend l ON l.ticker = s.ticker AND l.date = s.date
     WHERE s.date >= (SELECT MAX(date) FROM byo_institutional) - $1::int
    ON CONFLICT (ticker, date) DO UPDATE SET
      "foreignNet5D" = EXCLUDED."foreignNet5D", "foreignNet20D" = EXCLUDED."foreignNet20D",
      "trustNet5D" = EXCLUDED."trustNet5D", "trustNet20D" = EXCLUDED."trustNet20D",
      "foreignBuyStreak" = EXCLUDED."foreignBuyStreak", "trustBuyStreak" = EXCLUDED."trustBuyStreak",
      "foreignHoldPct" = EXCLUDED."foreignHoldPct", "foreignHoldChg20Pp" = EXCLUDED."foreignHoldChg20Pp",
      "lendingChg5" = EXCLUDED."lendingChg5"`,
    [days],
  );

  /**
   * 清掉沒有對應法人資料的孤兒特徵列。
   *
   * 實測(2026-09-06):byo_feature 裡躺著 18,738 筆權證特徵 —— 那是加上 isStock
   * 過濾**之前**跑的第一輪留下的。上面的 INSERT 只會 upsert 現有 ticker,
   * 不會回頭刪除來源已消失的列,所以它們永遠不更新也永遠不消失,
   * 而查詢時看起來就跟正常資料一樣(foreignNet5D 有值)。
   *
   * 來源表已經是唯一真相,所以用「不在來源裡就刪」而不是再寫一次 isStock ——
   * 過濾規則將來若再改,這裡不必跟著改。
   *
   * ⚠️ 比對的是 **ticker** 而不是 ticker+date:上面的網格會刻意為「當天沒有
   * 法人進出」的日子補 0 列,那些列在來源表裡本來就沒有對應。用 ticker+date
   * 比對會把剛補上的列立刻刪掉。
   */
  const { rowCount: orphans } = await pool.query(
    `DELETE FROM byo_feature f
      WHERE f.date >= (SELECT MAX(date) FROM byo_institutional) - $1::int
        AND NOT EXISTS (SELECT 1 FROM byo_institutional i WHERE i.ticker = f.ticker)`,
    [days],
  );
  if (orphans > 0) log(`清除孤兒特徵 ${orphans} 列(來源已無對應法人資料)`);
  return rowCount;
}

async function runDaily(day = twDate()) {
  const parts = [];
  for (const [name, fn] of [
    ["法人", fetchInstitutional],
    ["外資持股", fetchForeignHolding],
    ["借券", fetchLending],
  ]) {
    try {
      parts.push(`${name} ${await fn(day)} 列`);
    } catch (e) {
      // 單一來源失敗不該讓其他來源也不抓 —— 分開記錄,下輪重試
      parts.push(`${name} 失敗(${e.message})`);
      await pool.query(
        `INSERT INTO byo_job_run (job, last_error) VALUES ($1,$2)
         ON CONFLICT (job) DO UPDATE SET last_error = EXCLUDED.last_error`,
        [name, String(e.message).slice(0, 300)],
      );
    }
  }
  const n = await rebuildFeatures();
  parts.push(`特徵重算 ${n} 列`);
  await pool.query(
    `INSERT INTO byo_job_run (job, last_date, last_ok_at, last_error) VALUES ('daily',$1,now(),NULL)
     ON CONFLICT (job) DO UPDATE SET last_date = EXCLUDED.last_date, last_ok_at = now(), last_error = NULL`,
    [day],
  );
  log(`${day}:`, parts.join(" / "));
}

// ── CLI ─────────────────────────────────────────────
await ensureSchema();
if (process.argv[2] === "--once") {
  await runDaily(process.argv[3] || twDate());
  await pool.end();
  process.exit(0);
}
/**
 * 回補一段期間。
 *
 * 沒有歷史就算不出 5/20 日累計與連買天數 —— 只有一天資料時,
 * 「5 日累計」實際只累了一天,數值會與 Investa 差很多(實測 2330:1885 vs -9886)。
 * 逐日抓,每日之間留間隔避免打爆對方。
 */
if (process.argv[2] === "--backfill") {
  const days = Number(process.argv[3] || 90);
  const end = new Date(process.argv[4] || twDate());
  for (let i = days; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86400_000);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // 週末沒有交易資料,不必浪費請求
    try {
      const a = await fetchInstitutional(iso);
      const b = await fetchForeignHolding(iso);
      const c = await fetchLending(iso);
      if (a + b + c > 0) log(`${iso}: 法人 ${a} / 外資持股 ${b} / 借券 ${c}`);
    } catch (e) {
      log(`${iso} 失敗:`, e.message);
      // 配額耗盡就停 —— 繼續打只會把剩下的日子全部標成失敗,
      // 而且對方會一直拒絕。停下來讓人知道要等配額重置
      if (e.quotaExhausted) {
        log("配額已用盡,中止回補。等配額重置後再跑一次即可從缺口接續");
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const n = await rebuildFeatures(days + 10);
  log(`回補完成,特徵重算 ${n} 列`);
  await pool.end();
  process.exit(0);
}

if (process.argv[2] === "--rebuild") {
  const n = await rebuildFeatures(Number(process.argv[3] || 30));
  log(`特徵重算 ${n} 列`);
  await pool.end();
  process.exit(0);
}

/**
 * 歷史自動回補 —— 讓「啟用後會自動爬資料」成立。
 *
 * 沒有這一段的話,全新部署只會從當天開始累積:個股頁的副圖只有一個點、
 * /match 回測沒有可用區間。而使用者不會知道要去下 `--backfill`,
 * 他只會看到一個「裝好了但沒東西」的伺服器 —— 那和壞掉沒有分別。
 *
 * 設計:
 *   - 進度記在 byo_backfill_day,重啟後接續,不重抓
 *   - 配額耗盡就停,不標記進度,下一輪(或明天配額重置後)自然接上
 *   - 在背景跑,不擋每日排程 —— 首次回補要好幾天配額才補得完三年
 *   - 由舊往新補:先有連續的早期資料,累計與連買天數才算得準
 */
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 1095); // 預設三年
const BACKFILL_SLEEP_MS = Number(process.env.BACKFILL_SLEEP_MS || 400);
/**
 * 每輪最多補幾天 —— 用來避免一次吃光 FinMind 的當日配額。
 *
 * ⚠️ 如果這把 token 和別的服務共用,那個服務隔天早上會抓不到東西,
 * 而且失敗的樣子是「資料沒更新」,不會有人立刻聯想到是被這裡吃掉的。
 * **強烈建議替這台申請一把自己的 token** —— 它本來就該有自己的憑證。
 */
const BACKFILL_MAX_PER_RUN = Number(process.env.BACKFILL_MAX_PER_RUN || 40);
let backfilling = false;

async function autoBackfill() {
  if (backfilling) return;
  backfilling = true;
  try {
    const today = new Date(twDate());
    const todo = [];
    /*
     * ⚠️ 由**新往舊**補,不是由舊往新。
     *
     * 補到一半撞到配額是常態(三年 ≈ 2,200 次請求,遠超單日上限),所以順序決定了
     * 中斷時手上是什麼:
     *   由舊往新 → 早期一塊 + 近期一塊,中間一個洞。5 日/20 日累計會橫跨那個洞,
     *              算出來的數字看起來正常但是錯的。
     *   由新往舊 → 永遠是一段「到今天為止的連續區間」,只是比較短。
     * 短而正確,勝過長而中間破洞 —— 破洞不會有任何徵兆。
     */
    for (let i = 1; i <= BACKFILL_DAYS; i++) {
      const d = new Date(today.getTime() - i * 86400_000);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; // 週末沒有交易
      todo.push(d.toISOString().slice(0, 10));
    }
    const { rows } = await pool.query(`SELECT day FROM byo_backfill_day`);
    const done = new Set(rows.map((r) => new Date(r.day).toISOString().slice(0, 10)));
    const pending = todo.filter((d) => !done.has(d)).slice(0, BACKFILL_MAX_PER_RUN);
    const remain = todo.filter((d) => !done.has(d)).length;
    if (pending.length === 0) return;

    log(`歷史回補:本輪 ${pending.length} 天(還剩 ${remain - pending.length} 天;共 ${todo.length} 個交易日)`);
    let n = 0;
    for (const iso of pending) {
      try {
        const a = await fetchInstitutional(iso);
        const b = await fetchForeignHolding(iso);
        const c = await fetchLending(iso);
        await pool.query(
          `INSERT INTO byo_backfill_day (day, rows_written) VALUES ($1,$2)
             ON CONFLICT (day) DO UPDATE SET rows_written = EXCLUDED.rows_written, done_at = now()`,
          [iso, a + b + c],
        );
        n++;
        if (n % 50 === 0) log(`歷史回補:已完成 ${n}/${pending.length}`);
      } catch (e) {
        if (e.quotaExhausted) {
          log(`歷史回補:配額用盡,已補 ${n} 天,等重置後自動接續(還剩 ${pending.length - n} 天)`);
          return;
        }
        log(`歷史回補 ${iso} 失敗(不記進度,之後重試):`, e.message);
      }
      await new Promise((r) => setTimeout(r, BACKFILL_SLEEP_MS));
    }
    log(`歷史回補:本輪完成 ${n} 天`);
    await rebuildFeatures(BACKFILL_DAYS);
  } finally {
    backfilling = false;
  }
}

/**
 * 常駐排程。以「今天有沒有跑過」判斷而不是計時器 ——
 * 容器重啟後計時器歸零，用日期比對才不會漏掉或重複跑。
 */
const RUN_HOURS_TW = [17, 19, 21]; // 盤後陸續公布，跑三輪補齊
log("worker started");

// 啟動就開始補歷史(背景);配額用盡會自己停,每小時再試一次接續
autoBackfill().catch((e) => log("歷史回補異常:", e.message));
setInterval(() => autoBackfill().catch((e) => log("歷史回補異常:", e.message)), 3600_000);

/**
 * 盤中 1 分 K:每分鐘一輪(自己判斷是否在盤中時段)。
 *
 * 不與歷史回補搶:一個打 MIS、一個打 FinMind,互不相干。
 * 用 setInterval 而不是對齊整分:MIS 是連續揭示,起點差幾秒不影響那一分鐘的聚合,
 * 而對齊整分要多一層計時邏輯,容器重啟後還會失準。
 */
let intradayBusy = false;
setInterval(async () => {
  if (intradayBusy) return; // 一輪要 ~25 秒,重疊會讓兩輪互相覆寫量能差分
  intradayBusy = true;
  try {
    await collectIntraday(pool);
  } catch (e) {
    log("盤中收集異常:", e.message);
  } finally {
    intradayBusy = false;
  }
}, 60_000);
setInterval(async () => {
  try {
    const now = new Date(Date.now() + 8 * 3600_000);
    if (!RUN_HOURS_TW.includes(now.getUTCHours()) || now.getUTCMinutes() !== 5) return;
    const today = twDate();
    const { rows } = await pool.query(`SELECT last_date FROM byo_job_run WHERE job = 'daily'`);
    const last = rows[0]?.last_date ? new Date(rows[0].last_date).toISOString().slice(0, 10) : null;
    // 同一天已經跑過仍要再跑：盤後資料是分批公布的，後面幾輪是為了補齊
    await runDaily(today);
    if (last !== today) log(`(當日首次)`);
  } catch (e) {
    log("排程失敗:", e.message);
  }
}, 60_000);
