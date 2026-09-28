const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cron = require('node-cron');
const webpush = require('web-push');

const { fetchContracts } = require('./g2bClient');
const { summarize, itemMatchesKeyword, buildContractKey } = require('./fields');

const app = express();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    region TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seen_contracts (
    contract_key TEXT NOT NULL,
    filter_id INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    matched_keyword TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (contract_key, filter_id)
  );
`);

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
    lastRunAt: getSetting('last_run_at'),
    lastRunSummary: getSetting('last_run_summary'),
  });
});
app.post('/api/settings/service-key', (req, res) => {
  const { serviceKey } = req.body || {};
  if (!serviceKey) return res.status(400).json({ error: 'serviceKey 필요' });
  setSetting('g2b_service_key', serviceKey);
  res.json({ ok: true });
});

app.get('/api/filters', (req, res) => {
  res.json(db.prepare(`SELECT * FROM filters ORDER BY id DESC`).all());
});
app.post('/api/filters', (req, res) => {
  const { keyword, region } = req.body || {};
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: 'keyword 필요' });
  const info = db.prepare(`INSERT INTO filters (keyword, region, created_at) VALUES (?, ?, ?)`)
    .run(keyword.trim(), (region || '').trim() || null, new Date().toISOString());
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/filters/:id', (req, res) => {
  db.prepare(`DELETE FROM filters WHERE id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM seen_contracts WHERE filter_id = ?`).run(req.params.id);
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

// ─── 계약 조회 / 매칭 / 알림 ──────────────────────────────
function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function runDailyCheck({ daysBack = 1 } = {}) {
  const serviceKey = getSetting('g2b_service_key');
  if (!serviceKey) return { error: '서비스키가 설정되지 않았습니다' };

  const end = new Date();
  const begin = new Date(end.getTime() - daysBack * 86400000);
  const beginDate = fmtDate(begin), endDate = fmtDate(end);

  const { items, operation, truncated, meta } = await fetchContracts(serviceKey, beginDate, endDate);

  const filters = db.prepare(`SELECT * FROM filters`).all();
  const insertSeen = db.prepare(`INSERT INTO seen_contracts
      (contract_key, filter_id, raw_json, summary_json, matched_keyword, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(contract_key, filter_id) DO NOTHING`);
  const alreadySeen = db.prepare(`SELECT 1 FROM seen_contracts WHERE contract_key = ? AND filter_id = ?`);

  const newByFilter = new Map();
  for (const item of items) {
    const key = buildContractKey(item);
    for (const filter of filters) {
      const kwMatch = itemMatchesKeyword(item, filter.keyword);
      const rgMatch = !filter.region || itemMatchesKeyword(item, filter.region);
      if (!kwMatch || !rgMatch) continue;
      if (alreadySeen.get(key, filter.id)) continue;

      const summary = summarize(item);
      insertSeen.run(key, filter.id, JSON.stringify(item), JSON.stringify(summary), filter.keyword, new Date().toISOString());
      if (!newByFilter.has(filter.id)) newByFilter.set(filter.id, { filter, items: [] });
      newByFilter.get(filter.id).items.push(summary);
    }
  }

  for (const { filter, items: matched } of newByFilter.values()) {
    const top = matched.slice(0, 3).map((m) => `${m.itemName || '품목명 미확인'} / ${m.demandOrg || '기관 미확인'}`).join('\n');
    await sendPushToAll({
      title: `나라장터 신규 계약 ${matched.length}건 - ${filter.keyword}`,
      body: top,
      url: '/',
    });
  }

  const summaryText = `${beginDate}~${endDate} 조회(${operation}${truncated ? ', 일부 페이지 생략됨' : ''}), 원본 ${items.length}건, 신규 매칭 ${[...newByFilter.values()].reduce((s, v) => s + v.items.length, 0)}건`;
  setSetting('last_run_at', new Date().toISOString());
  setSetting('last_run_summary', summaryText);

  return { beginDate, endDate, operation, totalFetched: items.length, truncated, meta, newByFilter: Object.fromEntries([...newByFilter].map(([k, v]) => [k, v.items])) };
}

app.post('/api/check-now', async (req, res) => {
  try {
    const result = await runDailyCheck({ daysBack: Number(req.body?.daysBack) || 1 });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 실제 API 응답 구조를 필드명 확정 없이 그대로 확인하기 위한 원본 미리보기
app.get('/api/test-fetch', async (req, res) => {
  try {
    const serviceKey = getSetting('g2b_service_key');
    if (!serviceKey) return res.status(400).json({ error: '서비스키가 설정되지 않았습니다' });
    const days = Number(req.query.days) || 3;
    const end = new Date();
    const begin = new Date(end.getTime() - days * 86400000);
    const { items, operation, meta } = await fetchContracts(serviceKey, fmtDate(begin), fmtDate(end), { maxPages: 1, numOfRows: 20 });
    res.json({ operation, meta, sampleCount: items.length, sample: items.slice(0, 5) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contracts', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare(`
    SELECT sc.contract_key, sc.filter_id, sc.summary_json, sc.matched_keyword, sc.created_at, f.keyword, f.region
    FROM seen_contracts sc JOIN filters f ON f.id = sc.filter_id
    ORDER BY sc.created_at DESC LIMIT ?
  `).all(limit);
  res.json(rows.map((r) => ({ ...r, summary: JSON.parse(r.summary_json), summary_json: undefined })));
});

app.use(express.static(path.join(__dirname, 'public')));

cron.schedule('0 7 * * *', () => {
  runDailyCheck({ daysBack: 1 }).catch((err) => console.error('daily check failed:', err.message));
}, { timezone: 'Asia/Seoul' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`g2b-alert listening on ${PORT}`));
