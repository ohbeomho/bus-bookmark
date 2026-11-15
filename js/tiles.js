// 정류장 타일 로딩 (PRD 6.2). 규칙은 scripts/build-tiles.js · data/tiles/index.json의 format과 같다.
//  - index.json의 tiles에 있는 타일만 요청한다 (없는 타일은 404 낭비)
//  - 받은 타일은 IndexedDB에 저장하고, index.json의 version이 바뀌면 모두 지운다
//  - 메모리에는 최근 사용 타일 MAX_MEMORY_TILES개만, 네트워크 요청은 동시에 MAX_FETCHES개까지
// 행 형식: [nodeId, 이름, 위도, 경도, ARS("" = 결측), cityCode(숫자)]

const INDEX_URL = "data/tiles/index.json";
const CITIES_URL = "data/cities.json";
const GRID = 50000; // 0.05° (1e-6 단위)
const MAX_MEMORY_TILES = 50;
const MAX_FETCHES = 4;
const FETCH_TIMEOUT_MS = 15000;
const DB_NAME = "bus-bookmark";

export const tileIdx = (deg) => Math.floor(Math.round(deg * 1e6) / GRID);
/** 정류장 행 → 즐겨찾기 키 (store.stopKey와 같은 형식) */
export const rowKey = (r) => `${r[5]}:${r[0]}`;

// ---------- IndexedDB (없거나 막혀 있으면 메모리만 쓴다) ----------
let dbP = null;
function db() {
  if (!dbP) {
    dbP = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("tiles");
          req.result.createObjectStore("meta");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbP;
}

async function idb(storeName, mode, fn) {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req?.result ?? null);
      tx.onerror = tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
const idbGet = (s, k) => idb(s, "readonly", (o) => o.get(k));
const idbPut = (s, k, v) => idb(s, "readwrite", (o) => o.put(v, k));
const idbClear = (s) => idb(s, "readwrite", (o) => o.clear());

// ---------- index.json ----------
let meta = null; // { version, collectedAt, tiles: Set }
let indexP = null;

const validIndex = (j) => j && typeof j.version === "string" && Array.isArray(j.tiles);

/** index.json을 읽는다. 오프라인이면 IndexedDB에 저장해 둔 마지막 index를 쓴다 */
export function loadIndex() {
  if (!indexP) {
    indexP = (async () => {
      let fresh = null;
      try {
        const res = await fetch(INDEX_URL);
        if (res.ok) fresh = await res.json();
      } catch {
        /* 오프라인 등 */
      }
      const saved = await idbGet("meta", "index");
      let use = validIndex(fresh) ? fresh : validIndex(saved) ? saved : null;
      if (!use) {
        indexP = null; // 다음에 다시 시도
        throw new Error("index_unavailable");
      }
      if (use === fresh && saved?.version !== fresh.version) {
        // 데이터가 바뀌었다: 캐시한 타일을 모두 버린다
        memory.clear();
        await idbClear("tiles");
        await idbPut("meta", "index", { version: fresh.version, collectedAt: fresh.collectedAt, tiles: fresh.tiles });
      }
      meta = { version: use.version, collectedAt: String(use.collectedAt || ""), tiles: new Set(use.tiles) };
      return meta;
    })();
  }
  return indexP;
}

/**
 * 범위에 걸친 타일 중 index에 있는 것의 이름. 타일이 maxTiles보다 많으면 null (너무 넓은 범위)
 */
export function tilesInBounds(south, west, north, east, maxTiles = 36) {
  if (!meta) return [];
  const [a, b, c, d] = [tileIdx(south), tileIdx(north), tileIdx(west), tileIdx(east)];
  if ((b - a + 1) * (d - c + 1) > maxTiles) return null;
  const out = [];
  for (let i = a; i <= b; i++) for (let j = c; j <= d; j++) if (meta.tiles.has(`${i}_${j}`)) out.push(`${i}_${j}`);
  return out;
}

// ---------- 타일 ----------
const memory = new Map(); // name → rows (Map 순서 = 최근 사용 순)
const pending = new Map(); // name → Promise

function remember(name, rows) {
  memory.delete(name);
  memory.set(name, rows);
  while (memory.size > MAX_MEMORY_TILES) memory.delete(memory.keys().next().value);
}

let running = 0;
const waiting = [];
async function limited(fn) {
  if (running >= MAX_FETCHES) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** 행 형식이 맞는 것만 남긴다 */
function cleanRows(json) {
  if (!Array.isArray(json)) throw new Error("bad_tile");
  return json.filter(
    (r) => Array.isArray(r) && typeof r[0] === "string" && Number.isFinite(r[2]) && Number.isFinite(r[3]) && Number.isInteger(r[5])
  );
}

async function fetchTile(name) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`data/tiles/${name}.json`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`tile_http_${res.status}`);
    return cleanRows(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** 타일 1개: 메모리 → IndexedDB → 네트워크 순. 실패하면 reject */
export function getTile(name) {
  if (memory.has(name)) {
    const rows = memory.get(name);
    remember(name, rows);
    return Promise.resolve(rows);
  }
  if (pending.has(name)) return pending.get(name);
  const version = meta?.version;
  const p = (async () => {
    const cached = await idbGet("tiles", name);
    let rows = cached && cached.v === version && Array.isArray(cached.rows) ? cached.rows : null;
    if (!rows) {
      rows = await limited(() => fetchTile(name));
      idbPut("tiles", name, { v: version, rows });
    }
    if (meta?.version === version) remember(name, rows);
    return rows;
  })().finally(() => pending.delete(name));
  pending.set(name, p);
  return p;
}

/** 메모리에 올라 있는 타일의 모든 정류장 (검색용, PRD F-S1 "불러온 지역 데이터 안에서") */
export function* loadedRows() {
  for (const rows of memory.values()) yield* rows;
}


// ---------- 지원 도시 (data/cities.json) ----------
let citiesP = null;
/** [{code, name, bbox: [south, west, north, east], center?: [lat, lng]}]. 실패하면 [] */
export function loadCities() {
  if (!citiesP) {
    citiesP = fetch(CITIES_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => (Array.isArray(j?.cities) ? j.cities.filter((c) => Array.isArray(c.bbox) && c.bbox.length === 4) : []))
      .catch(() => {
        citiesP = null;
        return [];
      });
  }
  return citiesP;
}

export const citiesAt = (cities, lat, lng) =>
  cities.filter(({ bbox: [s, w, n, e] }) => lat >= s && lat <= n && lng >= w && lng <= e);

// ---------- 거리 ----------
/** 두 지점 사이 거리(m). 수 km 범위라 등장방형 근사로 충분하다 */
export function distanceM(lat1, lng1, lat2, lng2) {
  const k = Math.PI / 180;
  const x = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.hypot(x, y) * 6371000;
}

const DIRS = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
/** 기준점에서 본 방향 (8방위) */
export function direction(lat1, lng1, lat2, lng2) {
  const x = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const y = lat2 - lat1;
  const deg = (Math.atan2(x, y) * 180) / Math.PI;
  return DIRS[Math.round(((deg + 360) % 360) / 45) % 8];
}

export const fmtDistance = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`);
