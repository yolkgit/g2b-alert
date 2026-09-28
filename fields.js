// 나라장터 계약정보 API의 실제 응답 필드명이 사전에 100% 확정되지 않아,
// 로직은 후보 키 목록에서 값을 찾는 방식으로 짜고, 원본 JSON은 항상 별도 보존한다.
// 실제 첫 응답을 보고 후보가 틀렸으면 이 파일의 후보 배열만 고치면 된다.
const FIELD_CANDIDATES = {
  contractNo: ['cntrctNo', 'untyCntrctNo', 'cntrctSno'],
  contractDate: ['cntrctCnclsDate', 'cntrctDate', 'cntrctCnclsDe', 'cntrctDminsttDate'],
  itemName: ['prdctClsfcNoNm', 'prdctNm', 'bidNtceNm', 'cntrctNm'],
  detailItemName: ['dtilPrdctClsfcNoNm', 'prdctClsfcNoNm'],
  demandOrg: ['dmndInsttNm', 'dminsttNm', 'cntrctInsttNm'],
  company: ['rprsntCorpNm', 'corpNm', 'cmpnyNm'],
  amount: ['cntrctAmt', 'ttalCntrctAmt', 'cntrctPrdAmt'],
  region: ['dmndInsttRgnNm', 'rprsntCorpAdrs', 'cntrctInsttRgnNm'],
};

function pick(item, candidates) {
  for (const key of candidates) {
    const v = item[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function summarize(item) {
  const out = {};
  for (const [field, candidates] of Object.entries(FIELD_CANDIDATES)) out[field] = pick(item, candidates);
  return out;
}

// 아이템의 모든 문자열 값을 대상으로 키워드가 포함되는지 검사 (필드명을 몰라도 매칭 가능)
function itemMatchesKeyword(item, keyword) {
  if (!keyword) return true;
  const needle = keyword.toLowerCase();
  return Object.values(item).some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
}

function buildContractKey(item) {
  const no = pick(item, FIELD_CANDIDATES.contractNo);
  if (no) return no;
  return require('crypto').createHash('sha1').update(JSON.stringify(item)).digest('hex');
}

module.exports = { FIELD_CANDIDATES, pick, summarize, itemMatchesKeyword, buildContractKey };
