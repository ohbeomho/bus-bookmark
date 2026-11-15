// 지도로 정류장 찾기 (PRD 5.2 F-M1~M6, 5.4 F-L0~L2, 6.2 타일 로딩)
// - Leaflet + OSM 타일. Leaflet은 지도 탭을 처음 열 때만 CDN에서 SRI로 검증해 불러온다 (홈 첫 화면을 느리게 하지 않게)
// - 위치 권한은 지도 탭을 처음 열 때 요청한다. 위치는 지도 이동·거리 계산에만 쓰고 기기 밖으로 보내지 않는다
//   (Worker에는 cityCode·nodeId만 간다). 마지막 본 지역(F-L2)은 소수 3자리(약 100m)로 줄여 이 기기에만 저장한다
// - 정류장 마커는 L.canvas 렌더러의 circleMarker. MIN_MARKER_ZOOM 미만이면 숨기고(F-M3) 화면(+여유) 안 마커만 그린다
// - 마커 탭은 지도 클릭 위치에서 가장 가까운 마커(HIT_PX 안)를 고른다: 터치 영역 44px 이상, 밀집 지역에서도 정확
import * as tiles from "./tiles.js";
import * as store from "./store.js";
import * as geo from "./geo.js";
import { h, toast } from "./ui/dom.js";
import { initStopSheet, openStopSheet } from "./ui/stop-sheet.js";
import { initSearch, showNearby, closeResults } from "./ui/search.js";

// Leaflet 1.9.4 (cdnjs). 해시는 실제 파일로 계산 (sha256 값은 Leaflet 공식 문서의 SRI와 일치 확인)
const LEAFLET_BASE = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
const LEAFLET_JS_SRI = "sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH";
const LEAFLET_CSS_SRI = "sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H";
// OSM 타일 사용 정책: 표준 URL, 저작권 표기 필수, 대량·선행 다운로드 금지 (보이는 타일만 Leaflet이 요청)
const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const FALLBACK = [33.4996, 126.5312]; // 제주시청 부근 (F-L0)
const START_ZOOM = 16;
const MIN_MARKER_ZOOM = 15;
const REGION_CHECK_ZOOM = 12; // 이 줌 이상에서 "근처 정류장 없음"까지 판단
const NEAR_M = 1500; // 지도 중심에서 이 거리 안에 정류장이 없으면 미지원 지역일 수 있다고 안내
const GEO_TIMEOUT_MS = 8000;
const HIT_PX = 24; // 마커 탭 허용 반경 (지름 48px)
const VIEW_KEY = "bus-bookmark:map-view";
const KOREA = [
  [32.0, 123.5],
  [39.5, 132.5],
];

let L, map, renderer, stopLayer, mapEl, statusEl, hooks;
let startP = null;
let bound = false;
let cities = [];
let lastRows = []; // 마지막으로 그린 타일 정류장
const drawn = new Map(); // key → { m, r, fav }
let myPos = null; // {lat, lng} — 메모리에만
let myMarker = null;
let selMarker = null;
let userMoved = false;
let seq = 0;
let moveTimer = null;
let region = "ok"; // ok | unsupported | nostops

/** app.js가 지도 탭을 보일 때마다 호출 */
export function showMap(panel, options = {}) {
  if (!startP) {
    startP = start(panel, options).catch((e) => {
      console.warn("[map]", e);
      startP = null;
      setStatus("지도를 불러오지 못했어요. 연결을 확인해 주세요.", ["다시 시도", () => showMap(panel, options)]);
    });
  } else startP.then(() => map?.invalidateSize());
}

// ---------- Leaflet 로드 ----------
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  const add = (tag, props) =>
    new Promise((resolve, reject) => {
      // 다시 시도할 때 이미 불러온 CSS는 또 넣지 않는다
      if (tag === "link" && document.querySelector(`link[href="${props.href}"]`)?.sheet) return resolve();
      const el =Object.assign(document.createElement(tag), props, { crossOrigin: "anonymous", referrerPolicy: "no-referrer" });
      el.onload = resolve;
      el.onerror = () => {
        el.remove();
        reject(new Error(`leaflet ${tag} load failed`));
      };
      // CSS는 앱 스타일보다 앞에 둬야 앱의 덮어쓰기(.leaflet-*)가 이긴다
      if (tag === "link") document.head.insertBefore(el, document.querySelector('link[rel="stylesheet"]'));
      else document.head.append(el);
    });
  return Promise.all([
    add("link", { rel: "stylesheet", href: LEAFLET_BASE + "leaflet.css", integrity: LEAFLET_CSS_SRI }),
    add("script", { src: LEAFLET_BASE + "leaflet.js", integrity: LEAFLET_JS_SRI }),
  ]).then(() => window.L);
}

// ---------- 시작 ----------
async function start(panel, options) {
  hooks = options;
  mapEl = panel.querySelector("#map-view");
  statusEl = panel.querySelector("#map-status");
  if (!bound) bindUi(panel);
  setStatus("지도를 불러오는 중…");
  [L] = await Promise.all([loadLeaflet(), tiles.loadIndex().catch(() => null), tiles.loadCities().then((c) => (cities = c))]);

  map = L.map(mapEl, { zoomControl: false, minZoom: 7, maxZoom: 19, maxBounds: KOREA, maxBoundsViscosity: 0.8 });
  L.control.zoom({ position: "bottomright", zoomInTitle: "확대", zoomOutTitle: "축소" }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR }).addTo(map);
  renderer = L.canvas({ padding: 0.3 });
  stopLayer = L.layerGroup().addTo(map);

  map.on("moveend", onMoveEnd);
  map.on("click", onMapClick);
  // 사용자가 지도를 만지면, 늦게 온 위치로 지도를 옮기지 않는다
  map.on("dragstart", markUser);
  for (const t of ["pointerdown", "wheel", "keydown"]) mapEl.addEventListener(t, markUser, { passive: true });
  store.subscribe(() => map && drawRows(lastRows));
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", restyle);

  // 기본 위치 (F-L0, F-L2): 현재 위치 > 마지막 본 지역 > 제주시청
  const saved = readView();
  if (saved) map.setView([saved.lat, saved.lng], saved.zoom);
  else setStatus("현재 위치를 확인하는 중…");
  const res = await requestPosition((pos) => !userMoved && map.setView([pos.lat, pos.lng], START_ZOOM));
  if (res.pos) {
    if (!saved || !userMoved) map.setView([res.pos.lat, res.pos.lng], START_ZOOM);
  } else if (!saved) {
    map.setView(FALLBACK, START_ZOOM);
    toast(`${GEO_TEXT[res.error] || GEO_TEXT.unavailable} 제주시청 부근을 보여 드려요.`);
  }
}

const markUser = () => (userMoved = true);

function bindUi(panel) {
  bound = true;
  panel.querySelector("#btn-locate").addEventListener("click", onLocate);
  panel.querySelector("#btn-list").addEventListener("click", () => {
    if (!map) return;
    const [s, w, n, e] = boundsArr(map.getBounds());
    showNearby(lastRows.filter((r) => r[2] >= s && r[2] <= n && r[3] >= w && r[3] <= e));
  });
  initSearch(panel.querySelector("#map-search"), panel.querySelector("#search-results"), {
    keepOpen: [panel.querySelector("#btn-list")], // 목록 버튼은 바깥 탭으로 치지 않는다 (F-M7)
    getOrigin,
    cityName,
    onPick: focusStop,
    canSearch: () => (region === "unsupported" ? REGION_TEXT.unsupported : ""),
  });
  initStopSheet(document.getElementById("stop-sheet"), {
    onArrivals: hooks.onArrivals,
    peekArrivals: hooks.peekArrivals,
    onClose: () => {
      selMarker?.remove();
      selMarker = null;
    },
  });
}

// ---------- 위치 ----------
const GEO_TEXT = {
  denied: "위치 권한이 없어요.",
  timeout: "위치 확인 시간이 지났어요.",
  unavailable: "위치를 확인하지 못했어요.",
};

/**
 * 현재 위치 1회. GEO_TIMEOUT_MS 안에 답이 없으면 {error:"timeout"}으로 먼저 끝내고,
 * 권한 창에 늦게 답해 위치가 나중에 오면 onLate(pos)를 부른다.
 */
function requestPosition(onLate) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ error: "unavailable" });
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      resolve({ error: "timeout" });
    }, GEO_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        setMyPos(pos);
        if (done) return onLate?.(pos);
        done = true;
        clearTimeout(timer);
        resolve({ pos });
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ error: e.code === 1 ? "denied" : e.code === 3 ? "timeout" : "unavailable" });
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: GEO_TIMEOUT_MS }
    );
  });
}

function setMyPos(pos) {
  myPos = pos;
  geo.setPosition(pos); // 홈의 거리순 정렬·도보 추정과 같은 위치 값을 쓴다 (위치 요청 중복 방지)
  if (!map) return;
  const ll = [pos.lat, pos.lng];
  if (myMarker) myMarker.setLatLng(ll);
  else {
    myMarker = L.circleMarker(ll, { renderer, interactive: false, radius: 8, weight: 3, color: "#fff", fillColor: "#1a73e8", fillOpacity: 1 }).addTo(map);
  }
  // PRD 6.2: 현재 타일 + 주변 8개 타일을 미리 받는다 (index에 있는 것만)
  const d = 0.05;
  for (const n of tiles.tilesInBounds(pos.lat - d, pos.lng - d, pos.lat + d, pos.lng + d) || []) tiles.getTile(n).catch(() => {});
}

async function onLocate() {
  const btn = document.getElementById("btn-locate");
  if (btn.getAttribute("aria-busy") === "true") return;
  btn.setAttribute("aria-busy", "true");
  btn.classList.add("busy");
  markUser();
  const go = (pos) => map?.setView([pos.lat, pos.lng], Math.max(map.getZoom(), START_ZOOM));
  const res = await requestPosition(go);
  btn.removeAttribute("aria-busy");
  btn.classList.remove("busy");
  if (res.pos) go(res.pos);
  else toast(res.error === "denied" ? "위치 권한이 꺼져 있어요. 브라우저 설정에서 허용해 주세요." : GEO_TEXT[res.error]);
}

// ---------- 지도 이동 → 타일 로딩 ----------
function onMoveEnd() {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    saveView();
    refresh();
  }, 150);
}

const boundsArr = (b) => [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];

async function refresh() {
  if (!map) return;
  const my = ++seq;
  const z = map.getZoom();
  const c = map.getCenter();
  let meta = null;
  try {
    meta = await tiles.loadIndex();
  } catch {
    /* 아래에서 안내 */
  }
  if (my !== seq) return;
  if (!meta) {
    drawRows([]);
    return setStatus("정류장 정보를 불러오지 못했어요.", ["다시 시도", refresh]);
  }

  let rows = [];
  let failed = false;
  if (z >= MIN_MARKER_ZOOM) {
    const [s, w, n, e] = boundsArr(map.getBounds().pad(0.2));
    const names = tiles.tilesInBounds(s, w, n, e) || [];
    const slow = setTimeout(() => my === seq && setStatus("정류장 불러오는 중…"), 400);
    const res = await Promise.allSettled(names.map(tiles.getTile));
    clearTimeout(slow);
    if (my !== seq) return;
    for (const r of res) {
      if (r.status === "rejected") failed = true;
      else for (const row of r.value) if (row[2] >= s && row[2] <= n && row[3] >= w && row[3] <= e) rows.push(row);
    }
  }
  drawRows(rows);

  region = await checkRegion(c, z);
  if (my !== seq) return;
  if (region !== "ok") setStatus(REGION_TEXT[region], ["제주로 이동", goJeju]);
  else if (failed) setStatus("일부 정류장을 불러오지 못했어요.", ["다시 시도", refresh]);
  else if (z < MIN_MARKER_ZOOM) setStatus("확대하면 정류장이 보여요", ["확대", () => map.setZoom(MIN_MARKER_ZOOM)]);
  else setStatus("");
}

const REGION_TEXT = {
  unsupported: "이 지역은 아직 지원하지 않아요.",
  nostops: "이 근처에는 정류장 정보가 없어요. 제주 밖이라면 아직 지원하지 않는 지역이에요.",
};

/**
 * 미지원 지역 판단 (PRD 4.4). 지원 도시 bbox 밖이면 미지원.
 * bbox는 직사각형이라 서울처럼 이웃 도시 bbox에 들어가는 미지원 지역이 있어, 확대된 상태에서는
 * 지도 중심 NEAR_M 안에 정류장이 하나도 없을 때도 안내한다.
 */
async function checkRegion(c, z) {
  if (!cities.length) return "ok";
  if (!tiles.citiesAt(cities, c.lat, c.lng).length) return "unsupported";
  if (z < REGION_CHECK_ZOOM) return "ok";
  const dLat = NEAR_M / 111320;
  const dLng = dLat / Math.cos((c.lat * Math.PI) / 180);
  const names = tiles.tilesInBounds(c.lat - dLat, c.lng - dLng, c.lat + dLat, c.lng + dLng) || [];
  const res = await Promise.allSettled(names.map(tiles.getTile));
  if (res.some((r) => r.status === "rejected")) return "ok"; // 판단 불가
  for (const r of res) for (const row of r.value) if (tiles.distanceM(c.lat, c.lng, row[2], row[3]) <= NEAR_M) return "ok";
  return "nostops";
}

/** 지도 위 안내 한 줄 + 선택 버튼. text가 비면 숨김 */
function setStatus(text, action) {
  if (!statusEl) return;
  statusEl.replaceChildren(
    ...(text ? [h("span", null, text), action && h("button", { class: "btn small", type: "button", onclick: action[1] }, action[0])] : []).filter(Boolean)
  );
  statusEl.hidden = !text;
}

// ---------- 마커 ----------
function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    stop: { radius: 7, weight: 2, color: v("--surface"), fillColor: v("--accent"), fillOpacity: 1 },
    // 즐겨찾기(F-M6): 색뿐 아니라 크기·테두리 굵기도 다르게 (색만으로 구분하지 않기)
    fav: { radius: 11, weight: 3, color: v("--text"), fillColor: v("--star"), fillOpacity: 1 },
  };
}

function drawRows(rows) {
  lastRows = rows;
  const favs = new Map();
  for (const s of store.getStops()) if (s.lat != null) favs.set(store.stopKey(s), s);
  const want = new Map();
  for (const r of rows) want.set(tiles.rowKey(r), r);
  // 즐겨찾기 정류장은 줌과 관계없이 화면 안이면 표시
  const [s, w, n, e] = boundsArr(map.getBounds().pad(0.2));
  for (const [k, f] of favs) {
    if (!want.has(k) && f.lat >= s && f.lat <= n && f.lng >= w && f.lng <= e) {
      want.set(k, [f.nodeId, f.name, f.lat, f.lng, f.ars, f.cityCode]);
    }
  }
  for (const [k, d] of drawn) {
    if (!want.has(k) || d.fav !== favs.has(k)) {
      stopLayer.removeLayer(d.m);
      drawn.delete(k);
    }
  }
  const pal = palette();
  for (const [k, r] of want) {
    if (drawn.has(k)) continue;
    const fav = favs.has(k);
    const m = L.circleMarker([r[2], r[3]], { renderer, interactive: false, ...(fav ? pal.fav : pal.stop) });
    stopLayer.addLayer(m);
    drawn.set(k, { m, r, fav });
  }
  for (const d of drawn.values()) if (d.fav) d.m.bringToFront();
  selMarker?.bringToFront();
}

function restyle() {
  const pal = palette();
  for (const d of drawn.values()) d.m.setStyle(d.fav ? pal.fav : pal.stop);
}

function onMapClick(e) {
  const p = e.containerPoint;
  let best = null;
  let bd = HIT_PX * HIT_PX;
  for (const d of drawn.values()) {
    const q = map.latLngToContainerPoint(d.m.getLatLng());
    const dd = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  if (best) openStop(best.r);
}

function openStop(r) {
  closeResults();
  selMarker?.remove();
  selMarker = L.circleMarker([r[2], r[3]], { renderer, interactive: false, radius: 17, weight: 4, color: getComputedStyle(document.documentElement).getPropertyValue("--text").trim(), fill: false }).addTo(map);
  const near = myPos && tiles.distanceM(myPos.lat, myPos.lng, r[2], r[3]);
  openStopSheet(
    { nodeId: r[0], name: r[1], lat: r[2], lng: r[3], ars: r[4] ? String(r[4]) : "", cityCode: r[5] },
    { cityName: cityName(r[5]), distanceText: near != null && near < 50000 ? `현재 위치에서 ${tiles.fmtDistance(near)}` : "" }
  );
}

/** 검색 결과 선택 (F-S3): 정류장으로 옮기고 시트를 연다. 시트에 가리지 않게 정류장을 화면 위쪽에 둔다 */
function focusStop(r) {
  if (!map) return;
  markUser();
  map.setView([r[2], r[3]], Math.max(map.getZoom(), 17), { animate: false });
  map.panBy([0, Math.round(mapEl.clientHeight * 0.25)], { animate: false });
  openStop(r);
}

// ---------- 기준 위치 ----------
const cityName = (code) => cities.find((c) => c.code === code)?.name || "";

/** 미지원 지역 안내의 버튼: 제주(F-L0 기본 위치)로 돌아간다. 제주 전용이라 도시 선택은 없다 (v0.6) */
function goJeju() {
  if (!map) return;
  markUser();
  map.setView(FALLBACK, START_ZOOM);
}

/** 검색 거리 기준: 현재 위치가 화면 근처면 현재 위치, 아니면 지도 중심 */
function getOrigin() {
  if (myPos && map?.getBounds().pad(0.5).contains([myPos.lat, myPos.lng])) return { ...myPos, label: "현재 위치" };
  const c = map ? map.getCenter() : { lat: FALLBACK[0], lng: FALLBACK[1] };
  return { lat: c.lat, lng: c.lng, label: "지도 중심" };
}

// ---------- 마지막 본 지역 (F-L2) ----------
function saveView() {
  const c = map.getCenter();
  const r3 = (x) => Math.round(x * 1000) / 1000;
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ version: 1, lat: r3(c.lat), lng: r3(c.lng), zoom: map.getZoom() }));
  } catch {
    /* 무시 */
  }
}

function readView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    const ok =
      v && Number.isFinite(v.lat) && Number.isFinite(v.lng) && Number.isInteger(v.zoom) &&
      v.lat >= KOREA[0][0] && v.lat <= KOREA[1][0] && v.lng >= KOREA[0][1] && v.lng <= KOREA[1][1];
    return ok ? { lat: v.lat, lng: v.lng, zoom: Math.min(19, Math.max(7, v.zoom)) } : null;
  } catch {
    return null;
  }
}
