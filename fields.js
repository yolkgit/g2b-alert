// 실제 서비스키로 확인된 getCntrctInfoListThng 응답 필드명(2026-09-28).
// dminsttList/corpList는 "[순번^필드^필드^...]" 형태로 패킹된 문자열이라 별도로 풀어서 읽는다.
const FIELD_CANDIDATES = {
  contractNo: ['untyCntrctNo', 'dcsnCntrctNo', 'cntrctRefNo'],
  contractDate: ['cntrctCnclsDate', 'cntrctDate'],
  itemName: ['cntrctNm'],
  detailItemName: ['pubPrcrmntClsfcNm', 'pubPrcrmntMidClsfcNm', 'pubPrcrmntLrgClsfcNm'],
  amount: ['thtmCntrctAmt', 'totCntrctAmt'],
  detailUrl: ['cntrctDtlInfoUrl', 'cntrctInfoUrl'],
  bizType: ['bsnsDivNm'],
  bidMethod: ['cntrctCnclsMthdNm'],
};

function pick(item, candidates) {
  for (const key of candidates) {
    const v = item[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

// "[1^1270315^법무부 대전지방교정청 대전교도소^국가기관^^^][2^...]" 같은 패킹 문자열에서
// 그룹별로 필드를 쪼갠다. fieldIndex는 각 그룹을 "^"로 split한 배열의 인덱스.
function parsePackedList(raw, fieldIndex) {
  if (!raw) return [];
  const groups = raw.split('][').map((g) => g.replace(/^\[/, '').replace(/\]$/, ''));
  return groups.map((g) => g.split('^')[fieldIndex]).filter(Boolean);
}

function demandOrgNames(item) {
  const names = parsePackedList(item.dminsttList, 2);
  return names.length ? names.join(', ') : pick(item, ['cntrctInsttNm']);
}
function companyNames(item) {
  const names = parsePackedList(item.corpList, 3);
  return names.length ? names.join(', ') : null;
}

function summarize(item) {
  const out = {};
  for (const [field, candidates] of Object.entries(FIELD_CANDIDATES)) out[field] = pick(item, candidates);
  out.demandOrg = demandOrgNames(item);
  out.company = companyNames(item);
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
