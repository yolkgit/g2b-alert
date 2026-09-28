const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cron = require('node-cron');
const webpush = require('web-push');

const { fetchContracts } = require('./g2bClient');
const { searchItemCodes, summarizeItem } = require('./itemLookupClient');
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
  CREATE TABLE IF NOT EXISTS seen_contracts (
    contract_key TEXT NOT NULL,
    filter_id INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    matched_keyword TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (contract_key, filter_id)
  );
  CREATE TABLE IF NOT EXISTS raw_contracts (
    contract_key TEXT PRIMARY KEY,
    raw_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fetch_log (
    begin_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    PRIMARY KEY (begin_date, end_date)
  );
  CREATE TABLE IF NOT EXISTS fetch_items (
    begin_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    contract_key TEXT NOT NULL,
    PRIMARY KEY (begin_date, end_date, contract_key)
  );
`);

// filters.item_code는 뒤늦게 추가된 컬럼이라, 이미 만들어진 filters 테이블에는 없을 수 있다
try { db.exec(`ALTER TABLE filters ADD COLUMN item_code TEXT`); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }

// fields.js에 bizType/bidMethod를 뒤늦게 추가했는데, 이미 저장된 seen_contracts.summary_json은
// raw_json은 그대로 있으니 API를 다시 부르지 않고도 재계산할 수 있다 — 부팅 시 한 번 채워준다.
{
  const staleRows = db.prepare(`SELECT contract_key, filter_id, raw_json, summary_json FROM seen_contracts`).all();
  const updateSummaryStmt = db.prepare(`UPDATE seen_contracts SET summary_json = ? WHERE contract_key = ? AND filter_id = ?`);
  const migrateSummariesTx = db.transaction((rows) => {
    let migrated = 0;
    for (const r of rows) {
      if ('bizType' in JSON.parse(r.summary_json)) continue;
      updateSummaryStmt.run(JSON.stringify(summarize(JSON.parse(r.raw_json))), r.contract_key, r.filter_id);
      migrated++;
    }
    return migrated;
  });
  const migratedCount = migrateSummariesTx(staleRows);
  if (migratedCount) console.log(`summary_json 재계산: ${migratedCount}건`);
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
    lastRunAt: getSetting('last_run_at'),
    lastRunSummary: getSetting('last_run_summary'),
    lastBackfillAt: getSetting('last_backfill_at'),
    lastBackfillSummary: getSetting('last_backfill_summary'),
    alarmTime: getSetting('alarm_time', '07:00'),
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

const insertRawStmt = db.prepare(`INSERT INTO raw_contracts (contract_key, raw_json, fetched_at)
    VALUES (?, ?, ?) ON CONFLICT(contract_key) DO NOTHING`);
const insertFetchItemStmt = db.prepare(`INSERT INTO fetch_items (begin_date, end_date, contract_key)
    VALUES (?, ?, ?) ON CONFLICT(begin_date, end_date, contract_key) DO NOTHING`);
const upsertFetchLogStmt = db.prepare(`INSERT INTO fetch_log (begin_date, end_date, fetched_at, item_count)
    VALUES (?, ?, ?, ?) ON CONFLICT(begin_date, end_date) DO UPDATE SET fetched_at = excluded.fetched_at, item_count = excluded.item_count`);
const getFetchLogStmt = db.prepare(`SELECT 1 FROM fetch_log WHERE begin_date = ? AND end_date = ?`);
const getCachedRawStmt = db.prepare(`
  SELECT rc.raw_json FROM fetch_items fi JOIN raw_contracts rc ON rc.contract_key = fi.contract_key
  WHERE fi.begin_date = ? AND fi.end_date = ?
`);
const cacheRawTx = db.transaction((beginDate, endDate, items) => {
  const now = new Date().toISOString();
  for (const item of items) {
    const key = buildContractKey(item);
    insertRawStmt.run(key, JSON.stringify(item), now);
    insertFetchItemStmt.run(beginDate, endDate, key);
  }
});

// beginDate~endDate가 이미(완전히 지난 기간으로) API에서 받아온 적 있으면 캐시에서 그대로 돌려주고,
// 없으면 API를 호출해서 캐시에 저장한다. 오늘을 포함하는 구간은 계속 바뀔 수 있어 캐시하지 않고
// 항상 새로 부른다. 캐시 재생 시 항목의 계약일자로 다시 걸러내지 않는다 — cntrctCnclsDate/cntrctDate가
// 실제 조회 기준(계약 변경 이력 등)과 다른 경우가 있어 그렇게 하면 항목이 누락된다(실측 확인함).
// 대신 fetch_items로 "이 구간을 조회했을 때 실제로 돌아온 항목"을 그대로 기록해서 재생한다.
async function getOrFetchChunk(serviceKey, beginDate, endDate) {
  const today = fmtDate(new Date());
  const cacheable = endDate < today;
  if (cacheable && getFetchLogStmt.get(beginDate, endDate)) {
    const rows = getCachedRawStmt.all(beginDate, endDate);
    return { items: rows.map((r) => JSON.parse(r.raw_json)), truncated: false, fromCache: true };
  }
  const result = await fetchContracts(serviceKey, beginDate, endDate);
  if (cacheable) {
    cacheRawTx(beginDate, endDate, result.items);
    upsertFetchLogStmt.run(beginDate, endDate, new Date().toISOString(), result.items.length);
  }
  return { ...result, fromCache: false };
}

const insertSeenStmt = db.prepare(`INSERT INTO seen_contracts
    (contract_key, filter_id, raw_json, summary_json, matched_keyword, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(contract_key, filter_id) DO NOTHING`);
const alreadySeenStmt = db.prepare(`SELECT 1 FROM seen_contracts WHERE contract_key = ? AND filter_id = ?`);

// items를 filters에 매칭시켜 처음 보는 것만 seen_contracts에 저장하고, 필터별 신규 매칭 목록을 돌려준다
function matchAndStore(items, filters) {
  const newByFilter = new Map();
  for (const item of items) {
    const key = buildContractKey(item);
    for (const filter of filters) {
      const kwMatch = itemMatchesKeyword(item, filter.keyword);
      const rgMatch = !filter.region || itemMatchesKeyword(item, filter.region);
      if (!kwMatch || !rgMatch) continue;
      if (alreadySeenStmt.get(key, filter.id)) continue;

      const summary = summarize(item);
      insertSeenStmt.run(key, filter.id, JSON.stringify(item), JSON.stringify(summary), filter.keyword, new Date().toISOString());
      if (!newByFilter.has(filter.id)) newByFilter.set(filter.id, { filter, items: [] });
      newByFilter.get(filter.id).items.push(summary);
    }
  }
  return newByFilter;
}

async function runDailyCheck({ daysBack = 1 } = {}) {
  const serviceKey = getSetting('g2b_service_key');
  if (!serviceKey) return { error: '서비스키가 설정되지 않았습니다' };

  const end = new Date();
  const begin = new Date(end.getTime() - daysBack * 86400000);
  const beginDate = fmtDate(begin), endDate = fmtDate(end);

  const { items, operation, truncated, meta } = await fetchContracts(serviceKey, beginDate, endDate);
  const filters = db.prepare(`SELECT * FROM filters`).all();
  const newByFilter = matchAndStore(items, filters);

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

// 하루 단위로 잘라서 훑는 과거 내역 일괄 조회(알림 없음, 필터에 매칭되는 것만 저장). 결과를 바로 쓰지
// 않고 백그라운드로 돌리는 이유: 몇 달치를 훑으면 API 호출이 수백 번이라 리버스 프록시 타임아웃을 넘긴다.
let backfillState = { status: 'idle', progress: '', error: null };

async function runBackfillJob(fromDate, toDate) {
  const serviceKey = getSetting('g2b_service_key');
  if (!serviceKey) { backfillState = { status: 'error', progress: '', error: '서비스키가 설정되지 않았습니다' }; return; }
  const filters = db.prepare(`SELECT * FROM filters`).all();
  if (!filters.length) { backfillState = { status: 'error', progress: '', error: '등록된 필터가 없습니다' }; return; }

  const chunkMs = 7 * 86400000;
  const from = new Date(`${fromDate.slice(0, 4)}-${fromDate.slice(4, 6)}-${fromDate.slice(6, 8)}T00:00:00Z`);
  const to = new Date(`${toDate.slice(0, 4)}-${toDate.slice(4, 6)}-${toDate.slice(6, 8)}T00:00:00Z`);
  const chunks = [];
  for (let t = from.getTime(); t < to.getTime(); t += chunkMs) {
    chunks.push([new Date(t), new Date(Math.min(t + chunkMs, to.getTime()))]);
  }

  let totalFetched = 0;
  let totalMatched = 0;
  let truncatedAny = false;
  let cachedChunks = 0;
  for (let i = 0; i < chunks.length; i++) {
    const [begin, end] = chunks[i];
    const beginDate = fmtDate(begin), endDate = fmtDate(end);
    backfillState = { status: 'running', progress: `${i + 1}/${chunks.length} 구간 조회 중 (${beginDate}~${endDate}), 지금까지 원본 ${totalFetched}건 · 매칭 ${totalMatched}건 (캐시 ${cachedChunks}구간 재사용)`, error: null };
    try {
      const { items, truncated, fromCache } = await getOrFetchChunk(serviceKey, beginDate, endDate);
      if (fromCache) cachedChunks++;
      totalFetched += items.length;
      if (truncated) truncatedAny = true;
      const newByFilter = matchAndStore(items, filters);
      for (const { items: matched } of newByFilter.values()) totalMatched += matched.length;
    } catch (err) {
      // 중간에 실패해도 여기까지 처리한 구간은 이미 매칭·저장됐으니(캐시된 구간은 다음 번에 이어서
      // 재사용됨) 진행 상황을 남겨서 "얼마나 됐었는지"가 사라지지 않게 한다.
      const partialSummary = `${fromDate}~${toDate} 조회 중 ${i}/${chunks.length}구간에서 중단(${beginDate}~${endDate} 실패), 그때까지 원본 ${totalFetched}건 중 매칭 ${totalMatched}건 (캐시 재사용 ${cachedChunks}구간) — ${err.message}`;
      setSetting('last_backfill_at', new Date().toISOString());
      setSetting('last_backfill_summary', partialSummary);
      backfillState = { status: 'error', progress: partialSummary, error: err.message };
      return;
    }
  }

  const summaryText = `${fromDate}~${toDate} 전체 조회, 원본 ${totalFetched}건 중 매칭 ${totalMatched}건 (캐시 재사용 ${cachedChunks}/${chunks.length}구간)${truncatedAny ? ' (일부 구간 최대 페이지 초과로 일부 생략됨)' : ''}`;
  setSetting('last_backfill_at', new Date().toISOString());
  setSetting('last_backfill_summary', summaryText);
  backfillState = { status: 'done', progress: summaryText, error: null };
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

app.post('/api/backfill', (req, res) => {
  if (backfillState.status === 'running') return res.status(409).json({ error: '이미 실행 중입니다' });
  const fromDate = req.body?.fromDate || '20260101';
  const toDate = req.body?.toDate || fmtDate(new Date());
  backfillState = { status: 'running', progress: '시작 중...', error: null };
  runBackfillJob(fromDate, toDate).catch((err) => { backfillState = { status: 'error', progress: '', error: err.message }; });
  res.json({ started: true, fromDate, toDate });
});

app.get('/api/backfill/status', (req, res) => res.json(backfillState));

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
    SELECT sc.contract_key, sc.filter_id, sc.summary_json, sc.matched_keyword, sc.created_at, f.keyword, f.region, f.item_code
    FROM seen_contracts sc JOIN filters f ON f.id = sc.filter_id
    ORDER BY sc.created_at DESC LIMIT ?
  `).all(limit);
  res.json(rows.map((r) => ({ ...r, summary: JSON.parse(r.summary_json), summary_json: undefined })));
});

app.use(express.static(path.join(__dirname, 'public')));

let dailyTask = null;
function scheduleDailyCheck(time) {
  if (dailyTask) dailyTask.stop();
  const [hh, mm] = time.split(':').map(Number);
  dailyTask = cron.schedule(`${mm} ${hh} * * *`, () => {
    runDailyCheck({ daysBack: 1 }).catch((err) => console.error('daily check failed:', err.message));
  }, { timezone: 'Asia/Seoul' });
}
scheduleDailyCheck(getSetting('alarm_time', '07:00'));

app.post('/api/settings/alarm-time', (req, res) => {
  const { time } = req.body || {};
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time || '')) return res.status(400).json({ error: '시간 형식이 올바르지 않습니다 (HH:MM)' });
  setSetting('alarm_time', time);
  scheduleDailyCheck(time);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`g2b-alert listening on ${PORT}`));
