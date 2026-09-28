const https = require('https');

const BASE_URL = 'https://apis.data.go.kr/1230000/ao/ThngListInfoService';
// 세부물품분류번호(10자리 = 세부품명) 목록/검색 오퍼레이션. 파라미터명은 실제 서비스키 승인 전이라
// 미확정 — prdctClsfcNoNm(품명)을 우선 시도하고 안 되면 dtilPrdctClsfcNoNm으로 재시도한다.
const OPERATION = 'getPrdctClsfcNoUnit10Info';
const KEYWORD_PARAM_CANDIDATES = ['prdctClsfcNoNm', 'dtilPrdctClsfcNoNm'];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function buildUrl(serviceKey, keywordParam, keyword) {
  const params = new URLSearchParams({
    serviceKey,
    type: 'json',
    numOfRows: '30',
    pageNo: '1',
    [keywordParam]: keyword,
  });
  return `${BASE_URL}/${OPERATION}?${params.toString()}`;
}

function parseResponse(json) {
  if (json.OpenAPI_ServiceResponse) {
    const h = json.OpenAPI_ServiceResponse.cmmMsgHeader;
    return { items: [], error: `${h.returnReasonCode} ${h.errMsg}` };
  }
  const wrapper = json.response || json['nkoneps.com.response.ResponseError'];
  const header = wrapper?.header;
  if (!header) return { items: [], error: '알 수 없는 응답 형식' };
  if (header.resultCode !== '00' && header.resultCode !== '0') {
    return { items: [], error: `${header.resultCode} ${header.resultMsg}` };
  }
  const body = wrapper.body || {};
  let items = body.items;
  if (!items) items = [];
  else if (items.item) items = Array.isArray(items.item) ? items.item : [items.item];
  else if (!Array.isArray(items)) items = [items];
  return { items };
}

// 파라미터명 후보를 순서대로 시도해서 정상 응답(에러 없음)을 주는 쪽을 쓴다
async function searchItemCodes(serviceKey, keyword) {
  let lastError = null;
  for (const keywordParam of KEYWORD_PARAM_CANDIDATES) {
    const url = buildUrl(serviceKey, keywordParam, keyword);
    const { body } = await httpGet(url);
    let json;
    try { json = JSON.parse(body); } catch { lastError = `응답 파싱 실패: ${body.slice(0, 200)}`; continue; }
    const { items, error } = parseResponse(json);
    if (!error) return { items, keywordParam };
    lastError = error;
  }
  throw new Error(`물품목록 검색 API 오류: ${lastError}`);
}

// 응답 필드명도 미확정이라 후보 키 중 값이 있는 걸 골라 화면에 보여줄 이름/코드를 구성한다.
// 후보가 틀렸으면 이 배열만 고치면 되고, 원본 item은 그대로 함께 내려가니 화면에서 원본도 볼 수 있다.
const NAME_CANDIDATES = ['dtilPrdctClsfcNoNm', 'prdctClsfcNoNm', 'prdctNm'];
const CODE_CANDIDATES = ['dtilPrdctClsfcNo', 'prdctClsfcNo'];

function pick(item, candidates) {
  for (const key of candidates) {
    const v = item[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function summarizeItem(item) {
  return { name: pick(item, NAME_CANDIDATES), code: pick(item, CODE_CANDIDATES), raw: item };
}

module.exports = { searchItemCodes, summarizeItem, BASE_URL, OPERATION };
