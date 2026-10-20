/**
 * 預測市場（Polymarket）追蹤清單 —— **要增減事件就改這一個檔**
 *
 * 每一項：
 *   slug      Polymarket 事件網址最後那段（gamma-api.polymarket.com/events?slug=<slug>）
 *   title     顯示用的繁中標題
 *   category  分組（順序見 CATEGORY_ORDER；新分類要加進去，不然排在最後）
 *   hint      （選填）與台股的關聯，一句話，給「為什麼要看這個」的脈絡，不下結論
 *   sort      （選填）多選項事件的排序："prob"（機率高到低，預設）或 "threshold"
 *             （照事件本身的級距：降息次數、利率落點、日期等有順序的選項）
 *   include   （選填）只收這些選項（groupItemTitle 原文）—— 選項很多但只有幾個跟台股有關時用
 *   labels    （選填）選項的繁中名稱 { 原文: 中文 }；沒列的會走 predictions.mjs 的通用翻譯，再不行就顯示原文
 *
 * 選事件的原則：與台股有傳導路徑（利率、兩岸、AI 資本支出、美國景氣）、
 * 而且事件總成交量夠大（> 10 萬美元）—— 太薄的市場機率很容易被少數人推動，
 * 看起來是「市場共識」，其實只是一兩筆單。
 *
 * ⚠️ **絕對不要加入台灣選舉相關的市場**（總統、立委、縣市長、公投……）。
 * 在台灣對選舉結果下注本身違法（公職人員選舉罷免法／刑法賭博罪），
 * 就算只是「看機率」，把它做成功能也是在替違法賭盤導流。
 * 其他國家的選舉也不收 —— 跟台股的傳導太間接，不值得冒誤解的風險。
 *
 * 2026-10-20 建立清單時，每個 slug 都以 Gamma API 驗證過仍在交易、事件成交量 > 10 萬美元。
 * slug 失效（事件下架或改名）時 worker 會記錄錯誤並保留最後一次的值，不會讓整輪失敗。
 */

export const CATEGORY_ORDER = ["央行利率", "兩岸地緣", "美國經濟", "AI 與科技"];

/** Fed 決策類選項的共通翻譯（10 月、12 月兩個事件共用） */
const FED_DECISION_LABELS = {
  "No change": "利率不變",
  "25 bps increase": "升息 1 碼（25bp）",
  "50+ bps increase": "升息 2 碼以上（50bp+）",
  "25 bps decrease": "降息 1 碼（25bp）",
  "50+ bps decrease": "降息 2 碼以上（50bp+）",
};

export const PREDICTION_EVENTS = [
  // ── 央行利率 ─────────────────────────────────────────
  {
    slug: "fed-decision-in-october-20260617190323537",
    title: "聯準會 10 月利率決策",
    category: "央行利率",
    hint: "利率方向影響美元、台幣匯率與外資動向，對高本益比的科技股評價最敏感",
    labels: FED_DECISION_LABELS,
  },
  {
    slug: "fed-decision-in-december-20260729232808632",
    title: "聯準會 12 月利率決策",
    category: "央行利率",
    labels: FED_DECISION_LABELS,
  },
  {
    slug: "how-many-fed-rate-cuts-in-2026",
    title: "聯準會 2026 年降息幾次？",
    category: "央行利率",
    sort: "threshold",
  },
  {
    slug: "another-fed-rate-hike-in-2026",
    title: "聯準會 2026 年內再升息？",
    category: "央行利率",
  },
  {
    slug: "what-will-the-fed-rate-be-at-the-end-of-2026",
    title: "2026 年底聯邦基金利率落點",
    category: "央行利率",
    sort: "threshold",
  },
  {
    slug: "fed-rate-cut-by-629",
    title: "聯準會下一次降息最晚在哪次會議？",
    category: "央行利率",
    sort: "threshold",
  },

  // ── 兩岸地緣 ─────────────────────────────────────────
  {
    slug: "will-china-invade-taiwan-before-2027",
    title: "中國在 2026 年底前武力犯台？",
    category: "兩岸地緣",
    hint: "地緣風險溢價：外資對台股的風險評估、台幣與國防／航運類股的波動",
  },
  {
    slug: "will-china-invade-taiwan-by-december-31-2027",
    title: "中國在 2027 年底前武力犯台？",
    category: "兩岸地緣",
  },
  {
    slug: "will-china-blockade-taiwan-by-in-2026",
    title: "中國在 2026 年封鎖台灣？",
    category: "兩岸地緣",
  },
  {
    slug: "china-x-taiwan-military-clash-before-2027",
    title: "2026 年底前兩岸發生軍事衝突？",
    category: "兩岸地緣",
  },
  {
    slug: "us-x-china-military-clash-before-2027",
    title: "2026 年底前美中發生軍事衝突？",
    category: "兩岸地緣",
  },

  // ── 美國經濟 ─────────────────────────────────────────
  {
    slug: "us-recession-by-end-of-2026",
    title: "美國在 2026 年底前陷入衰退？",
    category: "美國經濟",
    hint: "美國是台灣最大出口市場，終端需求轉弱會先反映在電子零組件與消費性電子",
  },
  {
    slug: "us-economic-state-at-the-end-of-2026",
    title: "2026 年底美國經濟處於哪種狀態？",
    category: "美國經濟",
    labels: {
      "Overheating (Unemployment <5.0%, Inflation ≥3.5%)": "過熱（失業率 <5%、通膨 ≥3.5%）",
      "Soft Landing (Unemployment <5.0%, Inflation <3.5%)": "軟著陸（失業率 <5%、通膨 <3.5%）",
      "Slack (Unemployment ≥5.0%, Inflation <3.5%)": "疲軟（失業率 ≥5%、通膨 <3.5%）",
      "Stagflation (Unemployment ≥5.0%, Inflation ≥3.5%)": "停滯性通膨（失業率 ≥5%、通膨 ≥3.5%）",
    },
  },
  {
    slug: "how-high-will-inflation-get-in-2026",
    title: "2026 年美國通膨最高到多少？",
    category: "美國經濟",
    sort: "threshold",
  },
  {
    slug: "spx-hit-dec-2026",
    title: "S&P 500 在 12 月底前會觸及哪些價位？",
    category: "美國經濟",
    sort: "threshold",
  },

  // ── AI 與科技 ────────────────────────────────────────
  {
    slug: "ai-bubble-burst-by",
    title: "AI 泡沫會在何時前破裂？",
    category: "AI 與科技",
    hint: "台股權值高度集中在 AI 供應鏈（晶圓代工、伺服器、散熱、PCB）",
    sort: "threshold",
  },
  {
    slug: "largest-company-end-of-december-2026",
    title: "2026 年底全球市值最大的公司",
    category: "AI 與科技",
  },
  {
    slug: "openai-ipo-by",
    title: "OpenAI 何時 IPO？",
    category: "AI 與科技",
    sort: "threshold",
  },
  {
    slug: "which-companies-will-the-us-take-a-stake-in",
    title: "美國政府會入股哪些公司？",
    category: "AI 與科技",
    hint: "只列與台灣半導體／AI 供應鏈相關的選項",
    include: ["TSMC", "Nvidia", "Micron", "Samsung Electronics", "GlobalFoundries", "OpenAI", "Anthropic"],
    labels: { TSMC: "台積電 TSMC", "Samsung Electronics": "三星電子" },
  },
];
