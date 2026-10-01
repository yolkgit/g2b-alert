const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cron = require('node-cron');
const { spawn } = require('child_process');
const webpush = require('web-push');

const { searchItemCodes, summarizeItem } = require('./itemLookupClient');
const { registerSeoRoutes } = require('./seo');

const app = express();
app.disable('x-powered-by');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

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
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    alarm_time TEXT NOT NULL DEFAULT '07:00',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
`);

// filters.item_code는 뒤늦게 추가된 컬럼이라, 이미 만들어진 filters 테이블에는 없을 수 있다
try { db.exec(`ALTER TABLE filters ADD COLUMN item_code TEXT`); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
// 사용자별 계정 도입 이전에 만들어진 filters/push_subscriptions에는 소유자가 없다 — 아래 admin
// 마이그레이션이 기존 행들을 이 컬럼으로 이전한다.
try { db.exec(`ALTER TABLE filters ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
try { db.exec(`ALTER TABLE push_subscriptions ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }

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

// ─── 비밀번호 해싱 (내장 crypto만 사용, 새 의존성 없음) ──────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [scheme, salt, hashHex] = (stored || '').split(':');
  if (scheme !== 'scrypt' || !salt || !hashHex) return false;
  const candidate = crypto.scryptSync(pw, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ─── 세션 (쿠키 값 = 랜덤 토큰, sessions 테이블에서 조회) ────────
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 365 * 86400000);
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId, now.toISOString(), expires.toISOString());
  return token;
}
function getSessionUser(req) {
  const token = parseCookies(req).app_auth;
  if (!token) return null;
  return db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, new Date().toISOString()) || null;
}
function destroySession(req) {
  const token = parseCookies(req).app_auth;
  if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

// ─── 레거시 단일 비밀번호 → admin 계정 마이그레이션 (1회성) ──────
// 계정 도입 전 필터/구독이 이미 있었으면(=실제 운영 데이터), 그때 쓰던 공유 비밀번호를 그대로
// 해싱해서 admin 계정을 만들고 기존 행들을 그 계정으로 이전한다. 진짜 빈 새 설치에서는(필터도
// 구독도 0건) admin을 자동으로 만들지 않는다 — docker-compose 기본 비밀번호로 아무나 추측 가능한
// admin 계정이 생기는 걸 막기 위함. users가 이미 있으면(=이미 마이그레이션 끝남) 아무것도 안 함.
{
  const userCount = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
  const legacyPassword = getSetting('password');
  const filterCount = db.prepare(`SELECT COUNT(*) c FROM filters`).get().c;
  const subCount = db.prepare(`SELECT COUNT(*) c FROM push_subscriptions`).get().c;
  if (userCount === 0 && legacyPassword && (filterCount > 0 || subCount > 0)) {
    const legacyAlarmTime = getSetting('alarm_time', '07:00');
    const info = db.prepare(`INSERT INTO users (username, password_hash, alarm_time, created_at) VALUES (?, ?, ?, ?)`)
      .run('admin', hashPassword(legacyPassword), legacyAlarmTime, new Date().toISOString());
    db.prepare(`UPDATE filters SET user_id = ? WHERE user_id IS NULL`).run(info.lastInsertRowid);
    db.prepare(`UPDATE push_subscriptions SET user_id = ? WHERE user_id IS NULL`).run(info.lastInsertRowid);
    console.log(`[migrate] admin 계정 생성, 필터 ${filterCount}건·구독 ${subCount}건 이전, alarm_time=${legacyAlarmTime}`);
  }
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

// ─── 계정 인증 (아이디+비밀번호, 세션 쿠키) ──────────────────
function parseCookies(req) {
  const out = {}; const h = req.headers.cookie || '';
  h.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `app_auth=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get((username || '').trim());
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다' });
  }
  setSessionCookie(res, createSession(user.id));
  res.json({ ok: true, username: user.username });
});

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const uname = (username || '').trim();
  if (!uname || uname.length < 3) return res.status(400).json({ error: '아이디는 3자 이상이어야 합니다' });
  if (!/^[a-zA-Z0-9_-]+$/.test(uname)) return res.status(400).json({ error: '아이디는 영문/숫자/-/_ 만 가능합니다' });
  if (!password || password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다' });
  if (db.prepare(`SELECT id FROM users WHERE username = ?`).get(uname)) {
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다' });
  }
  const info = db.prepare(`INSERT INTO users (username, password_hash, alarm_time, created_at) VALUES (?, ?, ?, ?)`)
    .run(uname, hashPassword(password), '07:00', new Date().toISOString());
  setSessionCookie(res, createSession(info.lastInsertRowid));
  res.json({ ok: true, username: uname });
});

app.post('/api/logout', (req, res) => {
  destroySession(req);
  res.setHeader('Set-Cookie', `app_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const user = getSessionUser(req);
  res.json({ authed: !!user, username: user ? user.username : null });
});

app.use((req, res, next) => {
  const openPaths = ['/api/login', '/api/register', '/api/session', '/manifest.json', '/sw.js', '/login.html'];
  if (openPaths.includes(req.path) || req.path.startsWith('/icons/')) return next();
  if (req.path.startsWith('/api/')) {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: '로그인이 필요합니다' });
    req.user = user;
    return next();
  }
  next();
});

// ─── 설정 / 필터 ──────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json({
    hasServiceKey: !!getSetting('g2b_service_key'),
    vapidPublicKey: getSetting('vapid_public'),
    alarmTime: req.user.alarm_time,
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
  if (!verifyPassword(currentPassword, req.user.password_hash)) return res.status(401).json({ error: '현재 비밀번호가 틀렸습니다' });
  if (newPassword.length < 4) return res.status(400).json({ error: '새 비밀번호는 4자 이상이어야 합니다' });
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

app.get('/api/filters', (req, res) => {
  res.json(db.prepare(`SELECT * FROM filters WHERE user_id = ? ORDER BY id DESC`).all(req.user.id));
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
  const info = db.prepare(`INSERT INTO filters (user_id, keyword, region, item_code, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(req.user.id, keyword.trim(), (region || '').trim() || null, (itemCode || '').trim() || null, new Date().toISOString());
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/filters/:id', (req, res) => {
  const info = db.prepare(`DELETE FROM filters WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: '필터를 찾을 수 없습니다' });
  res.json({ ok: true });
});

// ─── 웹푸시 구독 ──────────────────────────────────────────
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys) return res.status(400).json({ error: 'subscription 형식 오류' });
  // 같은 endpoint(=같은 브라우저/기기)가 다른 계정으로 재구독되면 소유자를 그 계정으로 옮긴다
  // (기기 재로그인 시나리오 — 알림은 "지금 그 기기에 로그인된 사람"에게 가는 게 맞음).
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString());
  res.json({ ok: true });
});
app.delete('/api/push/subscribe', (req, res) => {
  const { endpoint } = req.body || {};
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`).run(endpoint, req.user.id);
  res.json({ ok: true });
});

async function sendPushToUser(userId, payload) {
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`).all(userId);
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

// 검색엔진용 공개 페이지(/, /items, /item/:code, robots.txt, sitemap.xml) — "/"를 static보다
// 먼저 가로채야 해서 이 위치에 둔다.
registerSeoRoutes(app, { db, getSessionUser });
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/settings/alarm-time', (req, res) => {
  const { time } = req.body || {};
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time || '')) return res.status(400).json({ error: '시간 형식이 올바르지 않습니다 (HH:MM)' });
  db.prepare(`UPDATE users SET alarm_time = ? WHERE id = ?`).run(time, req.user.id);
  rescheduleAllAlarms();
  res.json({ ok: true });
});

// ─── 조달데이터허브 수집(단가·수량·단위) ──────────────────────
// 헤드리스 브라우저를 띄우는 무거운 작업이라 서버 프로세스와 분리해 자식 프로세스로 돌린다.
// 브라우저가 죽더라도 앱 본체는 영향받지 않는다.
let hubState = { status: 'idle', progress: '', percent: 0, error: null };

// scrape-hub.js는 "1. 보고서 팝업 열기...", "2. 조회물품을...", ..., "5. 수집 완료..." 처럼
// 단계마다 번호를 찍는다. 그 줄을 실시간으로 잡아서(자식 프로세스가 끝나야만 아는 게 아니라)
// 현재 몇 단계인지 onStep으로 알려준다 — 화면에서 "멈췄나 진행 중인가" 구분이 안 되던 문제 해결용.
const HUB_STEP_COUNT = 5;
// index/total = 지금까지 끝난 품목 비율, step = 지금 품목 안에서 몇 단계(1~5)인지.
function stepPercent(index, total, step) {
  const base = index / total;
  const slice = (1 / total) * (step ? (step - 1) / HUB_STEP_COUNT : 0);
  return Math.min(99, Math.round((base + slice) * 100));
}
function runHubScrape(code, fromDate, toDate, onStep) {
  return new Promise((resolve) => {
    const newRowsFile = path.join(path.dirname(DB_PATH), `hub-new-${code}-${process.pid}.json`);
    const args = [path.join(__dirname, 'scripts', 'scrape-hub.js'), code];
    if (fromDate && toDate) args.push(fromDate, toDate);
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: { ...process.env, HUB_SHOTS: '0', NEW_ROWS_FILE: newRowsFile }, // 서버에선 스크린샷 생략
    });
    let tail = '';
    let lineBuf = '';
    const keep = (buf) => {
      const s = buf.toString();
      tail = (tail + s).slice(-2000);
      if (!onStep) return;
      lineBuf += s;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        const m = line.match(/^(\d+)(?:-\d+)?\.\s*(.+)/);
        if (m) onStep(Number(m[1]), m[2].trim());
      }
    };
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

// 종료일을 오늘로 주면 조달데이터허브 달력에서 항상 하루 전으로 튕겨나가 조회 자체가 실패한다
// (오늘치는 아직 집계가 안 끝나 선택이 안 되는 걸로 보임, 실측 확인함) — 그래서 어제까지로 잡는다.
function defaultScrapeWindow() {
  const end = new Date(Date.now() - 86400000);
  const begin = new Date(end.getTime() - 6 * 86400000);
  return { fromDate: fmtDate(begin), toDate: fmtDate(end) };
}

// hub_items에 처음 들어간(=진짜 신규) 행이라도, 계약일자가 오래된 과거 건이면(예: 과거 날짜를
// 수동 조회하다 우연히 처음 긁힌 경우) "신규 계약" 알림 대상에서 뺀다 — 매일 알림은 "당일 새로
// 올라온 것"을 알리는 용도이지, DB에 언제 들어왔는지는 사용자와 상관없는 내부 사정이라서.
const NOTIFY_RECENT_DAYS = 3;
function isRecentEnoughToNotify(row) {
  const d = row['계약(납품요구)일자'];
  if (!d || !/^\d{8}$/.test(d)) return false;
  const cutoff = fmtDate(new Date(Date.now() - NOTIFY_RECENT_DAYS * 86400000));
  return d >= cutoff;
}

// item_code 하나를 긁어서, 이번에 새로 발견된(hub_items PK 기준) 행 중 최근 것만 그 품목을
// 보는 모든 사용자에게 알린다 — 트리거(크론이든 수동 조회든)와 무관하게 항상 같은 규칙 적용.
// hub_items는 PK로 중복 제거되므로 "신규"는 딱 한 번만 감지된다 — 그 순간 알림을 안 보내면
// 그 품목을 보는 다른 사용자는 영영 못 받으므로, 트리거한 사람만이 아니라 전원에게 보낸다.
async function notifyAllUsersForCode(itemCode, rows) {
  const recent = rows.filter(isRecentEnoughToNotify);
  if (!recent.length) return;
  const filters = db.prepare(`SELECT * FROM filters WHERE item_code = ?`).all(itemCode);
  const byUser = new Map();
  for (const f of filters) if (!byUser.has(f.user_id)) byUser.set(f.user_id, f);
  if (!byUser.size) return;
  const top = recent.slice(0, 3)
    .map((r) => `${r['품목명'] || itemCode} / ${r['수요기관'] || '기관 미확인'} / ${r['계약납품단가'] ? Number(r['계약납품단가']).toLocaleString() + '원' : ''}`)
    .join('\n');
  for (const [userId, f] of byUser) {
    await sendPushToUser(userId, {
      title: `나라장터 신규 계약 ${recent.length}건 - ${f.keyword}`,
      body: top,
      url: '/',
    });
  }
}

// item_code 목록을 하나씩(중복 없이) 긁는다 — 여러 사용자가 같은 품목을 봐도 한 번만 스크래핑.
async function scrapeCodesAndNotify(codes, { fromDate, toDate }) {
  const results = [];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    hubState = { status: 'running', progress: `${i + 1}/${codes.length} ${code} 수집 중...`, percent: stepPercent(i, codes.length), error: null };
    const r = await runHubScrape(code, fromDate, toDate, (step, label) => {
      hubState = { status: 'running', progress: `${i + 1}/${codes.length} ${code} — ${label}`, percent: stepPercent(i, codes.length, step), error: null };
    });
    results.push({ code, ...r });
    if (r.exitCode !== 0) console.error(`[hub] ${code} 실패:\n${r.tail.slice(-600)}`);
    else mergeCoverage(code, fromDate, toDate);
    if (r.newRows && r.newRows.length) await notifyAllUsersForCode(code, r.newRows);
  }
  return results;
}

// 특정 alarm_time을 가진 사용자들의 필터에서(중복 제거된) item_code만 뽑아 수집한다.
// 크론 틱 하나당 한 번 호출됨 — "그 시간을 등록한 사용자들이 보는 품목만" 긁는다.
async function runHubScrapeForTime(time) {
  const { fromDate, toDate } = defaultScrapeWindow();
  // item_code 컬럼이 생기기 전에 만든 필터는 번호가 비어 있다. 키워드로 물품목록 API를 조회해
  // 이름이 정확히 일치하는 세부품명이 있으면 자동으로 채운다(사용자가 다시 등록할 필요 없게).
  await fillMissingItemCodes();

  const codes = db.prepare(`
    SELECT DISTINCT f.item_code FROM filters f JOIN users u ON u.id = f.user_id
    WHERE u.alarm_time = ? AND f.item_code IS NOT NULL AND f.item_code <> ''
  `).all(time).map((r) => r.item_code);
  if (!codes.length) {
    hubState = { status: 'done', progress: `${time}에 등록된 품목 없음`, percent: 100, error: null };
    return;
  }
  const results = await scrapeCodesAndNotify(codes, { fromDate, toDate });
  const summary = `${new Date().toLocaleString('ko-KR')} · ${results.map((r) => `${r.code} ${r.exitCode === 0 ? `${r.count ?? '?'}건` : '실패'}`).join(', ')}`;
  setSetting('last_hub_at', new Date().toISOString());
  setSetting('last_hub_summary', summary);
  hubState = { status: 'done', progress: summary, percent: 100, error: null };
}

// 상태 조회만 남긴다 — 수동 "지금 확인하기" 버튼은 없앴고(매일 자동 실행으로 충분, 표의
// "조회"는 알림 없이 조회만 함), hub-query가 트는 수집의 진행 상황을 폴링하는 데 쓰인다.
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
    // "전체" 탭 조회는 내 필터만 대상으로 한다 — 다른 사용자가 보는 품목까지 긁을 필요 없음.
    : db.prepare(`SELECT DISTINCT item_code FROM filters WHERE user_id = ? AND item_code IS NOT NULL AND item_code <> ''`).all(req.user.id).map((r) => r.item_code);
  if (!codes.length) return res.status(400).json({ error: '조회할 품목이 없습니다' });

  const gaps = [];
  for (const code of codes) {
    for (const [gFrom, gTo] of findMissingRanges(code, fromDate, toDate)) gaps.push({ code, gFrom, gTo });
  }
  if (!gaps.length) return res.json({ needsScrape: false });

  hubState = { status: 'running', progress: '빠진 기간 확인됨, 수집 준비 중...', percent: 0, error: null };
  (async () => {
    for (let i = 0; i < gaps.length; i++) {
      const { code, gFrom, gTo } = gaps[i];
      hubState = { status: 'running', progress: `${i + 1}/${gaps.length} ${code} (${gFrom}~${gTo}) 수집 중...`, percent: stepPercent(i, gaps.length), error: null };
      const r = await runHubScrape(code, gFrom, gTo, (step, label) => {
        hubState = { status: 'running', progress: `${i + 1}/${gaps.length} ${code} (${gFrom}~${gTo}) — ${label}`, percent: stepPercent(i, gaps.length, step), error: null };
      });
      if (r.exitCode === 0) mergeCoverage(code, gFrom, gTo);
      else console.error(`[hub-query] ${code} (${gFrom}~${gTo}) 실패:\n${r.tail.slice(-600)}`);
      // 수동 조회라도 "신규 계약"으로 잡힌 게 있으면(당일치만) 그 품목을 보는 모든 사용자에게
      // 알린다 — 과거 날짜 브라우징은 notifyAllUsersForCode 안의 당일 필터가 걸러준다.
      if (r.exitCode === 0 && r.newRows && r.newRows.length) await notifyAllUsersForCode(code, r.newRows);
    }
    hubState = { status: 'done', progress: '조회 완료', percent: 100, error: null };
  })().catch((e) => { hubState = { status: 'error', progress: '', percent: 0, error: e.message }; });

  res.json({ needsScrape: true, started: true });
});

// 사용자마다 다른 alarm_time을 가질 수 있어, 실제로 쓰이는 시간마다 크론 job을 하나씩 띄운다.
// 알림 시간 저장 시(POST /api/settings/alarm-time)마다, 그리고 서버 부팅 시 1번 호출된다.
let hubTasks = new Map();
function rescheduleAllAlarms() {
  for (const t of hubTasks.values()) t.stop();
  hubTasks.clear();
  const times = db.prepare(`SELECT DISTINCT alarm_time FROM users`).all().map((r) => r.alarm_time);
  for (const time of times) {
    const [hh, mm] = time.split(':').map(Number);
    hubTasks.set(time, cron.schedule(`${mm} ${hh} * * *`, () => {
      if (hubState.status === 'running') return;
      runHubScrapeForTime(time).catch((e) => console.error('hub scrape failed:', e.message));
    }, { timezone: 'Asia/Seoul' }));
  }
}
rescheduleAllAlarms();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`g2b-alert listening on ${PORT}`));
