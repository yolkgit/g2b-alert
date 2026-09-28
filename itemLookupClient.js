const https = require('https');

// 실제 서비스키로 확인된 값(2026-09-28, 참고문서 "조달청_OpenAPI참고자료_물품목록정보서비스_1.2.docx"):
// 서비스명/오퍼레이션명 모두 "02"가 붙는다(v1 이름으로 호출하면 NO_OPENAPI_SERVICE_ERROR).
// dtilPrdctClsfcNoNm(세부품명)은 Like 검색이라 "제설제"처럼 일부만 넣어도 고상제설제/액상제설제 등이 다 걸린다.
const BASE_URL = 'https://apis.data.go.kr/1230000/ao/ThngListInfoService02';
const OPERATION = 'getPrdctClsfcNoUnit10Info02';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function buildUrl(serviceKey, keyword) {
  const params = new URLSearchParams({
    serviceKey,
    type: 'json',
    numOfRows: '30',
    pageNo: '1',
    dtilPrdctClsfcNoNm: keyword,
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

async function searchItemCodes(serviceKey, keyword) {
  const { body } = await httpGet(buildUrl(serviceKey, keyword));
  let json;
  try { json = JSON.parse(body); } catch { throw new Error(`응답 파싱 실패: ${body.slice(0, 200)}`); }
  const { items, error } = parseResponse(json);
  if (error) throw new Error(`물품목록 검색 API 오류: ${error}`);
  return { items };
}

function summarizeItem(item) {
  return {
    name: item.dtilPrdctClsfcNoNm || null,
    code: item.dtilPrdctClsfcNo || null,
    desc: item.dtilPrdctClsfcNoNmDscrpt || null,
    raw: item,
  };
}

module.exports = { searchItemCodes, summarizeItem, BASE_URL, OPERATION };
