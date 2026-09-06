-- BYO 資料庫綱要
--
-- 只放「沒有開放授權、必須由使用者自備」的資料。
-- 刻意不照搬 Investa 的資料表結構:這裡只需要服務 /match 與 /quote 的最小集合,
-- 結構相依愈少,兩邊愈能各自演進。
--
-- 為什麼有 feature 表而不是每次從原始明細現算:
-- /match 要在三年區間上做範圍查詢,現算連買天數之類的累積量會很慢;
-- 而且這正是「使用者自己的伺服器負責算自己的特徵」的邊界 ——
-- Investa 不再為這些欄位計算或保存任何東西。

CREATE TABLE IF NOT EXISTS byo_feature (
  ticker              text        NOT NULL,
  date                date        NOT NULL,
  "foreignNet5D"      double precision,
  "foreignNet20D"     double precision,
  "trustNet5D"        double precision,
  "trustNet20D"       double precision,
  "foreignBuyStreak"  integer,
  "trustBuyStreak"    integer,
  "foreignHoldPct"    double precision,
  "foreignHoldChg20Pp" double precision,
  "lendingChg5"       double precision,
  PRIMARY KEY (ticker, date)
);

-- /match 的查詢形狀是「某欄位 >= 值 且日期在區間內」,所以每個可篩欄位各一個
-- 以日期為前綴的索引。沒有索引的話三年區間會全表掃描。
CREATE INDEX IF NOT EXISTS byo_feature_date ON byo_feature (date);
CREATE INDEX IF NOT EXISTS byo_feature_fstreak ON byo_feature (date, "foreignBuyStreak");
CREATE INDEX IF NOT EXISTS byo_feature_tstreak ON byo_feature (date, "trustBuyStreak");
CREATE INDEX IF NOT EXISTS byo_feature_fnet5 ON byo_feature (date, "foreignNet5D");
CREATE INDEX IF NOT EXISTS byo_feature_tnet5 ON byo_feature (date, "trustNet5D");
CREATE INDEX IF NOT EXISTS byo_feature_fhold ON byo_feature (date, "foreignHoldPct");
