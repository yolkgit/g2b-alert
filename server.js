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
const { buildXlsx } = require('./xlsx');

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
// 서비스키처럼 앱 전체에 걸린 설정은 관리자만 바꿀 수 있다. 가입이 열려 있어서 아무나 계정을 만들 수
// 있으므로, 일반 계정이 덮어쓰면 모든 사용자의 품목 검색이 같이 망가진다.
// 관리자 아이디는 코드에 박지 않고 환경변수 ADMIN_USERNAMES(쉼표로 여러 개)로 정한다. 안 정하면
// 계정 도입 전 공유 비밀번호가 옮겨간 'admin'.
const ADMIN_USERNAMES = new Set((process.env.ADMIN_USERNAMES || 'admin').split(',').map((s) => s.trim()).filter(Boolean));
const isAdmin = (user) => ADMIN_USERNAMES.has(user.username);

app.get('/api/settings', (req, res) => {
  res.json({
    isAdmin: isAdmin(req.user),
    hasServiceKey: !!getSetting('g2b_service_key'),
    vapidPublicKey: getSetting('vapid_public'),
    alarmTime: req.user.alarm_time,
    lastHubAt: getSetting('last_hub_at'),
    lastHubSummary: getSetting('last_hub_summary'),
  });
});
app.post('/api/settings/service-key', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '관리자만 바꿀 수 있습니다' });
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
  const kw = keyword.trim(), rg = (region || '').trim(), code = (itemCode || '').trim();
  // 추가 버튼 한 번으로 바로 등록되므로(더블클릭·재전송) 같은 품목+지역이 이미 있으면 막는다.
  // 품목번호가 있으면 번호+지역으로, 없으면(번호 못 찾은 필터) 이름+지역으로 같은지 본다.
  const dup = code
    ? db.prepare(`SELECT id FROM filters WHERE user_id = ? AND item_code = ? AND COALESCE(region, '') = ?`).get(req.user.id, code, rg)
    : db.prepare(`SELECT id FROM filters WHERE user_id = ? AND (item_code IS NULL OR item_code = '') AND keyword = ? AND COALESCE(region, '') = ?`).get(req.user.id, kw, rg);
  if (dup) return res.status(409).json({ error: '이미 추가된 품목·지역이에요' });
  const info = db.prepare(`INSERT INTO filters (user_id, keyword, region, item_code, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(req.user.id, kw, rg || null, code || null, new Date().toISOString());
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
// 이 기기(endpoint)가 지금 로그인한 계정으로 구독돼 있는지 — 화면이 로드될 때마다 "알림 켜짐"
// 표시를 실제 상태로 맞추는 데 쓴다. endpoint는 푸시를 보낼 수 있는 주소라 URL이 아니라 본문으로 받는다.
app.post('/api/push/status', (req, res) => {
  const { endpoint } = req.body || {};
  const row = endpoint ? db.prepare(`SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`).get(endpoint, req.user.id) : null;
  res.json({ subscribed: !!row });
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

// ─── 필터의 지역 조건 ─────────────────────────────────────
// 지역은 수요기관 소재지("경기도 수원시 권선구", "충청남도 천안시")에 대해 맞춘다. 원본은
// 정식 명칭이라 "충남"·"서울시"·"강원도" 같은 흔한 입력은 그대로는 안 걸려서 시도 약칭을 풀어준다.
const SIDO_ALIASES = {};
for (const [names, forms] of [
  [['서울', '서울시', '서울특별시'], ['서울특별시']],
  [['부산', '부산시', '부산광역시'], ['부산광역시']],
  [['대구', '대구시', '대구광역시'], ['대구광역시']],
  [['인천', '인천시', '인천광역시'], ['인천광역시']],
  [['광주광역시'], ['광주광역시']], // "광주"만 쓰면 경기도 광주시도 걸리게 그대로 둔다
  [['대전', '대전시', '대전광역시'], ['대전광역시']],
  [['울산', '울산시', '울산광역시'], ['울산광역시']],
  [['세종', '세종시', '세종특별자치시'], ['세종특별자치시']],
  [['경기', '경기도'], ['경기도']],
  [['강원', '강원도', '강원특별자치도'], ['강원특별자치도', '강원도']],
  [['충북', '충청북도'], ['충청북도']],
  [['충남', '충청남도'], ['충청남도']],
  [['전북', '전라북도', '전북특별자치도'], ['전북특별자치도', '전라북도']],
  [['전남', '전라남도'], ['전라남도']],
  [['경북', '경상북도'], ['경상북도']],
  [['경남', '경상남도'], ['경상남도']],
  [['제주', '제주도', '제주특별자치도'], ['제주특별자치도', '제주도']],
]) for (const n of names) SIDO_ALIASES[n] = forms;

// "서울, 경기 수원" → [[["서울특별시"]], [["경기도"], ["수원"]]]
// 쉼표로 나눈 묶음끼리는 OR, 묶음 안의 띄어쓴 단어들은 AND("경기 수원" = 경기도 수원시).
// 단, 묶음이 시도 이름만으로 돼 있으면("서울 경기") 한 곳이 두 시도일 순 없으니 OR로 본다.
// 단어 하나는 표기 후보들(전북특별자치도/전라북도 등) 중 아무거나 맞으면 된다.
function parseRegion(region) {
  const groups = [];
  for (const term of String(region || '').split(/[,，/]+/)) {
    const tokens = term.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const forms = tokens.map((t) => SIDO_ALIASES[t] || [t]);
    if (tokens.length > 1 && tokens.every((t) => SIDO_ALIASES[t])) forms.forEach((f) => groups.push([f]));
    else groups.push(forms);
  }
  return groups;
}

const LOCATION_SQL = `json_extract(raw_json, '$."수요기관소재시군구"')`;
function regionSql(region) {
  const groups = parseRegion(region);
  if (!groups.length) return null;
  const params = [];
  const like = (s) => { params.push(`%${s.replace(/[\\%_]/g, '\\$&')}%`); return `${LOCATION_SQL} LIKE ? ESCAPE '\\'`; };
  const sql = groups.map((g) => `(${g.map((forms) => `(${forms.map(like).join(' OR ')})`).join(' AND ')})`).join(' OR ');
  return { sql: `(${sql})`, params };
}
function regionMatcher(region) {
  const groups = parseRegion(region);
  if (!groups.length) return () => true;
  return (row) => {
    const loc = String(row['수요기관소재시군구'] || '');
    return groups.some((g) => g.every((forms) => forms.some((f) => loc.includes(f))));
  };
}

// 내 필터(세부품명번호 + 선택적 지역)를 hub_items WHERE 조건으로. filterId를 주면 그 필터
// 하나만, 안 주면("전체" 탭) 내 필터 전부의 합집합. 걸 게 없으면 null.
function myFiltersWhere(userId, filterId) {
  const filters = filterId
    ? db.prepare(`SELECT item_code, region FROM filters WHERE user_id = ? AND id = ? AND item_code IS NOT NULL`).all(userId, filterId)
    : db.prepare(`SELECT item_code, region FROM filters WHERE user_id = ? AND item_code IS NOT NULL`).all(userId);
  if (!filters.length) return null;
  const params = [];
  const parts = filters.map((f) => {
    params.push(f.item_code);
    const r = regionSql(f.region);
    if (!r) return '(item_code = ?)';
    params.push(...r.params);
    return `(item_code = ? AND ${r.sql})`;
  });
  return { sql: `(${parts.join(' OR ')})`, params };
}

// 표 머리글 정렬: 화면의 컬럼명만 허용(그대로 SQL에 넣지 않고 JSON 경로는 바인딩으로 넘긴다).
// 단가·수량·금액은 "255,400" 같은 문자열이라 쉼표를 빼고 숫자로 비교한다.
const SORTABLE_COLS = new Set(['조달방식', '업무구분', '계약구분', '계약(납품요구)일자', '수요기관', '수요기관소재시군구',
  '세부품명번호', '세부품명', '품목명', '업체명', '낙찰방법', '단위', '계약납품단가', '계약납품수량', '공급금액']);
function orderBySql(col, dir) {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  const tiebreak = 'contract_date DESC, contract_no DESC, item_seq';
  if (!SORTABLE_COLS.has(col) || col === '계약(납품요구)일자') return { sql: `contract_date ${d}, contract_no ${d}, item_seq`, params: [] };
  const path = `$."${col}"`;
  if (/단가|수량|금액/.test(col)) return { sql: `CAST(REPLACE(json_extract(raw_json, ?), ',', '') AS REAL) ${d}, ${tiebreak}`, params: [path] };
  return { sql: `json_extract(raw_json, ?) ${d}, ${tiebreak}`, params: [path] };
}

// 품목명은 "세부품명, 제조사, 모델, 규격…" 꼴로 들어와서, 앞의 세부품명·제조사(=업체)가 표의
// 세부품명·업체명 컬럼과 겹친다. 표시용으로는 그 겹치는 앞부분을 뺀다(원본 raw_json은 그대로).
//  - 맨 앞이 이 행의 세부품명이면 뺀다.
//  - 그다음 덩어리가 이 행의 업체명 컬럼과 같은 회사일 때만 뺀다("(주)"·"주식회사" 같은 표기는 무시).
//    업체명과 다른 제조사·상표 이름은 정보라서 남긴다.
//  - 빼고 나면 아무것도 안 남으면(품목명이 세부품명뿐) 원래 이름을 그대로 둔다.
// 쉼표 뒷부분은 문자열을 자르기만 해서 "TW-M400,1종"처럼 값 안의 쉼표도 그대로 보존된다.
const COMPANY_NOISE = /\([가-힣]{1,3}\)|㈜|주식회사|유한회사|합자회사|합명회사|\s+/g; // (주)·(합자)·(유) 같은 법인 표기 포함
const normCompany = (s) => String(s || '').replace(COMPANY_NOISE, '').toLowerCase();
function cleanItemName(row) {
  const name = String(row['품목명'] || '').trim();
  const detail = String(row['세부품명'] || '').trim();
  if (!name || !detail || !name.startsWith(detail)) return name;
  let rest = name.slice(detail.length).match(/^\s*,\s*([\s\S]*)$/);
  if (!rest) return name;
  rest = rest[1];
  const comma = rest.indexOf(',');
  const token = comma < 0 ? rest : rest.slice(0, comma);
  const t = normCompany(token), c = normCompany(row['업체명']);
  // 같은 회사: 이름이 같거나, 2글자 이상 줄임말이 회사명 앞부분("남일" ← "남일스페이스")이거나 3글자 이상이 포함될 때
  if (t && c && (t === c || (t.length >= 2 && c.startsWith(t)) || (t.length >= 3 && c.includes(t)))) rest = comma < 0 ? '' : rest.slice(comma + 1).trimStart();
  return rest || name;
}
const toDisplayRow = (rawJson) => { const j = JSON.parse(rawJson); j['품목명'] = cleanItemName(j); return j; };
// 품목명 정렬은 화면에 보이는(정리된) 이름 기준이어야 해서 SQL이 아니라 여기서 한다(필터로 좁힌 행만이라 작다).
// sort()는 안정 정렬이라 같은 이름끼리는 SQL이 준 최신 계약순이 유지된다.
const sortByDisplayName = (rows, dir) => rows.sort((a, b) => (dir === 'asc' ? 1 : -1) * String(a['품목명']).localeCompare(String(b['품목명']), 'ko'));

// ─── 표 머리글 값 필터(엑셀의 열 필터처럼) ────────────────────
// cf = { 컬럼명: [허용할 값…] } — 화면 컬럼명 화이트리스트만 받고 값은 문자열로. 컬럼당 최대 1000개.
// 빈 배열은 "아무것도 선택 안 함"이라 아무 행도 안 맞는 걸로 본다. 빈 값은 ''로 통일(없는 키 = 빈 문자열).
// GET은 cf를 JSON 문자열로, POST는 객체로 받는다(값을 많이 고르면 URL이 너무 길어져서 POST를 쓴다).
function parseColFilters(cf) {
  if (typeof cf === 'string') { try { cf = JSON.parse(cf); } catch (e) { return {}; } }
  const out = {};
  if (!cf || typeof cf !== 'object' || Array.isArray(cf)) return out;
  for (const [col, vals] of Object.entries(cf)) {
    if (!SORTABLE_COLS.has(col) || !Array.isArray(vals)) continue;
    out[col] = [...new Set(vals.slice(0, 1000).map((v) => String(v ?? '')))];
  }
  return out;
}
const colExpr = `COALESCE(json_extract(raw_json, ?), '')`;

// 내 필터(탭) + 기간 + 컬럼 값 필터를 WHERE로. skipCol은 그 컬럼 자신의 필터는 빼고(값 목록용 —
// 그래야 이미 고른 값도 목록에 남아 다시 바꿀 수 있다). 품목명은 화면에 보이는(정리된) 이름 기준이라
// SQL로 못 걸러서 nameSet으로 돌려주고 호출한 쪽이 JS에서 거른다. 탭에 걸 필터가 없으면 null.
function buildHubQuery(userId, q, skipCol) {
  const scope = myFiltersWhere(userId, Number(q.filter) || null);
  if (!scope) return null;
  const conds = [scope.sql], params = [...scope.params];
  const from = String(q.from || '').trim(), to = String(q.to || '').trim();
  if (from) { conds.push('contract_date >= ?'); params.push(from); }
  if (to) { conds.push('contract_date <= ?'); params.push(to); }
  let nameSet = null;
  for (const [col, vals] of Object.entries(parseColFilters(q.cf))) {
    if (col === skipCol) continue;
    if (col === '품목명') { nameSet = new Set(vals); continue; }
    if (!vals.length) { conds.push('0'); continue; }
    conds.push(`${colExpr} IN (${vals.map(() => '?').join(',')})`);
    params.push(`$."${col}"`, ...vals);
  }
  return { where: 'WHERE ' + conds.join(' AND '), params, nameSet };
}

// 화면 목록·엑셀이 같이 쓰는 조회. 정렬은 SQL로 하고, 품목명으로 정렬하거나 거를 때만(화면에 보이는
// 이름이 SQL에 없어서) 행을 모두 읽어 JS에서 처리한다. 반환 rows는 offset부터 limit개의 표시용 행.
function queryHubRows(userId, q, offset, limit) {
  const bq = buildHubQuery(userId, q);
  if (!bq) return { rows: [], total: 0 };
  const byName = q.sort === '품목명';
  if (byName || bq.nameSet) {
    const order = byName ? { sql: 'contract_date DESC, contract_no DESC, item_seq', params: [] } : orderBySql(q.sort, q.dir);
    let all = db.prepare(`SELECT raw_json FROM hub_items ${bq.where} ORDER BY ${order.sql}`).all(...bq.params, ...order.params)
      .map((r) => toDisplayRow(r.raw_json));
    if (bq.nameSet) all = all.filter((r) => bq.nameSet.has(r['품목명']));
    if (byName) sortByDisplayName(all, q.dir);
    return { rows: all.slice(offset, offset + limit), total: all.length };
  }
  const order = orderBySql(q.sort, q.dir);
  const total = db.prepare(`SELECT COUNT(*) c FROM hub_items ${bq.where}`).get(...bq.params).c;
  const rows = db.prepare(`SELECT raw_json FROM hub_items ${bq.where} ORDER BY ${order.sql} LIMIT ? OFFSET ?`)
    .all(...bq.params, ...order.params, limit, offset).map((r) => toDisplayRow(r.raw_json));
  return { rows, total };
}

// 조달데이터허브에서 긁어온 라인아이템을 내 필터(품목번호+지역)로 좁혀서 본다.
// 기간(from/to)·컬럼 값 필터(cf)·정렬(sort/dir)·페이지(page/pageSize)는 서버에서 처리한다(페이지를 넘겨도 유지).
const hubItemsHandler = (req, res) => {
  const q = req.method === 'POST' ? req.body || {} : req.query;
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(Math.max(1, Number(q.pageSize) || 20), 200);
  const { rows, total } = queryHubRows(req.user.id, q, (page - 1) * pageSize, pageSize);
  res.json({ rows, total, page, pageSize });
};
app.get('/api/hub-items', hubItemsHandler);
app.post('/api/hub-items', hubItemsHandler);

// 머리글 메뉴의 체크박스 목록: 지금 보고 있는 범위(탭·기간·다른 컬럼의 필터)에서 그 컬럼에 실제로 있는
// 값과 건수. 자기 컬럼 필터는 빼고 센다. q는 값 검색어, 너무 많으면(1000개 초과) truncated로 알린다.
const VALUES_MAX = 1000;
app.post('/api/hub-items/values', (req, res) => {
  const q = req.body || {};
  const col = String(q.col || '');
  if (!SORTABLE_COLS.has(col)) return res.status(400).json({ error: '알 수 없는 컬럼' });
  const bq = buildHubQuery(req.user.id, q, col);
  if (!bq) return res.json({ values: [], total: 0, truncated: false });

  let counts;
  if (col === '품목명') {
    counts = new Map();
    for (const r of db.prepare(`SELECT raw_json FROM hub_items ${bq.where}`).all(...bq.params)) {
      const v = toDisplayRow(r.raw_json)['품목명'];
      counts.set(v, (counts.get(v) || 0) + 1);
    }
  } else {
    counts = new Map(db.prepare(`SELECT ${colExpr} v, COUNT(*) n FROM hub_items ${bq.where} GROUP BY v`)
      .all(`$."${col}"`, ...bq.params).map((r) => [r.v, r.n]));
  }
  let values = [...counts].map(([v, n]) => ({ v, n }));
  const needle = String(q.q || '').trim().toLowerCase();
  if (needle) values = values.filter((x) => x.v.toLowerCase().includes(needle));
  const numeric = /단가|수량|금액/.test(col);
  const num = (s) => Number(String(s).replace(/,/g, '')) || 0;
  values.sort((a, b) => (a.v === '' ? -1 : b.v === '' ? 1 : numeric ? num(a.v) - num(b.v) : a.v.localeCompare(b.v, 'ko')));
  res.json({ values: values.slice(0, VALUES_MAX), total: values.length, truncated: values.length > VALUES_MAX });
});

// 탭 라벨에 쓰는 필터별 전체 건수(기간 필터 없이, 지역 조건은 반영) — 표와 별개로 가볍게 조회.
app.get('/api/hub-items/counts', (req, res) => {
  const count = (scope) => (scope ? db.prepare(`SELECT COUNT(*) c FROM hub_items WHERE ${scope.sql}`).get(...scope.params).c : 0);
  const byFilter = {};
  for (const f of db.prepare(`SELECT id FROM filters WHERE user_id = ?`).all(req.user.id)) {
    byFilter[f.id] = count(myFiltersWhere(req.user.id, f.id));
  }
  res.json({ total: count(myFiltersWhere(req.user.id, null)), byFilter });
});

// 화면에 보이는 목록(같은 탭·기간·컬럼 값 필터·정렬·컬럼 순서)을 페이지 구분 없이 전부 엑셀로.
// /api/hub-items와 같은 조회 함수를 써서 화면과 파일 내용이 어긋나지 않게 한다.
// 값 필터를 많이 고르면 URL이 길어지므로 화면은 POST로 부르고, GET도 그대로 받는다.
const EXPORT_MAX_ROWS = 50000;
const exportHandler = (req, res) => {
  const q = req.method === 'POST' ? req.body || {} : req.query;
  const filterId = Number(q.filter) || null;
  const from = String(q.from || '').trim();
  const to = String(q.to || '').trim();
  const colList = Array.isArray(q.cols) ? q.cols : String(q.cols || '').split(',');
  const cols = colList.filter((c) => SORTABLE_COLS.has(c));
  const header = cols.length ? [...new Set(cols)] : [...SORTABLE_COLS];

  const { rows: list } = queryHubRows(req.user.id, q, 0, EXPORT_MAX_ROWS);
  const rows = list.map((j) => header.map((c) => j[c] ?? ''));

  const f = filterId ? db.prepare(`SELECT keyword, region FROM filters WHERE id = ? AND user_id = ?`).get(filterId, req.user.id) : null;
  const label = f ? `${f.keyword}${f.region ? `_${f.region}` : ''}` : '전체';
  const period = from || to ? `${from || '처음'}-${to || '끝'}` : '전체기간';
  const filtered = Object.keys(parseColFilters(q.cf)).length ? '_필터적용' : '';
  const filename = `나라장터_조달내역_${label}_${period}${filtered}.xlsx`.replace(/[\/:*?"<>|,\s]+/g, '_');
  const buf = buildXlsx({ sheetName: label, header, rows, numeric: header.map((c) => /단가|수량|금액/.test(c)) });
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="g2b-export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  }).send(buf);
};
app.get('/api/hub-items/export', exportHandler);
app.post('/api/hub-items/export', exportHandler);

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
  // 같은 사용자가 같은 품목에 지역만 다르게 필터를 여러 개 걸 수 있다 — 그중 하나라도
  // 맞는 행만 모아서, 사용자당 알림은 한 번만 보낸다(지역이 안 맞으면 안 보냄).
  const byUser = new Map();
  for (const f of db.prepare(`SELECT * FROM filters WHERE item_code = ?`).all(itemCode)) {
    const e = byUser.get(f.user_id) || { filter: f, matchers: [] };
    e.matchers.push(regionMatcher(f.region));
    byUser.set(f.user_id, e);
  }
  for (const [userId, { filter: f, matchers }] of byUser) {
    const matched = recent.filter((r) => matchers.some((m) => m(r)));
    if (!matched.length) continue;
    const top = matched.slice(0, 3)
      .map((r) => `${r['품목명'] || itemCode} / ${r['수요기관'] || '기관 미확인'} / ${r['계약납품단가'] ? r['계약납품단가'] + '원' : ''}`)
      .join('\n');
    await sendPushToUser(userId, {
      title: `나라장터 신규 계약 ${matched.length}건 - ${f.keyword}${matchers.length === 1 && f.region ? ` · ${f.region}` : ''}`,
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

// 재시작 뒤에도 알림 설정이 남아 있는지 로그만 보고 알 수 있게, 부팅 때 요약을 남긴다(개수·시간만).
{
  const n = (sql) => db.prepare(sql).get().c;
  const times = db.prepare(`SELECT alarm_time t, COUNT(*) c FROM users GROUP BY alarm_time ORDER BY alarm_time`).all()
    .map((r) => `${r.t}(${r.c}명)`).join(' ') || '없음';
  console.log(`[boot] 관리자 ${[...ADMIN_USERNAMES].join(',')} · 사용자 ${n('SELECT COUNT(*) c FROM users')}명 · 필터 ${n('SELECT COUNT(*) c FROM filters')}건 · 푸시 구독 ${n('SELECT COUNT(*) c FROM push_subscriptions')}건 · 알림 시간 ${times}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`g2b-alert listening on ${PORT}`));
