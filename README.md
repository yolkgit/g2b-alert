# 나라장터 특정품목 조달 계약 알림

나라장터(조달청)에서 매일 새로 체결되는 계약 중, 내가 등록한 품목/지역 필터에 맞는 건만 골라서
휴대폰 홈화면 알림(웹푸시)으로 매일 아침 받아보는 앱.

## 데이터 소스

공공데이터포털(data.go.kr)의 **"조달청_나라장터 계약정보서비스"** OpenAPI를 사용한다.

1. https://www.data.go.kr/data/15129427/openapi.do 접속 → 로그인 → **활용신청**
2. 승인되면 마이페이지 > 개발계정에서 **인증키(Decoding)** 값을 복사
3. 앱 실행 후 로그인 → "data.go.kr 서비스키" 칸에 붙여넣고 저장
4. **테스트 조회(원본 확인)** 버튼으로 실제 응답이 오는지 먼저 확인할 것

> 실제 서비스키로 확인됨(2026-09-28): `getCntrctInfoListThng` 오퍼레이션, 날짜 파라미터는
> `inqryBgnDt`/`inqryEndDt`에 **YYYYMMDDHHMM(12자리)** 형식으로 넘겨야 한다(8자리면 게이트웨이가
> `HTTP_ERROR`로 튕겨낸다). 응답은 **계약 단위**(줄단위 품목 아님)이고, `cntrctNm`(계약명)에 품목
> 키워드가 대부분 들어있어 이걸로 매칭한다. `pubPrcrmntClsfcNm`(품목분류명) 필드가 있긴 한데 실제
> 응답에서는 거의 항상 빈 값이라 신뢰하지 않는다. 수요기관/업체명은 `dminsttList`/`corpList`에
> `[순번^필드^필드^...]` 형태로 패킹돼 있어 `fields.js`의 `parsePackedList`로 풀어서 읽는다.

## 사용법

1. 로그인 (기본 비밀번호는 `.env`의 `APP_PASSWORD`, 배포 시 반드시 변경할 것)
2. 서비스키 등록 → 테스트 조회로 확인
3. "알림 받을 품목/지역 필터"에 관심 품목 키워드(예: 고상제설제) 추가. 지역은 선택.
4. "홈화면 알림 켜기"로 웹푸시 구독 (모바일 브라우저에서 먼저 홈 화면에 추가하면 더 안정적으로 동작)
5. 매일 오전 7시(Asia/Seoul)에 자동으로 전날 계약을 조회해서 새 매칭 건만 알림. "지금 계약 조회"로 즉시 테스트 가능.

## 로컬 실행

```
npm install
npm run gen-icons   # 아이콘 재생성이 필요할 때만
node server.js
```

## 배포

[[deploy-server]] 서버(`dhind@61.35.3.148`)의 `~/g2b-alert`에 동일 패턴:

```
cd ~/g2b-alert && git pull && docker compose up -d --build
```

호스트 포트 **3009** (3004 dhweb·3006 asphalt·3007 factory·3008 jejucar와 겹치지 않게 선택).

공개 주소: **https://g2b.soritok.com** (`*.soritok.com` 와일드카드 DNS가 이미 서버 IP를 가리키고 있어
DNS 작업은 불필요, nginx + certbot만 필요). 서버에서 아래를 사용자가 직접 실행(sudo 비밀번호 필요):

```
sudo tee /etc/nginx/sites-enabled/g2b.soritok.com <<'EOF'
server {
    listen 80;
    server_name g2b.soritok.com;
    location / {
        proxy_pass http://127.0.0.1:3009;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d g2b.soritok.com --redirect
```
