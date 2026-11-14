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
 * 정책 A(=정책 2): TAGO 도착정보 API가 지원하지 않는 도시코드(data/cities.json 기준, 서울 11 포함 23개)의
 *   정류장은 타일에서 전부 제외한다.
 *
 * 정책 1 (중복 정류장, docs/phase0-findings.md "중복 정류장 검증" 참고): 이름이 같고 좌표를 소수 4자리로
 *   반올림했을 때 같은(= 사실상 같은 위치) 행이 nodeId·cityCode만 다르게 여러 개 있는 경우가 있다
 *   (예: 대구/경산 BIS가 같은 정류장을 각자 등록). 이런 중복 그룹에서는 "자신의 cityCode의 주류 nodeId
 *   접두사"와 "자신의 nodeId 접두사"가 일치하는 행만 남기고 나머지는 제외한다. 주류 접두사는 CSV 전체
 *   (정제는 됐지만 도시 지원 여부로 거르기 전)에서 cityCode별 접두사 최빈값으로 계산한다. 그룹 크기가
 *   1인(중복이 없는) 행은 접두사 일치 여부와 무관하게 그대로 둔다. 제외된 행은 data/excluded-stops.json에
 *   이유와 함께 남긴다.
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
const EXCLUDED_PATH = path.join(ROOT, 'data', 'excluded-stops.json');

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

// nodeId 접두사: 맨 앞 영문자 연속 구간 (예: "DJB8002453" -> "DJB"). 없으면 "" (숫자만인 ID는 없음, 방어적으로 처리).
function nodeIdPrefix(id) {
  const m = /^[A-Za-z]+/.exec(id);
  return m ? m[0] : '';
}

// 정류장명+좌표(소수 4자리 반올림) 그룹 키. 중복 정류장 검증(docs/phase0-findings.md)에서 쓴 기준과 같다.
function dupGroupKey(name, latE6, lngE6) {
  const lat4 = Math.round(latE6 / 100) / 10000; // 1e6 마이크로도 -> 소수 4자리
  const lng4 = Math.round(lngE6 / 100) / 10000;
  return name + '|' + lat4.toFixed(4) + '|' + lng4.toFixed(4);
}

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

  // 3) 기본 정제 (좌표·nodeId 등). 도시 지원 여부(정책 2)와는 무관하게 CSV 전체를 정리한다 —
  //    정책 1의 주류 접두사는 "CSV 전체"로 계산해야 하기 때문이다.
  const removed = { 컬럼수오류: 0, 좌표누락: 0, 좌표0: 0, 한국범위밖: 0, nodeId누락: 0, nodeId중복: 0 };
  const seen = new Set();
  const cleaned = []; // {id,name,latE6,lngE6,ars,city,prefix}
  let latestDate = '';

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
    let ars = r[5].trim();
    if (ars === '0') ars = '';
    const latE6 = Math.round(lat * 1e6), lngE6 = Math.round(lng * 1e6);
    const name = r[1].replace(/\uFFFD/g, '').trim();
    cleaned.push({ id, name, latE6, lngE6, ars, city, prefix: nodeIdPrefix(id) });
  }

  // 3-1) 정책 1: 도시코드별 nodeId 주류 접두사 (CSV 전체 기준, 최빈값. 동점이면 접두사 문자열 오름차순으로 고정).
  const cityPrefixCounts = new Map(); // city -> Map(prefix -> count)
  for (const s of cleaned) {
    if (!cityPrefixCounts.has(s.city)) cityPrefixCounts.set(s.city, new Map());
    const m = cityPrefixCounts.get(s.city);
    m.set(s.prefix, (m.get(s.prefix) || 0) + 1);
  }
  const cityMajorityPrefix = new Map();
  for (const [city, m] of cityPrefixCounts) {
    let best = null, bestCount = -1;
    for (const [prefix, count] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      if (count > bestCount) { best = prefix; bestCount = count; }
    }
    cityMajorityPrefix.set(city, best);
  }

  // 3-2) 정책 1: 중복 그룹(이름+좌표 소수 4자리 동일, nodeId/cityCode만 다름) 찾기.
  const dupGroups = new Map(); // key -> [stop, ...]
  for (const s of cleaned) {
    const key = dupGroupKey(s.name, s.latE6, s.lngE6);
    if (!dupGroups.has(key)) dupGroups.set(key, []);
    dupGroups.get(key).push(s);
  }
  const excludedStops = []; // {id,name,lat,lng,city,reason,detail?}
  const dupExcludeIds = new Set();
  let dupGroupCount = 0, dupRowCount = 0;
  for (const group of dupGroups.values()) {
    if (group.length < 2) continue; // 비중복 행은 그대로 둔다
    dupGroupCount++;
    dupRowCount += group.length;
    for (const s of group) {
      const majority = cityMajorityPrefix.get(s.city);
      if (s.prefix !== majority) {
        dupExcludeIds.add(s.id);
        excludedStops.push({
          id: s.id, name: s.name, lat: fmtCoord(s.latE6), lng: fmtCoord(s.lngE6), city: s.city,
          reason: '정책1_중복접두사불일치',
          detail: 'nodeId접두사=' + (s.prefix || '(없음)') + ', cityCode ' + s.city + '의 주류접두사=' + (majority || '(없음)'),
        });
      }
    }
  }

  // 4) 정책 2: 지원하지 않는 도시코드(data/cities.json 기준) 행은 전부 제외.
  const excludedByCity = new Map(); // 미지원 도시코드별 제외 수
  const stops = []; // {id,name,latE6,lngE6,ars,city}
  const cityPts = new Map(); // code -> [[latE6,lngE6], ...] (bbox/center 계산용)

  for (const s of cleaned) {
    if (dupExcludeIds.has(s.id)) continue; // 정책 1에서 이미 제외, 중복 보고 방지
    if (!supported.has(s.city)) {
      excludedByCity.set(s.city, (excludedByCity.get(s.city) || 0) + 1);
      excludedStops.push({
        id: s.id, name: s.name, lat: fmtCoord(s.latE6), lng: fmtCoord(s.lngE6), city: s.city,
        reason: '정책2_미지원도시코드',
      });
      continue;
    }
    stops.push(s);
    if (!cityPts.has(s.city)) cityPts.set(s.city, []);
    cityPts.get(s.city).push([s.latE6, s.lngE6]);
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

  // 6-1) 제외된 행 전체 목록 (data/excluded-stops.json). 배포 대상은 아니지만 원본 CSV만큼 민감하지 않고
  //      재현 검증에 필요하므로 git에는 커밋한다 (.vercelignore로 배포에서만 뺀다).
  excludedStops.sort((a, b) => byCodeUnit(a.id, b.id));
  fs.writeFileSync(EXCLUDED_PATH, JSON.stringify({
    generatedAt: collected,
    policies: {
      정책1_중복접두사불일치: '이름+좌표(소수 4자리) 중복 그룹에서 자신의 cityCode 주류 nodeId 접두사와 다른 행 제외',
      정책2_미지원도시코드: 'data/cities.json(TAGO 도시코드 목록)에 없는 cityCode의 행 전부 제외',
    },
    count: excludedStops.length,
    rows: excludedStops,
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
  console.log('  정책 1 (중복 정류장, 접두사 불일치): ' + dupExcludeIds.size + '행 제외 (중복 그룹 ' + dupGroupCount + '개, 그룹 내 행 ' + dupRowCount + '개 중)');
  const exTotal = [...excludedByCity.values()].reduce((a, b) => a + b, 0);
  console.log('  정책 2 (미지원 도시코드): ' + exTotal + '행, ' + excludedByCity.size + '개 코드');
  for (const [c, v] of [...excludedByCity.entries()].sort((a, b) => b[1] - a[1])) console.log('    ' + c + ': ' + v);
  console.log('  제외 행 전체 목록: data/excluded-stops.json (' + excludedStops.length + '행)');
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
