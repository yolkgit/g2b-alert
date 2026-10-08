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
//
// 수집 경로는 두 가지다:
//   1) CSV 내보내기(기본) — 전체 결과를 받는다. 버튼을 누르면 새 창이 뜨고 거기서 "내보내기"를
//      한 번 더 눌러야 파일이 떨어진다. 받은 파일은 이름만 .csv 이고 실제로는 UTF-16LE + 탭 구분.
//   2) 화면 표 파싱(대체) — 페이지당 100건이 상한이라 기간을 쪼개 여러 번 조회한다.
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
  csvDown: 'mf_popupCnts_btnCsvDown',
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
    // 주의: 이 select의 value에는 끝 공백이 있다("2026 ", "1 "). value로 고르면 조용히 실패하고
    // 기본값이 남아 엉뚱한 기간으로 조회된다 — 반드시 label("2026년", "1월")로 고른다.
    try {
      await frame.selectOption(sel(`wq_uuid_157_${which}_selectbox_year`), { label: `${y}년` });
      await frame.selectOption(sel(`wq_uuid_157_${which}_selectbox_month`), { label: `${m}월` });
    } catch (e) {
      console.log(`   [경고] ${which} 연/월 선택 실패:`, e.message.split('\n')[0]);
    }
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

// CSV다운로드: 버튼을 누르면 별도 창이 뜨고, 그 창의 "내보내기"를 눌러야 파일이 떨어진다.
// 화면 표는 페이지당 100건이 상한이지만 내보내기는 전체 결과를 담는다.
async function downloadCsv(page) {
  const ctx = page.context();
  const popupPromise = ctx.waitForEvent('page', { timeout: 30000 });
  await page.mainFrame().click(sel(ID.csvDown), { timeout: 20000 });

  let pop;
  try { pop = await popupPromise; } catch { throw new Error('CSV 창이 열리지 않음'); }
  await pop.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await pop.waitForTimeout(4000);
  console.log('   [CSV] 창 열림:', pop.url().slice(0, 90));

  const dlPromise = ctx.waitForEvent('download', { timeout: 120000 });
  // 창 구조가 프레임으로 감싸여 있을 수 있어 모든 프레임에서 내보내기 버튼을 찾는다
  let clicked = false;
  for (const f of pop.frames()) {
    clicked = await f.evaluate(() => {
      const btn = [...document.querySelectorAll('input,button,a')]
        .find((b) => /내보내기|export|다운로드|확인/i.test((b.value || b.textContent || '').trim()) && b.offsetParent);
      if (!btn) return false;
      btn.click();
      return true;
    }).catch(() => false);
    if (clicked) break;
  }
  if (!clicked) {
    // 못 찾았으면 창 안의 버튼 목록을 남겨서 다음 시도에 쓴다
    const btns = await pop.mainFrame().evaluate(() =>
      [...document.querySelectorAll('input,button,a')]
        .map((b) => ({ id: b.id || null, text: (b.value || b.textContent || '').trim().slice(0, 30) }))
        .filter((b) => b.text).slice(0, 25)).catch(() => []);
    console.log('   [CSV] 내보내기 버튼 못 찾음. 창 안 버튼들:', JSON.stringify(btns).slice(0, 600));
    await pop.screenshot({ path: 'hub-7-csv-window.png' }).catch(() => {});
    throw new Error('내보내기 버튼을 찾지 못함 (hub-7-csv-window.png 확인)');
  }

  const dl = await dlPromise;
  const out = 'hub-download.csv';
  await dl.saveAs(out);
  console.log(`   [CSV] 받음: ${dl.suggestedFilename()} → ${out}`);
  await pop.close().catch(() => {});
  return out;
}

// 받은 파일을 파싱한다. 실측 결과 이 내보내기는 이름만 .csv 이고 실제로는
// UTF-16LE + 탭 구분이며, 앞쪽 45줄쯤이 "검색조건 : 프롬프트 N: ..." 머리말이다.
function parseCsvFile(file) {
  const buf = fs.readFileSync(file);
  // BOM으로 인코딩 판별 (FF FE = UTF-16LE)
  const text = (buf[0] === 0xFF && buf[1] === 0xFE)
    ? buf.toString('utf16le').replace(/^﻿/, '')
    : buf.toString('utf8').replace(/^﻿/, '');

  // 구분자는 헤더 줄을 보고 정한다(탭 우선, 없으면 콤마)
  const lines = text.split(/\r?\n/);
  const hIdx = lines.findIndex((l) => l.includes('세부품명번호'));
  if (hIdx < 0) return null;
  const delim = lines[hIdx].includes('\t') ? '\t' : ',';

  // 따옴표 안의 구분자·줄바꿈을 보존하는 최소 파서 (머리말은 건너뛴 뒤부터 처리)
  const body = lines.slice(hIdx).join('\n');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) {
      if (c === '"') { if (body[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }

  const header = rows[0].map((h) => h.trim());
  const data = rows.slice(1).filter((r) => r.length === header.length && r.some((v) => v.trim()));
  return { header, rows: data.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()]))) };
}

// 긁은 라인아이템을 앱 DB(hub_items)에 넣는다. 앱이 이 표를 화면에 그리고, 이 함수가 돌려주는
// "신규" 목록으로 서버가 푸시 알림을 보낸다(하나의 라인아이템 = (계약번호,변경차수,물품순번) 키).
// NEW_ROWS_FILE 환경변수가 있으면(서버가 자식 프로세스로 띄울 때) 신규 목록을 그 파일에도 쓴다 —
// 서버는 stdout이 아니라 그 파일을 읽어서 알림 본문(품목명·기관명 등)을 구성한다.
// DB_PATH 환경변수로 대상 지정 가능(기본: 프로젝트의 data.db).
function saveToDb(rows) {
  let Database;
  try { Database = require('better-sqlite3'); } catch { console.log('   [DB] better-sqlite3 없음 — 건너뜀'); return []; }
  const dbPath = process.env.DB_PATH || require('path').join(__dirname, '..', 'data.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS hub_items (
    contract_no TEXT NOT NULL, chg_seq TEXT NOT NULL, item_seq TEXT NOT NULL,
    item_code TEXT, contract_date TEXT, raw_json TEXT NOT NULL, fetched_at TEXT NOT NULL,
    PRIMARY KEY (contract_no, chg_seq, item_seq))`);

  const keyOf = (r) => `${r['계약(납품요구)번호'] || ''}|${r['변경차수'] || ''}|${r['물품순번'] || ''}`;
  const existing = new Set(
    db.prepare(`SELECT contract_no || '|' || chg_seq || '|' || item_seq AS k FROM hub_items`).all().map((r) => r.k));
  const newRows = rows.filter((r) => !existing.has(keyOf(r)));

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
  console.log(`   [DB] hub_items 저장 ${rows.length}건(신규 ${newRows.length}건) → ${dbPath}`);
  db.close();

  if (process.env.NEW_ROWS_FILE) {
    fs.writeFileSync(process.env.NEW_ROWS_FILE, JSON.stringify(newRows));
  }
  return newRows;
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

// 고정 대기(waitForTimeout) 대신 "원하는 상태가 되면 바로" 넘어간다. 최대 maxMs까지만 기다리고(= 예전 고정 대기와 같은 값),
// 그때까지 조건이 안 맞으면 false를 돌려줄 뿐 예외는 던지지 않는다 — 그 뒤 동작은 예전과 똑같다.
async function waitUntil(page, cond, maxMs, pollMs = 250) {
  const end = Date.now() + maxMs;
  for (;;) {
    if (await Promise.resolve().then(cond).catch(() => false)) return true;
    if (Date.now() + pollMs >= end) return false;
    await page.waitForTimeout(pollMs);
  }
}

// 도커(alpine)에서는 이미지에 설치된 chromium을 쓰고(CHROMIUM_PATH), 로컬에서는
// playwright가 받아둔 브라우저를 그대로 쓴다. 컨테이너는 root로 돌아서 sandbox를 끈다.
function launchOpts() {
  const opts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  // alpine 버전에 따라 chromium 실행파일 이름이 chromium-browser / chromium 으로 갈린다.
  // 지정된 경로가 없으면 나머지 후보를 찾아본다(경로가 틀리면 기능 전체가 죽으므로).
  const candidates = [process.env.CHROMIUM_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium'].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) opts.executablePath = found;
  else if (process.env.CHROMIUM_PATH) console.log('   [경고] CHROMIUM_PATH를 찾지 못해 기본 브라우저로 시도합니다');
  return opts;
}

async function shot(page, name) {
  if (!SHOT) return;
  try { await page.screenshot({ path: `hub-${name}.png` }); log(`   [shot] hub-${name}.png`); } catch {}
}

async function openReportOnce(ctx) {
  const page = await ctx.newPage();
  const popupPromise = ctx.waitForEvent('page', { timeout: 45000 }).catch(() => null);
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.getByText('특정품목 조달 내역', { exact: true }).first().click({ timeout: 45000 });
  const popup = await popupPromise;
  const target = popup || page;
  await target.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  // 고정 12초 대신: 조회물품 선택칸이 보이면(실측 로딩 후 약 3초) 위젯이 자리잡도록 2초만 더 두고 넘어간다.
  await waitUntil(target, async () => {
    for (const f of target.frames()) if (await f.locator(sel(ID.itemKindSelect)).isVisible().catch(() => false)) return true;
    return false;
  }, 12000);
  await target.waitForTimeout(2000);
  return target;
}

// 리소스가 빠듯한 서버(특히 첫 실행)에서는 팝업 클릭이 타이밍상 한 번 실패할 수 있어(실측: 프로덕션
// 서버에서 20초 안에 클릭이 안 끝남) 한 번 더 시도한다. 실패한 페이지는 닫고 새로 연다.
async function openReport(ctx) {
  try {
    return await openReportOnce(ctx);
  } catch (e) {
    log(`   [재시도] 보고서 팝업 열기 실패(${e.message.slice(0, 100)}), 한 번 더 시도`);
    for (const p of ctx.pages()) await p.close().catch(() => {});
    return await openReportOnce(ctx);
  }
}

// ── 기간 분할 ────────────────────────────────────────────────
// 화면 표는 페이지당 100건이 상한이라 한 번에 그 이상은 못 읽는다(CSV 다운로드는 헤드리스에서
// 이벤트가 발생하지 않아 못 씀). 그래서 기간을 잘라 각 조회가 100건 미만이 되게 하고,
// 그래도 100건이 꽉 차면 그 구간을 반으로 더 쪼갠다.
const PAGE_CAP = 100;
const toDate = (ymd) => new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
const toYmd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const addDays = (ymd, n) => toYmd(new Date(toDate(ymd).getTime() + n * 86400000));

// [from, to]를 월 단위로 자른다
function monthChunks(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    const d = toDate(cur);
    const lastOfMonth = toYmd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    const end = lastOfMonth > to ? to : lastOfMonth;
    out.push([cur, end]);
    cur = addDays(end, 1);
  }
  return out;
}

// 결과 프레임에서 헤더행을 찾아 행 객체 배열로 바꾼다
async function extractRows(scope) {
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
  }).catch(() => null);
  if (!parsed) return [];
  return parsed.data.map((r) => Object.fromEntries(parsed.header.map((h, i) => [h, r[i]])));
}

// 한 구간을 조회한다. 기간 설정이 어긋나면 조용히 넘어가지 않고 예외를 던진다.
async function searchRange(page, form, dFrom, dTo) {
  await setCalendarRange(page, form, dFrom, dTo);
  const gotFrom = await readValue(form, ID.dateFrom);
  const gotTo = await readValue(form, ID.dateTo);
  if (gotFrom !== fmt(dFrom) || gotTo !== fmt(dTo)) {
    throw new Error(`기간 설정 실패 (요청 ${fmt(dFrom)}~${fmt(dTo)}, 실제 ${gotFrom}~${gotTo})`);
  }
  // 기본 대기(30초)를 그대로 두면 이 요소가 없는 화면에서 30초가 통째로 사라진다(실측: 운영에서 매번 30.0초).
  const sizeErr = await form.selectOption(sel(ID.pageSize), '100', { timeout: 2000 }).then(() => null, (e) => e.message.split('\n')[0]);
  if (sizeErr) log(`   [페이지 크기] 설정 못 함(무시): ${sizeErr.slice(0, 90)}`);
  await form.click(sel(ID.searchBtn), { timeout: 20000 });

  // 고정 13초(3초 + 10초) 대신 결과표가 나타나 안정되면 바로 넘어간다. 결과가 없거나 늦으면 예전과 같은 13초까지 기다린다.
  // 검증 경고창은 예전처럼 3초가 지난 뒤부터 확인한다(그 전에는 로딩 중 화면과 헷갈릴 수 있다).
  const t0 = Date.now();
  let warned = null, dialogChecked = false, lastCount = -1;
  await waitUntil(page, async () => {
    // 경고창 확인은 예전처럼 딱 한 번만 한다(반복하면 로딩 중 화면의 문구를 경고로 오인할 수 있다)
    if (!dialogChecked && Date.now() - t0 >= 3000) { dialogChecked = true; warned = await dismissDialog(page, form); if (warned) return true; }
    const f = page.frames().find((x) => x.name() === 'mstrFrame' && x.url() !== 'about:blank');
    if (!f) return false;
    const n = (await extractRows(f)).length;
    const stable = n > 0 && n === lastCount; // 표가 아직 그려지는 중이면 행 수가 계속 늘어난다
    lastCount = n;
    return stable;
  }, 13000, 400);
  if (!dialogChecked) warned = await dismissDialog(page, form); // 결과가 3초 전에 떠서 위에서 못 한 경우
  if (warned) throw new Error('검증 경고: ' + warned.slice(0, 100));

  let mstr = null;
  for (let i = 0; i < 12; i++) {
    mstr = page.frames().find((f) => f.name() === 'mstrFrame' && f.url() !== 'about:blank');
    if (mstr) break;
    await page.waitForTimeout(4000);
  }
  return mstr ? extractRows(mstr) : [];
}

// 구간을 조회하되 100건(페이지 상한)이 꽉 차면 절반으로 쪼개 재귀 조회한다.
async function collectRange(page, form, dFrom, dTo, depth = 0) {
  const rows = await searchRange(page, form, dFrom, dTo);
  const capped = rows.length >= PAGE_CAP && dFrom !== dTo && depth < 7;
  log(`   ${dFrom}~${dTo}: ${rows.length}건${capped ? ' → 상한 도달, 분할' : ''}`);
  if (!capped) return rows;
  const mid = toYmd(new Date((toDate(dFrom).getTime() + toDate(dTo).getTime()) / 2));
  const left = await collectRange(page, form, dFrom, mid, depth + 1);
  const right = await collectRange(page, form, addDays(mid, 1), dTo, depth + 1);
  return [...left, ...right];
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
  // 종료일을 오늘로 주면 달력에서 항상 하루 전으로 튕겨나가 조회가 실패한다(실측 확인) — 기본값은 어제.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const dFrom = from || yesterday, dTo = to || yesterday;
  log(`조회: 세부품명번호=${code}, 기간=${dFrom}~${dTo}`);

  const browser = await chromium.launch({ headless: true, ...launchOpts() });
  try {
    await runScrape(browser, code, dFrom, dTo, from, to);
  } finally {
    // 도중에 실패해도 chromium 프로세스가 서버에 계속 남아있으면 안 되므로(매일 자동 실행됨) 항상 닫는다.
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });

async function runScrape(browser, code, dFrom, dTo, from, to) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ko-KR', acceptDownloads: true });

  log('\n1. 보고서 팝업 열기...');
  const page = await openReport(ctx);
  const form = formFrame(page);
  log('   url:', page.url().slice(0, 100));
  await shot(page, '1-open');

  log('\n2. 조회물품을 "세부품명"으로 변경...');
  await form.click(sel(ID.itemKindSelect), { timeout: 20000 });
  // 고정 1.5초 대신: 드롭다운 옵션("세부품명")이 DOM에 생기면 바로(최대 1.5초)
  const kindOptions = () => form.evaluate(() => [...document.querySelectorAll('div,td,li,span')]
    .filter((e) => e.textContent.trim() === '세부품명' && e.offsetParent !== null).length);
  await waitUntil(page, async () => (await kindOptions()) > 0, 1500);
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
  // 고정 2.5초 대신: 선택칸에 "세부품명"이 반영되면 바로(최대 2.5초)
  await waitUntil(page, async () => /세부품명/.test(await form.textContent(sel(ID.itemKindSelect))), 2500);
  await page.waitForTimeout(300);
  const kindNow = await form.textContent(sel(ID.itemKindSelect)).catch(() => '?');
  log('   현재 조회물품 =', (kindNow || '').replace(/\s+/g, ' ').trim().slice(0, 40));
  await shot(page, '3-kind-set');

  log('\n3. 돋보기 → 세부품명 선택 레이어에서 고르기...');
  await form.click(sel(ID.itemPickBtn), { timeout: 15000 });
  await page.waitForSelector(sel(ID.pickCode), { timeout: 30000 });
  await setInputValue(form, ID.pickCode, code);
  log('   세부품명번호 입력:', await readValue(form, ID.pickCode));
  await form.click(sel(ID.pickSearch), { timeout: 15000 });
  // 고정 6초 대신: 첫 행에 우리가 찾는 번호가 떠 있으면 바로(최대 6초). 검색 전 목록의 첫 행을 잘못 고르는 일도 막는다.
  await waitUntil(page, () => form.evaluate(({ id, code }) => {
    // 체크박스에서 위로 올라가며 "행 하나 크기"(글자 400자 이하) 안에서 번호가 보이는지 본다(표가 table이든 div 격자든 동작)
    for (let el = document.getElementById(id), i = 0; el && i < 6; el = el.parentElement, i++) {
      const t = el.innerText || '';
      if (t.length > 400) return false;
      if (t.includes(code)) return true;
    }
    return false;
  }, { id: ID.pickRow0, code }), 6000);
  await shot(page, '3a-picker');

  const rowFound = await form.evaluate((id) => !!document.getElementById(id), ID.pickRow0);
  if (!rowFound) {
    log('   ERROR: 선택 레이어 검색 결과가 비어 있음 (세부품명번호 확인 필요)');
    await shot(page, '3b-picker-empty');
    throw new Error('세부품명번호로 검색된 항목이 없음');
  }
  await form.click(sel(ID.pickRow0), { timeout: 10000 });
  await page.waitForTimeout(800);
  await form.click(sel(ID.pickConfirm), { timeout: 10000 });
  // 고정 3초 대신: 선택된 품목이 입력칸에 반영되면 바로(최대 3초)
  await waitUntil(page, async () => !!(await readValue(form, ID.itemInput)), 3000);
  await page.waitForTimeout(500);
  log('   선택됨 →', await readValue(form, ID.itemInput));
  await shot(page, '3c-picked');

  // CSV 내보내기는 전체 결과를 담으므로 먼저 시도하고, 안 되면 기간을 쪼개 화면을 긁는다.
  log('\n4. 전체 기간 조회 후 CSV 내보내기 시도...');
  let collected = [];
  let viaCsv = false;
  try {
    await searchRange(page, form, dFrom, dTo);
    await shot(page, '5-result');
    const csv = parseCsvFile(await downloadCsv(page));
    if (csv && csv.rows.length) {
      collected = csv.rows;
      viaCsv = true;
      log(`   [CSV] 컬럼 ${csv.header.length}개 / ${collected.length}건`);
    } else {
      log('   [CSV] 파일에서 헤더를 못 찾음 — 기간 분할로 대체');
    }
  } catch (e) {
    log('   [CSV] 실패:', e.message.split('\n')[0]);
  }

  if (!viaCsv) {
    log('\n4-2. 기간을 나눠 화면 조회...');
    // 화면 표는 한 번에 100건까지만 읽히므로 월 단위로 자르고, 그래도 꽉 차면 더 쪼갠다.
    const chunks = (from && to) ? monthChunks(dFrom, dTo) : [[dFrom, dTo]];
    log(`   구간 ${chunks.length}개`);
    for (const [cFrom, cTo] of chunks) {
      try {
        collected.push(...await collectRange(page, form, cFrom, cTo));
      } catch (e) {
        log(`   [실패] ${cFrom}~${cTo}: ${e.message.split('\n')[0]}`);
      }
    }
    await shot(page, '5-result');
  }

  // 같은 라인아이템이 구간 경계나 중복 렌더링으로 겹칠 수 있어 키로 중복 제거
  const seen = new Set();
  const rows = collected.filter((r) => {
    const k = [r['계약(납품요구)번호'], r['변경차수'], r['물품순번']].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  log(`\n5. 수집 완료(${viaCsv ? 'CSV' : '화면 분할'}): 원본 ${collected.length}건 → 중복 제거 후 ${rows.length}건`);

  if (!rows.length) {
    log('   결과 없음');
  } else {
    const show = ['계약(납품요구)일자', '수요기관', '품목명', '업체명', '단위', '계약납품단가', '계약납품수량'];
    rows.slice(0, 3).forEach((r, i) =>
      log(`   [${i}]`, JSON.stringify(Object.fromEntries(show.filter((n) => n in r).map((n) => [n, r[n]]))).slice(0, 320)));

    const header = Object.keys(rows[0]);
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    fs.writeFileSync('hub-result.json', JSON.stringify({ code, from: dFrom, to: dTo, rows }, null, 2));
    fs.writeFileSync('hub-result.csv',
      '﻿' + [header.map(esc).join(','), ...rows.map((r) => header.map((h) => esc(r[h])).join(','))].join('\r\n'));
    log('   저장: hub-result.json / hub-result.csv');
    saveToDb(rows);
  }
}
