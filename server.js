const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { spawn } = require('child_process');
const webpush = require('web-push');

const { searchItemCodes, summarizeItem } = require('./itemLookupClient');

const app = express();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    region TEXT,
    item_code TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  -- 조달데이터허브 보고서에서 긁어온 라인아이템(단가·수량·단위 포함).
  -- 오픈API에는 없는 값들이라 scripts/scrape-hub.js가 따로 채운다.
  CREATE TABLE IF NOT EXISTS hub_items (
    contract_no TEXT NOT NULL,   -- 계약(납품요구)번호
    chg_seq TEXT NOT NULL,       -- 변경차수
    item_seq TEXT NOT NULL,      -- 물품순번
    item_code TEXT,              -- 세부품명번호
    contract_date TEXT,          -- 계약(납품요구)일자 YYYYMMDD
    raw_json TEXT NOT NULL,      -- 49개 컬럼 원본
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (contract_no, chg_seq, item_seq)
  );
  CREATE INDEX IF NOT EXISTS idx_hub_items_code_date ON hub_items (item_code, contract_date);
  -- 품목별로 "이 기간은 허브에서 확실히 다 긁어왔다"를 기록한다(여러 구간이 있을 수 있어
  -- item_code당 여러 행 허용). 조회 화면에서 이미 커버된 기간은 다시 안 긁고 DB에서 바로 보여주고,
  -- 빠진 구간만 골라서 긁는 데 쓴다.
  CREATE TABLE IF NOT EXISTS hub_coverage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hub_coverage_code ON hub_coverage (item_code);
`);

// filters.item_code는 뒤늦게 추가된 컬럼이라, 이미 만들어진 filters 테이블에는 없을 수 있다
try { db.exec(`ALTER TABLE filters ADD COLUMN item_code TEXT`); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }

// hub_coverage는 이 기능이 생기기 전부터 이미 hub_items에 쌓여 있던 자료를 모른다 — 그대로 두면
// "조회" 버튼이 이미 가진 자료까지 전부 빠진 걸로 보고 다시 긁으려 든다. 커버리지가 비어 있는
// 품목은, 이미 저장된 자료의 최소~최대 계약일자 범위를 1회성으로 커버리지에 채워준다.
{
  const codes = db.prepare(`
    SELECT item_code, MIN(contract_date) minD, MAX(contract_date) maxD FROM hub_items
    WHERE item_code IS NOT NULL AND item_code NOT IN (SELECT DISTINCT item_code FROM hub_coverage)
    GROUP BY item_code
  `).all();
  const ins = db.prepare(`INSERT INTO hub_coverage (item_code, from_date, to_date) VALUES (?, ?, ?)`);
  for (const c of codes) {
    if (!c.minD || !c.maxD) continue;
    ins.run(c.item_code, c.minD, c.maxD);
    console.log(`[hub] 기존 자료로 커버리지 초기화: ${c.item_code} ${c.minD}~${c.maxD}`);
  }
}

function getSetting(key, fallback = null) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

const ENV_PASSWORD = process.env.APP_PASSWORD || 'g2balert2026';
if (!getSetting('password')) setSetting('password', ENV_PASSWORD);

if (process.env.G2B_SERVICE_KEY && !getSetting('g2b_service_key')) {
  setSetting('g2b_service_key', process.env.G2B_SERVICE_KEY);
}

if (!getSetting('vapid_public')) {
  const keys = webpush.generateVAPIDKeys();
  setSetting('vapid_public', keys.publicKey);
  setSetting('vapid_private', keys.privateKey);
}
webpush.setVapidDetails(
  'mailto:admin@example.com',
  getSetting('vapid_public'),
  getSetting('vapid_private')
);

app.use(express.json({ limit: '2mb' }));

// ─── 접속 비밀번호 인증 (쿠키 기반) ──────────────────────────
function getPassword() { return getSetting('password', ENV_PASSWORD); }
function getAuthToken(pw) { return 'auth_' + Buffer.from(pw).toString('base64'); }
function parseCookies(req) {
  const out = {}; const h = req.headers.cookie || '';
  h.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function isAuthed(req) { return parseCookies(req).app_auth === getAuthToken(getPassword()); }

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== getPassword()) return res.status(401).json({ error: '비밀번호가 틀렸습니다' });
  res.cookie ? null : null;
  res.setHeader('Set-Cookie', `app_auth=${encodeURIComponent(getAuthToken(password))}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});
app.get('/api/session', (req, res) => res.json({ authed: isAuthed(req) }));

app.use((req, res, next) => {
  const openPaths = ['/api/login', '/api/session', '/manifest.json', '/sw.js', '/login.html'];
  if (openPaths.includes(req.path) || req.path.startsWith('/icons/')) return next();
  if (req.path.startsWith('/api/')) {
    if (!isAuthed(req)) return res.status(401).json({ error: '로그인이 필요합니다' });
    return next();
  }
  next();
});

// ─── 설정 / 필터 ──────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json({
    hasServiceKey: !!getSetting('g2b_service_key'),
    vapidPublicKey: getSetting('vapid_public'),
    alarmTime: getSetting('alarm_time', '07:00'),
    lastHubAt: getSetting('last_hub_at'),
    lastHubSummary: getSetting('last_hub_summary'),
  });
});
app.post('/api/settings/service-key', (req, res) => {
  const { serviceKey } = req.body || {};
  if (!serviceKey) return res.status(400).json({ error: 'serviceKey 필요' });
  setSetting('g2b_service_key', serviceKey);
  res.json({ ok: true });
});

app.post('/api/settings/password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 모두 입력하세요' });
  if (currentPassword !== getPassword()) return res.status(401).json({ error: '현재 비밀번호가 틀렸습니다' });
  if (newPassword.length < 4) return res.status(400).json({ error: '새 비밀번호는 4자 이상이어야 합니다' });
  setSetting('password', newPassword);
  res.setHeader('Set-Cookie', `app_auth=${encodeURIComponent(getAuthToken(newPassword))}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

app.get('/api/filters', (req, res) => {
  res.json(db.prepare(`SELECT * FROM filters ORDER BY id DESC`).all());
});

app.get('/api/item-lookup', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: '검색어가 필요합니다' });
  const serviceKey = getSetting('g2b_service_key');
  if (!serviceKey) return res.status(400).json({ error: '서비스키가 설정되지 않았습니다' });
  try {
    const { items } = await searchItemCodes(serviceKey, keyword);
    res.json({ items: items.map(summarizeItem) });
  } catch (err) {
    const hint = err.message.includes('SERVICE_KEY_IS_NOT_REGISTERED') ? ' (data.go.kr에서 "조달청_물품목록정보서비스" 활용신청이 별도로 필요합니다)' : '';
    res.status(500).json({ error: err.message + hint });
  }
});
app.post('/api/filters', (req, res) => {
  const { keyword, region, itemCode } = req.body || {};
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: 'keyword 필요' });
  const info = db.prepare(`INSERT INTO filters (keyword, region, item_code, created_at) VALUES (?, ?, ?, ?)`)
    .run(keyword.trim(), (region || '').trim() || null, (itemCode || '').trim() || null, new Date().toISOString());
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/filters/:id', (req, res) => {
  db.prepare(`DELETE FROM filters WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ─── 웹푸시 구독 ──────────────────────────────────────────
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys) return res.status(400).json({ error: 'subscription 형식 오류' });
  db.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(endpoint) DO NOTHING`)
    .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString());
  res.json({ ok: true });
});
app.delete('/api/push/subscribe', (req, res) => {
  const { endpoint } = req.body || {};
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
  res.json({ ok: true });
});

async function sendPushToAll(payload) {
  const subs = db.prepare(`SELECT * FROM push_subscriptions`).all();
  const body = JSON.stringify(payload);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(sub.endpoint);
      }
    }
  }
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}

// ─── 품목별 수집 커버리지(어느 기간까지 이미 긁었는지) ──────────
function getCoverageIntervals(itemCode) {
  return db.prepare(`SELECT from_date, to_date FROM hub_coverage WHERE item_code = ? ORDER BY from_date`).all(itemCode);
}

// [qFrom, qTo] 중 아직 안 긁은 구간만 뽑아낸다(0개면 전부 커버됨 = DB에서 바로 보여주면 됨).
function findMissingRanges(itemCode, qFrom, qTo) {
  const intervals = getCoverageIntervals(itemCode);
  let cursor = qFrom;
  const missing = [];
  for (const iv of intervals) {
    if (iv.to_date < cursor || iv.from_date > qTo) continue;
    if (iv.from_date > cursor) missing.push([cursor, addDaysYmd(iv.from_date, -1)]);
    if (iv.to_date >= cursor) cursor = addDaysYmd(iv.to_date, 1);
  }
  if (cursor <= qTo) missing.push([cursor, qTo]);
  return missing;
}

// 새로 긁은 구간을 커버리지에 추가하고, 겹치거나 붙어 있는 구간은 하나로 합친다.
function mergeCoverage(itemCode, newFrom, newTo) {
  const all = [...getCoverageIntervals(itemCode), { from_date: newFrom, to_date: newTo }]
    .sort((a, b) => (a.from_date < b.from_date ? -1 : 1));
  const merged = [];
  for (const iv of all) {
    const last = merged[merged.length - 1];
    if (last && iv.from_date <= addDaysYmd(last.to_date, 1)) {
      if (iv.to_date > last.to_date) last.to_date = iv.to_date;
    } else {
      merged.push({ ...iv });
    }
  }
  db.prepare(`DELETE FROM hub_coverage WHERE item_code = ?`).run(itemCode);
  const ins = db.prepare(`INSERT INTO hub_coverage (item_code, from_date, to_date) VALUES (?, ?, ?)`);
  for (const iv of merged) ins.run(itemCode, iv.from_date, iv.to_date);
}

// 조달데이터허브에서 긁어온 라인아이템. 필터 키워드(=세부품명)나 코드로 좁혀서 본다.
// 기간(from/to)과 페이지(page/pageSize)로 서버 사이드 페이지네이션한다.
app.get('/api/hub-items', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(Math.max(1, Number(req.query.pageSize) || 20), 200);
  const code = (req.query.code || '').trim();
  const from = (req.query.from || '').trim();
  const to = (req.query.to || '').trim();

  const conds = [], params = [];
  if (code) { conds.push('item_code = ?'); params.push(code); }
  if (from) { conds.push('contract_date >= ?'); params.push(from); }
  if (to) { conds.push('contract_date <= ?'); params.push(to); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) c FROM hub_items ${where}`).get(...params).c;
  const rows = db.prepare(`SELECT raw_json FROM hub_items ${where} ORDER BY contract_date DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ rows: rows.map((r) => JSON.parse(r.raw_json)), total, page, pageSize });
});

// 탭 라벨에 쓰는 품목별 전체 건수(기간 필터 없이) — 표 페이지네이션과 별개로 가볍게 조회.
app.get('/api/hub-items/counts', (req, res) => {
  const byCode = db.prepare(`SELECT item_code, COUNT(*) c FROM hub_items GROUP BY item_code`).all();
  const total = db.prepare(`SELECT COUNT(*) c FROM hub_items`).get().c;
  res.json({ total, byCode: Object.fromEntries(byCode.map((r) => [r.item_code, r.c])) });
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/settings/alarm-time', (req, res) => {
  const { time } = req.body || {};
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time || '')) return res.status(400).json({ error: '시간 형식이 올바르지 않습니다 (HH:MM)' });
  setSetting('alarm_time', time);
  scheduleHubScrape(time);
  res.json({ ok: true });
});

// ─── 조달데이터허브 수집(단가·수량·단위) ──────────────────────
// 헤드리스 브라우저를 띄우는 무거운 작업이라 서버 프로세스와 분리해 자식 프로세스로 돌린다.
// 브라우저가 죽더라도 앱 본체는 영향받지 않는다.
let hubState = { status: 'idle', progress: '', error: null };

function runHubScrape(code, fromDate, toDate) {
  return new Promise((resolve) => {
    const newRowsFile = path.join(path.dirname(DB_PATH), `hub-new-${code}-${process.pid}.json`);
    const args = [path.join(__dirname, 'scripts', 'scrape-hub.js'), code];
    if (fromDate && toDate) args.push(fromDate, toDate);
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: { ...process.env, HUB_SHOTS: '0', NEW_ROWS_FILE: newRowsFile }, // 서버에선 스크린샷 생략
    });
    let tail = '';
    const keep = (buf) => { tail = (tail + buf.toString()).slice(-2000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (exitCode) => {
      const m = tail.match(/중복 제거 후 (\d+)건/);
      let newRows = [];
      try {
        if (fs.existsSync(newRowsFile)) {
          newRows = JSON.parse(fs.readFileSync(newRowsFile, 'utf8'));
          fs.unlinkSync(newRowsFile);
        }
      } catch (e) { console.error('[hub] 신규 항목 파일 읽기 실패:', e.message); }
      resolve({ exitCode, count: m ? Number(m[1]) : null, newRows, tail });
    });
  });
}

// 번호가 비어 있는 필터를 키워드로 조회해 채운다. 이름이 정확히 일치하는 세부품명이 하나일
// 때만 채우고, 애매하면(여러 개거나 못 찾으면) 건드리지 않는다 — 엉뚱한 품목을 수집하면 안 되므로.
async function fillMissingItemCodes() {
  const serviceKey = getSetting('g2b_service_key');
  if (!serviceKey) return;
  const pending = db.prepare(`SELECT * FROM filters WHERE item_code IS NULL OR item_code = ''`).all();
  const update = db.prepare(`UPDATE filters SET item_code = ? WHERE id = ?`);
  for (const f of pending) {
    try {
      const { items } = await searchItemCodes(serviceKey, f.keyword);
      const exact = items.filter((it) => (it.dtilPrdctClsfcNoNm || '').trim() === f.keyword.trim());
      if (exact.length === 1) {
        update.run(exact[0].dtilPrdctClsfcNo, f.id);
        console.log(`[hub] 세부품명번호 자동 등록: ${f.keyword} → ${exact[0].dtilPrdctClsfcNo}`);
      } else {
        console.log(`[hub] ${f.keyword}: 정확히 일치하는 세부품명 ${exact.length}건 — 건너뜀`);
      }
    } catch (e) {
      console.error(`[hub] ${f.keyword} 품목 조회 실패:`, e.message);
    }
  }
}

// 등록된 필터 중 세부품명번호가 있는 것만 수집한다(번호가 없으면 허브 조회가 불가능).
// 기간을 안 주면 최근 7일치를 본다 — 오늘 하루만 보면 아직 계약이 안 올라와 0건이 되기 쉽다.
async function runHubScrapeAll({ fromDate, toDate } = {}) {
  if (!fromDate || !toDate) {
    // 종료일을 오늘로 주면 조달데이터허브 달력에서 항상 하루 전으로 튕겨나가 조회 자체가
    // 실패한다(오늘치는 아직 집계가 안 끝나 선택이 안 되는 걸로 보임, 실측 확인함) —
    // 그래서 어제까지로 잡는다.
    const end = new Date(Date.now() - 86400000);
    const begin = new Date(end.getTime() - 6 * 86400000);
    fromDate = fmtDate(begin);
    toDate = fmtDate(end);
  }
  // item_code 컬럼이 생기기 전에 만든 필터는 번호가 비어 있다. 키워드로 물품목록 API를 조회해
  // 이름이 정확히 일치하는 세부품명이 있으면 자동으로 채운다(사용자가 다시 등록할 필요 없게).
  await fillMissingItemCodes();

  const filters = db.prepare(`SELECT * FROM filters WHERE item_code IS NOT NULL AND item_code <> ''`).all();
  if (!filters.length) {
    hubState = { status: 'error', progress: '', error: '세부품명번호를 확인할 수 없습니다. 필터의 품목명이 정확한지(예: 고상제설제) 확인하거나, 품목 검색으로 다시 추가해 주세요.' };
    return;
  }
  const done = [];
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    hubState = { status: 'running', progress: `${i + 1}/${filters.length} ${f.keyword}(${f.item_code}) 수집 중...`, error: null };
    const r = await runHubScrape(f.item_code, fromDate, toDate);
    done.push(`${f.keyword} ${r.exitCode === 0 ? `${r.count ?? '?'}건` : '실패'}`);
    if (r.exitCode !== 0) console.error(`[hub] ${f.keyword} 실패:\n${r.tail.slice(-600)}`);
    else mergeCoverage(f.item_code, fromDate, toDate);
    if (r.newRows && r.newRows.length) await notifyNewHubRows(f, r.newRows);
  }
  const summary = `${new Date().toLocaleString('ko-KR')} · ${done.join(', ')}`;
  setSetting('last_hub_at', new Date().toISOString());
  setSetting('last_hub_summary', summary);
  hubState = { status: 'done', progress: summary, error: null };
}

// 이번 수집에서 새로 발견된(=hub_items에 처음 들어간) 라인아이템을 필터별로 알림 보낸다.
// hub_items의 PK(계약번호+변경차수+물품순번)가 그대로 "이미 알렸는지" 판단 기준이라 별도
// dedup 테이블이 필요 없다 — 다음 수집에서 같은 항목은 다시 신규로 잡히지 않는다.
async function notifyNewHubRows(filter, rows) {
  const top = rows.slice(0, 3)
    .map((r) => `${r['품목명'] || filter.keyword} / ${r['수요기관'] || '기관 미확인'} / ${r['계약납품단가'] ? Number(r['계약납품단가']).toLocaleString() + '원' : ''}`)
    .join('\n');
  await sendPushToAll({
    title: `나라장터 신규 계약 ${rows.length}건 - ${filter.keyword}`,
    body: top,
    url: '/',
  });
}

app.post('/api/hub-scrape', (req, res) => {
  if (hubState.status === 'running') return res.status(409).json({ error: '이미 실행 중입니다' });
  const { fromDate, toDate } = req.body || {};
  hubState = { status: 'running', progress: '시작 중...', error: null };
  runHubScrapeAll({ fromDate, toDate }).catch((e) => { hubState = { status: 'error', progress: '', error: e.message }; });
  res.json({ started: true });
});
app.get('/api/hub-scrape/status', (req, res) => res.json(hubState));

// 표 위쪽 "조회" 버튼용: 이미 긁어놓은 기간이면 바로 DB에서 보여주면 되니 아무것도 안 하고,
// 빠진 구간이 있을 때만 그 구간만 골라서 긁는다(알림은 안 보냄 — 조회는 알림과 무관).
app.post('/api/hub-query', (req, res) => {
  if (hubState.status === 'running') return res.status(409).json({ error: '이미 실행 중입니다' });
  const { itemCode, fromDate, toDate } = req.body || {};
  if (!/^\d{8}$/.test(fromDate || '') || !/^\d{8}$/.test(toDate || '') || fromDate > toDate) {
    return res.status(400).json({ error: '조회 기간이 올바르지 않습니다' });
  }
  const codes = itemCode
    ? [itemCode]
    : db.prepare(`SELECT DISTINCT item_code FROM filters WHERE item_code IS NOT NULL AND item_code <> ''`).all().map((r) => r.item_code);
  if (!codes.length) return res.status(400).json({ error: '조회할 품목이 없습니다' });

  const gaps = [];
  for (const code of codes) {
    for (const [gFrom, gTo] of findMissingRanges(code, fromDate, toDate)) gaps.push({ code, gFrom, gTo });
  }
  if (!gaps.length) return res.json({ needsScrape: false });

  hubState = { status: 'running', progress: '빠진 기간 확인됨, 수집 준비 중...', error: null };
  (async () => {
    for (let i = 0; i < gaps.length; i++) {
      const { code, gFrom, gTo } = gaps[i];
      hubState = { status: 'running', progress: `${i + 1}/${gaps.length} ${code} (${gFrom}~${gTo}) 수집 중...`, error: null };
      const r = await runHubScrape(code, gFrom, gTo);
      if (r.exitCode === 0) mergeCoverage(code, gFrom, gTo);
      else console.error(`[hub-query] ${code} (${gFrom}~${gTo}) 실패:\n${r.tail.slice(-600)}`);
    }
    hubState = { status: 'done', progress: '조회 완료', error: null };
  })().catch((e) => { hubState = { status: 'error', progress: '', error: e.message }; });

  res.json({ needsScrape: true, started: true });
});

// 설정된 알림 시간에 허브 수집을 돌린다 — 이게 곧 매일 알림이다(신규 항목이 있으면 푸시 발송).
let hubTask = null;
function scheduleHubScrape(time) {
  if (hubTask) hubTask.stop();
  const [hh, mm] = time.split(':').map(Number);
  hubTask = cron.schedule(`${mm} ${hh} * * *`, () => {
    if (hubState.status === 'running') return;
    runHubScrapeAll().catch((e) => console.error('hub scrape failed:', e.message));
  }, { timezone: 'Asia/Seoul' });
}
scheduleHubScrape(getSetting('alarm_time', '07:00'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`g2b-alert listening on ${PORT}`));
