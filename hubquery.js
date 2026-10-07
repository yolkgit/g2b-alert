// 조달 내역 표(목록·값 목록·건수·엑셀)가 쓰는 조회 로직. 서버 본체와 엑셀 전용 스레드(exportWorker.js)가 같이 쓴다.
//
// 왜 hub_idx(가벼운 색인 표)인가: hub_items의 한 행은 raw_json(약 1~2KB)이 통째로 들어 있어서, 조건·정렬을
// 위해 수만 행을 읽으면(JSON을 매번 풀어서) 수백 ms가 걸리고, SQLite가 동기식이라 그동안 서버 전체가 멈춘다.
// 그래서 조건·정렬에 쓰는 값만 뽑아 둔 행당 약 100바이트짜리 표(hub_idx)에서 후보를 고르고, 화면에 보일
// 20건만 hub_items에서 가져온다(같은 쿼리가 10~20배 빠름 — 15만 건 기준 160~300ms → 12~15ms).
// hub_idx는 hub_items의 INSERT/UPDATE/DELETE 트리거로 항상 맞춰진다. 수집 스크립트(scrape-hub.js)가 별도
// 프로세스로 hub_items에 써도 트리거가 실행되므로, 트리거는 SQLite 내장 함수만 쓴다(없는 함수를 부르면
// 수집 쪽 INSERT가 깨진다). JS가 필요한 "정리된 품목명"만 서버가 뒤따라 채운다(fillNames).
'use strict';

// ─── 컬럼 정의: 화면 컬럼명 → hub_idx 컬럼 ──────────────────────────
// key = hub_items.raw_json 안의 키(화면 컬럼명과 같음), c = hub_idx 컬럼, num = 숫자로 저장/정렬
const COLS = {
  '조달방식': { c: 'proc' },
  '업무구분': { c: 'kind' },
  '계약구분': { c: 'ctype' },
  '계약(납품요구)일자': { c: 'cdate' },
  '수요기관': { c: 'org' },
  '수요기관소재시군구': { c: 'loc' },
  '세부품명번호': { c: 'item_code' },
  '세부품명': { c: 'dname' },
  '품목명': { c: 'name_clean' },
  '업체명': { c: 'company' },
  '낙찰방법': { c: 'method' },
  '단위': { c: 'unit' },
  '계약납품단가': { c: 'price', num: true },
  '계약납품수량': { c: 'qty', num: true },
  '공급금액': { c: 'amount', num: true },
};
const SORTABLE_COLS = new Set(Object.keys(COLS));
const INDEX_VERSION = '4';

// ─── 지역 ─────────────────────────────────────────────────────────
// 지역은 수요기관 소재지("경기도 수원시 권선구")에 대해 맞춘다. 원본이 정식 명칭이라 "충남"·"서울시"·
// "강원도" 같은 흔한 입력은 그대로는 안 걸려서 시도 약칭을 풀어준다.
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
function regionSql(region, col = 'loc') {
  const groups = parseRegion(region);
  if (!groups.length) return null;
  const params = [];
  const like = (s) => { params.push(`%${s.replace(/[\\%_]/g, '\\$&')}%`); return `${col} LIKE ? ESCAPE '\\'`; };
  const sql = groups.map((g) => `(${g.map((forms) => `(${forms.map(like).join(' OR ')})`).join(' AND ')})`).join(' OR ');
  return { sql: `(${sql})`, params };
}
// 같은 규칙을 이미 읽어 온 행(JS 객체)에 적용 — 푸시 알림 대상 판정용
function regionMatcher(region) {
  const groups = parseRegion(region);
  if (!groups.length) return () => true;
  return (row) => {
    const loc = String(row['수요기관소재시군구'] || '');
    return groups.some((g) => g.every((forms) => forms.some((f) => loc.includes(f))));
  };
}

// ─── 품목명 정리(표시용) ────────────────────────────────────────────
// 품목명은 "세부품명, 제조사, 모델, 규격…" 꼴로 들어와서, 앞의 세부품명·제조사(=업체)가 표의 세부품명·업체명
// 컬럼과 겹친다. 표시용으로는 그 겹치는 앞부분을 뺀다(원본 raw_json은 그대로).
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
// 품목명 정렬 키. SQLite에는 한국어 정렬(ICU)이 없어서, 한국어 정렬 규칙("기호 < 숫자 < 한글 < 영문", 대소문자·호환 문자
// 무시)을 코드 순서(바이트 비교)로 흉내 낼 수 있는 문자열을 미리 만들어 저장해 두고 그걸로 정렬한다.
//  - NFKC로 호환 문자를 풀고("㎏" → "kg") 소문자로 맞춘다.
//  - 영문 a~z는 한글(U+AC00~)보다 뒤인 사용자 영역(U+E000~)으로 옮겨 "한글이 영문보다 먼저"가 되게 한다.
//  - ASCII 기호는 이 서버의 한국어 정렬 순서대로 번호를 매겨 숫자(U+0030)보다 앞의 문자로 바꾼다.
// 이 키는 정렬에만 쓰고 화면에는 나가지 않는다.
const KO = new Intl.Collator('ko');
const PUNCT_RANK = new Map();
{
  const punct = [];
  for (let c = 0x20; c < 0x7f; c++) { const ch = String.fromCharCode(c); if (!/[0-9a-zA-Z]/.test(ch)) punct.push(ch); }
  punct.sort(KO.compare).forEach((ch, i) => PUNCT_RANK.set(ch, String.fromCharCode(0x01 + i)));
}
function nameSortKey(name) {
  let out = '';
  for (const ch of String(name).normalize('NFKC').toLowerCase()) {
    const c = ch.codePointAt(0);
    if (c >= 0x61 && c <= 0x7a) out += String.fromCharCode(0xe000 + c - 0x61);
    else out += PUNCT_RANK.get(ch) || ch;
  }
  return out;
}

// ─── 색인 표(hub_idx) ───────────────────────────────────────────────
// 트리거와 초기 채우기가 같은 식을 쓰도록 한 곳에서 만든다.
const jx = (alias, key) => `COALESCE(json_extract(${alias}.raw_json, '$."${key}"'), '')`;
const numx = (alias, key) => `CASE WHEN TRIM(${jx(alias, key)}) = '' THEN NULL ELSE CAST(REPLACE(${jx(alias, key)}, ',', '') AS REAL) END`;
const IDX_COLS = ['id', 'item_code', 'cdate', 'proc', 'kind', 'ctype', 'org', 'loc', 'dname', 'company', 'method', 'unit', 'price', 'qty', 'amount', 'fin'];
function idxSelect(alias) {
  return [
    `${alias}.rowid`, `COALESCE(${alias}.item_code, '')`, `COALESCE(${alias}.contract_date, '')`,
    jx(alias, '조달방식'), jx(alias, '업무구분'), jx(alias, '계약구분'), jx(alias, '수요기관'), jx(alias, '수요기관소재시군구'),
    jx(alias, '세부품명'), jx(alias, '업체명'), jx(alias, '낙찰방법'), jx(alias, '단위'),
    numx(alias, '계약납품단가'), numx(alias, '계약납품수량'), numx(alias, '공급금액'),
    // 같은 계약이 변경될 때마다 변경차수별 행이 따로 쌓이는데, 공개 통계는 최종 변경분(최종여부가 'N'이 아닌 것)만 센다
    `CASE WHEN json_extract(${alias}.raw_json, '$."최종계약(납품요구)여부"') = 'N' THEN 0 ELSE 1 END`,
  ].join(', ');
}

// 서버가 시작할 때(그리고 hub_items가 처음 만들어진 뒤) 호출. 여러 번 불러도 안전하다.
function ensureHubIndex(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_items (
    contract_no TEXT NOT NULL, chg_seq TEXT NOT NULL, item_seq TEXT NOT NULL,
    item_code TEXT, contract_date TEXT, raw_json TEXT NOT NULL, fetched_at TEXT NOT NULL,
    PRIMARY KEY (contract_no, chg_seq, item_seq))`);
  db.exec(`CREATE TABLE IF NOT EXISTS hub_idx (
    id INTEGER PRIMARY KEY, item_code TEXT NOT NULL DEFAULT '', cdate TEXT NOT NULL DEFAULT '',
    proc TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', ctype TEXT NOT NULL DEFAULT '',
    org TEXT NOT NULL DEFAULT '', loc TEXT NOT NULL DEFAULT '', dname TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '', method TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT '',
    price REAL, qty REAL, amount REAL, name_clean TEXT, name_sort TEXT, fin INTEGER NOT NULL DEFAULT 1)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_hub_idx_code_date ON hub_idx (item_code, cdate)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_hub_idx_names_null ON hub_idx (id) WHERE name_clean IS NULL');
  // 공개 페이지의 품목별 집계(건수·첫/마지막 날짜·세부품명)가 표 본체를 안 읽고 색인만으로 끝나게 하는 전용 색인
  db.exec('CREATE INDEX IF NOT EXISTS idx_hub_idx_public ON hub_idx (item_code, fin, cdate, dname)');

  const cols = IDX_COLS.join(', ');
  const ver = (db.prepare(`SELECT value FROM settings WHERE key = 'hub_idx_version'`).get() || {}).value;
  if (ver !== INDEX_VERSION) {
    // 정의가 바뀌었으면 트리거를 새로 만들고 색인 표를 처음부터 다시 채운다
    for (const t of ['trg_hub_idx_ai', 'trg_hub_idx_au', 'trg_hub_idx_ad']) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
    db.exec('DELETE FROM hub_idx');
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_hub_idx_ai AFTER INSERT ON hub_items BEGIN
    INSERT OR REPLACE INTO hub_idx (${cols}) SELECT ${idxSelect('new')}; END`);
  // 수집 스크립트는 같은 행을 다시 긁을 때마다 UPDATE(ON CONFLICT DO UPDATE)하므로, 내용이 실제로 바뀐 때만 갱신한다
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_hub_idx_au AFTER UPDATE OF raw_json, item_code, contract_date ON hub_items
    WHEN new.raw_json IS NOT old.raw_json OR new.item_code IS NOT old.item_code OR new.contract_date IS NOT old.contract_date BEGIN
    INSERT OR REPLACE INTO hub_idx (${cols}) SELECT ${idxSelect('new')}; END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_hub_idx_ad AFTER DELETE ON hub_items BEGIN
    DELETE FROM hub_idx WHERE id = old.rowid; END`);

  // 트리거가 없던 때(또는 직접 수정)로 어긋난 것을 맞춘다
  const orphan = db.prepare('DELETE FROM hub_idx WHERE id NOT IN (SELECT rowid FROM hub_items)').run().changes;
  const added = db.prepare(`INSERT INTO hub_idx (${cols}) SELECT ${idxSelect('h')} FROM hub_items h WHERE h.rowid NOT IN (SELECT id FROM hub_idx)`).run().changes;
  db.prepare(`INSERT INTO settings (key, value) VALUES ('hub_idx_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(INDEX_VERSION);
  db.pragma('optimize'); // 표가 크게 바뀌었으면 통계를 갱신한다(조회 계획이 안정적이도록)
  return { added, orphan };
}

// 정리된 품목명(name_clean)은 JS 함수가 필요해서 트리거가 못 채운다 — 비어 있는 행을 채운다. limit 만큼만.
function fillNames(db, limit = Infinity) {
  // 비어 있는 행의 id는 부분 색인(idx_hub_idx_names_null)에서 바로 얻는다 — 조인으로 한 번에 읽으면 색인을 못 타고 전체를 훑는다
  const selIds = db.prepare('SELECT id FROM hub_idx INDEXED BY idx_hub_idx_names_null WHERE name_clean IS NULL LIMIT ?');
  const upd = db.prepare('UPDATE hub_idx SET name_clean = ?, name_sort = ? WHERE id = ?');
  let done = 0;
  while (done < limit) {
    const ids = selIds.all(Math.min(2000, limit - done)).map((r) => r.id);
    if (!ids.length) break;
    const raws = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const r of db.prepare(`SELECT rowid id, raw_json FROM hub_items WHERE rowid IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) raws.set(r.id, r.raw_json);
    }
    db.transaction(() => {
      // 원본이 사라진 행(있을 수 없지만)은 빈 문자열로 닫아 무한 반복을 막는다
      for (const id of ids) { const n = raws.has(id) ? cleanItemName(JSON.parse(raws.get(id))) : ''; upd.run(n, nameSortKey(n), id); }
    })();
    done += ids.length;
  }
  return done;
}
// INDEXED BY: 통계(ANALYZE)가 없으면 SQLite가 부분 색인을 안 쓰고 15만 행을 전부 훑는다(70ms) — 색인을 지정하면 0.1ms
const hasPendingNames = (db) => !!db.prepare('SELECT 1 FROM hub_idx INDEXED BY idx_hub_idx_names_null WHERE name_clean IS NULL LIMIT 1').get();

// ─── 조건 만들기 ────────────────────────────────────────────────────
// 내 필터(세부품명번호 + 선택적 지역)를 hub_idx WHERE로. filterId를 주면 그 필터 하나만, 안 주면("전체" 탭) 내
// 필터 전부의 합집합. 같은 품목에 지역 없는 필터가 하나라도 있으면 그 품목은 통째로 포함이라 지역 조건을 뺀다.
// 걸 게 없으면 null.
function scopeFor(db, userId, filterId) {
  const rows = filterId
    ? db.prepare(`SELECT item_code, region FROM filters WHERE user_id = ? AND id = ? AND item_code IS NOT NULL AND item_code <> ''`).all(userId, filterId)
    : db.prepare(`SELECT item_code, region FROM filters WHERE user_id = ? AND item_code IS NOT NULL AND item_code <> ''`).all(userId);
  if (!rows.length) return null;
  const byCode = new Map();
  for (const f of rows) {
    const e = byCode.get(f.item_code) || { all: false, regions: [] };
    if (!(f.region || '').trim() || !parseRegion(f.region).length) e.all = true; else e.regions.push(f.region);
    byCode.set(f.item_code, e);
  }
  const params = [];
  const parts = [];
  for (const [code, e] of byCode) {
    params.push(code);
    if (e.all) { parts.push('(item_code = ?)'); continue; }
    const rs = e.regions.map((r) => regionSql(r)).filter(Boolean);
    parts.push(`(item_code = ? AND (${rs.map((r) => { params.push(...r.params); return r.sql; }).join(' OR ')}))`);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

// cf = { 화면컬럼명: [허용할 값…] } — 화면 컬럼명 화이트리스트만 받고 값은 항상 바인딩한다. 컬럼당 최대 1000개.
// 빈 배열은 "아무것도 선택 안 함"이라 아무 행도 안 맞는 걸로 본다. 빈 값은 ''(숫자 컬럼은 NULL)로 다룬다.
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
const parseNum = (s) => { const t = String(s).trim().replace(/,/g, ''); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : undefined; };

// 내 필터(탭) + 기간 + 컬럼 값 필터. skipCol은 그 컬럼 자신의 필터는 빼고(값 목록용 — 그래야 이미 고른 값도
// 목록에 남아 다시 바꿀 수 있다). 탭에 걸 필터가 없으면 null.
function buildWhere(db, userId, q, skipCol) {
  const scope = scopeFor(db, userId, Number(q.filter) || null);
  if (!scope) return null;
  const conds = [scope.sql], params = [...scope.params];
  const from = String(q.from || '').trim(), to = String(q.to || '').trim();
  if (from) { conds.push('cdate >= ?'); params.push(from); }
  if (to) { conds.push('cdate <= ?'); params.push(to); }
  for (const [col, vals] of Object.entries(parseColFilters(q.cf))) {
    if (col === skipCol) continue;
    const def = COLS[col];
    if (def.num) {
      const nums = vals.map(parseNum);
      const ns = nums.filter((n) => typeof n === 'number');
      const wantNull = nums.some((n) => n === null);
      const parts = [];
      if (ns.length) { parts.push(`${def.c} IN (${ns.map(() => '?').join(',')})`); params.push(...ns); }
      if (wantNull) parts.push(`${def.c} IS NULL`);
      conds.push(parts.length ? `(${parts.join(' OR ')})` : '0');
    } else if (!vals.length) conds.push('0');
    else {
      conds.push(`${def.c === 'name_clean' ? "COALESCE(name_clean, '')" : def.c} IN (${vals.map(() => '?').join(',')})`);
      params.push(...vals);
    }
  }
  return { sql: conds.join(' AND '), params };
}

// 정렬: 화면 컬럼명 화이트리스트만(그 밖은 날짜순). 같은 값끼리는 최신 계약 먼저, 마지막은 id로 순서를 고정한다.
// 품목명은 미리 정규화해 둔 정렬 키(name_sort)로 정렬한다(대소문자 무시, 한글은 코드 순서 = 가나다순).
function orderClause(col, dir) {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  const def = COLS[col];
  if (!def || def.c === 'cdate') return `cdate ${d}, id ${d}`;
  const c = def.c === 'name_clean' ? "COALESCE(name_sort, '')" : def.c;
  return `${c} ${d}, cdate DESC, id DESC`;
}
const usesNames = (q) => q.sort === '품목명' || Object.prototype.hasOwnProperty.call(parseColFilters(q.cf), '품목명');
const ensureNames = (db, q, fill = true) => { if (fill && usesNames(q) && hasPendingNames(db)) fillNames(db); };

// 조건에 맞는 전체 건수(COUNT)는 페이지를 넘기거나 정렬만 바꿀 땐 그대로라서 잠깐 기억해 둔다. 다른 프로세스(수집)가
// DB를 바꾸면 data_version이 달라지므로 그때 비운다. 키에 WHERE와 값이 다 들어 있어(사용자 필터 포함) 사용자끼리 섞이지 않는다.
const totalCache = new Map();
const CACHE_TTL_MS = 60 * 1000, CACHE_MAX = 2000;
const cacheState = new Map(); // db 파일 → 마지막으로 본 data_version
function cachedCount(db, w, fn) {
  const dv = db.pragma('data_version', { simple: true });
  if (cacheState.get(db.name) !== dv) { for (const k of totalCache.keys()) if (k.startsWith(db.name + '|')) totalCache.delete(k); cacheState.set(db.name, dv); }
  const key = `${db.name}|${w.sql}|${JSON.stringify(w.params)}`;
  const hit = totalCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.v;
  const v = fn();
  if (totalCache.size >= CACHE_MAX) totalCache.delete(totalCache.keys().next().value);
  totalCache.set(key, { at: Date.now(), v });
  return v;
}

// ─── 조회 ─────────────────────────────────────────────────────────
// clean=true면 화면 표시용으로 품목명을 정리한다. 공개 페이지는 원본 그대로 보여 주려고 false로 부른다.
function fetchRows(db, ids, clean = true) {
  const out = new Array(ids.length);
  const pos = new Map(ids.map((id, i) => [id, i]));
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT rowid id, raw_json FROM hub_items WHERE rowid IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) out[pos.get(r.id)] = clean ? toDisplayRow(r.raw_json) : JSON.parse(r.raw_json);
  }
  return out.filter(Boolean);
}

// 화면 목록 한 페이지: 후보는 가벼운 표에서 정렬해 고르고, 보일 행만 원본에서 가져온다.
function listRows(db, userId, q, offset, limit) {
  const w = buildWhere(db, userId, q);
  if (!w) return { rows: [], total: 0 };
  ensureNames(db, q);
  const total = cachedCount(db, w, () => db.prepare(`SELECT COUNT(*) c FROM hub_idx WHERE ${w.sql}`).get(...w.params).c);
  if (!total) return { rows: [], total: 0 };
  const ids = db.prepare(`SELECT id FROM hub_idx WHERE ${w.sql} ORDER BY ${orderClause(q.sort, q.dir)} LIMIT ? OFFSET ?`)
    .all(...w.params, limit, offset).map((r) => r.id);
  return { rows: fetchRows(db, ids), total };
}

// 엑셀용: 같은 조건·정렬의 전체(최대 max행). 메모리를 아끼려고 id만 먼저 받고 원본은 조각으로 가져온다.
function exportRows(db, userId, q, max, { fill = true } = {}) {
  const w = buildWhere(db, userId, q);
  if (!w) return { rows: [], total: 0 };
  ensureNames(db, q, fill);
  const ids = db.prepare(`SELECT id FROM hub_idx WHERE ${w.sql} ORDER BY ${orderClause(q.sort, q.dir)} LIMIT ?`).all(...w.params, max).map((r) => r.id);
  return { rows: fetchRows(db, ids), total: ids.length };
}

const collator = KO;
const fmtNum = (n) => (n === null || n === undefined ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 6 }));
const VALUES_MAX = 1000;
// ▾ 메뉴의 체크박스 목록: 지금 범위(탭·기간·다른 컬럼 필터)에서 그 컬럼에 실제로 있는 값과 건수.
function distinctValues(db, userId, q, col, needle) {
  const def = COLS[col];
  if (!def) return null;
  const w = buildWhere(db, userId, q, col);
  if (!w) return { values: [], total: 0, truncated: false };
  if (col === '품목명' && hasPendingNames(db)) fillNames(db);
  const expr = def.c === 'name_clean' ? "COALESCE(name_clean, '')" : def.c;
  let values = db.prepare(`SELECT ${expr} v, COUNT(*) n FROM hub_idx WHERE ${w.sql} GROUP BY v`).all(...w.params)
    .map((r) => ({ v: def.num ? fmtNum(r.v) : r.v, n: r.n, raw: r.v }));
  const nd = String(needle || '').trim().toLowerCase();
  if (nd) values = values.filter((x) => x.v.toLowerCase().includes(nd));
  values.sort((a, b) => (a.v === '' ? -1 : b.v === '' ? 1 : def.num ? a.raw - b.raw : collator.compare(a.v, b.v)));
  return { values: values.slice(0, VALUES_MAX).map(({ v, n }) => ({ v, n })), total: values.length, truncated: values.length > VALUES_MAX };
}

// 탭 라벨용 건수: 필터마다(지역 반영) + 전체(합집합)
function countsFor(db, userId) {
  const count = (scope) => (scope ? cachedCount(db, scope, () => db.prepare(`SELECT COUNT(*) c FROM hub_idx WHERE ${scope.sql}`).get(...scope.params).c) : 0);
  const byFilter = {};
  for (const f of db.prepare('SELECT id FROM filters WHERE user_id = ?').all(userId)) byFilter[f.id] = count(scopeFor(db, userId, f.id));
  return { total: count(scopeFor(db, userId, null)), byFilter };
}

// ─── 공개 페이지(로그인 없이 보이는 품목별 통계)용 ──────────────────────
// 로그인한 사용자의 필터와 무관한 "품목별" 집계라서 hub_idx만 훑는다(JSON을 풀지 않는다 — 15만 건에서 1.2초 → 수십 ms).
function publicItems(db) {
  return db.prepare(`SELECT item_code code, COUNT(*) n, MIN(NULLIF(cdate, '')) first, MAX(cdate) last, MAX(dname) name
    FROM hub_idx WHERE item_code <> '' AND fin = 1 GROUP BY item_code ORDER BY n DESC`).all();
}
// 한 품목의 최종 변경분 전부(통계용 좁은 열) + 최근 N건 원본
function publicItemRows(db, code, recentN) {
  const rows = db.prepare(`SELECT id, cdate, org, company, unit, price, qty, amount FROM hub_idx
    WHERE item_code = ? AND fin = 1 ORDER BY cdate DESC, id DESC`).all(code);
  return { rows, recent: fetchRows(db, rows.slice(0, recentN).map((r) => r.id), false) }; // 공개 페이지는 품목명을 원본 그대로
}

module.exports = {
  publicItems, publicItemRows,
  COLS, SORTABLE_COLS, parseRegion, regionSql, regionMatcher, cleanItemName, toDisplayRow,
  ensureHubIndex, fillNames, hasPendingNames, ensureNames, usesNames, scopeFor, parseColFilters, buildWhere, orderClause,
  listRows, exportRows, distinctValues, countsFor, VALUES_MAX,
};
