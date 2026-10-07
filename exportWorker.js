// 엑셀 저장을 서버 본체와 따로 돌리는 전용 스레드. 수만 행의 JSON을 풀고 zip으로 압축하는 일은 CPU를 오래
// 쓰는데, 서버 본체(이벤트 루프)에서 하면 그동안 다른 모든 사용자의 요청이 멈춘다. 읽기 전용으로 DB를 따로 열어
// (WAL이라 수집·다른 요청과 서로 막지 않음) 같은 조회 함수(hubquery.js)로 행을 읽고 xlsx를 만든다.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { exportRows } = require('./hubquery');
const { buildXlsx } = require('./xlsx');

try {
  const { dbPath, userId, q, header, label, max } = workerData;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  // 읽기 전용 연결이라 비어 있는 품목명을 채우지는 않는다(서버가 요청을 받을 때 이미 채웠다)
  const { rows } = exportRows(db, userId, q, max, { fill: false });
  db.close();
  const buf = buildXlsx({
    sheetName: label, header,
    rows: rows.map((j) => header.map((c) => j[c] ?? '')),
    numeric: header.map((c) => /단가|수량|금액/.test(c)),
  });
  parentPort.postMessage({ ok: true, buf, count: rows.length });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
