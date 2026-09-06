# 自訂資料源參考實作 —— 獨立於 Investa 之外的服務
FROM node:20-alpine
WORKDIR /srv
RUN npm init -y >/dev/null && npm i pg@8 >/dev/null
# 逐檔列出會在新增模組時漏掉 —— 2026-09-06 加 intraday.mjs 時就漏了,
# 而症狀是 worker 開機即 ERR_MODULE_NOT_FOUND、schema 也沒建起來。
# 改成整包複製 .mjs;.dockerignore 擋掉不該進去的東西。
COPY *.mjs ./
EXPOSE 8088
CMD ["node", "server.mjs"]
