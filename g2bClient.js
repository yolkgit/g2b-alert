const https = require('https');

const BASE_URL = 'https://apis.data.go.kr/1230000/ao/CntrctInfoService';
// 실제 서비스키로 확인된 오퍼레이션/파라미터(2026-09-28). 날짜는 YYYYMMDDHHMM(12자리) 형식이어야
// "필수값 입력 에러"가 나지 않는다 (YYYYMMDD 8자리로 보내면 게이트웨이가 HTTP_ERROR로 튕겨낸다).
const OPERATION = 'getCntrctInfoListThng';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

// data.go.kr은 "인증키(Encoding)"와 "인증키(Decoding)" 두 형태를 제공하는데, Encoding 형태를
// 그대로 붙여넣으면 %3D%3D 같은 퍼센트 인코딩이 문자 그대로 포함돼 있다. URLSearchParams가 이걸
// 다시 인코딩하면 %가 %25로 이중 인코딩되어 SERVICE_KEY_IS_NOT_REGISTERED_ERROR가 난다.
// 퍼센트 인코딩처럼 보이면 한 번 미리 디코딩해서 항상 순수 디코딩 형태로 맞춘다.
function normalizeServiceKey(key) {
  return /%[0-9A-Fa-f]{2}/.test(key) ? decodeURIComponent(key) : key;
}

function buildUrl(serviceKey, { beginDate, endDate, pageNo, numOfRows }) {
  const params = new URLSearchParams({
    serviceKey: normalizeServiceKey(serviceKey),
    type: 'json',
    numOfRows: String(numOfRows),
    pageNo: String(pageNo),
    inqryDiv: '1',
    inqryBgnDt: `${beginDate}0000`,
    inqryEndDt: `${endDate}0000`,
  });
  return `${BASE_URL}/${OPERATION}?${params.toString()}`;
}

// 정상 응답은 {response:{header,body}}, 필수값 오류는 {"nkoneps.com.response.ResponseError":{header}},
// 게이트웨이 오류(잘못된 파라미터명 등)는 {"OpenAPI_ServiceResponse":{cmmMsgHeader}} 로 각각 다른 최상위 키를 쓴다.
function extractItems(json) {
  if (json.OpenAPI_ServiceResponse) {
    const h = json.OpenAPI_ServiceResponse.cmmMsgHeader;
    return { items: [], totalCount: 0, error: `${h.returnReasonCode} ${h.errMsg} ${h.returnAuthMsg}` };
  }
  const wrapper = json.response || json['nkoneps.com.response.ResponseError'];
  const header = wrapper?.header;
  if (!header) return { items: [], totalCount: 0, error: '알 수 없는 응답 형식' };
  if (header.resultCode !== '00' && header.resultCode !== '0') {
    return { items: [], totalCount: 0, error: `${header.resultCode} ${header.resultMsg}` };
  }
  const body = wrapper.body || {};
  let items = body.items;
  if (!items) items = [];
  else if (items.item) items = Array.isArray(items.item) ? items.item : [items.item];
  else if (!Array.isArray(items)) items = [items];
  return { items, totalCount: Number(body.totalCount || items.length) };
}

// 날짜범위의 전체 페이지를 안전 한도(maxPages) 안에서 모두 가져온다
async function fetchContracts(serviceKey, beginDate, endDate, { maxPages = 20, numOfRows = 999 } = {}) {
  const all = [];
  let truncated = false;
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const url = buildUrl(serviceKey, { beginDate, endDate, pageNo, numOfRows });
    const { status, body } = await httpGet(url);
    let json;
    try { json = JSON.parse(body); } catch { throw new Error(`API 응답 파싱 실패 (status=${status}): ${body.slice(0, 300)}`); }
    const { items, totalCount, error } = extractItems(json);
    if (error) throw new Error(`나라장터 계약정보 API 오류: ${error}`);
    all.push(...items);
    if (all.length >= totalCount || items.length === 0) break;
    if (pageNo === maxPages && all.length < totalCount) truncated = true;
  }
  return { items: all, operation: OPERATION, truncated };
}

module.exports = { fetchContracts, BASE_URL, OPERATION };
