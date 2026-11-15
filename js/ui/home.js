// 즐겨찾기 홈 (PRD 5.1: F-H1~F-H9, F-W1, F-G2)
// 신규(4.6):
//  - F-H8 거리순 정렬: 현재 위치를 알면 가까운 정류장부터. 위치 거부·실패면 저장된 order 순서로 조용히 폴백
//  - F-W1 도보 소요시간: 현재 위치↔정류장 좌표로 매번 자동 추정(저장하지 않음). 추정값으로
//    "도착예정 − 도보" 출발 안내를 덧붙인다. 위치를 모르면 안내 자체를 생략(기존 화면과 같음)
//  - F-G2 그룹 최속: 즐겨찾기 전체를 가로질러 그룹마다 "지금 탈 수 있는 가장 빠른 노선" 하나를 크게 표시
// 위치는 브라우저 Geolocation API라 TAGO/Worker 호출 한도와 무관하다 (도착 정보 호출이 늘지 않는다)
// 호출 절약 (PRD 4.5): 화면이 보일 때만 자동 새로고침, 최소 30초, 접힌 카드는 호출 안 함,
// 새로고침 사이에는 arrtime 기준 1초 카운트다운만 한다. 추가로
//  - 사용자 입력이 IDLE_PAUSE_MS 동안 없으면 자동 새로고침 일시정지 (방치된 탭)
//  - 연속 실패한 정류장은 FAIL_BACKOFF_SEC 간격으로 늦춘다 (자동 새로고침만)
//  - 하루 한도 초과(quota) 응답을 받으면 QUOTA_PAUSE_MS 동안 자동 새로고침 정지
import * as store from "../store.js";
import * as geo from "../geo.js";
import { fetchArrivals, lastRequestAt } from "../api.js";
import { groupSelect } from "./groups.js";
import { initWeather, setWeatherActive } from "../weather.js";
import { initCommute, syncCommute } from "./commute.js";
import {
  MIN_AUTO_REFRESH_SEC,
  STALE_AFTER_MS,
  MANUAL_REFRESH_COOLDOWN_MS,
  FAIL_BACKOFF_SEC,
  IDLE_PAUSE_MS,
  QUOTA_PAUSE_MS,
  MAX_ROUTES,
  GEO_FRESH_MS,
  WALK_SAFETY_MIN,
} from "../config.js";
import { h, toast, fmtClock } from "./dom.js";

const PULL_THRESHOLD = 70;
const SLACK_MS = 2000; // 이만큼 일찍 도래한 정류장도 같은 회차에 묶어 부른다 (타이머 오차 흡수)
// 사용자 입력. scroll 이벤트는 쓰지 않는다: 카드 높이가 바뀌어 브라우저가 스크롤 위치를 고치는 것도
// scroll로 와서 방치된 탭이 영원히 "입력 있음"이 된다. 사람의 스크롤은 wheel·touchstart·keydown·pointerdown(스크롤바)으로 잡힌다
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"];

/**
 * key → { result?: {items,nodeName,fetchedAt}, error?: ArrivalsError, loading: bool, staleShown: bool,
 *         fails: 연속 실패 횟수, lastAttemptAt: 마지막 호출 시도 시각(ms) }
 */
const state = new Map();
let listEl;
let active = false; // 홈 탭이 보이고 페이지가 화면에 있음
let autoTimer = null;
let tickTimer = null;
let lastManualAt = 0; // 마지막 수동 새로고침 시각 (버튼·당겨서 공통 10초 쿨다운)
let cooldownTimer = null;
let prevCollapsed = new Map();
let lastInputAt = Date.now(); // 마지막 사용자 입력 시각
let idlePaused = false; // 입력이 없어 자동 새로고침을 멈춘 상태
let quotaUntil = 0; // 이 시각까지 자동 새로고침 정지 (하루 한도 초과)
let lastBest = new Map(); // F-G2: groupId → "stopKey|routeId" (마지막 렌더링 때 고른 그룹별 최속 노선)
let lastGeoPoll = 0; // 마지막 위치 재요청 시각 (홈이 보이는 동안 GEO_FRESH_MS 간격)
let hadPos = false; // 직전 tick에서 쓸 수 있는 위치가 있었는지 (바뀌면 다시 그린다)

const keyOf = store.stopKey;
const stOf = (key) => {
  if (!state.has(key)) state.set(key, { loading: false, fails: 0, lastAttemptAt: null });
  return state.get(key);
};
const offline = () => navigator.onLine === false;

/** 설정의 자동 새로고침 간격(초). 0 = 끄기. 최소 30초 */
function intervalSec() {
  const s = store.getSettings().refreshSec;
  return s === 0 ? 0 : Math.max(MIN_AUTO_REFRESH_SEC, s);
}

/** 정류장의 다음 자동 호출 가능 시각: 기본 간격과 실패 백오프(30→60→120→300초) 중 긴 쪽 */
function dueAt(st, baseSec) {
  if (st.lastAttemptAt == null) return 0;
  const backoff = FAIL_BACKOFF_SEC[Math.min(st.fails || 0, FAIL_BACKOFF_SEC.length - 1)];
  return st.lastAttemptAt + Math.max(baseSec, backoff) * 1000;
}

export function initHome(panel) {
  listEl = panel.querySelector("#stop-list");
  // F-WX1 날씨: 도착 정보와 별개 모듈·별개 타이머. 실패하면 스스로 영역을 숨긴다
  initWeather(panel.querySelector("#weather"));
  // F-CM1~F-CM4 출근 무지각 체크인: 날씨 바로 아래. 네트워크 호출이 없고 저장소도 따로라
  // 도착 정보 새로고침·타이머와 얽히지 않는다 (날짜가 바뀔 때만 tick에서 다시 그린다)
  initCommute(panel.querySelector("#commute"));
  panel.querySelector("#refresh-btn").addEventListener("click", () => refreshAll(true));
  panel.querySelector("#idle-note").addEventListener("click", onUserInput);
  setupPull(document.getElementById("main"), panel.querySelector("#ptr"));
  for (const t of INPUT_EVENTS) document.addEventListener(t, onUserInput, { capture: true, passive: true });
  const stops = store.getStops();
  prevCollapsed = new Map(stops.map((s) => [keyOf(s), s.collapsed]));
  store.subscribe(onStoreChange);
  // 위치를 받으면 거리순 정렬·도보 안내를 다시 그린다 (지도 탭이 받은 위치도 같이 쓴다)
  geo.subscribe(() => render());
  render();
}

/**
 * 홈이 보이는 동안 위치를 GEO_FRESH_MS 간격으로 다시 받아 둔다 (F-W1: 사용자가 움직이면 값도 바뀌어야 한다).
 * geo.ensurePosition()은 아직 신선하거나 거부·무시된 상태면 아무것도 하지 않는다.
 * Geolocation은 브라우저 API라 도착 정보 호출 한도와 무관하다.
 */
function pollPosition(now) {
  if (!store.getStops().length || now - lastGeoPoll < GEO_FRESH_MS) return;
  lastGeoPoll = now;
  geo.ensurePosition();
}

/** app.js가 탭 전환·visibilitychange 때 호출 */
export function setHomeActive(on) {
  if (on === active) return;
  active = on;
  // 날씨(F-WX1)는 여기서 켜고 끄기만 한다. 주기(30분)는 weather.js가 따로 관리하므로
  // 아래 도착 정보 타이머(30초)와 섞이지 않는다
  setWeatherActive(on);
  if (!on) {
    clearTimeout(autoTimer);
    clearInterval(tickTimer);
    autoTimer = tickTimer = null;
    return;
  }
  // 탭으로 돌아오거나 화면을 다시 켠 것은 사용자가 있다는 뜻으로 본다
  lastInputAt = Date.now();
  idlePaused = false;
  // F-H8·F-W1: 홈에서도 위치를 요청한다. 거부·실패해도 오류를 띄우지 않고 저장된 순서로 그대로 간다.
  // (도착 정보 호출과 무관하므로 한도에 영향 없음. 결과가 오면 geo.subscribe가 다시 그린다)
  pollPosition(Date.now());
  tick();
  tickTimer = setInterval(tick, 1000);
  // 다시 보이게 되면: 간격(끄기면 30초)과 실패 백오프가 지난 정류장만 즉시 호출.
  // 다른 탭에 있는 동안 추가된 정류장(아직 호출 안 함)도 여기서 불러온다
  refreshDue(intervalSec() || MIN_AUTO_REFRESH_SEC).then(schedule);
}

/** 이 정류장의 마지막 성공 도착 정보 (지도 바텀시트가 중복 호출을 피하려고 참고) */
export const peekArrivals = (key) => state.get(key)?.result ?? null;

/**
 * 다른 화면(지도 바텀시트)에서 받은 도착 정보를 홈 카드에 반영한다. 즐겨찾기 정류장만.
 * 호출한 것으로 치므로 다음 자동 새로고침은 그 시각부터 간격을 센다 (api.js 10초 중복 무시와 같은 취지)
 */
export function primeArrivals(key, result) {
  if (!result || !store.hasStop(key)) return;
  const st = stOf(key);
  if (st.loading || (st.result && st.result.fetchedAt >= result.fetchedAt)) return;
  st.result = result;
  st.error = null;
  st.fails = 0;
  st.staleShown = false;
  st.lastAttemptAt = Math.max(st.lastAttemptAt ?? 0, result.fetchedAt);
  renderCard(key);
}

/** 온라인으로 돌아왔을 때 (app.js). 연결이 자주 끊겨도 정류장별 간격·백오프를 넘겨 부르지 않는다 */
export function onOnline() {
  render(); // "오프라인" 문구 지우기
  if (!active) return;
  // 실패했거나 아직 못 불러온 정류장만. 성공한 정류장은 schedule()이 원래 간격대로 부른다
  refreshDue(intervalSec() || MIN_AUTO_REFRESH_SEC, (st) => !!st.error || !st.result).then(schedule);
}

/** 오프라인이 됐을 때 (app.js): 카드 문구를 "오프라인 · 이전 정보"로 다시 그리고 타이머 정지 */
export function onOffline() {
  render();
  schedule();
}

// ---------- 유휴(방치된 탭) 감지 ----------

function onUserInput() {
  lastInputAt = Date.now();
  if (!idlePaused) return;
  idlePaused = false;
  updateNotes();
  // 재개: 데이터가 30초 이상 지난 정류장(백오프 적용)만 즉시 1회 호출
  if (active) refreshDue(MIN_AUTO_REFRESH_SEC).then(schedule);
}

/** 입력이 IDLE_PAUSE_MS 동안 없으면 일시정지. 멈췄으면 true */
function checkIdle(now) {
  if (idlePaused) return true;
  if (!intervalSec() || now - lastInputAt < IDLE_PAUSE_MS) return false;
  idlePaused = true;
  clearTimeout(autoTimer);
  autoTimer = null;
  updateNotes();
  return true;
}

function pauseForQuota() {
  quotaUntil = Date.now() + QUOTA_PAUSE_MS;
  updateNotes();
  schedule();
}

// ---------- 새로고침 ----------

function schedule() {
  clearTimeout(autoTimer);
  autoTimer = null;
  const sec = intervalSec();
  if (!active || !sec || idlePaused || offline()) return;
  const stops = store.getStops().filter((s) => !s.collapsed);
  if (!stops.length) return;
  const now = Date.now();
  const next = Math.max(Math.min(...stops.map((s) => dueAt(stOf(keyOf(s)), sec))), quotaUntil);
  autoTimer = setTimeout(async () => {
    autoTimer = null;
    if (!active || checkIdle(Date.now())) return;
    if (Date.now() >= quotaUntil) await refreshDue(sec);
    schedule();
  }, Math.max(1000, next - now));
}

/** 간격(baseSec)과 백오프가 지난 펼친 정류장만 호출. pick으로 더 좁힐 수 있다 */
async function refreshDue(baseSec, pick = () => true) {
  if (offline()) return;
  const now = Date.now();
  const due = store.getStops().filter((s) => {
    const st = stOf(keyOf(s));
    return !s.collapsed && !st.loading && pick(st) && dueAt(st, baseSec) - SLACK_MS <= now;
  });
  // 동시 요청 수는 api.js가 MAX_CONCURRENT_REQUESTS건으로 제한한다
  await Promise.all(due.map(refreshStop));
}

/** 수동 새로고침 후 남은 쿨다운(ms). 0이면 누를 수 있음 */
function cooldownLeft() {
  return Math.max(0, lastManualAt + MANUAL_REFRESH_COOLDOWN_MS - Date.now());
}

/** 쿨다운 동안 버튼을 비활성화하고 남은 초를 표시 */
function startCooldown() {
  const btn = document.getElementById("refresh-btn");
  const label = document.getElementById("refresh-label");
  clearInterval(cooldownTimer);
  const update = () => {
    const left = cooldownLeft();
    if (left <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      btn.disabled = false;
      label.textContent = "새로고침";
      btn.removeAttribute("aria-label");
      return;
    }
    const sec = Math.ceil(left / 1000);
    btn.disabled = true;
    label.textContent = `새로고침 (${sec})`;
    btn.setAttribute("aria-label", `새로고침, ${sec}초 뒤에 다시 누를 수 있어요`);
  };
  update();
  cooldownTimer = setInterval(update, 1000);
}

/** 수동 새로고침(버튼·당겨서): 10초 쿨다운만 따르고 실패 백오프·한도 정지는 무시한다 */
async function refreshAll(manual) {
  if (!manual) return refreshDue(intervalSec() || MIN_AUTO_REFRESH_SEC);
  // 과도한 호출 방지: 수동 새로고침은 10초에 한 번만 (당겨서 새로고침도 같은 쿨다운)
  const left = cooldownLeft();
  if (left > 0) {
    toast(`${Math.ceil(left / 1000)}초 뒤에 다시 새로고침할 수 있어요`);
    return;
  }
  lastManualAt = Date.now();
  startCooldown();
  const stops = store.getStops().filter((s) => !s.collapsed);
  if (!stops.length) return;
  if (offline()) {
    toast("오프라인 — 도착 정보를 불러올 수 없어요");
    return;
  }
  const res = await Promise.all(stops.map(refreshStop));
  schedule(); // 수동 새로고침 후 자동 타이머 다시 계산
  const kinds = stops.map((s, i) => (res[i] === "error" ? state.get(keyOf(s))?.error?.kind : null));
  if (res.every((r) => r === "skipped")) toast("방금 업데이트했어요. 10초 뒤에 다시 시도해 주세요");
  else if (kinds.includes("quota")) toast(errorText("quota"));
  else if (kinds.includes("rate_limited")) toast(errorText("rate_limited"));
  else if (res.includes("error")) toast("일부 정류장 업데이트 실패");
}

/** @returns "ok" | "skipped" | "error" */
async function refreshStop(stop) {
  const key = keyOf(stop);
  const st = stOf(key);
  st.loading = true;
  st.lastAttemptAt = Date.now();
  renderCard(key);
  try {
    const r = await fetchArrivals(stop.cityCode, stop.nodeId);
    if (!r) {
      // 10초 내 중복 호출 무시됨: 실제 마지막 호출 시각으로 맞춘다
      st.lastAttemptAt = lastRequestAt(stop.cityCode, stop.nodeId) || st.lastAttemptAt;
      return "skipped";
    }
    st.result = r;
    st.error = null;
    st.fails = 0;
    st.staleShown = false;
    if (quotaUntil) {
      quotaUntil = 0; // 성공했으니 한도 정지 해제
      updateNotes();
    }
    store.updateFromArrivals(key, r.items, r.nodeName); // knownRoutes 누적
    return "ok";
  } catch (e) {
    st.error = e;
    st.fails = (st.fails || 0) + 1;
    if (e?.kind === "quota") pauseForQuota();
    return "error";
  } finally {
    st.loading = false;
    renderCard(key);
  }
}

function onStoreChange() {
  const stops = store.getStops();
  const keys = new Set(stops.map(keyOf));
  for (const k of state.keys()) if (!keys.has(k)) state.delete(k);
  render();
  if (active && !offline()) {
    const now = Date.now();
    for (const s of stops) {
      const key = keyOf(s);
      if (s.collapsed) continue;
      const was = prevCollapsed.get(key);
      const st = stOf(key);
      // 새로 추가된 정류장, 또는 접혀 있다가 펼쳐졌고 30초(실패 시 백오프)가 지난 경우만 호출
      const due = !st.loading && dueAt(st, MIN_AUTO_REFRESH_SEC) - SLACK_MS <= now;
      if ((was === undefined && st.lastAttemptAt == null) || (was === true && due)) refreshStop(s);
    }
  }
  if (active) schedule(); // 설정에서 간격이 바뀌었을 수 있음
  prevCollapsed = new Map(stops.map((s) => [keyOf(s), s.collapsed]));
}

/** 읽기 전용 데이터면 안내하고 true */
function readOnlyGuard() {
  if (!store.isReadOnly()) return false;
  toast(store.ADD_STOP_MESSAGES.readonly);
  return true;
}

// ---------- 렌더링 ----------

/**
 * F-H8: 현재 위치를 알면 가까운 정류장부터. 좌표가 없는 정류장과 위치를 모를 때는
 * 저장된 order 순서를 그대로 쓴다 (권한 거부·실패 시 조용한 폴백).
 */
function sortStops(stops) {
  const pos = geo.getPosition();
  if (!pos) return stops;
  return stops
    .map((s) => ({ s, d: geo.distanceTo(s, pos) ?? Infinity }))
    .sort((a, b) => a.d - b.d || a.s.order - b.s.order)
    .map((x) => x.s);
}

/**
 * F-G2: 즐겨찾기 전체(여러 정류장)를 가로질러 그룹마다 "지금 탈 수 있는 가장 빠른 노선" 하나를 고른다.
 * 도보 시간(자동 추정)을 반영해 두 단계로 고른다:
 *  1) 여유 = `도착예정 − 도보`. 음수면 걸어가는 사이에 떠나므로 후보에서 빼고, 여유가
 *     WALK_SAFETY_MIN 이상인 "넉넉히 탈 수 있는" 후보를 먼저 본다 (tier 0).
 *     덕분에 "도보 2분·버스 11분"(여유 9분)이 "도보 9분·버스 10분"(여유 1분)보다 앞선다.
 *     넉넉한 후보가 하나도 없으면 아슬아슬한 후보(tier 1) 중에서 고른다.
 *  2) 같은 tier 안에서는 도착예정이 빠른 쪽 — "가장 빨리 탈 수 있는 노선"(PRD 4.6)이다.
 *     (여유만으로 비교하면 같은 정류장에서 30분 뒤 버스가 5분 뒤 버스를 이기는 뒤집힘이 생긴다)
 * 도보 시간을 모르는 정류장(위치 권한 없음·너무 먼 곳)은 도착예정만으로 비교에 넣는다.
 * 같은 값이면 "stopKey|routeId" 문자열 순으로 정해 목록 순서가 달라도 결과가 흔들리지 않게 한다.
 * @returns Map(groupId → "stopKey|routeId")
 */
function computeBest(stops, now = Date.now()) {
  const best = [];
  for (const stop of stops) {
    if (stop.collapsed) continue; // 접힌 카드는 도착 정보를 불러오지 않는다
    const r = state.get(keyOf(stop))?.result;
    if (!r) continue;
    const walk = geo.walkMinutes(stop);
    const { byId } = groupByRoute(r.items);
    for (const route of stop.routes) {
      if (!route.groupId) continue;
      const arr = byId.get(route.routeId);
      if (!arr || arr.arrTime == null) continue;
      const min = etaMinutes(r.fetchedAt + arr.arrTime * 1000, now);
      if (walk != null && min < walk) continue; // 걸어가면 이미 놓쳤을 버스
      // tier 0 = 넉넉히 탈 수 있음(도보를 모르면 여기), 1 = 아슬아슬함
      const tier = walk != null && min - walk < WALK_SAFETY_MIN ? 1 : 0;
      best.push({ groupId: route.groupId, tier, eta: min, id: `${keyOf(stop)}|${route.routeId}` });
    }
  }
  return pickBestByGroup(best);
}

/**
 * 그룹마다 후보 하나를 고른다: tier(넉넉함) → eta(도착예정) → id 순.
 * id까지 보는 이유는 동점일 때 목록 순서에 따라 결과가 달라지지 않게 하기 위함이다
 * (순서가 흔들리면 카드 하나만 다시 그려도 매번 전체 재렌더로 빠진다).
 * @param entries [{groupId, tier, eta, id}]
 * @returns Map(groupId → id)
 */
export function pickBestByGroup(entries) {
  const best = new Map();
  const better = (a, b) => a.tier - b.tier || a.eta - b.eta || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const e of entries) {
    const cur = best.get(e.groupId);
    if (!cur || better(e, cur) < 0) best.set(e.groupId, e);
  }
  return new Map([...best].map(([g, v]) => [g, v.id]));
}

const sameBest = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

function render() {
  const focusKey = document.activeElement?.dataset?.fkey;
  const stops = sortStops(store.getStops());
  lastBest = computeBest(stops);
  hadPos = !!geo.getPosition();
  document.getElementById("refresh-btn").hidden = stops.length === 0;
  const ro =
    store.isReadOnly() &&
    h("p", { class: "readonly-note", role: "note" }, "새 버전 앱에서 저장한 즐겨찾기라 볼 수만 있어요. 앱을 새로고침하면 최신 버전으로 열려요.");
  if (!stops.length) {
    listEl.replaceChildren(...[ro, emptyState()].filter(Boolean));
  } else {
    listEl.replaceChildren(...[ro, ...stops.map(card)].filter(Boolean));
  }
  restoreFocus(focusKey);
  updateNotes();
}

function renderCard(key) {
  const old = listEl.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const stop = store.getStop(key);
  if (!old || !stop) return;
  // 그룹 선택 드롭다운을 쓰는 중이면 카드를 바꾸지 않는다: 모바일의 네이티브 선택 UI가 몇 초씩
  // 열려 있는데 그사이 자동 새로고침이 카드를 갈아끼우면 고르던 것이 취소된다. 다음 갱신 때 그려진다
  const open = document.activeElement;
  if (open?.classList?.contains("group-select") && old.contains(open)) return;
  // 그룹 최속 노선(F-G2)이 다른 카드로 옮겨갔으면 목록 전체를 다시 그려야 강조가 한 곳에만 남는다.
  // 비교는 render()와 같은(정렬된) 목록으로 해야 동점일 때 매번 전체 재렌더로 빠지지 않는다
  if (!sameBest(computeBest(sortStops(store.getStops())), lastBest)) return render();
  const focusKey = document.activeElement?.dataset?.fkey;
  old.replaceWith(card(stop));
  restoreFocus(focusKey);
}

function restoreFocus(fkey) {
  if (!fkey) return;
  const el = listEl.querySelector(`[data-fkey="${CSS.escape(fkey)}"]`);
  if (el && document.activeElement !== el) el.focus({ preventScroll: true });
}

function emptyState() {
  return h(
    "div",
    { class: "empty" },
    h("p", { class: "empty-title" }, "아직 즐겨찾기한 정류장이 없어요"),
    h("p", null, "지도에서 자주 타는 정류장을 찾아 노선을 즐겨찾기해 두면, 여기에서 도착 정보를 바로 볼 수 있어요."),
    h("div", { class: "empty-actions" }, h("a", { class: "btn primary", href: "#map" }, "지도에서 정류장 찾기"))
  );
}

const stopTitle = (s) => (s.alias ? `${s.alias} · ${s.name || s.nodeId}` : s.name || s.nodeId);

function card(stop) {
  const key = keyOf(stop);
  const st = stOf(key);
  const title = stopTitle(stop);
  const bodyId = `body-${key.replace(/[^A-Za-z0-9]/g, "_")}`;
  // F-W1·F-H8: 현재 위치 기준 거리·도보 추정. 위치를 모르면 둘 다 null → 아무것도 덧붙이지 않는다
  const dist = geo.distanceTo(stop);
  const walk = geo.walkMinutes(stop);

  const head = h(
    "div",
    { class: "card-head" },
    h(
      "h2",
      { class: "card-h" },
      h(
        "button",
        {
          class: "card-toggle",
          type: "button",
          "aria-expanded": String(!stop.collapsed),
          "aria-controls": bodyId,
          "data-fkey": `t:${key}`,
          onclick: () => readOnlyGuard() || store.setCollapsed(key, !stop.collapsed),
        },
        h("span", { class: "chev", "aria-hidden": "true" }, stop.collapsed ? "▸" : "▾"),
        h(
          "span",
          { class: "card-title" },
          h("span", { class: "stop-name" }, title),
          // ARS는 없을 수 있다 (제주는 전부 빈 값)
          stop.ars && h("span", { class: "ars" }, `(${stop.ars})`),
          // 거리·도보 추정 (위치를 알 때만). 저장하지 않고 그릴 때마다 다시 계산한 값이다
          dist != null &&
            h(
              "span",
              { class: "walk" },
              h("span", { class: "sr-only" }, "현재 위치에서 "),
              geo.fmtDistance(dist),
              walk == null ? "" : walk === 0 ? " · 바로 앞" : ` · 도보 약 ${walk}분`
            )
        )
      )
    ),
    h(
      "button",
      {
        class: "icon-btn",
        type: "button",
        "aria-label": `${title} 정류장 메뉴`,
        "data-fkey": `m:${key}`,
        onclick: () => readOnlyGuard() || openMenu(key),
      },
      h("span", { "aria-hidden": "true" }, "⋮")
    )
  );

  const r = st.result;
  const stale = !!r && (!!st.error || offline() || Date.now() - r.fetchedAt > STALE_AFTER_MS);
  st.staleShown = stale;

  const art = h("article", { class: "card", "data-key": key }, head);
  if (stop.collapsed) {
    art.append(h("p", { class: "collapsed-note", id: bodyId }, "접어둔 정류장은 도착 정보를 불러오지 않아요"));
    return art;
  }

  // 같은 routeId가 여러 건 올 수 있다 (대구: 같은 노선의 다음 버스). 노선별로 묶어 첫 버스 + 다음 버스
  const { byId, list: arrivals } = groupByRoute(r?.items);
  const favIds = new Set(stop.routes.map((x) => x.routeId));
  const etaOrder = (x) => byId.get(x.routeId)?.arrTime ?? Infinity;

  const withType = (x) => ({ ...x, routeType: x.routeType || byId.get(x.routeId)?.routeType || "" });
  const favs = stop.routes.map(withType).sort((a, b) => etaOrder(a) - etaOrder(b));
  // 다른 노선: 지금 도착 예정인 노선(시간순) + 전에 본 노선(knownRoutes)
  const others = [
    ...arrivals.filter((i) => !favIds.has(i.routeId)),
    ...stop.knownRoutes
      .filter((k) => !favIds.has(k.routeId) && !byId.has(k.routeId))
      .map(withType)
      .sort((a, b) => a.routeNo.localeCompare(b.routeNo, "ko", { numeric: true })),
  ];
  // 같은 routeNo가 routeId만 다르게 여러 번 올 수 있다 (제주). 식별은 항상 routeId
  const labels = routeLabels([...favs, ...others]);
  const row = (x, fav) =>
    routeRow(key, x, byId.get(x.routeId), st, fav, labels.get(x.routeId), {
      walk, // 도보 추정 분 (없으면 null → 출발 안내 생략)
      best: fav && x.groupId && lastBest.get(x.groupId) === `${key}|${x.routeId}`,
    });

  const body = h("div", { class: "card-body" + (stale ? " stale" : ""), id: bodyId });

  if (favs.length) {
    body.append(h("ul", { class: "routes", "aria-label": "즐겨찾기 노선" }, favs.map((x) => row(x, true))));
  }
  if (r && r.items.length === 0) body.append(h("p", { class: "note" }, "도착 예정 버스 없음"));
  else if (!r && !favs.length && st.loading) body.append(h("p", { class: "note" }, "불러오는 중…"));

  if (others.length) {
    // F-H3a: 즐겨찾기 노선이 있으면 다른 노선의 출발 안내(도보 예측)는 연하게 → 즐겨찾기 노선 안내가 먼저 보이게
    const list = h("ul", { class: "routes others" + (favs.length ? " dim" : "") }, others.map((x) => row(x, false)));
    if (!favs.length) {
      body.append(h("p", { class: "hint" }, "타는 노선의 ☆를 눌러 즐겨찾기하세요. 지금 운행 중인 노선과 전에 본 노선만 보여요."), list);
    } else {
      body.append(h("p", { class: "others-label" }, `다른 노선 ${others.length}개`), list);
    }
  }

  body.append(statusLine(stop, st, stale));
  art.append(body);
  return art;
}

function routeRow(key, route, arr, st, fav, label, opts = {}) {
  const no = route.routeNo || "?";
  const name = label ? `${no}번 ${label}` : `${no}번`;
  const due = arr && arr.arrTime != null && st.result ? st.result.fetchedAt + arr.arrTime * 1000 : null;
  let eta;
  if (due != null) {
    eta = h("span", { class: "eta", "data-due": due });
    renderEta(eta, Date.now());
  } else {
    eta = h("span", { class: "eta none" }, st.result ? "도착 정보 없음" : st.loading ? "불러오는 중" : "—");
  }
  const group = fav && route.groupId ? store.getGroup(route.groupId) : null;
  return h(
    "li",
    { class: "route" + (fav ? " fav" : "") + (opts.best ? " group-top" : "") },
    h(
      "span",
      { class: "route-id" },
      routeNoChip(route),
      label && h("span", { class: "route-tp" }, label),
      group && h("span", { class: "route-group" }, group.name)
    ),
    eta,
    arr?.prevStations != null && h("span", { class: "stations" }, `${arr.prevStations}정거장 전`),
    arr?.lowFloor && h("span", { class: "badge" }, "저상"),
    nextEta(arr, st.result?.fetchedAt),
    // F-G2: 그룹에서 지금 가장 빨리 탈 수 있는 노선 (색만이 아니라 글자로도 알린다)
    opts.best && h("span", { class: "group-badge" }, "가장 먼저 탈 수 있어요"),
    // F-W1: 도보 추정을 반영한 출발 안내. 1초 카운트다운과 함께 tick()이 다시 쓴다
    departNote(due, opts.walk),
    // F-G1: 즐겨찾기한 노선에만 그룹 선택. 별표 토글 바로 왼쪽
    fav && groupSelect(key, route, `g:${key}:${route.routeId}`),
    h(
      "button",
      {
        class: "star",
        type: "button",
        "aria-pressed": String(fav),
        "aria-label": `${name} 즐겨찾기`,
        "data-fkey": `s:${key}:${route.routeId}`,
        onclick: () => {
          if (readOnlyGuard()) return;
          if (fav) return store.removeRoute(key, route.routeId);
          if ((store.getStop(key)?.routes.length ?? 0) >= MAX_ROUTES) {
            return toast(`노선은 정류장당 최대 ${MAX_ROUTES}개까지 즐겨찾기할 수 있어요`);
          }
          store.addRoute(key, { routeId: route.routeId, routeNo: route.routeNo, routeType: route.routeType });
        },
      },
      h("span", { "aria-hidden": "true" }, fav ? "★" : "☆")
    )
  );
}

/** 도착 예정 시각(ms) → 화면에 쓰는 남은 분. 1분 미만은 0("곧 도착") */
export function etaMinutes(due, now = Date.now()) {
  const sec = (Number(due) - now) / 1000;
  return sec < 60 ? 0 : Math.max(1, Math.round(sec / 60));
}

/**
 * 남은 시간 표시: 분 단위가 기본, 1분 미만은 "곧 도착" (F-H6).
 * 지역에 따라 arrtime이 분 단위로 반올림돼 오므로(제주: 전부 60의 배수) 초는 보여주지 않는다.
 * 1초마다 내부적으로 다시 계산하지만, 표시가 바뀔 때만 DOM을 고친다.
 */
export function renderEta(el, now) {
  const min = etaMinutes(el.dataset.due, now);
  if (el.dataset.min === String(min)) return;
  el.dataset.min = String(min);
  el.classList.toggle("soon", min === 0);
  if (el.classList.contains("eta-next")) {
    // 다음 버스: 작게 "다음 17분". 스크린리더는 ", 다음 버스 17분 후"로 읽는다
    const sr = (t) => h("span", { class: "sr-only" }, t);
    el.replaceChildren(sr(", "), "다음", sr(" 버스"), ...(min === 0 ? [" 곧 도착"] : [` ${min}분`, sr(" 후")]));
  } else if (min === 0) el.replaceChildren("곧 도착");
  else el.replaceChildren(`${min}분`, h("span", { class: "eta-sub" }, " 후"));
}

/**
 * 도착 목록(arrTime 오름차순)을 routeId별로 묶는다. 첫 항목이 그 노선의 첫 버스, next는 두 번째 버스(없으면 null).
 * 세 번째 이후는 버린다. list는 노선별 첫 버스를 도착 순서대로.
 */
export function groupByRoute(items = []) {
  const byId = new Map();
  const list = [];
  for (const i of items || []) {
    const g = byId.get(i.routeId);
    if (!g) {
      const e = { ...i, next: null };
      byId.set(i.routeId, e);
      list.push(e);
    } else if (!g.next && g.arrTime != null && i.arrTime != null) g.next = i;
  }
  return { byId, list };
}

/**
 * F-W1 출발 안내: "도착예정(분) − 자동 추정 도보 시간".
 * 도보 시간을 모르면(위치 권한 없음·너무 먼 정류장) null — 안내 자체를 생략한다.
 */
function departNote(due, walk) {
  if (due == null || walk == null) return null;
  const el = h("span", { class: "depart", "data-due": due, "data-walk": walk });
  renderDepart(el, Date.now());
  return el;
}

/**
 * 출발 안내 문구 갱신. 표시가 바뀔 때만 DOM을 고친다 (1초마다 호출).
 * 도보 시간은 직선거리 기반 추정이라 분 단위로 정확하지 않으므로, 몇 분 후에 출발하라는
 * 식의 숫자 안내 대신 여유 정도만 말로 전한다(WALK_SAFETY_MIN 이상 여유면 "여유로워요").
 */
export function renderDepart(el, now) {
  const walk = Number(el.dataset.walk);
  const diff = etaMinutes(el.dataset.due, now) - walk;
  if (el.dataset.diff === String(diff)) return;
  el.dataset.diff = String(diff);
  el.classList.toggle("warn", diff < 0);
  const w = walk === 0 ? "정류장 바로 앞" : `도보 약 ${walk}분`;
  const text =
    diff < 0
      ? `${w} · 이미 늦었을 수도 있어요`
      : diff < WALK_SAFETY_MIN
        ? `${w} · 지금 출발해야 할 것 같아요`
        : `${w} · 지금 출발하면 여유로워요`;
  el.replaceChildren(text);
}

/** 같은 노선 두 번째 버스 표시 (없으면 null). 정거장 수는 넣지 않는다 */
export function nextEta(arr, fetchedAt) {
  if (arr?.next?.arrTime == null || fetchedAt == null) return null;
  const el = h("span", { class: "eta eta-next", "data-due": fetchedAt + arr.next.arrTime * 1000 });
  renderEta(el, Date.now());
  return el;
}

/**
 * routeId 끝 n자리가 모두 다를 때까지 n을 늘린다 (최소 3).
 * 예: [JEB405320217, JEB405321217] → 4자리 ("0217", "1217")
 */
export function suffixLen(ids, min = 3) {
  const uniq = [...new Set(ids)];
  const longest = Math.max(0, ...uniq.map((id) => id.length));
  for (let n = min; n < longest; n++) {
    if (new Set(uniq.map((id) => id.slice(-n))).size === uniq.length) return n;
  }
  return Math.max(min, longest);
}

/** 같은 번호가 여러 노선(routeId)인 경우 구분 라벨. 예: "간선", 유형까지 같으면 "간선 · …217" */
export function routeLabels(routes) {
  const byNo = new Map();
  for (const r of routes) {
    const group = byNo.get(r.routeNo) || new Map(); // routeId로 중복 제거
    group.set(r.routeId, r);
    byNo.set(r.routeNo, group);
  }
  const labels = new Map();
  for (const groupMap of byNo.values()) {
    const group = [...groupMap.values()];
    if (group.length < 2) continue;
    const byType = new Map();
    for (const r of group) byType.set(r.routeType || "", [...(byType.get(r.routeType || "") || []), r.routeId]);
    for (const [type, ids] of byType) {
      const n = ids.length > 1 ? suffixLen(ids) : 0;
      for (const id of ids) {
        labels.set(id, [type.replace(/버스$/, ""), n && `…${id.slice(-n)}`].filter(Boolean).join(" · "));
      }
    }
  }
  return labels;
}

/**
 * 노선 유형(routeType) → 색상 카테고리. CSS의 `.route-no[data-rtype=...]`과 짝을 이룬다.
 * 지역마다 문구가 달라(간선버스/지선버스/급행버스/마을버스/외곽버스, 좌석·광역 등) 부분 일치로 본다.
 * 모르는 유형·빈 값은 ""(기본 글자색). 색은 장식일 뿐이고 번호·유형 라벨 글자가 정보를 전한다.
 *
 * 지금 앱은 제주만 지원한다(v0.5). trunk(파랑)·branch(초록)·express(빨강)는 제주 실제 도색과
 * 그대로 일치한다. 단, 번호대 분류(JEJU_NO_RULES)가 이 문구 규칙보다 먼저다 (v0.6, routeTypeClass 참고).
 * circular(노랑)도 제주 관광순환버스(810·820번)의 실제 도색이다.
 * village(주황)는 실제 도색(적색+노란색+흰색 다색)을 정확히 재현하진 못하지만 가장 가까운
 * 단색 근사치이고, seat(청록)는 제주에서 관측된 적 없는 유형이라 임의 배색일 뿐이다
 * (대전 등 다른 지역을 다시 지원할 경우를 대비해 남겨둠, docs/phase0-findings.md 참고).
 */
const ROUTE_TYPE_RULES = [
  [/급행|직행|광역|리무진|공항/, "express"], // 빨강: "좌석급행"도 여기로 (좌석보다 먼저 본다)
  [/좌석/, "seat"], // 임의 배색 (청록) — 제주에서 관측된 적 없음
  [/지선|외곽|농어촌|읍면|시외/, "branch"], // 초록
  [/간선|일반|시내/, "trunk"], // 파랑
  [/순환/, "circular"], // 노랑: 제주 관광순환버스(810·820) 실제 도색 ("마을"보다 먼저 본다)
  [/마을/, "village"], // 근사 배색 (주황) — 실제는 적색+노란색+흰색 다색
];
/**
 * 제주 노선 번호대 → 색상 카테고리 (v0.6: 사용자가 정한 번호대, API routetp보다 우선).
 * JEJU_NO_RULES: 100번대=지선, 200·400번대=간선, 300번대=급행, 800번대=관광순환 — 실제 Worker 호출로도
 *   확인된 값이다(2026-11-15, 제주시청 정류장 샘플, 810·820 관광순환).
 * JEJU_NO_GUESS: 500·600·700번대는 미확인 추정치 → routetp가 있으면 그쪽이 먼저, 없을 때만 쓴다.
 */
const JEJU_NO_RULES = { 1: "branch", 2: "trunk", 3: "express", 4: "trunk", 8: "circular" };
const JEJU_NO_GUESS = { 5: "trunk", 6: "branch", 7: "branch" };

/** 노선 번호 → 백의 자리. 숫자만으로 된 번호가 아니거나 100 미만이면 null */
function routeHundred(routeNo) {
  const s = String(routeNo ?? "").trim();
  if (!/^\d+$/.test(s)) return null; // "급행1" 같은 문자열 번호는 번호대 분류를 하지 않는다
  const n = Number(s);
  return n >= 100 ? Math.floor(n / 100) : null;
}

export function routeTypeClass(routeType, routeNo) {
  const hundred = routeHundred(routeNo);
  // 1) 정해진 번호대가 최우선 (API 유형 문구가 달라도 번호대로 칠한다)
  if (JEJU_NO_RULES[hundred]) return JEJU_NO_RULES[hundred];
  // 2) 그 밖의 번호는 API 유형 문구
  const t = String(routeType || "").replace(/\s+/g, "");
  if (t) {
    for (const [re, kind] of ROUTE_TYPE_RULES) if (re.test(t)) return kind;
  }
  // 3) 그것도 없으면 미확인 번호대 추정치
  return JEJU_NO_GUESS[hundred] || "";
}

/** 노선 번호 칩 (유형별 색). 홈 카드와 지도 바텀시트가 같이 쓴다 */
export function routeNoChip(route) {
  const no = route.routeNo || "?";
  return h(
    "span",
    { class: "route-no", "data-rtype": routeTypeClass(route.routeType, route.routeNo) || null },
    no,
    h("span", { class: "sr-only" }, "번")
  );
}

const ERROR_TEXT = {
  bad_request: "정류장 정보가 올바르지 않아요",
  rate_limited: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요",
  quota: "오늘 조회 한도를 모두 사용했어요",
};
const errorText = (kind) => ERROR_TEXT[kind] || "업데이트 실패";
const NO_RETRY_BUTTON = new Set(["bad_request", "quota"]); // 다시 눌러도 결과가 같다

function statusLine(stop, st, stale) {
  const parts = [];
  if (st.loading) parts.push(h("span", null, st.result ? "업데이트 중…" : "불러오는 중…"));
  else if (st.result) {
    // 오프라인이면 실패 문구 대신 "오프라인 · 이전 정보" (흐리게 표시와 함께 글자로도 알림)
    const note = offline() ? " · 오프라인 · 이전 정보" : stale ? " · 이전 정보" : "";
    parts.push(h("span", null, `${fmtClock(st.result.fetchedAt)} 갱신${note}`));
  } else if (offline()) {
    parts.push(h("span", { class: "err" }, "오프라인 — 도착 정보를 불러올 수 없어요"));
  }

  if (st.error && !st.loading && !offline()) {
    const kind = st.error.kind;
    parts.push(h("span", { class: "err" }, errorText(kind)));
    if (!NO_RETRY_BUTTON.has(kind)) parts.push(
      h(
        "button",
        {
          class: "btn small",
          type: "button",
          "data-fkey": `r:${keyOf(stop)}`,
          onclick: async () => {
            if ((await refreshStop(stop)) === "skipped") toast("방금 시도했어요. 10초 뒤에 다시 시도해 주세요");
          },
        },
        "다시 시도"
      )
    );
  }
  return h("div", { class: "status" }, parts);
}

function tick() {
  const now = Date.now();
  pollPosition(now);
  syncCommute(); // 목표까지 남은·지난 시간 갱신, 자정을 넘기면 다시 그린다
  // 위치가 새로 생겼거나(권한 허용) 오래돼 못 쓰게 됐으면(GEO_STALE_MS 초과) 정렬·도보 안내를 다시 그린다
  const hasPos = !!geo.getPosition();
  if (hasPos !== hadPos) {
    hadPos = hasPos;
    return render(); // render가 모든 카드를 다시 그리므로 아래 갱신은 건너뛴다
  }
  for (const el of listEl.querySelectorAll(".eta[data-due]")) renderEta(el, now);
  for (const el of listEl.querySelectorAll(".depart[data-due]")) renderDepart(el, now);
  // 오래된 정보는 흐리게 (한 번만 다시 그림)
  for (const [key, st] of state) {
    if (st.result && !st.staleShown && now - st.result.fetchedAt > STALE_AFTER_MS) renderCard(key);
  }
  checkIdle(now);
  if (quotaUntil && now >= quotaUntil) quotaUntil = 0;
  updateNotes();
}

/** FAB 위 안내: 유휴 일시정지(탭하여 재개)·한도 초과 정지. 색이 아니라 글자로 알린다 */
function updateNotes() {
  const idleEl = document.getElementById("idle-note");
  const quotaEl = document.getElementById("quota-note");
  const auto = intervalSec() > 0 && store.getStops().length > 0;
  idleEl.hidden = !(auto && idlePaused);
  const left = quotaUntil - Date.now();
  const quotaText =
    auto && left > 0 ? `오늘 조회 한도를 모두 사용했어요 · 자동 새로고침 ${Math.ceil(left / 60000)}분 멈춤` : "";
  if (quotaEl.textContent !== quotaText) quotaEl.textContent = quotaText;
  quotaEl.hidden = !quotaText;
}

// ---------- 정류장 메뉴 (별칭·순서·삭제) ----------

function openMenu(key) {
  const stop = store.getStop(key);
  const dlg = document.getElementById("stop-menu");
  if (!stop || !dlg) return;
  const form = dlg.querySelector("form");
  dlg.querySelector("#stop-menu-title").textContent = stop.name || stop.nodeId;
  form.alias.value = stop.alias;
  // 거리순 정렬 중(위치를 아는 상태)에는 저장 순서를 바꿔도 화면이 그대로라 혼란스럽다 → 막고 안내한다
  const byDistance = !!geo.getPosition();
  const idx = store.getStops().findIndex((s) => keyOf(s) === key);
  form.querySelector('[value="up"]').disabled = byDistance || idx <= 0;
  form.querySelector('[value="down"]').disabled = byDistance || idx >= store.getStops().length - 1;
  dlg.querySelector("#stop-menu-order-note").hidden = !byDistance;
  dlg.onclose = () => {
    const v = dlg.returnValue;
    dlg.returnValue = "";
    if (v === "alias") store.setAlias(key, form.alias.value);
    else if (v === "up") store.moveStop(key, -1);
    else if (v === "down") store.moveStop(key, 1);
    else if (v === "delete" && confirm(`'${stopTitle(stop)}'을(를) 즐겨찾기에서 삭제할까요?`)) {
      store.removeStop(key);
      toast("삭제했어요");
      return;
    }
    listEl.querySelector(`[data-fkey="${CSS.escape(`m:${key}`)}"]`)?.focus();
  };
  dlg.showModal();
}

// ---------- 당겨서 새로고침 ----------

function setupPull(scroller, indicator) {
  let startY = null;
  let dy = 0;
  const reset = () => {
    startY = null;
    dy = 0;
    indicator.style.setProperty("--pull", "0px");
    indicator.classList.remove("ready", "pulling");
  };
  scroller.addEventListener(
    "touchstart",
    (e) => {
      if (!active || scroller.scrollTop > 0 || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      dy = 0;
    },
    { passive: true }
  );
  scroller.addEventListener(
    "touchmove",
    (e) => {
      if (startY == null) return;
      dy = e.touches[0].clientY - startY;
      if (dy <= 0 || scroller.scrollTop > 0) return reset();
      indicator.classList.add("pulling");
      indicator.style.setProperty("--pull", `${Math.min(dy * 0.5, 60)}px`);
      const ready = dy > PULL_THRESHOLD;
      indicator.classList.toggle("ready", ready);
      indicator.textContent = ready ? "놓으면 새로고침" : "당겨서 새로고침";
    },
    { passive: true }
  );
  scroller.addEventListener("touchend", () => {
    if (startY != null && dy > PULL_THRESHOLD) refreshAll(true);
    reset();
  });
  scroller.addEventListener("touchcancel", reset);
}
