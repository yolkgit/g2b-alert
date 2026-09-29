// 2단계 탐색: 세부품명 선택용 돋보기 팝업과 날짜 입력 방식을 파악한다.
// 1단계에서 확인된 것: 조회물품 드롭다운(mf_popupCnts_comp4.5) 전환은 성공.
//   막힌 곳 — 세부품명 입력칸(mf_popupCnts_comp5)은 직접 타이핑 불가(돋보기 comp5_1로 선택),
//            날짜칸은 fill 시 달력이 떠버림.
//   실행: npm run explore-hub
const fs = require('fs');
const { chromium } = require('playwright');

const LIST_URL = 'https://data.g2b.go.kr/link/AISC001_01/?reptNm=UI-ADOXFA-190R';
const log = (...a) => console.log(...a);
const sel = (id) => `[id="${id}"]`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ko-KR' });

  const page0 = await ctx.newPage();
  const popupPromise = ctx.waitForEvent('page', { timeout: 45000 }).catch(() => null);
  await page0.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page0.waitForTimeout(5000);
  await page0.getByText('특정품목 조달 내역', { exact: true }).first().click({ timeout: 20000 });
  const page = (await popupPromise) || page0;
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(12000);
  const form = page.mainFrame();
  log('1. 보고서 열림');

  log('2. 조회물품 → 세부품명');
  await form.click(sel('mf_popupCnts_comp4.5'), { timeout: 20000 });
  await page.waitForTimeout(1500);
  await form.evaluate(() => {
    const c = [...document.querySelectorAll('div,td,li,span')]
      .filter((e) => e.textContent.trim() === '세부품명' && e.offsetParent !== null);
    if (c.length) c[c.length - 1].click();
  });
  await page.waitForTimeout(2500);

  // --- 입력칸 상태 확인: 왜 타이핑이 안 되는가? ---
  log('\n3. 세부품명 입력칸 속성');
  const attrs = await form.evaluate(() => {
    const out = {};
    for (const id of ['mf_popupCnts_comp5', 'mf_popupCnts_comp5_3']) {
      const el = document.getElementById(id);
      if (!el) { out[id] = null; continue; }
      out[id] = {
        readOnly: el.readOnly, disabled: el.disabled,
        visible: !!el.offsetParent, value: el.value,
        cls: (el.className || '').slice(0, 80),
      };
    }
    return out;
  });
  log('  ', JSON.stringify(attrs, null, 2));

  // --- 돋보기 팝업 열기 ---
  log('\n4. 돋보기(comp5_1) 클릭 → 팝업 구조 확인');
  const newPagePromise = ctx.waitForEvent('page', { timeout: 20000 }).catch(() => null);
  await form.click(sel('mf_popupCnts_comp5_1'), { timeout: 15000 }).catch((e) => log('   클릭 실패:', e.message.split('\n')[0]));
  const picker = await newPagePromise;
  await page.waitForTimeout(6000);

  const scope = picker || page;
  if (picker) { log('   새 창 팝업:', picker.url().slice(0, 120)); await picker.waitForLoadState('domcontentloaded').catch(() => {}); await picker.waitForTimeout(4000); }
  else log('   새 창 없음 → 같은 페이지 내 레이어로 추정');

  const pf = scope.mainFrame();
  const controls = await pf.evaluate(() => {
    const info = (el) => ({
      id: el.id || null, type: el.getAttribute('type') || null,
      value: (el.value || '').slice(0, 25) || null,
      title: el.getAttribute('title') || null,
      visible: !!el.offsetParent,
    });
    return {
      inputs: [...document.querySelectorAll('input')].map(info).filter((x) => x.visible && x.id),
      tables: [...document.querySelectorAll('table')].length,
    };
  });
  log('   보이는 input 목록:');
  controls.inputs.forEach((x) => log('     ', JSON.stringify(x)));
  log('   table 수:', controls.tables);

  fs.writeFileSync('hub-picker.html', await pf.content());
  await scope.screenshot({ path: 'hub-picker.png' });
  log('   저장: hub-picker.html / hub-picker.png');

  await browser.close();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
