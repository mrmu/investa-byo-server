/**
 * MIS 熔斷器 —— 連續失敗就停手，指數退避後再用一個請求探測
 *
 * 2026-10-05 事故：盤中 09:40 起 MIS 零星回 502／空 JSON，10:00 起對這台的 IP
 * 一律 socket hang up（TLS 握手成功、送出請求後被斷線；同時間從別的 IP 打完全正常）
 * —— 是 IP 層級的封鎖。而收集迴圈對失敗毫無反應：每輪照樣送滿 60 個請求，
 * 9 分鐘累積 542 次 hang up。對一個正在封你的伺服器持續猛打，只會讓封鎖拉長。
 *
 * 規則：
 *   - 連續失敗達 tripAfter 次 → 熔斷，冷卻 1, 2, 4, 8, 15 分鐘（封頂）
 *   - 冷卻中 allow() 回 false，呼叫端**不送請求**直接當作沒資料
 *   - 冷卻結束後放行；成功一次即完全復原，再失敗就以更長的冷卻重新熔斷
 *
 * 每個行程各有一份狀態（worker 與 server 是兩個行程）。兩邊共用同一個 IP，
 * 但狀態不共享 —— 各自都會在失敗時退開，已足夠避免持續猛打。
 */

const BASE_MS = 60_000;
const MAX_MS = 15 * 60_000;

const hhmm = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 16);

export function createMisGuard({ name, tripAfter = 1, log = console.log }) {
  let streak = 0; // 連續失敗次數（未熔斷前）
  let trips = 0; // 連續熔斷次數，決定冷卻長度
  let openUntil = 0;

  return {
    /** 現在可以打 MIS 嗎 */
    allow() {
      return Date.now() >= openUntil;
    },
    /** 熔斷中的話，回傳何時恢復（台北時間 HH:MM），否則 null */
    openUntilLabel() {
      return Date.now() < openUntil ? hhmm(openUntil) : null;
    },
    success() {
      if (trips > 0) log(`[${name}] MIS 恢復正常（先前熔斷 ${trips} 次）`);
      streak = 0;
      trips = 0;
      openUntil = 0;
    },
    failure(reason) {
      streak++;
      if (streak < tripAfter) return;
      streak = 0;
      const wait = Math.min(MAX_MS, BASE_MS * 2 ** trips);
      trips++;
      openUntil = Date.now() + wait;
      log(
        `[${name}] ⚠️ MIS 熔斷（第 ${trips} 次，原因：${reason}）—— 暫停 ${wait / 60_000} 分鐘，` +
          `${hhmm(openUntil)} 再探測`,
      );
    },
  };
}
