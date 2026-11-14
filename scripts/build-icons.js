// 앱 아이콘 생성 스크립트 (npm 의존성 없음, Node 내장 zlib만 사용).
// 사용법: node scripts/build-icons.js
// 출력: icons/icon.svg, icons/icon-192.png, icons/icon-512.png,
//       icons/icon-maskable-512.png, icons/apple-touch-icon.png, favicon.ico
// 디자인은 512x512 좌표계에서 정의하고, 도형을 슈퍼샘플링으로 래스터화한다.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'icons');

const ACCENT = [0x0b, 0x63, 0xce]; // css --accent (light)
const WHITE = [255, 255, 255];
const GOLD = [0xff, 0xc9, 0x28];

const BODY = { x: 136, y: 150, w: 240, h: 190, r: 36 };
const WHEELS = [[192, 346], [320, 346]];
const STAR = { cx: 350, cy: 180, R: 66, Rout: 80 };
const WINDOW = { x: 164, y: 180, w: 120, h: 76, r: 12 }; // 별 배지 왼쪽의 창
const HEADLIGHTS = []; // 바퀴와 겹쳐 제거

function starPoints(cx, cy, R) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : R * 0.46;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
}
const STAR_IN = starPoints(STAR.cx, STAR.cy, STAR.R);
const STAR_OUT = starPoints(STAR.cx, STAR.cy, STAR.Rout);

function inRRect(x, y, b) {
  if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return false;
  const cx = Math.min(Math.max(x, b.x + b.r), b.x + b.w - b.r);
  const cy = Math.min(Math.max(y, b.y + b.r), b.y + b.h - b.r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= b.r ** 2;
}
function inCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inPoly(x, y, p) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if (p[i][1] > y !== p[j][1] > y &&
        x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
}

// 한 점의 색(없으면 null = 투명). rounded=true면 배경 모서리를 둥글게.
function colorAt(x, y, rounded) {
  if (rounded && !inRRect(x, y, { x: 0, y: 0, w: 512, h: 512, r: 108 })) return null;
  let c = ACCENT;
  if (inRRect(x, y, BODY)) c = WHITE;
  for (const [wx, wy] of WHEELS) {
    if (inCircle(x, y, wx, wy, 40)) c = ACCENT;
    if (inCircle(x, y, wx, wy, 29)) c = WHITE;
  }
  if (inRRect(x, y, WINDOW)) c = ACCENT;
  for (const [hx, hy] of HEADLIGHTS) if (inCircle(x, y, hx, hy, 17)) c = ACCENT;
  if (inPoly(x, y, STAR_OUT)) c = ACCENT;
  if (inPoly(x, y, STAR_IN)) c = GOLD;
  return c;
}

function render(size, rounded) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  const k = 512 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((px + (sx + 0.5) / SS) * k, (py + (sy + 0.5) / SS) * k, rounded);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const o = (py * size + px) * 4;
      if (a) { buf[o] = r / a; buf[o + 1] = g / a; buf[o + 2] = b / a; }
      buf[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return buf;
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function svg() {
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const poly = (p) => p.map((q) => q.map((v) => +v.toFixed(1)).join(',')).join(' ');
  const A = hex(ACCENT);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="108" fill="${A}"/>
  <rect x="${BODY.x}" y="${BODY.y}" width="${BODY.w}" height="${BODY.h}" rx="${BODY.r}" fill="#fff"/>
${WHEELS.map(([x, y]) => `  <circle cx="${x}" cy="${y}" r="40" fill="${A}"/>\n  <circle cx="${x}" cy="${y}" r="29" fill="#fff"/>`).join('\n')}
  <rect x="${WINDOW.x}" y="${WINDOW.y}" width="${WINDOW.w}" height="${WINDOW.h}" rx="${WINDOW.r}" fill="${A}"/>
${HEADLIGHTS.map(([x, y]) => `  <circle cx="${x}" cy="${y}" r="17" fill="${A}"/>`).join('\n')}
  <polygon points="${poly(STAR_OUT)}" fill="${A}"/>
  <polygon points="${poly(STAR_IN)}" fill="${hex(GOLD)}"/>
</svg>
`;
}

fs.mkdirSync(ICONS, { recursive: true });
const png = (size, rounded) => encodePng(size, render(size, rounded));
fs.writeFileSync(path.join(ICONS, 'icon.svg'), svg());
fs.writeFileSync(path.join(ICONS, 'icon-192.png'), png(192, true));
fs.writeFileSync(path.join(ICONS, 'icon-512.png'), png(512, true));
fs.writeFileSync(path.join(ICONS, 'icon-maskable-512.png'), png(512, false));
fs.writeFileSync(path.join(ICONS, 'apple-touch-icon.png'), png(180, false));

// favicon.ico: 32x32 PNG 한 장을 담은 ICO
const p32 = png(32, true);
const head = Buffer.alloc(22);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = 32; head[7] = 32; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(p32.length, 14); head.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(ROOT, 'favicon.ico'), Buffer.concat([head, p32]));
console.log('icons written');
