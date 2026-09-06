# 自訂資料源參考實作 —— 獨立於 Investa 之外的服務
FROM node:20-alpine
WORKDIR /srv
RUN npm init -y >/dev/null && npm i pg@8 >/dev/null
COPY server.mjs worker.mjs ./
EXPOSE 8088
CMD ["node", "server.mjs"]
