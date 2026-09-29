FROM node:22-alpine

# better-sqlite3 빌드 도구 + 조달데이터허브 스크래퍼용 chromium.
# Playwright가 받아오는 chromium은 glibc 전용이라 alpine에서 못 돈다 —
# alpine 패키지 chromium을 쓰고 executablePath로 연결한다(CHROMIUM_PATH).
# font-noto-cjk는 스크래퍼가 막혔을 때 스크린샷으로 진단하기 위해 넣는다(한글 렌더링).
RUN apk add --no-cache \
      python3 make g++ \
      chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto-cjk

WORKDIR /app

COPY package*.json ./
# 위에서 alpine chromium을 설치했으므로 playwright의 브라우저 다운로드는 건너뛴다
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

COPY *.js ./
COPY scripts/ ./scripts/
COPY public/ ./public/

VOLUME ["/app/data"]

ENV PORT=3000 \
    DB_PATH=/app/data/data.db \
    TZ=Asia/Seoul \
    CHROMIUM_PATH=/usr/bin/chromium-browser

EXPOSE 3000

CMD ["node", "server.js"]
