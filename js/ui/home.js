// 즐겨찾기 홈 (PRD 5.1: F-H1, F-H2, F-H3, F-H4, F-H5, F-H6, F-H9)
// 호출 절약 (PRD 4.5): 화면이 보일 때만 자동 새로고침, 최소 30초, 접힌 카드는 호출 안 함,
// 새로고침 사이에는 arrtime 기준 1초 카운트다운만 한다. 추가로
//  - 사용자 입력이 IDLE_PAUSE_MS 동안 없으면 자동 새로고침 일시정지 (방치된 탭)
//  - 연속 실패한 정류장은 FAIL_BACKOFF_SEC 간격으로 늦춘다 (자동 새로고침만)
//  - 하루 한도 초과(quota) 응답을 받으면 QUOTA_PAUSE_MS 동안 자동 새로고침 정지
import * as store from "../store.js";
import { fetchArrivals, lastRequestAt } from "../api.js";
import {
  MIN_AUTO_REFRESH_SEC,
  STALE_AFTER_MS,
  MANUAL_REFRESH_COOLDOWN_MS,
  FAIL_BACKOFF_SEC,
  IDLE_PAUSE_MS,
  QUOTA_PAUSE_MS,
  MAX_ROUTES,
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
const openOthers = new Set(); // "다른 노선" 펼친 정류장
let listEl, opts;
let active = false; // 홈 탭이 보이고 페이지가 화면에 있음
let autoTimer = null;
let tickTimer = null;
let lastManualAt = 0; // 마지막 수동 새로고침 시각 (버튼·당겨서 공통 10초 쿨다운)
let cooldownTimer = null;
let prevCollapsed = new Map();
let lastInputAt = Date.now(); // 마지막 사용자 입력 시각
let idlePaused = false; // 입력이 없어 자동 새로고침을 멈춘 상태
let quotaUntil = 0; // 이 시각까지 자동 새로고침 정지 (하루 한도 초과)

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

export function initHome(panel, options = {}) {
  opts = options;
  listEl = panel.querySelector("#stop-list");
  panel.querySelector("#refresh-btn").addEventListener("click", () => refreshAll(true));
  panel.querySelector("#idle-note").addEventListener("click", onUserInput);
  setupPull(document.getElementById("main"), panel.querySelector("#ptr"));
  for (const t of INPUT_EVENTS) document.addEventListener(t, onUserInput, { capture: true, passive: true });
  const stops = store.getStops();
  prevCollapsed = new Map(stops.map((s) => [keyOf(s), s.collapsed]));
  store.subscribe(onStoreChange);
  render();
}

/** app.js가 탭 전환·visibilitychange 때 호출 */
export function setHomeActive(on) {
  if (on === active) return;
  active = on;
  if (!on) {
    clearTimeout(autoTimer);
    clearInterval(tickTimer);
    autoTimer = tickTimer = null;
    return;
  }
  // 탭으로 돌아오거나 화면을 다시 켠 것은 사용자가 있다는 뜻으로 본다
  lastInputAt = Date.now();
  idlePaused = false;
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

function render() {
  const focusKey = document.activeElement?.dataset?.fkey;
  const stops = store.getStops();
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
    h("div", { class: "empty-actions" }, h("a", { class: "btn primary", href: "#map" }, "지도에서 정류장 찾기"), opts.emptyExtra?.())
  );
}

const stopTitle = (s) => (s.alias ? `${s.alias} · ${s.name || s.nodeId}` : s.name || s.nodeId);

function card(stop) {
  const key = keyOf(stop);
  const st = stOf(key);
  const title = stopTitle(stop);
  const bodyId = `body-${key.replace(/[^A-Za-z0-9]/g, "_")}`;

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
          stop.ars && h("span", { class: "ars" }, `(${stop.ars})`)
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
  const row = (x, fav) => routeRow(key, x, byId.get(x.routeId), st, fav, labels.get(x.routeId));

  const body = h("div", { class: "card-body" + (stale ? " stale" : ""), id: bodyId });

  if (favs.length) {
    body.append(h("ul", { class: "routes", "aria-label": "즐겨찾기 노선" }, favs.map((x) => row(x, true))));
  }
  if (r && r.items.length === 0) body.append(h("p", { class: "note" }, "도착 예정 버스 없음"));
  else if (!r && !favs.length && st.loading) body.append(h("p", { class: "note" }, "불러오는 중…"));

  if (others.length) {
    const list = h("ul", { class: "routes others" }, others.map((x) => row(x, false)));
    if (!favs.length) {
      body.append(h("p", { class: "hint" }, "타는 노선의 ☆를 눌러 즐겨찾기하세요. 지금 운행 중인 노선과 전에 본 노선만 보여요."), list);
    } else {
      const det = h(
        "details",
        { class: "others-wrap", open: openOthers.has(key) },
        h("summary", { "data-fkey": `o:${key}` }, `다른 노선 ${others.length}개`),
        list
      );
      det.addEventListener("toggle", () => (det.open ? openOthers.add(key) : openOthers.delete(key)));
      body.append(det);
    }
  }

  body.append(statusLine(stop, st, stale));
  art.append(body);
  return art;
}

function routeRow(key, route, arr, st, fav, label) {
  const no = route.routeNo || "?";
  const name = label ? `${no}번 ${label}` : `${no}번`;
  let eta;
  if (arr && arr.arrTime != null) {
    eta = h("span", { class: "eta", "data-due": st.result.fetchedAt + arr.arrTime * 1000 });
    renderEta(eta, Date.now());
  } else {
    eta = h("span", { class: "eta none" }, st.result ? "도착 정보 없음" : st.loading ? "불러오는 중" : "—");
  }
  return h(
    "li",
    { class: "route" + (fav ? " fav" : "") },
    h(
      "span",
      { class: "route-id" },
      h("span", { class: "route-no" }, no, h("span", { class: "sr-only" }, "번")),
      label && h("span", { class: "route-tp" }, label)
    ),
    eta,
    arr?.prevStations != null && h("span", { class: "stations" }, `${arr.prevStations}정거장 전`),
    arr?.lowFloor && h("span", { class: "badge" }, "저상"),
    nextEta(arr, st.result?.fetchedAt),
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

/**
 * 남은 시간 표시: 분 단위가 기본, 1분 미만은 "곧 도착" (F-H6).
 * 지역에 따라 arrtime이 분 단위로 반올림돼 오므로(제주: 전부 60의 배수) 초는 보여주지 않는다.
 * 1초마다 내부적으로 다시 계산하지만, 표시가 바뀔 때만 DOM을 고친다.
 */
export function renderEta(el, now) {
  const sec = (Number(el.dataset.due) - now) / 1000;
  const min = sec < 60 ? 0 : Math.max(1, Math.round(sec / 60));
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
  for (const el of listEl.querySelectorAll(".eta[data-due]")) renderEta(el, now);
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
  const idx = store.getStops().findIndex((s) => keyOf(s) === key);
  form.querySelector('[value="up"]').disabled = idx <= 0;
  form.querySelector('[value="down"]').disabled = idx >= store.getStops().length - 1;
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
