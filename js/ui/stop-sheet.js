// 지도 정류장 바텀시트 (PRD F-M4): 정류장명·ARS, 지나는 노선(/arrivals 1회), 노선별 ☆, 정류장 즐겨찾기.
// 호출 절약: 시트를 열 때 1회만 부르고(30초 안에 받은 정보가 있으면 그것을 씀) 자동 새로고침은 하지 않는다.
// 새로 고치는 것은 "새로고침" 버튼(수동)뿐이며, 같은 정류장 10초 중복 무시·동시 4건 제한은 api.js가 맡는다.
import * as store from "../store.js";
import { fetchArrivals, lastRequestAt } from "../api.js";
import { MIN_GAP_MS, MIN_AUTO_REFRESH_SEC, MAX_ROUTES } from "../config.js";
import { h, toast, fmtClock } from "./dom.js";
import { routeLabels, renderEta, groupByRoute, nextEta, routeNoChip } from "./home.js";

const CACHE_MAX = 30;
const cache = new Map(); // key → 마지막 성공 결과 {items, nodeName, fetchedAt}

let dlg, bodyEl, hooks;
let cur = null; // { stop, key, ctx, result, error, loading, seq }
let tickTimer = null;

const offline = () => navigator.onLine === false;
const ERROR_TEXT = {
  bad_request: "정류장 정보가 올바르지 않아요",
  rate_limited: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요",
  quota: "오늘 조회 한도를 모두 사용했어요",
};
const NO_RETRY = new Set(["bad_request", "quota"]);

/** hooks: { onArrivals(key, result), peekArrivals(key) } — 홈 화면과 도착 정보를 나눠 쓴다 */
export function initStopSheet(dialog, options = {}) {
  dlg = dialog;
  hooks = options;
  bodyEl = dlg.querySelector(".sheet-body");
  // 바깥(배경)을 누르면 닫기
  dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());
  dlg.addEventListener("close", () => {
    clearInterval(tickTimer);
    tickTimer = null;
    cur = null;
    options.onClose?.();
  });
  store.subscribe(() => cur && render());
}

/**
 * @param stop { nodeId, cityCode, name, ars, lat, lng } 타일 데이터에서 온 값
 * @param ctx  { cityName, distanceText }
 */
export function openStopSheet(stop, ctx = {}) {
  const key = store.stopKey(stop);
  const prev = newest(cache.get(key), hooks.peekArrivals?.(key));
  cur = { stop, key, ctx, result: prev, error: null, loading: false, seq: 0 };
  render();
  if (!dlg.open) dlg.showModal();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
  // 30초 안에 받은 정보가 있으면 다시 부르지 않는다
  if (!prev || Date.now() - prev.fetchedAt >= MIN_AUTO_REFRESH_SEC * 1000) load(false);
}

const newest = (a, b) => (!a ? b || null : !b ? a : a.fetchedAt >= b.fetchedAt ? a : b);

async function load(manual) {
  const c = cur;
  if (!c || c.loading) return;
  if (offline()) {
    if (manual) toast("오프라인 — 도착 정보를 불러올 수 없어요");
    return render();
  }
  const seq = ++c.seq;
  c.loading = true;
  render();
  try {
    const r = await fetchArrivals(c.stop.cityCode, c.stop.nodeId);
    if (!r) {
      // 10초 안에 이미 부른 정류장: 호출하지 않았다
      const left = Math.ceil((lastRequestAt(c.stop.cityCode, c.stop.nodeId) + MIN_GAP_MS - Date.now()) / 1000);
      if (manual || !c.result) toast(`방금 불러왔어요. ${Math.max(1, left)}초 뒤에 다시 시도해 주세요`);
    } else {
      cache.delete(c.key);
      cache.set(c.key, r);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      if (c.seq === seq) {
        c.result = r;
        c.error = null;
      }
      share(c.key, r);
    }
  } catch (e) {
    if (c.seq === seq) c.error = e;
  } finally {
    if (c.seq === seq) c.loading = false;
    if (cur === c) render();
  }
}

/** 즐겨찾기 정류장이면 knownRoutes를 쌓고 홈 카드에도 바로 보여 준다 */
function share(key, r) {
  if (!store.hasStop(key)) return;
  store.updateFromArrivals(key, r.items, r.nodeName);
  hooks.onArrivals?.(key, r);
}

function guardReadOnly() {
  if (!store.isReadOnly()) return false;
  toast(store.ADD_STOP_MESSAGES.readonly);
  return true;
}

function addStop(routes = []) {
  const { stop, key, result } = cur;
  const res = store.tryAddStop({ ...stop, routes });
  if (!res.ok) {
    toast(store.ADD_STOP_MESSAGES[res.reason]);
    return false;
  }
  if (result) share(key, result);
  toast(routes.length ? `즐겨찾기에 추가했어요 · ${routes[0].routeNo}번` : "즐겨찾기에 추가했어요. 타는 노선의 ☆도 눌러 주세요");
  return true;
}

function toggleStop() {
  if (guardReadOnly()) return;
  const { key, stop } = cur;
  if (!store.hasStop(key)) return addStop();
  if (confirm(`'${stop.name}'을(를) 즐겨찾기에서 삭제할까요? 즐겨찾기한 노선도 함께 지워져요.`)) {
    store.removeStop(key);
    toast("삭제했어요");
  }
}

function toggleRoute(route) {
  if (guardReadOnly()) return;
  const { key } = cur;
  const r = { routeId: route.routeId, routeNo: route.routeNo, routeType: route.routeType };
  if (!store.hasStop(key)) return addStop([r]);
  if (store.isFavoriteRoute(key, r.routeId)) return store.removeRoute(key, r.routeId);
  if ((store.getStop(key)?.routes.length ?? 0) >= MAX_ROUTES) {
    return toast(`노선은 정류장당 최대 ${MAX_ROUTES}개까지 즐겨찾기할 수 있어요`);
  }
  store.addRoute(key, r);
}

// ---------- 렌더링 ----------

function render() {
  const c = cur;
  if (!c) return;
  const focusKey = document.activeElement?.dataset?.fkey;
  const saved = store.getStop(c.key);
  const isFav = !!saved;
  const { stop, ctx, result: r } = c;

  const meta = [stop.ars && `ARS ${stop.ars}`, ctx.cityName, ctx.distanceText].filter(Boolean).join(" · ");

  const head = h(
    "div",
    { class: "sheet-head" },
    h("h2", { id: "stop-sheet-title" }, stop.name || stop.nodeId),
    h("button", { class: "icon-btn", type: "button", "aria-label": "닫기", "data-fkey": "close", onclick: () => dlg.close() }, h("span", { "aria-hidden": "true" }, "✕"))
  );

  const favBtn = h(
    "button",
    {
      class: "btn" + (isFav ? "" : " primary"),
      type: "button",
      "aria-pressed": String(isFav),
      "data-fkey": "fav",
      onclick: toggleStop,
    },
    h("span", { "aria-hidden": "true" }, isFav ? "★ " : "☆ "),
    isFav ? "즐겨찾기한 정류장" : "정류장 즐겨찾기"
  );

  // 노선: 지금 도착 예정(시간순) + 전에 본 노선(knownRoutes)
  // 같은 routeId가 여러 건 오면(대구) 노선별로 묶어 첫 버스 + 다음 버스
  const { byId, list: arrivals } = groupByRoute(r?.items);
  const known = (saved?.knownRoutes || []).filter((k) => !byId.has(k.routeId));
  const favOnly = (saved?.routes || []).filter((k) => !byId.has(k.routeId) && !known.some((x) => x.routeId === k.routeId));
  const routes = [...arrivals, ...[...favOnly, ...known].sort((a, b) => a.routeNo.localeCompare(b.routeNo, "ko", { numeric: true }))];
  const labels = routeLabels(routes);
  const stale = !!r && (!!c.error || offline());

  const list = h(
    "ul",
    { class: "routes" + (stale ? " stale" : ""), "aria-label": "지나는 노선" },
    routes.map((x) => routeRow(x, byId.get(x.routeId), labels.get(x.routeId), isFav && saved.routes.some((f) => f.routeId === x.routeId)))
  );

  let note = null;
  if (c.loading && !r) note = "노선을 불러오는 중…";
  else if (r && !r.items.length) note = "지금 도착 예정인 버스가 없어요";
  else if (!r && offline()) note = "오프라인 — 도착 정보를 불러올 수 없어요";

  const body = [
    head,
    meta && h("p", { class: "sheet-meta" }, meta),
    favBtn,
    h("h3", { class: "sheet-h3" }, "지나는 노선"),
    h("p", { class: "hint" }, "지금 운행 중인 노선과 전에 본 노선만 보여요. 타는 노선의 ☆를 누르면 즐겨찾기에 저장돼요."),
    note && h("p", { class: "note" }, note),
    routes.length ? list : null,
    statusLine(c),
  ];
  bodyEl.replaceChildren(...body.filter(Boolean));
  if (focusKey) bodyEl.querySelector(`[data-fkey="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

function routeRow(route, arr, label, fav) {
  const no = route.routeNo || "?";
  const name = label ? `${no}번 ${label}` : `${no}번`;
  let eta;
  if (arr?.arrTime != null) {
    eta = h("span", { class: "eta", "data-due": cur.result.fetchedAt + arr.arrTime * 1000 });
    renderEta(eta, Date.now());
  } else {
    eta = h("span", { class: "eta none" }, cur.result ? "도착 정보 없음" : "—");
  }
  return h(
    "li",
    { class: "route" + (fav ? " fav" : "") },
    h(
      "span",
      { class: "route-id" },
      routeNoChip(route),
      label && h("span", { class: "route-tp" }, label)
    ),
    eta,
    arr?.prevStations != null && h("span", { class: "stations" }, `${arr.prevStations}정거장 전`),
    arr?.lowFloor && h("span", { class: "badge" }, "저상"),
    nextEta(arr, cur.result?.fetchedAt),
    h(
      "button",
      {
        class: "star",
        type: "button",
        "aria-pressed": String(fav),
        "aria-label": `${name} 즐겨찾기`,
        "data-fkey": `s:${route.routeId}`,
        onclick: () => toggleRoute(route),
      },
      h("span", { "aria-hidden": "true" }, fav ? "★" : "☆")
    )
  );
}

function tick() {
  if (!cur) return;
  const now = Date.now();
  for (const el of bodyEl.querySelectorAll(".eta[data-due]")) renderEta(el, now);
}

function statusLine(c) {
  const parts = [];
  if (c.loading) parts.push(h("span", null, c.result ? "업데이트 중…" : "불러오는 중…"));
  else if (c.result) parts.push(h("span", null, `${fmtClock(c.result.fetchedAt)} 갱신${c.error || offline() ? " · 이전 정보" : ""}`));
  const kind = c.error?.kind;
  if (c.error && !c.loading) parts.push(h("span", { class: "err" }, ERROR_TEXT[kind] || "업데이트 실패"));
  if (!NO_RETRY.has(kind)) {
    parts.push(
      h(
        "button",
        // 불러오는 중에도 포커스를 잃지 않게 비활성화하지 않는다 (load()가 중복을 막음)
        { class: "btn small", type: "button", "data-fkey": "reload", disabled: offline(), onclick: () => load(true) },
        c.error ? "다시 시도" : "새로고침"
      )
    );
  }
  return h("div", { class: "status" }, parts);
}
