// 홈 화면 날씨·우산 안내 (F-WX1, PRD 4.6)
//
// - 출처는 Open-Meteo(키 불필요·무료·CORS 허용)라 보관할 비밀이 없다 → Worker를 거치지 않고 여기서 직접 부른다.
//   TAGO/Worker 호출 한도와 무관하므로 PRD 4.5의 트래픽 예산에 영향이 없다.
// - 그래도 과하게 부르지 않는다: 홈이 보일 때 1회, 활성 상태가 이어지면 WEATHER_REFRESH_MS(30분) 간격으로만.
//   **버스 도착 정보의 30초 타이머와는 완전히 별개 타이머다.** 이 모듈은 js/api.js를 거치지 않고,
//   반대로 도착 정보 새로고침도 이 모듈을 건드리지 않는다 (섞으면 한쪽 주기가 다른 쪽을 끌고 간다).
// - 좌표는 js/geo.js의 현재 위치를 재사용한다 (여기서 Geolocation을 또 요청하지 않는다).
//   위치를 모르면 data/cities.json의 제주 center로 폴백 (F-L0 기본 위치와 같은 생각).
//   밖으로 나가는 좌표는 소수점 2자리(약 1km)로 뭉갠다 — 날씨에는 그 정도면 충분하고 정확한 위치를 보낼 이유가 없다.
// - 실패(네트워크·타임아웃·이상한 응답)는 **조용히 영역을 숨긴다**. 토스트·배너를 띄우지 않는다
//   (핵심 기능이 아니라서 도착 정보 화면을 방해하면 안 된다).
import { getPosition, ensurePosition, subscribe as subscribeGeo, distanceM } from "./geo.js";
import {
  OPEN_METEO_URL,
  WEATHER_REFRESH_MS,
  WEATHER_RETRY_MS,
  WEATHER_TIMEOUT_MS,
  WEATHER_RAIN_PROB,
  FALLBACK_CITY_CODE,
} from "./config.js";
import { h } from "./ui/dom.js";

let el = null;
let active = false;
let timer = null;
let inflight = null;
let lastOkAt = 0; // 마지막 성공 시각
let lastTryAt = 0; // 마지막 시도 시각 (실패 후 연타 방지)
let shownAt = null; // 마지막으로 그린 좌표 {lat, lng, fallback}
let pendingAt = null; // 지금 받는 중인 좌표 (좌표를 정하기 전이면 null)
let again = false; // 폴백 좌표로 받는 중에 위치가 왔다 → 끝나면 한 번 더

// ---------- WMO 날씨 코드 → 아이콘·텍스트 ----------
// 아이콘만으로 정보를 전하지 않는다: 이모지는 aria-hidden이고 옆의 텍스트가 같은 뜻을 전한다.
const WMO = [
  [[0], "☀️", "맑음"],
  [[1], "🌤️", "대체로 맑음"],
  [[2], "⛅", "구름 조금"],
  [[3], "☁️", "흐림"],
  [[45, 48], "🌫️", "안개"],
  [[51, 53, 55, 56, 57], "🌦️", "이슬비"],
  [[61, 63, 65], "🌧️", "비"],
  [[66, 67], "🌧️", "어는 비"],
  [[71, 73, 75, 77], "❄️", "눈"],
  [[80, 81, 82], "🌦️", "소나기"],
  [[85, 86], "❄️", "소나기눈"],
  [[95], "⛈️", "뇌우"],
  [[96, 99], "⛈️", "우박을 동반한 뇌우"],
];
const CODE_MAP = new Map();
for (const [codes, icon, text] of WMO) for (const c of codes) CODE_MAP.set(c, { icon, text });

/** 비·눈·뇌우 코드 (WMO 51–67, 71–77, 80–86, 95–99) */
const isWetCode = (c) =>
  (c >= 51 && c <= 67) || (c >= 71 && c <= 77) || (c >= 80 && c <= 86) || (c >= 95 && c <= 99);

const describe = (code) => CODE_MAP.get(code) ?? { icon: "🌡️", text: "날씨" };

// ---------- 데이터 ----------

/**
 * 위치를 모를 때 쓰는 기본 좌표: data/cities.json의 제주 center. 없으면 null.
 * tiles.js는 홈 첫 화면에 필요 없는 모듈이라 이 폴백이 실제로 쓰일 때만 불러온다 (app.js의 지연 로딩과 같은 취지).
 */
async function fallbackPoint() {
  const cities = await import("./tiles.js").then((m) => m.loadCities()).catch(() => []);
  const c = cities.find((x) => Number(x.code) === FALLBACK_CITY_CODE) ?? cities[0];
  const center = c?.center;
  if (!Array.isArray(center) || center.length !== 2) return null;
  return { lat: Number(center[0]), lng: Number(center[1]), fallback: true };
}

/**
 * 지금 쓸 좌표. 현재 위치(js/geo.js) 우선, 없으면 제주 center.
 * 위치를 아직 모르면 geo.ensurePosition()을 기다린다 — 앱을 막 열었을 때 바로 폴백으로 부르면
 * 위치를 허용한 사용자도 늘 "제주 기준" 날씨를 먼저 보게 된다 (홈의 위치 요청과 pending을 공유하므로
 * 요청이 늘지 않고, 거부·무시된 상태면 즉시 null이 와서 바로 폴백한다. 최대 GEO_TIMEOUT_MS).
 */
async function point() {
  const p = getPosition() || (await ensurePosition().catch(() => null));
  if (p) return { lat: p.lat, lng: p.lng, fallback: false };
  return fallbackPoint();
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Open-Meteo 1회 호출. 실패·타임아웃이면 throw (호출한 쪽이 영역을 숨긴다) */
async function fetchWeather({ lat, lng }) {
  const q = new URLSearchParams({
    latitude: String(round2(lat)),
    longitude: String(round2(lng)),
    current: "temperature_2m,precipitation,weather_code",
    daily: "precipitation_probability_max",
    timezone: "Asia/Seoul",
    forecast_days: "1",
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const res = await fetch(`${OPEN_METEO_URL}?${q}`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const j = await res.json();
    const cur = j?.current;
    const temp = Number(cur?.temperature_2m);
    const code = Number(cur?.weather_code);
    if (!Number.isFinite(temp) || !Number.isFinite(code)) throw new Error("bad payload");
    const prob = Number(j?.daily?.precipitation_probability_max?.[0]);
    return {
      temp,
      code,
      precip: Number(cur?.precipitation) || 0,
      prob: Number.isFinite(prob) ? prob : null,
    };
  } finally {
    clearTimeout(t);
  }
}

// ---------- 표시 ----------

function hide() {
  shownAt = null;
  if (!el) return;
  el.hidden = true;
  el.replaceChildren();
}

function paint(wx, at) {
  if (!el) return;
  const { icon, text } = describe(wx.code);
  const wet = wx.precip > 0 || isWetCode(wx.code);
  // 지금 오는 중이면 강하게, 아니면 오늘 강수확률이 높을 때만 약하게 안내한다
  const tip = wet
    ? "☂️ 우산을 챙기세요"
    : wx.prob != null && wx.prob >= WEATHER_RAIN_PROB
      ? "☂️ 오늘 비 올 수도 있어요"
      : null;
  const extras = at.fallback ? [h("span", { class: "wx-where" }, "제주 기준")] : [];
  el.replaceChildren(
    ...[
      h("span", { class: "wx-icon", "aria-hidden": "true" }, icon),
      h("span", { class: "wx-temp" }, `${Math.round(wx.temp)}°C`),
      h("span", { class: "wx-desc" }, text),
      tip && h("span", { class: "wx-tip" }, tip),
      ...extras
    ].filter(Boolean)
  );
  el.hidden = false;
  shownAt = at;
}

// ---------- 호출 주기 ----------

async function load() {
  const at = await point();
  pendingAt = at;
  if (!at) return hide();
  try {
    const wx = await fetchWeather(at);
    lastOkAt = Date.now();
    paint(wx, at);
  } catch {
    hide(); // 에러 문구 없이 영역만 숨긴다
  }
}

/** 받을 때가 됐으면 1회 받는다 (아직 신선하거나 방금 실패했으면 아무것도 안 함) */
function refresh(force = false) {
  if (!el || inflight) return;
  const now = Date.now();
  if (!force && now - lastOkAt < WEATHER_REFRESH_MS) return;
  if (!force && now - lastTryAt < WEATHER_RETRY_MS) return; // 실패 직후 반복 호출 방지
  lastTryAt = now;
  again = false;
  pendingAt = null;
  inflight = load().finally(() => {
    inflight = null;
    pendingAt = null;
    if (again && active) refresh(true);
  });
}

/**
 * 폴백(제주 center)으로 그려 둔 뒤 실제 현재 위치를 받았거나, 꽤 멀리 이동했으면 한 번 더 받는다.
 * 홈이 보이는 동안만, 그리고 위치가 실제로 달라졌을 때만이라 호출이 늘어나지 않는다.
 */
function onGeo(p) {
  if (!active || !p) return;
  // 폴백 좌표로 받는 중에 위치가 왔다: 끝나면 실제 위치로 한 번 더 (예전엔 이 경우를 놓쳐 폴백이 그대로 남았다)
  // (좌표를 정하기 전, 즉 위치를 기다리는 중이면 point()가 이 위치를 그대로 쓰므로 아무것도 안 한다)
  if (inflight) {
    if (pendingAt?.fallback) again = true;
    return;
  }
  if (!shownAt) return;
  const moved = distanceM(shownAt.lat, shownAt.lng, p.lat, p.lng) > 20000;
  if (!shownAt.fallback && !moved) return;
  refresh(true);
}

/** 홈 패널의 날씨 영역을 연결한다 (app.js/home.js가 1회 호출) */
export function initWeather(node) {
  el = node || null;
  if (el) el.hidden = true;
  subscribeGeo(onGeo);
}

/**
 * 홈이 보이는지 알린다 (home.js의 setHomeActive에서 호출).
 * 보일 때 1회 받고, 계속 보이면 30분마다. 안 보이면 타이머를 멈춘다.
 */
export function setWeatherActive(on) {
  if (on === active) return;
  active = on;
  clearInterval(timer);
  timer = null;
  if (!on) return;
  refresh();
  timer = setInterval(refresh, WEATHER_REFRESH_MS);
}
