FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY g2bClient.js fields.js server.js ./
COPY public/ ./public/

VOLUME ["/app/data"]

ENV PORT=3000 \
    DB_PATH=/app/data/data.db \
    TZ=Asia/Seoul

EXPOSE 3000

CMD ["node", "server.js"]
