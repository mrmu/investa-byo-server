import { request as httpsRequest } from "node:https";

/**
 * 走 node:https 的 GET —— **不要對證交所／櫃買改用 undici 的 fetch**
 *
 * 2026-09-04 事故（Investa 那邊）：worker 內 `fetch()` 打 mis.twse.com.tw 與
 * openapi.twse.com.tw 一律 ECONNRESET，但同一容器內的 wget、以及 node:https
 * 三次三中。也就是說不是網路、不是限流、不是 UA —— 是 undici 這個 client
 * 被對方的 TLS／連線處理拒絕。
 *
 * 症狀之惡劣在於它是**靜默的**：批次迴圈把例外 catch 起來只印 warning，
 * 於是每分鐘「成功完成」但一列都沒寫。整個交易日約 40 萬列的盤中 1 分 K
 * 就這樣沒了，隔天查新鮮度才發現。
 *
 * 2026-09-06 再次驗證：這台移植過來時用了裸 `fetch`，第一次手測 MIS 就
 * ECONNRESET —— 同一個坑踩第二次。註解寫在那裡沒有用，得把 client 一起帶過來。
 *
 * 推測成因在對方伺服器與 undici 的互動，不在我們這邊，
 * 所以「改用能通的 client」才是修法，不是重試或換 UA。
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export async function httpGetText(url, opts = {}) {
  return get(url, opts.headers ?? {}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_REDIRECTS);
}

/** 取 JSON；非 2xx 或內容不是 JSON 都丟例外，呼叫端自行決定要不要吞 */
export async function httpGetJson(url, opts = {}) {
  const { status, body } = await httpGetText(url, opts);
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  return JSON.parse(body);
}

function get(url, headers, timeoutMs, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: "GET", headers: { "Accept-Encoding": "identity", ...headers } },
      (res) => {
        const code = res.statusCode ?? 0;
        const loc = res.headers.location;
        if (code >= 300 && code < 400 && loc && redirectsLeft > 0) {
          res.resume(); // 必須排空，否則 socket 不會釋放
          resolve(get(new URL(loc, url).toString(), headers, timeoutMs, redirectsLeft - 1));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: code, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end();
  });
}
