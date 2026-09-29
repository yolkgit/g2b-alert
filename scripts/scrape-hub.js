// 조달데이터허브 "특정품목 조달 내역"(UI-ADOXFA-190R)을 헤드리스 브라우저로 조회한다.
// 나라장터 오픈API(계약정보서비스)에는 없는 단가·수량·단위까지 얻기 위한 경로.
//
//   실행: npm run scrape-hub -- <세부품명번호> [시작일 YYYYMMDD] [종료일 YYYYMMDD]
//   예:   npm run scrape-hub -- 4713182301 20260101 20260928
//
// 탐색(explore-hub.js)으로 확인된 화면 구조:
//   - 로그인 불필요. 목록에서 보고서명을 클릭하면 팝업으로 열린다.
//   - 검색폼은 팝업의 메인 프레임, 결과는 iframe[name=mstrFrame](MicroStrategy).
//   - 조회물품 드롭다운 mf_popupCnts_comp4.5 (WebSquare selectbox, 기본 "물품분류")
//   - 그 옆 입력칸 mf_popupCnts_comp5, 날짜 wq_uuid_157_ibxStrDay/ibxEndDay, 검색 mf_popupCnts_btnS0001
const fs = require('fs');
const { chromium } = require('playwright');

const LIST_URL = 'https://data.g2b.go.kr/link/AISC001_01/?reptNm=UI-ADOXFA-190R';
const SHOT = process.env.HUB_SHOTS !== '0';
const log = (...a) => console.log(...a);

const ID = {
  itemKindSelect: 'mf_popupCnts_comp4.5', // 조회물품 (물품분류 / 세부품명 ...)
  itemInput: 'mf_popupCnts_comp5',        // readOnly+disabled — 돋보기로만 채울 수 있다
  itemPickBtn: 'mf_popupCnts_comp5_1',    // 돋보기(선택 레이어 열기)
  dateFrom: 'wq_uuid_157_ibxStrDay',
  dateTo: 'wq_uuid_157_ibxEndDay',
  searchBtn: 'mf_popupCnts_btnS0001',
  pageSize: 'mf_popupCnts_wq_uuid_139',
  // 세부품명 선택 레이어(같은 페이지 안에 뜬다)
  pickCode: 'comPopup_wframe_popupCnts_srchDataParam1', // 세부품명번호
  pickSearch: 'comPopup_wframe_popupCnts_btnS0001',
  pickRow0: 'G_comPopup_wframe_popupCnts_grdList___checkbox_CHK_0',
  pickConfirm: 'comPopup_wframe_popupCnts_btnClose',    // value="확인"
};
const sel = (id) => `[id="${id}"]`;

// WebSquare 입력칸은 달력/마스크 위젯이 붙어 있어 fill()이 가로막히는 경우가 있다.
// 값을 직접 주입하고 input/change/blur를 발생시켜 내부 모델까지 갱신되게 한다.
async function setInputValue(frame, id, value) {
  await frame.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    for (const t of ['input', 'change', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }));
  }, { id, value });
}
const readValue = (frame, id) => frame.evaluate(
  (id) => { const el = document.getElementById(id); return el ? el.value : null; }, id);

// 달력 위젯을 실제로 조작해서 기간을 설정한다(내부 모델까지 갱신되도록).
// 달력 토글 → 시작/종료 각각 연·월 선택 후 해당 일자 셀 클릭 → 선택완료
async function setCalendarRange(page, frame, fromYmd, toYmd) {
  await frame.click(sel('wq_uuid_157_btnCal'), { timeout: 15000 });
  await page.waitForTimeout(2000);
  for (const [which, ymd] of [['calStart', fromYmd], ['calEnd', toYmd]]) {
    const y = String(Number(ymd.slice(0, 4)));
    const m = String(Number(ymd.slice(4, 6)));
    const day = String(Number(ymd.slice(6, 8)));
    await frame.selectOption(sel(`wq_uuid_157_${which}_selectbox_year`), y).catch(() => {});
    await frame.selectOption(sel(`wq_uuid_157_${which}_selectbox_month`), m).catch(() => {});
    await page.waitForTimeout(1200);
    // 해당 달력 컨테이너 안에서, 이전/다음달 흐린 칸을 빼고 날짜 숫자가 일치하는 셀을 클릭
    const ok = await frame.evaluate(({ which, day }) => {
      const root = document.querySelector(`[id*="${which}"]`);
      if (!root) return false;
      const cells = [...root.querySelectorAll('td,a,span')].filter((e) => {
        if (e.textContent.trim() !== day || !e.offsetParent) return false;
        const cls = (e.className || '') + (e.parentElement?.className || '');
        return !/prev|next|other|dim|disabled/i.test(cls);
      });
      if (!cells.length) return false;
      cells[0].click();
      return true;
    }, { which, day });
    if (!ok) console.log(`   [경고] ${which} ${ymd} 날짜 셀을 못 찾음`);
    await page.waitForTimeout(800);
  }
  await frame.click(sel('wq_uuid_157_btnChceCplt'), { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

// 긁은 라인아이템을 앱 DB(hub_items)에 넣는다. 앱이 이 표를 화면에 그린다.
// DB_PATH 환경변수로 대상 지정 가능(기본: 프로젝트의 data.db).
function saveToDb(rows) {
  let Database;
  try { Database = require('better-sqlite3'); } catch { console.log('   [DB] better-sqlite3 없음 — 건너뜀'); return; }
  const dbPath = process.env.DB_PATH || require('path').join(__dirname, '..', 'data.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS hub_items (
    contract_no TEXT NOT NULL, chg_seq TEXT NOT NULL, item_seq TEXT NOT NULL,
    item_code TEXT, contract_date TEXT, raw_json TEXT NOT NULL, fetched_at TEXT NOT NULL,
    PRIMARY KEY (contract_no, chg_seq, item_seq))`);
  const up = db.prepare(`INSERT INTO hub_items
    (contract_no, chg_seq, item_seq, item_code, contract_date, raw_json, fetched_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(contract_no, chg_seq, item_seq) DO UPDATE SET
      raw_json = excluded.raw_json, fetched_at = excluded.fetched_at`);
  const now = new Date().toISOString();
  const tx = db.transaction((list) => {
    for (const r of list) {
      up.run(r['계약(납품요구)번호'] || '', r['변경차수'] || '', r['물품순번'] || '',
        r['세부품명번호'] || null, r['계약(납품요구)일자'] || null, JSON.stringify(r), now);
    }
  });
  tx(rows);
  console.log(`   [DB] hub_items 저장 ${rows.length}건 → ${dbPath}`);
  db.close();
}

// "안내 메시지" 같은 검증 팝업이 떠 있으면 내용을 읽고 닫는다.
async function dismissDialog(page, frame) {
  const msg = await frame.evaluate(() => {
    const box = [...document.querySelectorAll('div')].find(
      (d) => d.offsetParent && /안내 메시지|알림/.test(d.textContent || '') && d.textContent.length < 400);
    if (!box) return null;
    const text = box.innerText.replace(/\s+/g, ' ').trim();
    const btn = [...box.querySelectorAll('input,button,a')].find((b) => /확인/.test(b.value || b.textContent || ''));
    if (btn) btn.click();
    return text;
  }).catch(() => null);
  if (msg) { console.log('   [경고창]', msg.slice(0, 160)); await page.waitForTimeout(1500); }
  return msg;
}

function fmt(d) { return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`; }

async function shot(page, name) {
  if (!SHOT) return;
  try { await page.screenshot({ path: `hub-${name}.png` }); log(`   [shot] hub-${name}.png`); } catch {}
}

async function openReport(ctx) {
  const page = await ctx.newPage();
  const popupPromise = ctx.waitForEvent('page', { timeout: 45000 }).catch(() => null);
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.getByText('특정품목 조달 내역', { exact: true }).first().click({ timeout: 20000 });
  const popup = await popupPromise;
  const target = popup || page;
  await target.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await target.waitForTimeout(12000);
  return target;
}

function formFrame(target) {
  for (const f of target.frames()) {
    // 검색폼 프레임은 조회물품 셀렉트박스를 가지고 있다
    if (f.url().includes('popupLayout.xml') || f === target.mainFrame()) return f;
  }
  return target.mainFrame();
}

(async () => {
  const [code, from, to] = process.argv.slice(2);
  if (!code) { console.error('사용법: npm run scrape-hub -- <세부품명번호> [YYYYMMDD] [YYYYMMDD]'); process.exit(1); }
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dFrom = from || today, dTo = to || today;
  log(`조회: 세부품명번호=${code}, 기간=${dFrom}~${dTo}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ko-KR' });

  log('\n1. 보고서 팝업 열기...');
  const page = await openReport(ctx);
  const form = formFrame(page);
  log('   url:', page.url().slice(0, 100));
  await shot(page, '1-open');

  log('\n2. 조회물품을 "세부품명"으로 변경...');
  await form.click(sel(ID.itemKindSelect), { timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot(page, '2-dropdown');
  // 드롭다운이 열리면 옵션 목록이 DOM에 생긴다. "세부품명" 텍스트를 가진 항목 클릭.
  const picked = await form.evaluate(() => {
    const cands = [...document.querySelectorAll('div,td,li,span')]
      .filter((e) => e.textContent.trim() === '세부품명' && e.offsetParent !== null);
    if (!cands.length) return null;
    cands[cands.length - 1].click();
    return cands.length;
  });
  log('   "세부품명" 후보 수:', picked);
  await page.waitForTimeout(2500);
  const kindNow = await form.textContent(sel(ID.itemKindSelect)).catch(() => '?');
  log('   현재 조회물품 =', (kindNow || '').replace(/\s+/g, ' ').trim().slice(0, 40));
  await shot(page, '3-kind-set');

  log('\n3. 돋보기 → 세부품명 선택 레이어에서 고르기...');
  await form.click(sel(ID.itemPickBtn), { timeout: 15000 });
  await page.waitForSelector(sel(ID.pickCode), { timeout: 30000 });
  await setInputValue(form, ID.pickCode, code);
  log('   세부품명번호 입력:', await readValue(form, ID.pickCode));
  await form.click(sel(ID.pickSearch), { timeout: 15000 });
  await page.waitForTimeout(6000);
  await shot(page, '3a-picker');

  const rowFound = await form.evaluate((id) => !!document.getElementById(id), ID.pickRow0);
  if (!rowFound) {
    log('   ERROR: 선택 레이어 검색 결과가 비어 있음 (세부품명번호 확인 필요)');
    await shot(page, '3b-picker-empty');
    await browser.close();
    process.exit(1);
  }
  await form.click(sel(ID.pickRow0), { timeout: 10000 });
  await page.waitForTimeout(800);
  await form.click(sel(ID.pickConfirm), { timeout: 10000 });
  await page.waitForTimeout(3000);
  log('   선택됨 →', await readValue(form, ID.itemInput));
  await shot(page, '3c-picked');

  log('\n3-2. 기간·페이지당 건수 설정...');
  // 날짜칸에 DOM 값만 주입하면 화면 표시는 바뀌어도 WebSquare 내부 모델이 갱신되지 않아
  // "최대 12개월까지 조회 가능합니다" 검증에 걸린다. 그래서 기본값(오늘) 그대로 쓰는 경로를
  // 기본으로 두고, 기간을 정말 바꿀 때만 달력 위젯을 실제로 조작한다.
  if (from && to) {
    await setCalendarRange(page, form, dFrom, dTo);
    log('   기간:', await readValue(form, ID.dateFrom), '~', await readValue(form, ID.dateTo));
  } else {
    log('   기간 미지정 → 기본값 유지:', await readValue(form, ID.dateFrom), '~', await readValue(form, ID.dateTo));
  }
  await form.selectOption(sel(ID.pageSize), '100').catch(() => {});
  await page.waitForTimeout(1000);
  await shot(page, '4-filled');

  log('\n4. 검색 클릭...');
  await form.click(sel(ID.searchBtn), { timeout: 20000 });
  await page.waitForTimeout(3000);
  // 검증에 걸리면 여기서 "안내 메시지"가 뜬다 — 내용을 남기고 닫아야 다음 단계가 진행된다
  const warned = await dismissDialog(page, form);
  if (warned) log('   → 검색이 검증에 걸렸습니다. 위 메시지 확인 필요.');
  log('   결과 대기 중(최대 90초)...');
  await page.waitForTimeout(12000);

  // MicroStrategy 결과 프레임이 채워지길 기다린다
  let mstr = null;
  for (let i = 0; i < 15; i++) {
    mstr = page.frames().find((f) => f.name() === 'mstrFrame' && f.url() !== 'about:blank');
    if (mstr) break;
    await page.waitForTimeout(5000);
  }
  log('   mstrFrame:', mstr ? mstr.url().slice(0, 100) : '(로드 안 됨 - about:blank)');
  await shot(page, '5-result');

  log('\n5. 결과 추출...');
  const scope = mstr || form;
  // 헤더행("조달방식"으로 시작하고 칸이 아주 많은 행)을 찾고, 그 아래 같은 칸 수의 행을 데이터로 읽는다.
  // MicroStrategy는 요약/중복 행도 같이 내보내므로 칸 수가 헤더와 일치하는 것만 남긴다.
  const parsed = await scope.evaluate(() => {
    for (const t of document.querySelectorAll('table')) {
      const rows = [...t.querySelectorAll('tr')]
        .map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()));
      const hIdx = rows.findIndex((r) => r.length > 30 && r[0] === '조달방식' && r.includes('세부품명번호'));
      if (hIdx < 0) continue;
      const header = rows[hIdx];
      const data = rows.slice(hIdx + 1).filter((r) => r.length === header.length && r[0] && r[0] !== '조달방식');
      if (data.length) return { header, data };
    }
    return null;
  }).catch((e) => { log('   추출 실패:', e.message.split('\n')[0]); return null; });

  if (!parsed) {
    log('   데이터 표 없음 (결과 0건이거나 화면 구조 변경)');
  } else {
    log(`   컬럼 ${parsed.header.length}개 / 데이터 ${parsed.data.length}건`);
    const col = (n) => parsed.header.indexOf(n);
    const show = ['계약(납품요구)일자', '수요기관', '세부품명', '품목명', '업체명', '단위'];
    parsed.data.slice(0, 3).forEach((r, i) => {
      log(`   [${i}]`, JSON.stringify(Object.fromEntries(
        show.filter((n) => col(n) >= 0).map((n) => [n, r[col(n)]]))).slice(0, 320));
    });
    // 단가·수량 계열 컬럼은 이름이 길어 따로 확인
    const numeric = parsed.header.filter((h) => /수량|단가|금액/.test(h));
    log('   수량/단가/금액 컬럼:', JSON.stringify(numeric).slice(0, 300));

    const rowsObj = parsed.data.map((r) => Object.fromEntries(parsed.header.map((h, i) => [h, r[i]])));
    fs.writeFileSync('hub-result.json', JSON.stringify({ code, from: dFrom, to: dTo, rows: rowsObj }, null, 2));
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    fs.writeFileSync('hub-result.csv',
      '﻿' + [parsed.header.map(esc).join(','), ...parsed.data.map((r) => r.map(esc).join(','))].join('\r\n'));
    log('   저장: hub-result.json / hub-result.csv');
    saveToDb(rowsObj);
  }

  try { fs.writeFileSync('hub-result.html', await scope.content()); } catch {}

  await browser.close();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
