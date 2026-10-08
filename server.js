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
const { Worker } = require('worker_threads');
const compression = require('compression');
const hubq = require('./hubquery');

const app = express();
app.disable('x-powered-by');
// nginx 한 단계 뒤에서 돈다 → X-Forwarded-For의 마지막 값(nginx가 붙인 실제 접속자 IP)을 req.ip로 쓴다.
// 요청 제한이 IP별로 동작하려면 필수다(안 하면 모두 같은 IP로 보여 한 명이 막히면 전원이 막힌다).
app.set('trust proxy', 1);
// JSON 응답·HTML을 압축한다(목록 한 페이지 약 30KB → 약 5KB, 폰·느린 망에서 체감이 크다). nginx는 HTML만 압축한다.
app.use(compression());
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
// WAL: 읽는 쪽과 쓰는 쪽이 서로 막지 않는다. 수집 스크립트(별도 프로세스)가 hub_items에 쓰는 동안에도, 엑셀 전용
// 스레드가 따로 읽는 동안에도 일반 요청이 멈추지 않는다(예전 방식은 쓰는 동안 읽기가 최대 5초 대기했다).
// synchronous=NORMAL은 WAL에서 안전하다(정전 시 마지막 몇 건만 잃을 수 있고 파일은 깨지지 않는다).
const journalMode = db.pragma('journal_mode = WAL', { simple: true });
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -32768'); // 페이지 캐시 32MB
db.pragma('temp_store = MEMORY');
if (journalMode !== 'wal') console.warn(`[db] WAL을 켜지 못했습니다(journal_mode=${journalMode}) — 동시 접속 성능이 떨어집니다`);

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

// 조회용 가벼운 색인 표(hub_idx)와 트리거를 보장한다 — 자세한 이유는 hubquery.js 맨 위 설명 참고
{
  const t0 = Date.now();
  const r = hubq.ensureHubIndex(db);
  if (r.added || r.orphan) console.log(`[db] 조회용 색인 표 정리: 추가 ${r.added}행, 제거 ${r.orphan}행 (${Date.now() - t0}ms)`);
  // 정리된 품목명(JS가 필요한 열)은 부팅을 막지 않도록 조금씩 나눠 채운다. 그 사이 품목명 정렬·필터 요청은 남은 만큼 즉시 채운다.
  const step = () => { try { if (hubq.fillNames(db, 3000)) setImmediate(step); } catch (e) { console.error('[db] 품목명 채우기 실패:', e.message); } };
  setImmediate(step);
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
// scrypt는 일부러 느린 함수(약 60~100ms, 메모리도 씀)라서 동기 버전을 쓰면 그동안 서버 전체가 멈춘다 — 로그인·가입이
// 몰리면 다른 사용자의 모든 요청이 줄줄이 늦어진다. 비동기 버전은 별도 스레드풀에서 돌아 서버가 계속 일한다.
const scryptAsync = (pw, salt) => new Promise((resolve, reject) => crypto.scrypt(pw, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scryptAsync(pw, salt)).toString('hex')}`;
}
function hashPasswordSync(pw) { // 부팅 때 한 번 도는 옛 비밀번호 이전용(요청 처리 중엔 쓰지 않는다)
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [scheme, salt, hashHex] = (stored || '').split(':');
  if (scheme !== 'scrypt' || !salt || !hashHex) return false;
  const candidate = await scryptAsync(pw, salt);
  const expected = Buffer.from(hashHex, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
// 없는 아이디도 같은 시간이 걸리게 하려고 쓰는 가짜 해시(응답 시간으로 가입 여부를 알아내지 못하게)
const DUMMY_HASH = hashPasswordSync(crypto.randomBytes(8).toString('hex'));

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
      .run('admin', hashPasswordSync(legacyPassword), legacyAlarmTime, new Date().toISOString());
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

app.use('/api/hub-items', express.json({ limit: '1mb' })); // 값 필터를 많이 고른 표 요청은 클 수 있다
app.use(express.json({ limit: '64kb' }));

// ─── 계정 인증 (아이디+비밀번호, 세션 쿠키) ──────────────────
function parseCookies(req) {
  const out = {}; const h = req.headers.cookie || '';
  h.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
// https(nginx가 X-Forwarded-Proto로 알려줌)로 들어온 요청이면 Secure를 붙여 http로는 쿠키가 나가지 않게 한다
const cookieTail = (req) => `Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;
function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', `app_auth=${encodeURIComponent(token)}; Max-Age=31536000; ${cookieTail(req)}`);
}

// ─── 요청 제한(메모리, 의존성 없음) ───────────────────────────
// 한 사람(또는 봇)이 서버를 독차지하지 못하게 창(windowMs) 안에서 max번까지만 받고 넘으면 429로 기다리게 한다.
// 키는 IP(로그인 전) 또는 사용자 id(로그인 후). 서버를 재시작하면 초기화된다.
// RATE_LIMIT_MULTIPLIER(환경변수, 기본 1)로 모든 제한을 한꺼번에 늘리거나 줄일 수 있다(예: 사무실 한 곳에서 다 같이 쓸 때 2~3배).
const RATE_LIMIT_MULTIPLIER = Number(process.env.RATE_LIMIT_MULTIPLIER) > 0 ? Number(process.env.RATE_LIMIT_MULTIPLIER) : 1;
function makeLimiter({ windowMs, max: baseMax, key, message }) {
  const max = Math.max(1, Math.round(baseMax * RATE_LIMIT_MULTIPLIER));
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, 60 * 1000).unref();
  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    let e = hits.get(k);
    if (!e || e.reset <= now) {
      if (hits.size > 50000) hits.clear(); // 서로 다른 IP가 수만 개 몰려도 메모리가 무한히 늘지 않게
      e = { n: 0, reset: now + windowMs };
      hits.set(k, e);
    }
    if (++e.n > max) {
      const secs = Math.max(1, Math.ceil((e.reset - now) / 1000));
      res.set('Retry-After', String(secs));
      return res.status(429).json({ error: `${message} ${secs >= 90 ? Math.ceil(secs / 60) + '분' : secs + '초'} 뒤에 다시 시도해 주세요.` });
    }
    next();
  };
}
const byIp = (req) => `ip:${req.ip}`;
const byUser = (req) => (req.user ? `u:${req.user.id}` : byIp(req));
const loginLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 30, key: byIp, message: '로그인 시도가 너무 많아요.' });
const registerLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 10, key: byIp, message: '가입 요청이 너무 많아요.' });
const generalLimiter = makeLimiter({ windowMs: 60 * 1000, max: 400, key: byUser, message: '요청이 너무 많아요.' });
const exportLimiter = makeLimiter({ windowMs: 60 * 1000, max: 8, key: byUser, message: '엑셀 저장을 너무 자주 눌렀어요.' });
const queryLimiter = makeLimiter({ windowMs: 60 * 1000, max: 10, key: byUser, message: '조회 요청이 너무 많아요.' });
const lookupLimiter = makeLimiter({ windowMs: 60 * 1000, max: 30, key: byUser, message: '품목 검색이 너무 잦아요.' });
const passwordLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 10, key: byUser, message: '비밀번호 변경 시도가 너무 많아요.' });

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const pw = typeof password === 'string' ? password.slice(0, 200) : '';
  const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(String(username || '').trim());
  const ok = await verifyPassword(pw, user ? user.password_hash : DUMMY_HASH); // 없는 아이디도 같은 시간을 들인다
  if (!user || !ok) return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다' });
  setSessionCookie(req, res, createSession(user.id));
  res.json({ ok: true, username: user.username });
});

app.post('/api/register', registerLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim();
  if (!uname || uname.length < 3) return res.status(400).json({ error: '아이디는 3자 이상이어야 합니다' });
  if (!/^[a-zA-Z0-9_-]+$/.test(uname)) return res.status(400).json({ error: '아이디는 영문/숫자/-/_ 만 가능합니다' });
  if (uname.length > 40) return res.status(400).json({ error: '아이디는 40자 이하여야 합니다' });
  if (typeof password !== 'string' || password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다' });
  if (password.length > 200) return res.status(400).json({ error: '비밀번호는 200자 이하여야 합니다' });
  if (db.prepare(`SELECT id FROM users WHERE username = ?`).get(uname)) {
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다' });
  }
  const hash = await hashPassword(password); // 해시하는 동안 같은 아이디로 동시에 가입이 들어올 수 있어 저장 직전에 다시 확인한다
  if (db.prepare(`SELECT id FROM users WHERE username = ?`).get(uname)) return res.status(409).json({ error: '이미 사용 중인 아이디입니다' });
  const info = db.prepare(`INSERT INTO users (username, password_hash, alarm_time, created_at) VALUES (?, ?, ?, ?)`)
    .run(uname, hash, '07:00', new Date().toISOString());
  setSessionCookie(req, res, createSession(info.lastInsertRowid));
  res.json({ ok: true, username: uname });
});

app.post('/api/logout', (req, res) => {
  destroySession(req);
  res.setHeader('Set-Cookie', `app_auth=; Max-Age=0; ${cookieTail(req)}`);
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
app.use('/api/', generalLimiter);
app.use('/api/hub-items/export', exportLimiter);
app.use('/api/hub-query', queryLimiter);
app.use('/api/item-lookup', lookupLimiter);
app.use('/api/settings/password', passwordLimiter);

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

app.post('/api/settings/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 모두 입력하세요' });
  if (!(await verifyPassword(currentPassword.slice(0, 200), req.user.password_hash))) return res.status(401).json({ error: '현재 비밀번호가 틀렸습니다' });
  if (newPassword.length < 4) return res.status(400).json({ error: '새 비밀번호는 4자 이상이어야 합니다' });
  if (newPassword.length > 200) return res.status(400).json({ error: '새 비밀번호는 200자 이하여야 합니다' });
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(await hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

app.get('/api/filters', (req, res) => {
  res.json(db.prepare(`SELECT * FROM filters WHERE user_id = ? ORDER BY id DESC`).all(req.user.id));
});

// 모든 사용자가 같은 data.go.kr 서비스키를 나눠 쓰므로(하루 호출 한도가 있다) 같은 검색어는 다시 부르지 않는다.
const lookupCache = new Map();
const lookupInflight = new Map();
const LOOKUP_TTL_MS = 60 * 60 * 1000, LOOKUP_MAX = 500;
app.get('/api/item-lookup', async (req, res) => {
  const keyword = String(req.query.keyword || '').trim().slice(0, 50);
  if (!keyword) return res.status(400).json({ error: '검색어가 필요합니다' });
  const serviceKey = getSetting('g2b_service_key');
  if (!serviceKey) return res.status(400).json({ error: '서비스키가 설정되지 않았습니다' });
  const ck = keyword.toLowerCase();
  const hit = lookupCache.get(ck);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return res.json({ items: hit.items });
  try {
    let p = lookupInflight.get(ck);
    if (!p) {
      p = searchItemCodes(serviceKey, keyword)
        .then(({ items }) => items.map((it) => { const m = summarizeItem(it); return { name: m.name, code: m.code, desc: m.desc }; }))
        .finally(() => lookupInflight.delete(ck));
      lookupInflight.set(ck, p);
    }
    const items = await p;
    if (lookupCache.size >= LOOKUP_MAX) lookupCache.delete(lookupCache.keys().next().value);
    lookupCache.set(ck, { at: Date.now(), items });
    res.json({ items });
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

// ─── 조달 내역 표(목록·값 목록·건수·엑셀) ─────────────────────
// 조회 로직은 hubquery.js(가벼운 색인 표 hub_idx 기반). 기간(from/to)·컬럼 값 필터(cf)·정렬(sort/dir)·페이지는 모두
// 서버가 전체 기준으로 처리해서 페이지를 넘겨도 유지된다. 값을 많이 고르면 GET 주소가 길어져서 화면은 POST로 부른다(GET도 받음).
const hubItemsHandler = (req, res) => {
  const q = req.method === 'POST' ? req.body || {} : req.query;
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(Math.max(1, Number(q.pageSize) || 20), 200);
  const { rows, total } = hubq.listRows(db, req.user.id, q, (page - 1) * pageSize, pageSize);
  res.json({ rows, total, page, pageSize });
};
app.get('/api/hub-items', hubItemsHandler);
app.post('/api/hub-items', hubItemsHandler);

// 머리글 ▾ 메뉴의 체크박스 목록: 지금 범위(탭·기간·다른 컬럼 필터)에서 그 컬럼에 실제로 있는 값과 건수.
app.post('/api/hub-items/values', (req, res) => {
  const q = req.body || {};
  const r = hubq.distinctValues(db, req.user.id, q, String(q.col || ''), q.q);
  if (!r) return res.status(400).json({ error: '알 수 없는 컬럼' });
  res.json(r);
});

// 탭 라벨에 쓰는 필터별 전체 건수(기간 필터 없이, 지역 조건은 반영). 결과는 hubquery 안에서 잠깐 기억한다.
app.get('/api/hub-items/counts', (req, res) => res.json(hubq.countsFor(db, req.user.id)));

// 화면에 보이는 목록(같은 탭·기간·컬럼 값 필터·정렬·컬럼 순서)을 페이지 구분 없이 전부 엑셀로.
// 수만 행을 읽고 압축하는 일은 CPU를 오래 써서 서버 본체를 멈추므로 전용 스레드(exportWorker.js)에서 만든다.
// 동시에 2개까지 돌리고 더 오면 짧게 줄을 세우며(최대 4개), 그보다 많으면 잠시 후 다시 하라고 알린다.
const EXPORT_MAX_ROWS = 50000, EXPORT_PARALLEL = 2, EXPORT_QUEUE_MAX = 4, EXPORT_TIMEOUT_MS = 60 * 1000;
let exportsRunning = 0;
const exportWaiters = [];
async function withExportSlot(fn) {
  if (exportsRunning >= EXPORT_PARALLEL) {
    if (exportWaiters.length >= EXPORT_QUEUE_MAX) { const e = new Error('지금 엑셀 저장 요청이 많아요. 잠시 뒤에 다시 눌러 주세요.'); e.status = 503; throw e; }
    await new Promise((resolve) => exportWaiters.push(resolve));
  }
  exportsRunning++;
  try { return await fn(); } finally { exportsRunning--; const next = exportWaiters.shift(); if (next) next(); }
}
function runExportWorker(payload) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'exportWorker.js'), { workerData: payload });
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { w.terminate(); finish(reject, new Error('엑셀 만들기 시간이 너무 오래 걸려 중단했어요')); }, EXPORT_TIMEOUT_MS);
    w.once('message', (m) => (m.ok ? finish(resolve, m) : finish(reject, new Error(m.error))));
    w.once('error', (e) => finish(reject, e));
    w.once('exit', (code) => finish(reject, new Error(`엑셀 작업이 비정상 종료했어요(${code})`)));
  });
}
const exportHandler = async (req, res) => {
  const q = req.method === 'POST' ? req.body || {} : req.query;
  const filterId = Number(q.filter) || null;
  const from = String(q.from || '').trim();
  const to = String(q.to || '').trim();
  const colList = Array.isArray(q.cols) ? q.cols : String(q.cols || '').split(',');
  const cols = colList.filter((c) => hubq.SORTABLE_COLS.has(c));
  const header = cols.length ? [...new Set(cols)] : [...hubq.SORTABLE_COLS];

  const f = filterId ? db.prepare(`SELECT keyword, region FROM filters WHERE id = ? AND user_id = ?`).get(filterId, req.user.id) : null;
  const label = f ? `${f.keyword}${f.region ? `_${f.region}` : ''}` : '전체';
  const period = from || to ? `${from || '처음'}-${to || '끝'}` : '전체기간';
  const filtered = Object.keys(hubq.parseColFilters(q.cf)).length ? '_필터적용' : '';
  const filename = `나라장터_조달내역_${label}_${period}${filtered}.xlsx`.replace(/[\\/:*?"<>|,\s]+/g, '_');

  hubq.ensureNames(db, q); // 전용 스레드는 읽기 전용이라 비어 있는 품목명은 여기서 미리 채운다
  const out = await withExportSlot(() => runExportWorker({
    dbPath: DB_PATH, userId: req.user.id, header, label, max: EXPORT_MAX_ROWS,
    q: { filter: q.filter, from: q.from, to: q.to, cf: q.cf, sort: q.sort, dir: q.dir },
  }));
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="g2b-export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  }).send(Buffer.from(out.buf));
};
app.get('/api/hub-items/export', (req, res) => exportHandler(req, res).catch((e) => res.status(e.status || 500).json({ error: e.message })));
app.post('/api/hub-items/export', (req, res) => exportHandler(req, res).catch((e) => res.status(e.status || 500).json({ error: e.message })));

// 검색엔진용 공개 페이지(/, /items, /item/:code, robots.txt, sitemap.xml) — "/"를 static보다
// 먼저 가로채야 해서 이 위치에 둔다.
registerSeoRoutes(app, { db, getSessionUser });
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/[\\/]icons[\\/]|og-image\.png$|favicon\.(ico|svg)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));

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
const SCRAPE_SCRIPT = process.env.SCRAPE_SCRIPT || path.join(__dirname, 'scripts', 'scrape-hub.js');
// 수집 하나(품목 하나)가 이 시간을 넘기면 멈춘 걸로 보고 강제로 끝낸다. 이게 없으면 허브 사이트가 응답하지 않을 때
// 브라우저가 영원히 매달려서 그 뒤의 모든 수집(과 알림)이 서버를 재시작할 때까지 막힌다.
const HUB_SCRAPE_TIMEOUT_MS = Number(process.env.HUB_SCRAPE_TIMEOUT_MS) || 8 * 60 * 1000;

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

// 한국 날짜(KST) 기준 YYYYMMDD. 서버 시계는 UTC라서 toISOString()으로 날짜를 만들면 한국 새벽~아침 9시 사이에는
// 하루 전 날짜가 나온다(아침 7시 알림이 "어제"를 그저께로 계산하던 버그의 원인).
const kstYmd = (offsetDays = 0) => new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10).replace(/-/g, '');

let currentChild = null;
// 자식(과 그가 띄운 크로미움)을 통째로 끝낸다. 리눅스에서는 프로세스 그룹으로 보내야 크로미움이 고아로 안 남는다.
function killTree(child, signal) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (e) { try { child.kill(signal); } catch (e2) { /* 이미 끝났음 */ } }
}
function killScrapeChild() { killTree(currentChild, 'SIGKILL'); }

function runHubScrape(code, fromDate, toDate, onStep) {
  return new Promise((resolve) => {
    const newRowsFile = path.join(path.dirname(DB_PATH), `hub-new-${code}-${process.pid}.json`);
    const args = [SCRAPE_SCRIPT, code];
    if (fromDate && toDate) args.push(fromDate, toDate);
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: { ...process.env, HUB_SHOTS: '0', NEW_ROWS_FILE: newRowsFile }, // 서버에선 스크린샷 생략
      detached: process.platform !== 'win32', // 새 프로세스 그룹 — killTree가 크로미움까지 정리할 수 있게
    });
    currentChild = child;
    let tail = '';
    let lineBuf = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[hub] ${code} 수집이 ${Math.round(HUB_SCRAPE_TIMEOUT_MS / 1000)}초를 넘겨 강제 종료합니다`);
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref();
    }, HUB_SCRAPE_TIMEOUT_MS);
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
    child.on('error', (e) => { // 실행 파일을 못 띄운 경우(예전에는 아무 처리가 없어 영원히 끝나지 않았다)
      clearTimeout(timer);
      if (currentChild === child) currentChild = null;
      resolve({ exitCode: -1, count: null, newRows: [], tail: `프로세스 실행 실패: ${e.message}`, timedOut: false });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (currentChild === child) currentChild = null;
      const m = tail.match(/중복 제거 후 (\d+)건/);
      let newRows = [];
      try {
        if (fs.existsSync(newRowsFile)) {
          newRows = JSON.parse(fs.readFileSync(newRowsFile, 'utf8'));
          fs.unlinkSync(newRowsFile);
        }
      } catch (e) { console.error('[hub] 신규 항목 파일 읽기 실패:', e.message); }
      resolve({ exitCode: timedOut ? 124 : (exitCode ?? -1), count: m ? Number(m[1]) : null, newRows, tail, timedOut });
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
// (오늘치는 아직 집계가 안 끝나 선택이 안 되는 걸로 보임, 실측 확인함) — 그래서 한국 날짜 기준 어제까지로 잡는다.
function defaultScrapeWindow() {
  const toDate = kstYmd(-1);
  return { fromDate: addDaysYmd(toDate, -6), toDate };
}

// ─── 알림 ─────────────────────────────────────────────────────────
// 알림 규칙: "처음 발견된 신규 계약"을 알린다. 허브 자료는 계약일보다 며칠 늦게(보통 2~8일, 연휴에는 더) 올라오기 때문에
// "계약일이 최근 3일 이내인 것만"이라는 예전 규칙은 거의 모든 신규 건을 걸러내서 알림이 안 갔다(어제 49건 → 0건).
//  - 자동 수집(크론): 수집 기간(최근 7일)에 처음 나타난 행은 전부 신규다 → 모두 알린다.
//  - 수동 "조회": 사용자가 아주 옛날 기간을 골라 처음 긁어 오는 경우가 있어서(과거 자료 채우기), 계약일이 10일 이내인
//    행만 알린다. 그보다 오래된 행은 말없이 DB에 들어간다.
// 신규는 hub_items의 기본키로 한 번만 감지되므로, 그 순간 알리지 않으면 그 품목을 보는 다른 사용자는 영영 못 받는다 —
// 그래서 수집을 누가 시켰든 그 품목을 보는 모든 사용자에게 보낸다.
const MANUAL_NOTIFY_DAYS = 10;
const isFreshForManual = (row) => /^\d{8}$/.test(row['계약(납품요구)일자'] || '') && row['계약(납품요구)일자'] >= kstYmd(-MANUAL_NOTIFY_DAYS);

// 푸시 한 사용자(그 사용자의 모든 기기)에게 보낸다. 결과를 로그로 남긴다 — 예전에는 404/410 말고는 실패해도
// 아무 기록이 없어서 알림이 안 갔을 때 원인을 알 수 없었다(주소·키는 기록하지 않는다).
async function sendPushToUser(userId, payload) {
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`).all(userId);
  const body = JSON.stringify(payload);
  const out = { subs: subs.length, sent: 0, failed: 0, removed: 0 };
  for (const sub of subs) {
    try {
      // TTL: 기기가 꺼져 있어도 하루 안에는 전달한다(그 뒤에는 오래된 소식이라 버린다)
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, { TTL: 86400 });
      out.sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(sub.endpoint);
        out.removed++;
      } else {
        out.failed++;
        let host = '?';
        try { host = new URL(sub.endpoint).host; } catch (e) { /* 주소 형식 오류 */ }
        console.error(`[push] user#${userId} 발송 실패 status=${err.statusCode || '-'} 서비스=${host} ${String(err.body || err.message).slice(0, 160)}`);
      }
    }
  }
  console.log(`[push] user#${userId} 구독 ${out.subs}건 → 성공 ${out.sent} 실패 ${out.failed} 만료삭제 ${out.removed}`);
  return out;
}

// 한 작업(수집 한 번)에서 새로 발견된 행을 모아 두었다가, 사용자마다 알림 한 번으로 묶어 보낸다
// (품목이 여러 개여도 아침에 푸시가 줄줄이 오지 않게).
class NotifyBatch {
  constructor(mode) { this.mode = mode; this.byCode = new Map(); }
  add(code, rows) { if (rows && rows.length) this.byCode.set(code, (this.byCode.get(code) || []).concat(rows)); }
  async flush() {
    const perUser = new Map(); // userId → Map(code → { keyword, rows })
    let newTotal = 0;
    for (const [code, all] of this.byCode) {
      const rows = this.mode === 'cron' ? all : all.filter(isFreshForManual);
      newTotal += all.length;
      if (!rows.length) continue;
      const filtersByUser = new Map();
      for (const f of db.prepare(`SELECT user_id, keyword, region FROM filters WHERE item_code = ?`).all(code)) {
        const l = filtersByUser.get(f.user_id) || [];
        l.push({ keyword: f.keyword, region: f.region, match: hubq.regionMatcher(f.region) });
        filtersByUser.set(f.user_id, l);
      }
      for (const [userId, list] of filtersByUser) {
        for (const r of rows) {
          const hit = list.find((x) => x.match(r)); // 지역이 하나라도 맞는 필터가 있으면 그 사용자의 신규 건
          if (!hit) continue;
          const groups = perUser.get(userId) || new Map();
          const g = groups.get(code) || { keyword: hit.keyword, rows: [] };
          g.rows.push(r);
          groups.set(code, g);
          perUser.set(userId, groups);
        }
      }
    }
    const targets = [...perUser];
    // 사용자가 많아도 느린 푸시 서비스 한 곳에 줄줄이 막히지 않게 5명씩 동시에 보낸다
    for (let i = 0; i < targets.length; i += 5) {
      await Promise.all(targets.slice(i, i + 5).map(([userId, groups]) => sendPushToUser(userId, buildPushPayload(groups))));
    }
    return { newTotal, users: targets.length };
  }
}
function buildPushPayload(groups) {
  const list = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length);
  const total = list.reduce((s, g) => s + g.rows.length, 0);
  const lines = list.slice(0, 3).map((g) => {
    const latest = g.rows.reduce((m, r) => ((r['계약(납품요구)일자'] || '') > (m['계약(납품요구)일자'] || '') ? r : m), g.rows[0]);
    const price = latest['계약납품단가'] ? ` / ${latest['계약납품단가']}원` : '';
    return `${g.keyword} ${g.rows.length}건 · ${hubq.cleanItemName(latest) || g.keyword} / ${latest['수요기관'] || '기관 미확인'}${price}`;
  });
  if (list.length > 3) lines.push(`외 ${list.length - 3}개 품목`);
  return { title: `나라장터 신규 계약 ${total}건`, body: lines.join('\n'), url: '/' };
}

// ─── 수집 작업 대기열 ────────────────────────────────────────────
// 크로미움을 띄우는 수집은 메모리를 많이 쓰고(다른 앱과 같이 쓰는 서버다) 한 번에 하나만 돌려야 한다. 예전에는 하나가
// 돌고 있으면 다른 사용자의 "조회"는 "이미 실행 중"으로 거절했고, 예약 시각이 겹친 자동 수집은 말없이 건너뛰었다 —
// 사용자가 늘수록 알림이 조용히 빠진다. 이제 모든 수집을 한 줄로 세워 차례대로 돌린다.
//  - 자동 수집(cron)은 수동 조회보다 앞에 세운다(사람의 조회 줄에 밀려 알림이 늦어지지 않게).
//  - 같은 일을 이미 기다리거나 돌고 있으면 새로 만들지 않고 그 작업을 돌려준다(연타·같은 시각 중복 방지).
//  - 수동 조회는 사용자당 하나만(한 사람이 줄을 독차지하지 못하게), 전체 대기는 최대 30개.
const JOB_QUEUE_MAX = 30;
const jobs = new Map(); // id → job (끝난 것도 10분은 남겨서 화면이 결과를 읽어 간다)
const jobQueue = [];    // 대기 중 job id (앞이 먼저)
let currentJob = null;
let jobSeq = 0;

function enqueueJob({ kind, key, userId = null, run }) {
  for (const j of jobs.values()) if ((j.state === 'queued' || j.state === 'running') && j.key === key) return { job: j, dup: true };
  if (jobQueue.length >= JOB_QUEUE_MAX) { const e = new Error('지금 수집 요청이 많아요. 잠시 뒤에 다시 시도해 주세요.'); e.status = 503; throw e; }
  const job = { id: ++jobSeq, kind, key, userId, state: 'queued', progress: '대기 중', percent: 0, error: null, createdAt: Date.now(), run };
  jobs.set(job.id, job);
  const at = kind === 'cron' ? jobQueue.findIndex((id) => jobs.get(id).kind !== 'cron') : -1;
  if (at >= 0) jobQueue.splice(at, 0, job.id); else jobQueue.push(job.id);
  setImmediate(pumpJobs);
  return { job, dup: false };
}
async function pumpJobs() {
  if (currentJob) return;
  const id = jobQueue.shift();
  if (id === undefined) return;
  const job = jobs.get(id);
  if (!job) return pumpJobs();
  currentJob = job;
  job.state = 'running'; job.startedAt = Date.now(); job.progress = '시작하는 중...';
  console.log(`[job #${job.id} ${job.key}] 시작 (대기 ${Math.round((job.startedAt - job.createdAt) / 1000)}초, 남은 대기 ${jobQueue.length}건)`);
  try {
    await job.run(job);
    job.state = 'done'; job.percent = 100;
  } catch (e) {
    job.state = 'error'; job.error = e.message;
    console.error(`[job #${job.id} ${job.key}] 실패:`, e.stack || e.message);
  } finally {
    job.finishedAt = Date.now();
    console.log(`[job #${job.id} ${job.key}] ${job.state} (${Math.round((job.finishedAt - job.startedAt) / 1000)}초)`);
    currentJob = null;
    setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000).unref();
    pumpJobs();
  }
}
// 화면이 보는 모양. status: queued(대기) / running / done / error
const jobView = (job) => ({
  id: job.id, status: job.state, progress: job.progress, percent: job.percent, error: job.error,
  ahead: job.state === 'queued' ? jobQueue.indexOf(job.id) + (currentJob ? 1 : 0) : 0, // 내 앞에서 기다리는 작업 수(돌고 있는 것 포함)
});

// 새로 들어온 행의 정리된 품목명을 채운다(트리거는 JS를 못 부른다). 한꺼번에 많아도 서버가 멈추지 않게 나눠서 한다.
async function fillNewNames() {
  while (hubq.hasPendingNames(db)) {
    hubq.fillNames(db, 2000);
    await new Promise((r) => setImmediate(r));
  }
}

// 품목들을 하나씩(중복 없이) 긁는다 — 여러 사용자가 같은 품목을 봐도 한 번만 수집. 실패한 품목은 건너뛰고 계속한다.
async function scrapeItems(job, items, batch, onSuccess) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const { code, from, to } = items[i];
    job.progress = `${i + 1}/${items.length} ${code} 수집 중...`; job.percent = stepPercent(i, items.length);
    const r = await runHubScrape(code, from, to, (step, label) => {
      job.progress = `${i + 1}/${items.length} ${code} — ${label}`; job.percent = stepPercent(i, items.length, step);
    });
    results.push({ code, ...r });
    if (r.exitCode !== 0) console.error(`[hub] ${code} 실패(종료 코드 ${r.exitCode}${r.timedOut ? ', 시간 초과' : ''}):\n${(r.tail || '').slice(-600)}`);
    else { mergeCoverage(code, from, to); batch.add(code, r.newRows); if (onSuccess) onSuccess(code); }
  }
  await fillNewNames();
  return results;
}

// 품목 하나를 수집하는 데 약 2분이 걸리고 수집은 한 줄로 돌기 때문에, 하루 수집 시간은 "서로 다른 품목 수 × 2분"이다. 알림 시각이
// 사용자마다 달라 같은 품목이 시각마다 또 수집되면(예: 07:00과 09:10) 그만큼 낭비다. 허브 자료는 하루에 한 번 정도 바뀌고, 새로 발견된
// 건은 그 품목을 보는 모든 사용자에게 바로 알림이 가므로(위 알림 규칙), 최근에 정상 수집한 품목은 건너뛰어도 알림이 빠지지 않는다.
const RESCRAPE_MIN_MS = Number(process.env.RESCRAPE_MIN_MS) || 6 * 3600 * 1000;
const scrapedRecently = (code) => { const at = Date.parse(getSetting(`scraped_at:${code}`) || ''); return Number.isFinite(at) && Date.now() - at < RESCRAPE_MIN_MS; };

// 자동 수집 한 번: 이 알림 시각을 쓰는 사용자들의 품목(중복 제거)을 최근 7일 기준으로 긁고 신규를 알린다.
async function cronJobRun(job, time) {
  const { fromDate, toDate } = defaultScrapeWindow();
  // item_code 컬럼이 생기기 전에 만든 필터는 번호가 비어 있다. 키워드로 물품목록 API를 조회해
  // 이름이 정확히 일치하는 세부품명이 있으면 자동으로 채운다(사용자가 다시 등록할 필요 없게).
  job.progress = '품목 번호 확인 중...';
  await fillMissingItemCodes();
  const codes = db.prepare(`
    SELECT DISTINCT f.item_code FROM filters f JOIN users u ON u.id = f.user_id
    WHERE u.alarm_time = ? AND f.item_code IS NOT NULL AND f.item_code <> ''
  `).all(time).map((r) => r.item_code);
  const todo = codes.filter((c) => !scrapedRecently(c));
  if (codes.length && todo.length < codes.length) console.log(`[cron ${time}] 품목 ${codes.length}개 중 ${codes.length - todo.length}개는 최근 ${Math.round(RESCRAPE_MIN_MS / 3600000)}시간 안에 이미 수집해서 건너뜁니다`);
  if (!codes.length) {
    job.progress = `${time}에 등록된 품목 없음`;
  } else if (!todo.length) {
    job.progress = '모든 품목을 최근에 수집해서 건너뜀';
  } else {
    const batch = new NotifyBatch('cron');
    const results = await scrapeItems(job, todo.map((code) => ({ code, from: fromDate, to: toDate })), batch, (code) => setSetting(`scraped_at:${code}`, new Date().toISOString()));
    job.progress = '알림 보내는 중...';
    const sent = await batch.flush();
    const summary = `${new Date().toLocaleString('ko-KR')} · ${results.map((r) => `${r.code} ${r.exitCode === 0 ? `${r.count ?? '?'}건` : '실패'}`).join(', ')}`;
    setSetting('last_hub_at', new Date().toISOString());
    setSetting('last_hub_summary', summary);
    job.progress = summary;
    // 일부가 실패해도 작업은 "완료"로 끝나므로(실패한 품목은 다음 알림 시각에 다시 시도된다) 로그에서 눈에 띄게 남긴다
    const failedCodes = results.filter((r) => r.exitCode !== 0).map((r) => r.code);
    console.log(`[notify] ${time} 자동 수집: 품목 ${todo.length}개, 신규 ${sent.newTotal}건 → 알림 대상 사용자 ${sent.users}명${failedCodes.length ? ` · ⚠ 수집 실패 ${failedCodes.length}개(${failedCodes.join(', ')})` : ''}`);
  }
  setSetting(`cron_done:${time}`, kstYmd(0)); // 오늘 이 시각 몫은 끝났다(부팅 때 놓친 수집을 챙길 때 쓴다)
  db.pragma('optimize');
}

// 표 위 "조회" 버튼의 수집: 빠진 기간만 골라 긁는다.
async function manualJobRun(job, gaps) {
  const batch = new NotifyBatch('manual');
  const results = await scrapeItems(job, gaps.map((g) => ({ code: g.code, from: g.gFrom, to: g.gTo })), batch);
  job.progress = '알림 확인 중...';
  await batch.flush();
  const failed = results.filter((r) => r.exitCode !== 0).length;
  job.progress = failed ? `조회 완료(${failed}건은 수집에 실패했어요)` : '조회 완료';
  if (failed === results.length) throw new Error('조달데이터허브에서 자료를 가져오지 못했어요. 잠시 뒤에 다시 시도해 주세요.');
}

// 화면이 진행 상황을 확인한다. job을 주면 그 작업(본인이 시킨 것만), 안 주면 전체가 바쁜지만 알려준다.
app.get('/api/hub-scrape/status', (req, res) => {
  if (req.query.job !== undefined) {
    const job = jobs.get(Number(req.query.job));
    if (!job || job.userId !== req.user.id) return res.status(404).json({ status: 'error', error: '조회 작업을 찾을 수 없어요(오래돼서 사라졌을 수 있어요)' });
    return res.json(jobView(job));
  }
  res.json({ status: currentJob ? 'running' : 'idle', progress: '', percent: 0, error: null, queued: jobQueue.length });
});

// 표 위쪽 "조회" 버튼용: 이미 긁어놓은 기간이면 바로 DB에서 보여주면 되니 아무것도 안 하고,
// 빠진 구간이 있을 때만 그 구간만 골라서 줄에 세운다.
app.post('/api/hub-query', (req, res) => {
  const { itemCode, fromDate, toDate } = req.body || {};
  if (!/^\d{8}$/.test(fromDate || '') || !/^\d{8}$/.test(toDate || '') || fromDate > toDate) {
    return res.status(400).json({ error: '조회 기간이 올바르지 않습니다' });
  }
  const mine = db.prepare(`SELECT DISTINCT item_code FROM filters WHERE user_id = ? AND item_code IS NOT NULL AND item_code <> ''`).all(req.user.id).map((r) => r.item_code);
  let codes = mine; // "전체" 탭 조회는 내 필터만 대상으로 한다 — 다른 사용자가 보는 품목까지 긁을 필요 없음.
  if (itemCode) {
    // 화면은 늘 내 필터의 품목번호를 보낸다. 그 밖의 번호로는 수집을 시킬 수 없게 한다(아무 번호나 긁게 두면 자원을 낭비한다).
    if (!/^\d{6,12}$/.test(String(itemCode)) || !mine.includes(String(itemCode))) return res.status(400).json({ error: '내 필터에 없는 품목이에요' });
    codes = [String(itemCode)];
  }
  if (!codes.length) return res.status(400).json({ error: '조회할 품목이 없습니다' });

  const gaps = [];
  for (const code of codes) {
    for (const [gFrom, gTo] of findMissingRanges(code, fromDate, toDate)) gaps.push({ code, gFrom, gTo });
  }
  if (!gaps.length) return res.json({ needsScrape: false });

  try {
    const { job, dup } = enqueueJob({ kind: 'manual', key: `manual:${req.user.id}`, userId: req.user.id, run: (j) => manualJobRun(j, gaps) });
    res.json({ needsScrape: true, started: !dup, alreadyRunning: dup, jobId: job.id });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 사용자마다 다른 alarm_time을 가질 수 있어, 실제로 쓰이는 시간마다 크론 job을 하나씩 띄운다.
// 알림 시간 저장 시(POST /api/settings/alarm-time)마다, 그리고 서버 부팅 시 1번 호출된다.
// 시각이 되면 작업을 줄에 세운다 — 다른 수집이 돌고 있어도 건너뛰지 않고 차례를 기다린다.
let hubTasks = new Map();
function enqueueCron(time) {
  try { enqueueJob({ kind: 'cron', key: `cron:${time}`, run: (j) => cronJobRun(j, time) }); }
  catch (e) { console.error(`[cron ${time}] 작업을 줄에 세우지 못했어요: ${e.message}`); }
}
function rescheduleAllAlarms() {
  for (const t of hubTasks.values()) t.stop();
  hubTasks.clear();
  const times = db.prepare(`SELECT DISTINCT alarm_time FROM users`).all().map((r) => r.alarm_time);
  for (const time of times) {
    const [hh, mm] = time.split(':').map(Number);
    hubTasks.set(time, cron.schedule(`${mm} ${hh} * * *`, () => enqueueCron(time), { timezone: 'Asia/Seoul' }));
  }
}
rescheduleAllAlarms();

// 서버가 꺼져 있거나 배포로 재시작되는 사이에 알림 시각이 지나가 버리면 그날 수집이 통째로 빠진다. 켜진 뒤 잠시 있다가
// "오늘 이미 지난 알림 시각인데 아직 안 돈 것"을 챙겨서 한 번 돌린다.
// 이 기능이 처음 켜지는 날에는 "오늘 몫이 돌았다"는 기록(cron_done)이 아직 없어서, 이미 정상으로 돈 알림 시각까지 전부 다시 돌게
// 된다 — 그래서 처음 한 번만 "지금까지 지난 시각은 이미 돌았다"고 표시하고 시작한다.
{
  const nowKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 16);
  if (!getSetting('cron_catchup_init')) {
    for (const { alarm_time: time } of db.prepare(`SELECT DISTINCT alarm_time FROM users`).all()) if (time <= nowKst) setSetting(`cron_done:${time}`, kstYmd(0));
    setSetting('cron_catchup_init', '1');
  }
}
setTimeout(() => {
  try {
    const nowKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 16); // HH:MM
    for (const { alarm_time: time } of db.prepare(`SELECT DISTINCT alarm_time FROM users`).all()) {
      if (time <= nowKst && getSetting(`cron_done:${time}`) !== kstYmd(0)) {
        console.log(`[cron ${time}] 오늘 몫이 아직 안 돌아서 지금 챙깁니다(서버가 꺼져 있었을 수 있어요)`);
        enqueueCron(time);
      }
    }
  } catch (e) { console.error('[cron] 놓친 수집 확인 실패:', e.message); }
}, Number(process.env.CATCHUP_DELAY_MS) || 90 * 1000).unref();

// 재시작 뒤에도 알림 설정이 남아 있는지 로그만 보고 알 수 있게, 부팅 때 요약을 남긴다(개수·시간만).
{
  const n = (sql) => db.prepare(sql).get().c;
  const times = db.prepare(`SELECT alarm_time t, COUNT(*) c FROM users GROUP BY alarm_time ORDER BY alarm_time`).all()
    .map((r) => `${r.t}(${r.c}명)`).join(' ') || '없음';
  console.log(`[boot] 관리자 ${[...ADMIN_USERNAMES].join(',')} · 사용자 ${n('SELECT COUNT(*) c FROM users')}명 · 필터 ${n('SELECT COUNT(*) c FROM filters')}건 · 푸시 구독 ${n('SELECT COUNT(*) c FROM push_subscriptions')}건 · 알림 시간 ${times}`);
}

// 만료된 세션은 조회에서만 걸러지고 지워지지 않아 계속 쌓인다 — 부팅 때와 6시간마다 정리한다
function purgeExpiredSessions() {
  try {
    const n = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString()).changes;
    if (n) console.log(`[db] 만료된 세션 ${n}건 정리`);
    db.pragma('optimize'); // 표가 바뀐 만큼 조회 통계를 갱신한다
  } catch (e) { console.error('[db] 세션 정리 실패:', e.message); }
}
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();

// 처리 안 된 Promise 오류 하나로 서버 전체가 죽지 않게 로그만 남긴다(Node 기본값은 프로세스 종료)
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack ? e.stack : e));

const PORT = process.env.PORT || 3000;
// 포트를 못 잡으면(이미 쓰는 중 등) 조용히 살아 있지 말고 바로 종료한다 — 크론 때문에 프로세스가 안 죽어서
// 요청을 못 받는 서버가 떠 있게 되는 걸 막고, 재시작 정책(restart: unless-stopped)이 다시 시도하게 한다.
const server = app.listen(PORT, () => console.log(`g2b-alert listening on ${PORT}`));
server.on('error', (e) => { console.error(`[server] ${PORT} 포트를 열지 못했습니다: ${e.message}`); process.exit(1); });
server.keepAliveTimeout = 65 * 1000; // nginx·모바일 망의 유휴 연결 재사용
server.headersTimeout = 66 * 1000;

// docker가 종료 신호(SIGTERM)를 보내면: 새 연결을 받지 않고, 돌고 있던 수집 프로세스를 정리하고, DB를 깨끗이 닫아(WAL 정리) 종료한다.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${sig} 수신 — 정리 후 종료합니다`);
  for (const t of hubTasks.values()) t.stop();
  try { if (typeof killScrapeChild === 'function') killScrapeChild(); } catch (e) { /* 이미 끝났을 수 있음 */ }
  server.close(() => { try { db.close(); } catch (e) { /* 사용 중인 연결이 남아 있을 수 있음 */ } process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref(); // docker 기본 종료 대기(10초) 안에 끝낸다
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
