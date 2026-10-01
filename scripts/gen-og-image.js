// 카톡·네이버·페이스북 등에 링크를 공유할 때 뜨는 미리보기 이미지(1200x630)를 만든다.
// 문구를 바꾸면 다시 돌려서 public/og-image.png를 갱신한다: npm run gen-og
const path = require('path');
const { chromium } = require('playwright');

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:#18181b;color:#fafafa;position:relative;
       font-family:'Malgun Gothic','Noto Sans CJK KR','Apple SD Gothic Neo',sans-serif;
       display:flex;flex-direction:column;justify-content:center;padding:0 96px}
  .badge{align-self:flex-start;border:1px solid #3f3f46;color:#a1a1aa;border-radius:999px;padding:8px 22px;font-size:24px;margin-bottom:36px}
  h1{font-size:78px;font-weight:700;letter-spacing:-2px;line-height:1.2}
  p{font-size:34px;color:#a1a1aa;margin-top:26px;line-height:1.55}
  .url{position:absolute;bottom:56px;left:96px;font-size:26px;color:#71717a}
  svg{position:absolute;right:96px;top:88px}
</style></head><body>
  <div class="badge">무료 · 조달청 조달데이터허브 공공데이터</div>
  <h1>나라장터 특정품목 알림</h1>
  <p>관심 품목 신규 계약을 매일 아침 푸시로<br>품목별 조달 단가·계약 내역 조회</p>
  <div class="url">g2b.soritok.com</div>
  <svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="#fafafa" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
  </svg>
</body></html>`;

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(html);
  const out = path.join(__dirname, '..', 'public', 'og-image.png');
  await page.screenshot({ path: out });
  await browser.close();
  console.log(`생성: ${out}`);
})();
