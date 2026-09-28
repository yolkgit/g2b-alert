const https = require('https');

const BASE_URL = 'https://apis.data.go.kr/1230000/ao/CntrctInfoService';
// 오퍼레이션명이 정확히 확인되지 않아 두 후보를 순서대로 시도한다 (첫 성공 응답을 그대로 사용)
const OPERATIONS = ['getCntrctInfoListThng', 'getCntrctInfoListThngPPSSrch'];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function buildUrl(operation, serviceKey, { beginDate, endDate, pageNo, numOfRows }) {
  const params = new URLSearchParams({
    serviceKey,
    type: 'json',
    numOfRows: String(numOfRows),
    pageNo: String(pageNo),
    inqryDiv: '1',
    inqryBgnDate: beginDate,
    inqryEndDate: endDate,
  });
  return `${BASE_URL}/${operation}?${params.toString()}`;
}

function extractItems(json) {
  const body = json && json.response && json.response.body;
  if (!body) return { items: [], totalCount: 0, resultCode: json?.response?.header?.resultCode, resultMsg: json?.response?.header?.resultMsg };
  let items = body.items;
  if (!items) items = [];
  else if (items.item) items = Array.isArray(items.item) ? items.item : [items.item];
  else if (!Array.isArray(items)) items = [items];
  return { items, totalCount: Number(body.totalCount || items.length), resultCode: json.response.header?.resultCode, resultMsg: json.response.header?.resultMsg };
}

// 특정 오퍼레이션+날짜범위의 전체 페이지를 안전 한도(MAX_PAGES) 안에서 모두 가져온다
async function fetchAllPages(operation, serviceKey, beginDate, endDate, { maxPages = 20, numOfRows = 999 } = {}) {
  const all = [];
  let truncated = false;
  let lastMeta = null;
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const url = buildUrl(operation, serviceKey, { beginDate, endDate, pageNo, numOfRows });
    const { status, body } = await httpGet(url);
    let json;
    try { json = JSON.parse(body); } catch { throw new Error(`API 응답 파싱 실패 (status=${status}): ${body.slice(0, 300)}`); }
    const { items, totalCount, resultCode, resultMsg } = extractItems(json);
    lastMeta = { resultCode, resultMsg, totalCount };
    if (resultCode && resultCode !== '00' && resultCode !== '0') {
      return { items: all, meta: lastMeta, error: resultMsg || resultCode };
    }
    all.push(...items);
    if (all.length >= totalCount || items.length === 0) break;
    if (pageNo === maxPages && all.length < totalCount) truncated = true;
  }
  return { items: all, meta: lastMeta, truncated };
}

// 두 오퍼레이션 후보를 순서대로 시도해서 정상 응답(resultCode 00)을 주는 쪽을 사용한다
async function fetchContracts(serviceKey, beginDate, endDate, opts) {
  let lastError = null;
  for (const operation of OPERATIONS) {
    const result = await fetchAllPages(operation, serviceKey, beginDate, endDate, opts);
    if (!result.error) return { ...result, operation };
    lastError = result.error;
  }
  throw new Error(`나라장터 계약정보 API 호출 실패: ${lastError}`);
}

module.exports = { fetchContracts, BASE_URL, OPERATIONS };
