// 사이트 아이콘 일체를 만든다: npm run gen-icons
//   favicon      태극만 (탭·검색결과용)  → public/favicon.svg, favicon.ico(16·32·48)
//   홈 화면 아이콘  태극 + 아래쪽 "특정품목"  → public/icons/icon-192·512.png(any),
//                icon-maskable-192·512.png(안드로이드 원형/둥근 마스크용), apple-touch-icon.png(아이폰)
//   알림 배지     태극 윤곽(단색 투명)      → public/icons/badge-96.png (안드로이드 상태줄은 알파만 씀)
// 한글을 그려야 해서 브라우저 엔진(Playwright)으로 렌더링한다. 결과 PNG는 커밋하므로 서버에선 안 돌려도 된다.
// 태극은 일반 태극 문양(적·청)이며 정부 상징/조달청 로고가 아니다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PUBLIC = path.join(__dirname, '..', 'public');
const ICONS = path.join(PUBLIC, 'icons');
const RED = '#CD2E3A', BLUE = '#0047A0', INK = '#18181b';
const FONT = "'Malgun Gothic','Noto Sans CJK KR','Apple SD Gothic Neo','Noto Sans KR',sans-serif";

// 태극기처럼 약 33.7° 기울인 태극. (cx,cy)=중심, r=반지름(viewBox 단위).
// 파란 원 위에 위쪽 반원(빨강)을 얹고, 왼쪽 작은 원은 빨강·오른쪽 작은 원은 파랑으로 S자를 만든다.
const taegeuk = (cx, cy, r) =>
  `<g transform="translate(${cx} ${cy}) rotate(-33.69) scale(${r / 50})">` +
  `<circle r="50" fill="${BLUE}"/><path d="M-50 0A50 50 0 0 1 50 0Z" fill="${RED}"/>` +
  `<circle cx="-25" r="25" fill="${RED}"/><circle cx="25" r="25" fill="${BLUE}"/></g>`;

const svgDoc = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;

const FAVICON_SVG = svgDoc(taegeuk(50, 50, 48));

// 홈 화면 아이콘. 흰 바탕(태극기처럼) + 태극 + 아래쪽 "특정품목".
// maskable은 바깥 10%가 잘려도 되게 모든 내용을 가운데 원(반지름 40%) 안에 넣는다.
function appIconSvg({ maskable }) {
  // 글자가 폰 홈 화면에서도 읽히게 크게. maskable은 글자 상자 모서리(dx=29, dy=18.5+7.25)가
  // 가운데 원(반지름 40) 안에 들어오게 맞췄다(거리 약 38.8).
  const g = maskable ? { cy: 34, r: 18, fs: 14.5, ty: 68.5 } : { cy: 36, r: 24.5, fs: 17, ty: 80 };
  return svgDoc(
    `<rect width="100" height="100" fill="#fff"/>${taegeuk(50, g.cy, g.r)}` +
    `<text x="50" y="${g.ty}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-weight="800" font-size="${g.fs}" fill="${INK}">특정품목</text>`);
}

// 알림 배지: 안드로이드는 알파 채널만 써서 단색으로 칠하므로, 흰색 윤곽 + 빨강 쪽 면만 채운 태극 실루엣.
const BADGE_SVG = svgDoc(
  `<g transform="translate(50 50) rotate(-33.69)"><circle r="45" fill="none" stroke="#fff" stroke-width="7"/>` +
  `<path d="M-37 0A37 37 0 0 1 37 0A18.5 18.5 0 0 0 0 0A18.5 18.5 0 0 1 -37 0Z" fill="#fff"/></g>`);

// PNG들을 담은 ICO(요즘 브라우저·윈도우는 PNG 압축 항목을 그대로 읽는다)
function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirs = [], datas = [];
  for (const { size, png } of entries) {
    const d = Buffer.alloc(16);
    d.writeUInt8(size >= 256 ? 0 : size, 0); d.writeUInt8(size >= 256 ? 0 : size, 1);
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6);
    d.writeUInt32LE(png.length, 8); d.writeUInt32LE(offset, 12);
    offset += png.length;
    dirs.push(d); datas.push(png);
  }
  return Buffer.concat([head, ...dirs, ...datas]);
}

(async () => {
  fs.mkdirSync(ICONS, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  const render = async (svg, size, { transparent }) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    return page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  };
  const write = (file, buf) => { fs.writeFileSync(file, buf); console.log(`생성: ${path.relative(path.join(__dirname, '..'), file)} (${buf.length}B)`); };

  write(path.join(PUBLIC, 'favicon.svg'), Buffer.from(FAVICON_SVG));
  const fav = [];
  for (const size of [16, 32, 48]) fav.push({ size, png: await render(FAVICON_SVG, size, { transparent: true }) });
  write(path.join(PUBLIC, 'favicon.ico'), buildIco(fav));

  for (const size of [192, 512]) {
    write(path.join(ICONS, `icon-${size}.png`), await render(appIconSvg({ maskable: false }), size, { transparent: false }));
    write(path.join(ICONS, `icon-maskable-${size}.png`), await render(appIconSvg({ maskable: true }), size, { transparent: false }));
  }
  write(path.join(ICONS, 'apple-touch-icon.png'), await render(appIconSvg({ maskable: false }), 180, { transparent: false }));
  write(path.join(ICONS, 'badge-96.png'), await render(BADGE_SVG, 96, { transparent: true }));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
