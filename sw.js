// 서비스워커 (PRD 9장 P-2). 빌드 도구가 없으므로 아래 SHELL 목록과 VERSION은 손으로 관리한다.
//
// !! 앱 파일(index.html, css/, js/, icons/, manifest)을 바꾸면 VERSION을 올린다.
//    올리지 않으면 이미 설치한 사용자는 옛 파일을 계속 본다 (sw.js 바이트가 같으면 업데이트가 없다).
// !! js/에 모듈을 추가·삭제하면 SHELL도 고친다 (없는 파일이 있으면 install이 실패해 옛 버전이 유지된다).
//
// 요청별 전략 (그 밖의 모든 요청에는 respondWith를 부르지 않는다 = 브라우저 기본 동작):
//  - 앱 셸(같은 출처, SHELL 목록)          : install 때 프리캐시, 캐시 우선. 페이지 이동은 오프라인이면 index.html
//  - data/cities.json                       : 네트워크 우선, 실패·지연 시 캐시 (오프라인 지도 기본 위치·도시명용)
//  - Leaflet 1.9.4 (cdnjs)                  : 처음 쓸 때 런타임 캐시, 캐시 우선
//  - OSM 지도 이미지                        : 캐시 우선, 최대 OSM_MAX장, 7일 지나면 다시 받음
//  - data/tiles/* (타일·index.json)         : 가로채지 않는다. tiles.js가 IndexedDB에 버전 관리하며 캐시하므로
//                                             SW가 또 캐시하면 index 버전이 바뀐 뒤에도 옛 타일이 섞일 수 있다
//  - 도착 정보 (*.workers.dev/arrivals)     : 절대 캐시하지 않는다. 가로채지도 않는다 (네트워크 직행)
//  - 날씨 (api.open-meteo.com, F-WX1)       : 가로채지 않는다. 실패하면 홈의 날씨 영역이 그냥 숨겨지면 된다
//                                             (옛 기온을 캐시에서 보여 주는 쪽이 더 나쁘다)

const VERSION = "v12";
const PREFIX = "bus-bookmark-";
const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;
const DATA_CACHE = `${PREFIX}data-v1`; // cities.json (버전 독립. 항상 네트워크 우선이라 옛것이 남아도 폴백으로만 쓴다)
const LEAFLET_CACHE = `${PREFIX}leaflet-1.9.4`; // 라이브러리 버전이 바뀌면 이름도 바꾼다
const OSM_CACHE = `${PREFIX}osm-tiles-v1`;
const KEEP = new Set([SHELL_CACHE, DATA_CACHE, LEAFLET_CACHE, OSM_CACHE]);

const OSM_MAX = 200; // 지도 이미지 보관 상한 (OSM 타일 사용 정책: 대량 저장·선행 다운로드 금지)
const OSM_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const NETWORK_FIRST_TIMEOUT_MS = 4000;
const LEAFLET_PREFIX = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
const OSM_HOST = "tile.openstreetmap.org";

// sw.js 위치 기준 상대 경로. 첫 항목("./")은 페이지 이동용 index.html
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "favicon.ico",
  "css/style.css",
  "js/app.js",
  "js/config.js",
  "js/store.js",
  "js/api.js",
  "js/tiles.js",
  "js/geo.js",
  "js/weather.js",
  "js/commute.js",
  "js/map.js",
  "js/ui/commute.js",
  "js/ui/dom.js",
  "js/ui/groups.js",
  "js/ui/home.js",
  "js/ui/settings.js",
  "js/ui/install.js",
  "js/ui/search.js",
  "js/ui/stop-sheet.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

const abs = (p) => new URL(p, self.location.href).href;
const SHELL_URLS = SHELL.map(abs);
const SHELL_SET = new Set(SHELL_URLS);
const INDEX_URL = abs("index.html");
const CITIES_URL = abs("data/cities.json");

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // cache:"reload" — 브라우저 HTTP 캐시를 건너뛰고 서버의 최신 파일을 받는다 (버전 안에서 파일이 섞이지 않게)
      await cache.addAll(SHELL_URLS.map((u) => new Request(u, { cache: "reload" })));
      // skipWaiting은 부르지 않는다: 실행 중인 페이지가 옛 캐시와 새 캐시를 섞어 쓰지 않게,
      // 새 버전은 페이지가 "새로고침"을 누를 때(SKIP_WAITING 메시지)나 앱을 모두 닫은 뒤 적용된다
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX) && !KEEP.has(name)) await caches.delete(name);
      }
      await self.clients.claim(); // 첫 설치 직후 그 세션에서도 런타임 캐시(Leaflet 등)가 동작하게
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 도착 정보는 무조건 통과 (이후 어떤 규칙도 이 요청에 닿지 않게 맨 앞에서 끊는다)
  if (url.hostname.endsWith(".workers.dev") || url.pathname.endsWith("/arrivals")) return;

  if (url.origin === self.location.origin) {
    if (req.mode === "navigate") return event.respondWith(navigate(req));
    const key = url.origin + url.pathname;
    if (SHELL_SET.has(key)) return event.respondWith(shellFirst(key, req));
    if (key === CITIES_URL) return event.respondWith(networkFirst(req, DATA_CACHE));
    return; // data/tiles/*, sw.js 등: 가로채지 않음
  }

  if (url.href.startsWith(LEAFLET_PREFIX)) return event.respondWith(cacheFirst(req, LEAFLET_CACHE));
  if (url.hostname === OSM_HOST) return event.respondWith(osmTile(req));
  // 그 밖의 다른 출처는 가로채지 않는다
});

// ---------- 전략 ----------

/** 페이지 이동: 같은 버전의 index.html을 캐시에서. 캐시가 없으면(프리캐시 실패 등) 네트워크 */
async function navigate(req) {
  const hit = await (await caches.open(SHELL_CACHE)).match(INDEX_URL);
  if (hit) return hit;
  return fetch(req);
}

/** 앱 셸: 현재 버전 캐시에서만 찾는다 (다른 버전 캐시와 섞이지 않게). 없으면 네트워크 */
async function shellFirst(key, req) {
  const hit = await (await caches.open(SHELL_CACHE)).match(key);
  return hit || fetch(req);
}

/** 네트워크 우선: 성공하면 캐시를 갱신, 실패하거나 NETWORK_FIRST_TIMEOUT_MS 넘으면 캐시 */
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  try {
    return await Promise.race([
      net,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_FIRST_TIMEOUT_MS)),
    ]);
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    // 캐시가 없으면 늦은 네트워크 응답이라도 기다린다
    return net;
  }
}

/** 캐시 우선 (cors 요청만 저장: SRI·crossorigin=anonymous로 불러온 Leaflet은 opaque가 아니다) */
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "cors") cache.put(req, res.clone());
  return res;
}

/**
 * OSM 이미지: 페이지가 요청한 것만 저장 (미리 받지 않음). <img>는 no-cors라 응답이 opaque(용량 계산이 크게 부풀려짐)이므로
 * 같은 요청을 cors·쿠키 없음으로 다시 만들어 받는다. OSM이 CORS를 거부하면 원래 요청 그대로 통과시킨다.
 */
async function osmTile(req) {
  const cache = await caches.open(OSM_CACHE);
  const hit = await cache.match(req.url);
  if (hit) {
    const age = Date.now() - new Date(hit.headers.get("date") || 0).getTime();
    if (age < OSM_MAX_AGE_MS) return hit;
    try {
      return await fetchAndStoreOsm(req, cache);
    } catch {
      return hit; // 오프라인이면 오래된 타일이라도
    }
  }
  try {
    return await fetchAndStoreOsm(req, cache);
  } catch {
    return fetch(req); // cors 실패 시 원래 방식 (저장은 안 함)
  }
}

async function fetchAndStoreOsm(req, cache) {
  const res = await fetch(new Request(req.url, { mode: "cors", credentials: "omit", referrer: req.referrer, referrerPolicy: req.referrerPolicy }));
  if (!res.ok) throw new Error(`osm_${res.status}`);
  await cache.put(req.url, res.clone());
  trimOsm(cache);
  return res;
}

/** 오래된 것부터 지워 OSM_MAX장 유지 (keys()는 저장 순서) */
async function trimOsm(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - OSM_MAX))) await cache.delete(k);
}
