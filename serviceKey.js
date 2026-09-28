// data.go.kr은 인증키를 Encoding(%3D%3D 포함)/Decoding(==) 두 형태로 제공하는데, Encoding
// 형태를 그대로 URLSearchParams에 넣으면 %가 다시 인코딩(%25)되어 이중 인코딩으로 깨진다.
// 모든 data.go.kr 호출 지점(g2bClient, itemLookupClient 등)이 이 함수를 거쳐야 한다.
function normalizeServiceKey(key) {
  return /%[0-9A-Fa-f]{2}/.test(key) ? decodeURIComponent(key) : key;
}

module.exports = { normalizeServiceKey };
