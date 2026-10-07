// 검색엔진(네이버·구글)용 공개 페이지. 앱 화면(index.html)은 클라이언트 렌더링 + 로그인
// 뒤라 크롤러에겐 로그인 박스만 보인다 — 그래서 품목별 단가·계약 내역을 서버에서 HTML로
// 그려 검색 유입을 받고, "이 품목 알림 받기"로 가입을 유도한다.
// 로그인 없이 보이는 건 hub_items(조달데이터허브 공공데이터)뿐이다. 사용자별 데이터
// (계정·필터·구독)는 이 파일에서 절대 읽지 않는다.
const fs = require('fs');
const path = require('path');

const SITE_URL = (process.env.SITE_URL || 'https://g2b.soritok.com').replace(/\/+$/, '');
const SITE_NAME = '나라장터 특정품목 알림';
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
// 이보다 건수가 적은 품목 페이지는 내용이 빈약해서 색인(검색 노출)과 sitemap에서 뺀다.
const MIN_ROWS_TO_INDEX = 3;
// 허브 자료는 하루 몇 번(크론·수동 조회) 바뀌는 게 전부라 집계 결과를 잠깐 들고 있는다.
const CACHE_MS = 10 * 60 * 1000;

const hubq = require('./hubquery');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function num(s) {
  const t = String(s ?? '').replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
const fmtNum = (s) => { const n = num(s); return n == null ? '-' : n.toLocaleString('ko-KR'); };
const won = (n) => (n == null ? '-' : `${Math.round(n).toLocaleString('ko-KR')}원`);
function bigWon(n) {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}억원`;
  if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString('ko-KR')}만원`;
  return won(n);
}
const isoDate = (ymd) => (/^\d{8}$/.test(ymd || '') ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : '');
const korDate = (ymd) => (/^\d{8}$/.test(ymd || '') ? `${+ymd.slice(0, 4)}년 ${+ymd.slice(4, 6)}월 ${+ymd.slice(6, 8)}일` : '');
// 받침 유무로 은/는을 고른다(한글로 안 끝나면 둘 다 표기).
function topicJosa(word) {
  const c = String(word).charCodeAt(String(word).length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? '은' : '는';
  return '은(는)';
}
// JSON-LD를 <script> 안에 넣을 때 "</script>"로 태그가 끊기지 않게 <를 이스케이프한다.
const jsonLdTag = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

// 첫 화면 HTML은 요청마다 디스크에서 읽지 않고(동기 읽기가 서버를 잠깐 멈춘다) 파일이 바뀌었을 때만 다시 읽는다
let indexCache = { mtimeMs: 0, html: '' };
function readIndexHtml() {
  const st = fs.statSync(INDEX_HTML);
  if (st.mtimeMs !== indexCache.mtimeMs) indexCache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(INDEX_HTML, 'utf8') };
  return indexCache.html;
}

const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ─── 데이터 ──────────────────────────────────────────────
// 같은 계약이 변경될 때마다 변경차수별 행이 따로 쌓이므로 집계는 최종 변경분만 센다(안 그러면 변경된 계약의 건수·금액이
// 두 번 잡힌다). 그 구분과 집계는 hubquery.js의 가벼운 색인 표(hub_idx)가 맡는다.
function listItems(db) {
  return cached('items', () => hubq.publicItems(db).map((r) => ({ ...r, name: r.name || r.code })));
}

const UNIT_ALIASES = { ton: '톤', t: '톤', ea: '개', kg: 'kg' };
function normUnit(u) {
  const t = String(u || '').trim();
  return UNIT_ALIASES[t.toLowerCase()] || t;
}

function groupTop(rows, key, sortKey, limit) {
  const m = new Map();
  for (const r of rows) {
    const k = String(r[key] || '').trim();
    if (!k) continue;
    const e = m.get(k) || { name: k, n: 0, amount: 0 };
    e.n += 1;
    e.amount += r.amount || 0;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b[sortKey] - a[sortKey] || b.n - a.n).slice(0, limit);
}

// listItems에 있는 코드만 넘어온다(아무 번호로나 찔러서 캐시가 무한정 커지는 걸 막기 위해).
function getItemData(db, code) {
  return cached(`item:${code}`, () => {
    const { rows, recent } = hubq.publicItemRows(db, code, 30); // rows: 통계용 좁은 열 전체(최신순), recent: 최근 30건 원본

    // 단위가 포·kg·25kg/포처럼 제각각이라 단가는 단위별로 따로 본다. 평균은 이상치에
    // 휘둘려서 중간값을 쓴다. 총액 일괄 계약이 "수량 1, 단가=공급금액"으로 들어온 행
    // (예: 1kg에 9억)은 단가가 아니라서 뺀다.
    const byUnit = new Map();
    for (const r of rows) {
      const p = r.price;
      if (!p || p <= 0) continue;
      if ((r.qty || 0) <= 1 && p === r.amount) continue;
      const u = normUnit(r.unit) || '(단위 없음)';
      if (!byUnit.has(u)) byUnit.set(u, []);
      byUnit.get(u).push(p);
    }
    const units = [...byUnit].map(([unit, prices]) => {
      prices.sort((a, b) => a - b);
      const mid = prices.length >> 1;
      const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
      return { unit, n: prices.length, min: prices[0], median, max: prices[prices.length - 1] };
    }).sort((a, b) => b.n - a.n);
    // 대표 단가는 표본이 몇 건은 돼야 의미가 있다.
    const topUnit = units[0] && units[0].n >= 3 ? units[0] : null;

    return {
      n: rows.length,
      first: rows.length ? rows[rows.length - 1].cdate : '',
      last: rows.length ? rows[0].cdate : '',
      total: rows.reduce((s, r) => s + (r.amount || 0), 0),
      units,
      topUnit,
      agencies: groupTop(rows, 'org', 'n', 10),
      suppliers: groupTop(rows, 'company', 'amount', 10),
      recent,
    };
  });
}

// ─── 렌더링 ──────────────────────────────────────────────
function layout({ title, description, canonical, noindex, jsonLd, body }) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">\n` : ''}${noindex ? '<meta name="robots" content="noindex,follow">\n' : ''}<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">\n` : ''}<meta property="og:image" content="${SITE_URL}/og-image.png">
<meta property="og:locale" content="ko_KR">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#18181b">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="stylesheet" href="/site.css">
${jsonLd ? jsonLdTag(jsonLd) : ''}
</head>
<body>
<header class="site-header"><div class="wrap">
  <a class="brand" href="/">🔔 ${SITE_NAME}</a>
  <a class="btn" href="/?signup=1" rel="nofollow">무료 알림 받기</a>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="site-footer"><div class="wrap">
  <p>출처: 조달청 조달데이터허브(공공데이터). 같은 계약의 변경 이력은 최종 변경분만 집계했습니다.</p>
  <p>이 사이트는 조달청·나라장터의 공식 서비스가 아닙니다.</p>
</div></footer>
</body>
</html>`;
}

const breadcrumbLd = (crumbs) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: crumbs.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url })),
});

function itemSummary(item, d) {
  const top = d.topUnit;
  return [
    `${item.name}(세부품명번호 ${item.code})${topicJosa(item.name)} ${korDate(d.first)}부터 ${korDate(d.last)}까지 나라장터에서 계약·납품요구 ${d.n.toLocaleString('ko-KR')}건, 공급금액 합계 ${bigWon(d.total)}이 집계됐습니다.`,
    top ? `가장 많이 거래된 단위는 '${top.unit}'이며, 단가 중간값은 ${won(top.median)}(최저 ${won(top.min)} ~ 최고 ${won(top.max)})입니다.` : '',
    d.agencies.length ? `주요 수요기관은 ${d.agencies.slice(0, 3).map((a) => a.name).join(', ')} 등입니다.` : '',
  ].filter(Boolean).join(' ');
}

const amountTable = (rows, label) => `<div class="table-scroll"><table>
<thead><tr><th>${label}</th><th class="num">건수</th><th class="num">공급금액</th></tr></thead>
<tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.n.toLocaleString('ko-KR')}</td><td class="num">${bigWon(r.amount)}</td></tr>`).join('')}</tbody>
</table></div>`;

function renderItemPage(item, d, items) {
  const canonical = `${SITE_URL}/item/${item.code}`;
  const summary = itemSummary(item, d);
  const top = d.topUnit;
  const units = d.units.filter((u) => u.n >= 5).slice(0, 6);
  const others = items.filter((i) => i.code !== item.code).slice(0, 20);
  const ctaHref = `/?signup=1&code=${item.code}&kw=${encodeURIComponent(item.name)}`;

  const body = `<nav class="crumbs"><a href="/">홈</a> › <a href="/items">품목별 조달 내역</a> › <span>${esc(item.name)}</span></nav>
<h1>${esc(item.name)} 조달 단가·계약 내역</h1>
<p class="lead">${esc(summary)}</p>
<div class="stats">
  <div class="stat"><span>계약·납품요구</span><b>${d.n.toLocaleString('ko-KR')}건</b></div>
  <div class="stat"><span>공급금액 합계</span><b>${bigWon(d.total)}</b></div>
  <div class="stat"><span>단가 중간값${top ? ` (${esc(top.unit)})` : ''}</span><b>${top ? won(top.median) : '-'}</b></div>
  <div class="stat"><span>최근 계약일</span><b>${isoDate(d.last)}</b></div>
</div>
<div class="cta">
  <div><b>${esc(item.name)} 새 계약이 올라오면 알려드릴까요?</b><p>매일 정한 시간에 확인해서 새 계약·납품요구가 있으면 휴대폰 푸시로 보내드립니다.</p></div>
  <a class="btn" href="${esc(ctaHref)}" rel="nofollow">이 품목 알림 받기 (무료)</a>
</div>
${units.length ? `<section class="card"><h2>단위별 단가</h2>
<p class="sub">자료에 적힌 단위 그대로 따로 집계했습니다(5건 이상인 단위만). 수량 1건으로 잡힌 총액 일괄 계약은 뺐습니다.</p><div class="table-scroll"><table>
<thead><tr><th>단위</th><th class="num">건수</th><th class="num">최저</th><th class="num">중간값</th><th class="num">최고</th></tr></thead>
<tbody>${units.map((u) => `<tr><td>${esc(u.unit)}</td><td class="num">${u.n.toLocaleString('ko-KR')}</td><td class="num">${won(u.min)}</td><td class="num">${won(u.median)}</td><td class="num">${won(u.max)}</td></tr>`).join('')}</tbody>
</table></div></section>` : ''}
<section class="card"><h2>최근 계약·납품요구 내역</h2>
<p class="sub">최근 ${d.recent.length.toLocaleString('ko-KR')}건 (전체 ${d.n.toLocaleString('ko-KR')}건)</p>
<div class="table-scroll"><table>
<thead><tr><th>계약일자</th><th>수요기관</th><th>업체명</th><th>단위</th><th class="num">단가</th><th class="num">수량</th><th class="num">공급금액</th><th>품목명</th><th>계약명</th></tr></thead>
<tbody>${d.recent.map((r) => `<tr><td>${isoDate(r['계약(납품요구)일자'])}</td><td class="wrap-cell">${esc(r['수요기관'])}</td><td class="wrap-cell">${esc(r['업체명'])}</td><td>${esc(r['단위'])}</td><td class="num">${fmtNum(r['계약납품단가'])}</td><td class="num">${fmtNum(r['계약납품수량'])}</td><td class="num">${fmtNum(r['공급금액'])}</td><td class="wrap-cell long">${esc(r['품목명'])}</td><td class="wrap-cell long">${esc(r['계약(납품요구)명'])}</td></tr>`).join('')}</tbody>
</table></div></section>
<div class="grid2">
  <section class="card"><h2>주요 수요기관</h2>${amountTable(d.agencies, '수요기관')}</section>
  <section class="card"><h2>주요 납품업체</h2>${amountTable(d.suppliers, '업체명')}</section>
</div>
${others.length ? `<section class="card"><h2>다른 품목 조달 내역</h2><ul class="chips">${others.map((i) => `<li><a href="/item/${i.code}">${esc(i.name)}</a></li>`).join('')}</ul></section>` : ''}
<p class="sub">자료 범위: ${isoDate(d.first)} ~ ${isoDate(d.last)}</p>`;

  return layout({
    title: `${item.name} 나라장터 조달 단가·계약 내역 | ${SITE_NAME}`,
    description: summary.length > 155 ? `${summary.slice(0, 154)}…` : summary,
    canonical,
    noindex: item.n < MIN_ROWS_TO_INDEX,
    jsonLd: breadcrumbLd([['홈', `${SITE_URL}/`], ['품목별 조달 내역', `${SITE_URL}/items`], [item.name, canonical]]),
    body,
  });
}

function renderItemsPage(items) {
  const body = `<nav class="crumbs"><a href="/">홈</a> › <span>품목별 조달 내역</span></nav>
<h1>품목별 나라장터 조달 단가·계약 내역</h1>
<p class="lead">조달청 조달데이터허브에 공개된 물품 계약·납품요구 내역을 품목(세부품명)별로 정리했습니다. 품목을 누르면 단위별 단가, 최근 계약, 주요 수요기관·납품업체를 볼 수 있습니다.</p>
${items.length ? `<ul class="item-list">${items.map((i) => `<li><a href="/item/${i.code}"><b>${esc(i.name)}</b><span>${i.code} · ${i.n.toLocaleString('ko-KR')}건 · 최근 ${isoDate(i.last)}</span></a></li>`).join('')}</ul>` : '<p class="sub">아직 공개된 품목이 없습니다.</p>'}
<div class="cta" style="margin-top:16px">
  <div><b>찾는 품목이 없나요?</b><p>가입 후 관심 품목을 등록하면 매일 계약 내역을 모으고, 새 계약이 올라오면 알려드립니다.</p></div>
  <a class="btn" href="/?signup=1" rel="nofollow">무료로 시작하기</a>
</div>`;
  return layout({
    title: `품목별 나라장터 조달 단가·계약 내역 | ${SITE_NAME}`,
    description: `조달청 조달데이터허브 공공데이터로 정리한 품목별 나라장터 계약·납품요구 내역. ${items.slice(0, 5).map((i) => i.name).join(', ')} 등 ${items.length}개 품목의 단가·수요기관·납품업체를 확인하세요.`,
    canonical: `${SITE_URL}/items`,
    jsonLd: breadcrumbLd([['홈', `${SITE_URL}/`], ['품목별 조달 내역', `${SITE_URL}/items`]]),
    body,
  });
}

const renderNotFound = () => layout({
  title: `페이지를 찾을 수 없습니다 | ${SITE_NAME}`,
  description: '요청하신 품목의 공개 자료가 없습니다.',
  noindex: true,
  body: `<h1>페이지를 찾을 수 없습니다</h1><p class="lead">요청하신 품목의 공개 자료가 없습니다. <a href="/items">품목별 조달 내역</a>에서 다른 품목을 찾아보세요.</p>`,
});

function renderHomeItemLinks(items) {
  if (!items.length) return '<p class="sub">아직 공개된 품목이 없습니다.</p>';
  return `<ul class="item-links">${items.slice(0, 12).map((i) => `<li><a href="/item/${i.code}"><span>${esc(i.name)}</span><span class="cnt">${i.n.toLocaleString('ko-KR')}건</span></a></li>`).join('')}</ul>
<p style="margin-top:12px;font-size:13px"><a href="/items">전체 품목 보기 →</a></p>`;
}

// ─── 라우트 ──────────────────────────────────────────────
// express.static보다 먼저 등록해야 "/"를 여기서 가로챈다.
function registerSeoRoutes(app, { db, getSessionUser }) {
  // 로그인 상태면 <html class="authed">로 내려 소개 화면이 깜빡이지 않게 하고, 공개 품목
  // 링크를 박아서 크롤러가 홈에서 품목 페이지로 따라 들어올 수 있게 한다.
  app.get('/', (req, res) => {
    let html = readIndexHtml();
    if (getSessionUser(req)) html = html.replace('<html lang="ko">', '<html lang="ko" class="authed">');
    html = html.replace('<!--ITEM_LINKS-->', renderHomeItemLinks(listItems(db)));
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  });
  app.get('/index.html', (req, res) => res.redirect(301, '/'));

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  });

  app.get('/sitemap.xml', (req, res) => {
    const items = listItems(db).filter((i) => i.n >= MIN_ROWS_TO_INDEX);
    const newest = items.reduce((m, i) => (i.last > m ? i.last : m), '');
    const url = (loc, lastmod) => `  <url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${isoDate(lastmod)}</lastmod>` : ''}</url>`;
    res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      url(`${SITE_URL}/`, newest),
      url(`${SITE_URL}/items`, newest),
      ...items.map((i) => url(`${SITE_URL}/item/${i.code}`, i.last)),
      '</urlset>',
    ].join('\n'));
  });

  app.get('/items', (req, res) => {
    res.set('Cache-Control', 'public, max-age=600').type('html').send(renderItemsPage(listItems(db)));
  });

  app.get('/item/:code', (req, res) => {
    const items = listItems(db);
    const item = items.find((i) => i.code === req.params.code);
    if (!item) return res.status(404).type('html').send(renderNotFound());
    res.set('Cache-Control', 'public, max-age=600').type('html').send(renderItemPage(item, getItemData(db, item.code), items));
  });
}

module.exports = { registerSeoRoutes };
