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

호스트 포트 **3008** (jejucar가 폐상돼 비었음 확인 후 사용. 3004 dhweb·3006 asphalt·3007 factory·3009 ipdf와는 겹치지 않음).

공개 주소: **https://g2b.soritok.com** (`*.soritok.com` 와일드카드 DNS가 이미 서버 IP를 가리키고 있어
DNS 작업은 불필요, nginx + certbot만 필요). 서버에서 아래를 사용자가 직접 실행(sudo 비밀번호 필요):

```
sudo tee /etc/nginx/sites-enabled/g2b.soritok.com <<'EOF'
server {
    listen 80;
    server_name g2b.soritok.com;
    location / {
        proxy_pass http://127.0.0.1:3008;
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

## 운영 설정(환경변수, 서버의 `.env`)

| 이름 | 기본값 | 설명 |
|---|---|---|
| `ADMIN_USERNAMES` | `admin` | 서비스키 같은 앱 공용 설정을 바꿀 수 있는 계정(쉼표로 여러 개) |
| `RATE_LIMIT_MULTIPLIER` | `1` | 요청 제한(로그인·가입·엑셀 등)을 한꺼번에 늘리거나 줄이는 배수. 접속자 IP 기준이라 한 곳에서 여럿이 쓰면 올린다 |
| `HUB_SCRAPE_TIMEOUT_MS` | `480000` | 품목 하나의 수집이 이 시간을 넘기면 멈춘 걸로 보고 강제 종료 |
| `CATCHUP_DELAY_MS` | `90000` | 서버가 켜진 뒤 "오늘 못 돈 알림 시각"의 수집을 챙기기까지 기다리는 시간 |

## 구조상 알아둘 점

- **조회 속도**: `hub_items`의 한 행은 JSON 원문(1~2KB)이라 조건·정렬에 그대로 쓰면 수만 행에서 느리고, SQLite가
  동기식이라 그동안 서버 전체가 멈춘다. 그래서 조건·정렬용 값만 뽑은 가벼운 표 `hub_idx`(트리거로 자동 유지)에서 후보를
  고르고 보일 20건만 원문에서 읽는다(`hubquery.js`). 수집 스크립트가 `hub_items`에 쓰면 트리거가 알아서 맞추므로
  수집 코드를 고칠 필요는 없다. **트리거는 SQLite 내장 함수만 쓸 것** — 없는 함수를 부르면 수집 쪽 INSERT가 깨진다.
- **엑셀 저장**은 CPU를 오래 써서 전용 스레드(`exportWorker.js`)에서 만든다(동시 2개, 대기 4개).
- **수집은 한 줄로 순서대로**(`enqueueJob`): 크로미움은 메모리를 많이 쓰고 서버를 다른 앱과 같이 쓰므로 한 번에 하나만 돌린다.
  자동 수집(크론)은 사람이 누른 조회보다 앞에 서고, 서버가 꺼져 있던 사이에 지난 알림 시각은 켜진 뒤 한 번 챙긴다.
- **알림 규칙**: 자동 수집이 "처음 발견한" 신규 계약은 계약일이 오래돼도 알린다(허브 자료는 계약일보다 며칠 늦게 올라온다).
  수동 조회는 과거 자료 채우기와 구분하려고 계약일 10일 이내만 알린다. 푸시 결과(성공/실패/만료)는 서버 로그의 `[push]`로 남는다.
- **DB 백업**: WAL 모드라 `data.db` 옆에 `data.db-wal`·`data.db-shm`이 생긴다. 파일만 `cp`하면 최근 변경이 빠질 수 있으니
  `sqlite3 data.db ".backup 복사본.db"` 또는 `VACUUM INTO`로 받을 것.
- 3008 포트는 `127.0.0.1`에만 열려 있다(nginx 전용). 외부에서 직접 열어야 하면 `docker-compose.yml`의 `ports`를 바꾼다.
