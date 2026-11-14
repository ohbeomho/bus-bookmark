#!/usr/bin/env node
/**
 * 정류장 타일 빌드 스크립트 (Phase 1). 배포 대상 아님. Node 22+, 외부 의존성 없음.
 *
 * 사용법
 *   node scripts/build-tiles.js [csv경로] [--refresh-cities]
 *     csv경로           기본값 data/raw/국토교통부_전국 버스정류장 위치정보.csv
 *     --refresh-cities  TAGO 도시코드 목록 API(getCtyCodeList)를 호출해 data/cities.json의
 *                       지원 도시 목록을 갱신한다. 서비스키는 환경변수 TAGO_API_KEY 또는
 *                       루트 .env의 TAGO_API_KEY(Decoding 키)에서만 읽고 어디에도 기록하지 않는다.
 *   평소 실행은 API를 호출하지 않고 data/cities.json의 지원 도시 목록을 입력으로 쓴다.
 *
 * 입력 CSV: EUC-KR(CP949), 따옴표 포함 CSV, 9컬럼
 *   정류장번호,정류장명,위도,경도,정보수집일,모바일단축번호,도시코드,도시명,관리도시명
 *   (관리도시명은 부정확하므로 쓰지 않는다. 도시 연결은 도시코드로만 한다.)
 *
 * 정책 A: TAGO 도착정보 API가 지원하지 않는 도시코드의 정류장은 타일에서 제외한다.
 *
 * ===== 타일 파일명 규칙 (프론트엔드 tiles.js가 동일하게 계산해야 함) =====
 *   격자 크기 0.05도. 파일명은 "격자 인덱스"이며 좌표 문자열이 아니므로 부동소수 오차가 없다.
 *     latE6 = Math.round(lat * 1e6)            // 정수 마이크로도
 *     lngE6 = Math.round(lng * 1e6)
 *     latIdx = Math.floor(latE6 / 50000)       // 예: 36.33 -> 726
 *     lngIdx = Math.floor(lngE6 / 50000)       // 예: 127.43 -> 2548
 *     파일명 = `${latIdx}_${lngIdx}.json`      // data/tiles/726_2548.json
 *   타일의 남서쪽 모서리 = (latIdx * 0.05, lngIdx * 0.05), 북동쪽 = (+0.05, +0.05).
 *   화면 범위(south,west,north,east)가 걸치는 타일: latIdx는 floor(south*20)..floor(north*20),
 *   lngIdx는 floor(west*20)..floor(east*20) 범위 (각 값은 위 식처럼 1e6 정수 반올림 후 나눈다).
 *   index.json의 tiles 목록에 있는 것만 실제 파일이 존재한다.
 *
 * 타일 내용: 키 없는 배열의 배열
 *   [nodeId, 정류장명, 위도, 경도, ARS번호, cityCode]
 *   위도/경도는 소수 6자리 숫자, ARS는 문자열(결측이면 ""), cityCode는 숫자.
 *   타일 안은 nodeId 오름차순(코드 단위 비교)이라 재실행해도 같은 결과가 나온다.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CSV = path.join(ROOT, 'data', 'raw', '국토교통부_전국 버스정류장 위치정보.csv');
const TILES_DIR = path.join(ROOT, 'data', 'tiles');
const CITIES_PATH = path.join(ROOT, 'data', 'cities.json');

const GRID_DEG = 0.05;
const GRID_E6 = 50000; // 0.05도 = 50000 마이크로도
const KOREA = { latMin: 33, latMax: 39, lngMin: 124, lngMax: 132 };
const EXPECTED_HEADER = ['정류장번호', '정류장명', '위도', '경도', '정보수집일', '모바일단축번호', '도시코드', '도시명', '관리도시명'];

// ---------- 유틸 ----------
function die(msg) {
  console.error('오류: ' + msg);
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* CRLF 무시 */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function readDotEnvKey() {
  if (process.env.TAGO_API_KEY) return process.env.TAGO_API_KEY.trim();
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return null;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*TAGO_API_KEY\s*=\s*(.*?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

async function fetchCityList() {
  const key = readDotEnvKey();
  if (!key) die('TAGO_API_KEY를 찾을 수 없다 (환경변수 또는 루트 .env).');
  const url = 'https://apis.data.go.kr/1613000/ArvlInfoInqireService/getCtyCodeList?' +
    new URLSearchParams({ serviceKey: key, _type: 'json' }).toString();
  let json;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) die('도시코드 API HTTP ' + res.status);
    json = await res.json();
  } catch (e) {
    die('도시코드 API 호출 실패 (' + (e && e.name) + ')'); // URL(키 포함)은 출력하지 않는다
  }
  const header = json && json.response && json.response.header;
  if (!header || header.resultCode !== '00') die('도시코드 API resultCode 이상: ' + (header && header.resultCode));
  let items = json.response.body && json.response.body.items && json.response.body.items.item;
  if (items == null) items = [];
  if (!Array.isArray(items)) items = [items];
  const byCode = new Map();
  for (const it of items) {
    const code = Number(it.citycode);
    const name = String(it.cityname).trim();
    if (!Number.isInteger(code)) continue;
    if (byCode.has(code)) {
      if (!byCode.get(code).includes(name)) byCode.set(code, byCode.get(code) + '/' + name);
    } else byCode.set(code, name);
  }
  return byCode;
}

function loadSupported() {
  if (!fs.existsSync(CITIES_PATH)) return null;
  const j = JSON.parse(fs.readFileSync(CITIES_PATH, 'utf8'));
  return new Map(j.cities.map((c) => [c.code, c.name]));
}

function fmtCoord(e6) {
  return Number((e6 / 1e6).toFixed(6)); // 정수 마이크로도에서 되돌려 표기 오차를 없앤다
}

// 도시 bbox/center 계산 (정수 마이크로도 입력).
//  center: 전체 정류장의 위도·경도 각각의 중앙값 (이상치에 강함).
//  bbox: 다른 시군 정류장이 이 도시코드로 잘못 등록된 이상치를 빼고 계산한다.
//    위도·경도 각각 Q1 - k*IQR ~ Q3 + k*IQR (k=1.5, Tukey의 표준 이상치 기준) 밖이면 이상치.
//    IQR이 아주 작은 도시를 위해 울타리 여유는 최소 0.05도(약 5km)로 한다.
//    백분위 1~99% 자르기와 달리 정상 정류장을 일정 비율로 깎지 않아 큰 도시의 가장자리가 유지된다.
//    정류장 8개 미만이면 사분위가 무의미하므로 이상치 제거 없이 전부 쓴다.
//  타일/정류장 목록에서는 아무것도 제외하지 않는다.
const FENCE_K = 1.5;
const FENCE_MIN_E6 = 50000;
const FENCE_MIN_POINTS = 8;
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function robustBox(pts) {
  const lats = pts.map((p) => p[0]).sort((a, b) => a - b);
  const lngs = pts.map((p) => p[1]).sort((a, b) => a - b);
  const center = [Math.round(quantile(lats, 0.5)), Math.round(quantile(lngs, 0.5))];
  let use = pts;
  if (pts.length >= FENCE_MIN_POINTS) {
    const fence = (s) => {
      const q1 = quantile(s, 0.25), q3 = quantile(s, 0.75);
      const m = Math.max(FENCE_K * (q3 - q1), FENCE_MIN_E6);
      return [q1 - m, q3 + m];
    };
    const [la0, la1] = fence(lats), [ln0, ln1] = fence(lngs);
    use = pts.filter((p) => p[0] >= la0 && p[0] <= la1 && p[1] >= ln0 && p[1] <= ln1);
  }
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [a, b] of use) {
    if (a < minLat) minLat = a; if (a > maxLat) maxLat = a;
    if (b < minLng) minLng = b; if (b > maxLng) maxLng = b;
  }
  return { bbox: [minLat, minLng, maxLat, maxLng], center, excluded: pts.length - use.length };
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- 메인 ----------
async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh-cities');
  const csvPath = path.resolve(args.find((a) => !a.startsWith('--')) || DEFAULT_CSV);

  // 1) 지원 도시 목록
  let supported = loadSupported();
  if (refresh || !supported) {
    if (!refresh) console.log('data/cities.json이 없어 도시코드 API로 새로 받는다.');
    supported = await fetchCityList();
    console.log('도시코드 API: ' + supported.size + '개 도시');
  }
  if (supported.size === 0) die('지원 도시 목록이 비어 있다.');

  // 2) CSV 읽기 + 인코딩 확인
  if (!fs.existsSync(csvPath)) die('CSV가 없다: ' + csvPath + ' (원본은 data/raw/ 또는 scripts/raw/에 두고 저장소에는 넣지 않는다)');
  const buf = fs.readFileSync(csvPath);
  const text = new TextDecoder('euc-kr', { fatal: false }).decode(buf).replace(/^﻿/, '');
  const rows = parseCsv(text);
  const header = rows.shift().map((h) => h.trim());
  const badLines = text.split('\n').filter((l) => l.includes('�')).length;
  // 원본 자체에 CP949로 해석 불가한 바이트가 소수 행에 있다(예: A3 6A). 0.1% 초과면 인코딩 오류로 본다.
  if (header.join(',') !== EXPECTED_HEADER.join(',') || badLines > rows.length * 0.001) {
    die('인코딩/헤더 확인 실패 (한글이 깨졌거나 컬럼이 다르다). 헤더: ' + header.join(','));
  }
  console.log('인코딩 확인: EUC-KR 디코딩 정상, 헤더 일치, 데이터 ' + rows.length + '행, 해석 불가 문자 포함 행 ' + badLines + '개(해당 문자는 이름에서 제거)');

  // 3) 정제
  const removed = { 컬럼수오류: 0, 좌표누락: 0, 좌표0: 0, 한국범위밖: 0, nodeId누락: 0, nodeId중복: 0 };
  const excludedByCity = new Map(); // 미지원 도시코드별 제외 수
  const seen = new Set();
  const stops = []; // {id,name,latE6,lngE6,ars,city}
  const cityNames = new Map(); // CSV 도시명 (참고용 집계는 하지 않음)
  let latestDate = '';
  const cityPts = new Map(); // code -> [[latE6,lngE6], ...] (bbox/center 계산용)

  for (const r of rows) {
    if (r.length === 1 && r[0] === '') continue; // 빈 줄
    if (r.length !== 9) { removed.컬럼수오류++; continue; }
    const id = r[0].trim();
    if (!id) { removed.nodeId누락++; continue; }
    const latS = r[2].trim(), lngS = r[3].trim();
    if (latS === '' || lngS === '') { removed.좌표누락++; continue; }
    const lat = Number(latS), lng = Number(lngS);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { removed.좌표누락++; continue; }
    if (lat === 0 || lng === 0) { removed.좌표0++; continue; }
    if (lat < KOREA.latMin || lat > KOREA.latMax || lng < KOREA.lngMin || lng > KOREA.lngMax) { removed.한국범위밖++; continue; }
    if (seen.has(id)) { removed.nodeId중복++; continue; }
    seen.add(id);

    const date = r[4].trim();
    if (date > latestDate) latestDate = date;
    const city = Number(r[6].trim());
    if (!supported.has(city)) {
      excludedByCity.set(city, (excludedByCity.get(city) || 0) + 1);
      continue;
    }
    let ars = r[5].trim();
    if (ars === '0') ars = '';
    const latE6 = Math.round(lat * 1e6), lngE6 = Math.round(lng * 1e6);
    stops.push({ id, name: r[1].replace(/\uFFFD/g, '').trim(), latE6, lngE6, ars, city });

    if (!cityPts.has(city)) cityPts.set(city, []);
    cityPts.get(city).push([latE6, lngE6]);
  }

  // 4) 타일 분할 (파일명 규칙은 상단 주석 참고)
  const tiles = new Map();
  for (const s of stops) {
    const key = Math.floor(s.latE6 / GRID_E6) + '_' + Math.floor(s.lngE6 / GRID_E6);
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(s);
  }
  const keys = [...tiles.keys()].sort((a, b) => {
    const [a1, a2] = a.split('_').map(Number), [b1, b2] = b.split('_').map(Number);
    return a1 - b1 || a2 - b2;
  });

  // 5) 출력 (이전 타일 정리 후 새로 작성)
  fs.mkdirSync(TILES_DIR, { recursive: true });
  for (const f of fs.readdirSync(TILES_DIR)) {
    if (/^-?\d+_-?\d+\.json$/.test(f) || f === 'index.json') fs.unlinkSync(path.join(TILES_DIR, f));
  }
  const hash = crypto.createHash('sha256');
  const sizes = [];
  for (const k of keys) {
    const list = tiles.get(k).sort((a, b) => byCodeUnit(a.id, b.id));
    const body = '[' + list.map((s) =>
      JSON.stringify([s.id, s.name, fmtCoord(s.latE6), fmtCoord(s.lngE6), s.ars, s.city])).join(',\n') + ']\n';
    const data = Buffer.from(body, 'utf8');
    fs.writeFileSync(path.join(TILES_DIR, k + '.json'), data);
    hash.update(k + '\n').update(data);
    sizes.push({ k, bytes: data.length, count: list.length });
  }
  const collected = /^\d{8}$/.test(latestDate) ? latestDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : latestDate;
  const index = {
    version: hash.digest('hex').slice(0, 12),
    collectedAt: collected,
    format: {
      gridDegrees: GRID_DEG,
      fileName: '{latIdx}_{lngIdx}.json',
      latIdx: 'Math.floor(Math.round(lat * 1e6) / 50000)',
      lngIdx: 'Math.floor(Math.round(lng * 1e6) / 50000)',
      row: ['nodeId', 'name', 'lat', 'lng', 'ars', 'cityCode'],
    },
    stopCount: stops.length,
    tileCount: keys.length,
    tiles: keys,
  };
  fs.writeFileSync(path.join(TILES_DIR, 'index.json'), JSON.stringify(index) + '\n');

  // 6) cities.json (지원 도시 + bbox: [south, west, north, east])
  const cities = [...supported.entries()].sort((a, b) => a[0] - b[0]).map(([code, name]) => {
    const pts = cityPts.get(code);
    if (!pts) return { code, name, stopCount: 0, bbox: null, center: null };
    const r = robustBox(pts);
    return {
      code, name,
      stopCount: pts.length,
      bbox: r.bbox.map(fmtCoord),
      center: r.center.map(fmtCoord),
    };
  });
  fs.writeFileSync(CITIES_PATH, JSON.stringify({
    source: 'TAGO ArvlInfoInqireService/getCtyCodeList (이름·코드), 정류장 좌표 (bbox, center)',
    bboxOrder: ['south', 'west', 'north', 'east'],
    centerOrder: ['lat', 'lng'],
    bboxMethod: 'Tukey fence (k=1.5, 최소 여유 0.05도)를 위도·경도 각각 적용해 벗어난 정류장을 제외한 뒤 남은 정류장의 min/max. 정류장 8개 미만이면 전부 사용. center는 전체 정류장의 위도·경도 중앙값.',
    cities,
  }, null, 1) + '\n');

  // 7) 점검 출력
  const total = sizes.reduce((a, s) => a + s.bytes, 0);
  const max = sizes.reduce((a, s) => (s.bytes > a.bytes ? s : a), sizes[0]);
  const maxCnt = sizes.reduce((a, s) => (s.count > a.count ? s : a), sizes[0]);
  const avg = total / sizes.length;
  const sortedBytes = sizes.map((s) => s.bytes).sort((a, b) => a - b);
  const kb = (x) => (x / 1024).toFixed(1) + 'KB';
  console.log('\n== 제거한 행 (이유별) ==');
  for (const [k, v] of Object.entries(removed)) console.log('  ' + k + ': ' + v);
  const exTotal = [...excludedByCity.values()].reduce((a, b) => a + b, 0);
  console.log('  미지원 도시코드(정책 A): ' + exTotal + '행, ' + excludedByCity.size + '개 코드');
  for (const [c, v] of [...excludedByCity.entries()].sort((a, b) => b[1] - a[1])) console.log('    ' + c + ': ' + v);
  console.log('\n== 결과 ==');
  console.log('  포함 정류장: ' + stops.length);
  console.log('  타일 수: ' + keys.length + ', 총 용량: ' + kb(total) + ' (' + (total / 1048576).toFixed(2) + 'MB)');
  console.log('  타일 평균: ' + kb(avg) + ', 중앙값: ' + kb(sortedBytes[sortedBytes.length >> 1]) + ', 최대: ' + kb(max.bytes) + ' (' + max.k + ', ' + max.count + '개)');
  console.log('  정류장 최다 타일: ' + maxCnt.k + ' (' + maxCnt.count + '개)');
  console.log('  30KB 초과 타일: ' + sizes.filter((s) => s.bytes > 30 * 1024).length + '개');
  console.log('  수집일: ' + collected + ', 버전: ' + index.version);
  if (avg > 30 * 1024) console.log('  경고: 평균이 30KB를 넘는다. 격자 축소(0.025도) 또는 gzip 전제를 검토할 것.');
  console.log('\n참고: 원본 CSV는 data/raw/ 또는 scripts/raw/에만 두고 저장소에 넣지 않는다.');
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
