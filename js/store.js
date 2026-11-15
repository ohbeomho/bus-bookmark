// 즐겨찾기·설정 저장소 (localStorage). 스키마: PRD 8.1
// 정류장 식별 키: `${cityCode}:${nodeId}`, 노선 식별: routeId
import { MAX_STOPS, MAX_ROUTES, MAX_GROUPS } from "./config.js";

const FAV_KEY = "bus-bookmark:favorites";
const FAV_BACKUP_KEY = "bus-bookmark:favorites:backup";
const SETTINGS_KEY = "bus-bookmark:settings";
// v2 (PRD 8.1): 최상위 groups, routes[].groupId(선택) 추가.
// 도보 소요시간(F-W1)은 전부 자동 계산이라 저장 필드가 없다
export const SCHEMA_VERSION = 2;
const REFRESH_CHOICES = [0, 30, 60];

const listeners = new Set();
let data = null; // { version, groups: [...], stops: [...] }
let readOnly = false; // 더 새 버전 앱이 쓴 데이터: 보여주기만 하고 저장하지 않는다
let needsSave = false; // 구버전에서 변환했으니 다음 ensure() 때 한 번 저장한다 (v1 → v2)

export const stopKey = (s) => `${s.cityCode}:${s.nodeId}`;

// ---------- 정제 ----------
const str = (v, max = 100) => (v == null ? "" : String(v).trim().slice(0, max));
const num = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

function cleanRoute(r) {
  if (!r || typeof r !== "object") return null;
  const routeId = str(r.routeId ?? r.routeid, 40);
  if (!routeId) return null;
  const out = { routeId, routeNo: str(r.routeNo ?? r.routeno, 20) };
  // 선택 필드(PRD 8.1에 추가): 같은 번호 노선(제주 등) 구분 표시용. 예: "간선버스"
  const routeType = str(r.routeType ?? r.routetp, 20);
  if (routeType) out.routeType = routeType;
  // v2 선택 필드: 즐겨찾기 그룹(F-G1). 없는 그룹을 가리키면 pruneGroups가 뗀다
  const groupId = str(r.groupId, 40);
  if (groupId) out.groupId = groupId;
  return out;
}

function cleanGroups(list) {
  const out = [];
  const seen = new Set();
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || typeof g !== "object") continue;
    const id = str(g.id, 40);
    const name = str(g.name, 20);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}

/** 존재하지 않는 그룹을 가리키는 routes[].groupId를 뗀다 (그룹 미지정으로). 바뀐 게 있으면 true */
function pruneGroups(d) {
  const ids = new Set(d.groups.map((g) => g.id));
  let changed = false;
  for (const s of d.stops) {
    for (const r of s.routes) {
      if (r.groupId && !ids.has(r.groupId)) {
        delete r.groupId;
        changed = true;
      }
    }
  }
  return changed;
}

const newGroupId = (taken) => {
  let id;
  do {
    id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  } while (taken.has(id));
  return id;
};

/** 중복 제거 후 MAX_ROUTES개까지. keepLast면 뒤쪽(최근에 본 노선)을 남긴다 */
function cleanRoutes(list, keepLast = false) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    const c = cleanRoute(r);
    if (c && !seen.has(c.routeId)) {
      seen.add(c.routeId);
      out.push(c);
    }
  }
  return keepLast ? out.slice(-MAX_ROUTES) : out.slice(0, MAX_ROUTES);
}

function cleanStop(s, i) {
  if (!s || typeof s !== "object") return null;
  const nodeId = str(s.nodeId);
  const cityCode = num(s.cityCode);
  if (!/^[A-Za-z0-9]{1,30}$/.test(nodeId)) return null;
  if (!Number.isInteger(cityCode) || cityCode <= 0 || cityCode > 999999999) return null;
  // 좌표는 선택 값. 범위를 벗어나면 둘 다 버린다
  let lat = num(s.lat);
  let lng = num(s.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) lat = lng = null;
  return {
    nodeId,
    cityCode,
    name: str(s.name),
    alias: str(s.alias, 30),
    ars: str(s.ars, 20) === "0" ? "" : str(s.ars, 20), // ARS는 없을 수 있다 (제주 전부 빈 값, "0"도 결측)
    lat,
    lng,
    routes: cleanRoutes(s.routes),
    // knownRoutes는 "본 적 있는 노선" 목록일 뿐이라 그룹을 갖지 않는다
    knownRoutes: cleanRoutes(s.knownRoutes, true).map(({ groupId, ...k }) => k),
    order: Number.isFinite(num(s.order)) ? num(s.order) : i,
    collapsed: s.collapsed === true,
  };
}

// 어떤 입력이 와도 현재 버전 스키마로 만든다. 알 수 없는 정류장은 버린다.
// v1 → v2: groups: []를 채우고 기존 필드는 모두 보존한다 (PRD 8.1)
function migrate(raw) {
  let stops;
  if (Array.isArray(raw)) stops = raw; // 버전 필드 없던 배열 형태(가정된 v0)
  else if (raw && typeof raw === "object" && Array.isArray(raw.stops)) stops = raw.stops;
  else stops = [];
  const groups = cleanGroups(raw && typeof raw === "object" ? raw.groups : null);

  const seen = new Set();
  const out = [];
  stops.forEach((s, i) => {
    const c = cleanStop(s, i);
    if (c && !seen.has(stopKey(c))) {
      seen.add(stopKey(c));
      out.push(c);
    }
  });
  out.sort((a, b) => a.order - b.order);
  if (out.length > MAX_STOPS) {
    console.warn(`[store] 정류장 ${out.length}곳 중 앞의 ${MAX_STOPS}곳만 남깁니다 (원본은 백업).`);
    out.length = MAX_STOPS;
  }
  out.forEach((s, i) => (s.order = i));
  const result = { version: SCHEMA_VERSION, groups, stops: out };
  pruneGroups(result); // 없는 그룹을 가리키는 groupId 정리
  return { ...result, truncated: stops.length > MAX_STOPS };
}

/**
 * 원본을 백업한다. 기존 백업은 덮어쓰지 않는다:
 * 비어 있으면 `…:backup`, 같은 내용이면 건너뛰고, 다르면 `…:backup:<시각>` 키에 저장.
 */
function backupRaw(raw) {
  try {
    if (localStorage.getItem(FAV_BACKUP_KEY) == null) return localStorage.setItem(FAV_BACKUP_KEY, raw);
    // 같은 원본이 이미 어느 백업에 있으면 건너뛴다 (다시 열 때마다 쌓이지 않게)
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(FAV_BACKUP_KEY) && localStorage.getItem(k) === raw) return;
    }
    localStorage.setItem(`${FAV_BACKUP_KEY}:${new Date().toISOString()}`, raw);
  } catch {
    /* 저장 공간 부족 등은 무시 */
  }
}

function load() {
  readOnly = false;
  needsSave = false;
  let raw = null;
  try {
    raw = localStorage.getItem(FAV_KEY);
  } catch {
    // 개인정보 보호 모드 등 localStorage 사용 불가
  }
  if (raw == null) return { version: SCHEMA_VERSION, groups: [], stops: [] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[store] 즐겨찾기 JSON이 손상되어 백업 후 초기화합니다.");
    backupRaw(raw);
    return { version: SCHEMA_VERSION, groups: [], stops: [] };
  }

  const ver = parsed && typeof parsed === "object" ? parsed.version : undefined;
  const { truncated, ...result } = migrate(parsed);
  if (typeof ver === "number" && ver > SCHEMA_VERSION) {
    // 더 최신 앱이 쓴 데이터: 낮춰서 변환·저장하지 않는다. 읽을 수 있는 만큼만 보여주고 읽기 전용
    console.warn(`[store] 스키마 버전 ${ver}은 이 앱(${SCHEMA_VERSION})보다 새 버전입니다. 읽기 전용으로 엽니다.`);
    readOnly = true;
    backupRaw(raw);
  } else if (ver !== SCHEMA_VERSION || truncated) {
    // 구버전 데이터 또는 상한 초과: 원본을 남기고 현재 스키마로 변환해 다시 저장한다
    if (ver !== SCHEMA_VERSION) console.warn(`[store] 스키마 버전 ${ver} → ${SCHEMA_VERSION} 변환 (원본은 백업)`);
    backupRaw(raw);
    needsSave = true;
  }
  return result;
}

function save() {
  if (readOnly) return false;
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.warn("[store] 저장 실패", e);
    return false;
  }
}

function ensure() {
  if (!data) {
    data = load();
    // 구버전(v1 등)에서 올라온 데이터는 바로 현재 스키마로 저장해 둔다 (PRD 8.1 v1 → v2)
    if (needsSave) {
      needsSave = false;
      save();
    }
  }
  return data;
}

function commit() {
  const ok = save();
  for (const fn of listeners) fn();
  return ok;
}

const find = (key) => ensure().stops.find((s) => stopKey(s) === key);
/** 쓰기용 조회: 읽기 전용이면 undefined */
const findW = (key) => (writable() ? find(key) : undefined);
const writable = () => (ensure(), !readOnly);

// ---------- 공개 API ----------
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 정렬된 정류장 목록 (복사본) */
export function getStops() {
  return structuredClone(ensure().stops);
}

export function getStop(key) {
  const s = find(key);
  return s ? structuredClone(s) : null;
}

export function hasStop(key) {
  return !!find(key);
}

/** 읽기 전용(더 새 버전 앱의 데이터)이면 true. UI는 변경 기능을 막고 안내한다 */
export const isReadOnly = () => (ensure(), readOnly);

/** 정류장을 더 추가할 수 없으면 true (MAX_STOPS) */
export const isFull = () => ensure().stops.length >= MAX_STOPS;

/** 추가 실패 이유별 안내 문구 (tryAddStop의 reason) */
export const ADD_STOP_MESSAGES = {
  full: `정류장은 최대 ${MAX_STOPS}곳까지 즐겨찾기할 수 있어요. 안 쓰는 정류장을 지운 뒤 다시 추가해 주세요.`,
  exists: "이미 즐겨찾기한 정류장이에요",
  invalid: "정류장 정보가 올바르지 않아요",
  readonly: "새 버전 앱에서 저장한 데이터라 이 화면에서는 바꿀 수 없어요",
  storage: "저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요",
};

/**
 * 정류장 추가.
 * @returns {{ok: true} | {ok: false, reason: "full"|"exists"|"invalid"|"readonly"|"storage"}}
 */
export function tryAddStop(stop) {
  if (!writable()) return { ok: false, reason: "readonly" };
  const d = ensure();
  const c = cleanStop({ ...stop, order: d.stops.length }, d.stops.length);
  if (!c) return { ok: false, reason: "invalid" };
  if (find(stopKey(c))) return { ok: false, reason: "exists" };
  if (d.stops.length >= MAX_STOPS) return { ok: false, reason: "full" };
  d.stops.push(c);
  pruneGroups(d); // 바깥에서 넘어온 groupId가 없는 그룹을 가리키면 뗀다
  return commit() ? { ok: true } : { ok: false, reason: "storage" };
}

/** 정류장 추가. 성공하면 true (이유가 필요하면 tryAddStop) */
export const addStop = (stop) => tryAddStop(stop).ok;

export function removeStop(key) {
  if (!writable()) return false;
  const d = ensure();
  const before = d.stops.length;
  d.stops = d.stops.filter((s) => stopKey(s) !== key);
  if (d.stops.length === before) return false;
  d.stops.forEach((s, i) => (s.order = i));
  return commit();
}

/** 순서 이동: delta -1 = 위로, +1 = 아래로 */
export function moveStop(key, delta) {
  if (!writable()) return false;
  const d = ensure();
  const i = d.stops.findIndex((s) => stopKey(s) === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= d.stops.length) return false;
  [d.stops[i], d.stops[j]] = [d.stops[j], d.stops[i]];
  d.stops.forEach((s, k) => (s.order = k));
  return commit();
}

/** 키 배열 순서대로 재배치 (드래그 정렬용) */
export function reorderStops(keys) {
  if (!writable()) return false;
  const d = ensure();
  const rank = new Map(keys.map((k, i) => [k, i]));
  d.stops.sort((a, b) => (rank.get(stopKey(a)) ?? 1e9) - (rank.get(stopKey(b)) ?? 1e9));
  d.stops.forEach((s, i) => (s.order = i));
  return commit();
}

export function setAlias(key, alias) {
  const s = findW(key);
  if (!s) return false;
  s.alias = str(alias, 30);
  return commit();
}

export function setCollapsed(key, collapsed) {
  const s = findW(key);
  if (!s || s.collapsed === !!collapsed) return false;
  s.collapsed = !!collapsed;
  return commit();
}

export function isFavoriteRoute(key, routeId) {
  return !!find(key)?.routes.some((r) => r.routeId === routeId);
}

export function addRoute(key, route) {
  const s = findW(key);
  const r = cleanRoute(route);
  if (!s || !r || s.routes.length >= MAX_ROUTES || s.routes.some((x) => x.routeId === r.routeId)) return false;
  if (r.groupId && !ensure().groups.some((g) => g.id === r.groupId)) delete r.groupId;
  s.routes.push(r);
  if (!s.knownRoutes.some((x) => x.routeId === r.routeId)) {
    // 같은 객체를 공유하면 나중에 붙는 groupId가 knownRoutes에도 묻으므로 복사본을 넣는다
    const { groupId, ...known } = r;
    s.knownRoutes.push(known);
    if (s.knownRoutes.length > MAX_ROUTES) s.knownRoutes = s.knownRoutes.slice(-MAX_ROUTES);
  }
  return commit();
}

export function removeRoute(key, routeId) {
  const s = findW(key);
  if (!s) return false;
  const before = s.routes.length;
  s.routes = s.routes.filter((r) => r.routeId !== routeId);
  return s.routes.length !== before && commit();
}

// ---------- 즐겨찾기 그룹 (F-G1, PRD 8.1 v2) ----------

/** 그룹 목록 (복사본). 그룹이 없으면 빈 배열 */
export function getGroups() {
  return ensure().groups.map((g) => ({ ...g }));
}

export const getGroup = (id) => ensure().groups.find((g) => g.id === id) || null;

/** 그룹을 더 만들 수 없으면 true (MAX_GROUPS) */
export const isGroupsFull = () => ensure().groups.length >= MAX_GROUPS;

export const GROUP_MESSAGES = {
  full: `그룹은 최대 ${MAX_GROUPS}개까지 만들 수 있어요`,
  invalid: "그룹 이름을 입력해 주세요",
  exists: "같은 이름의 그룹이 이미 있어요",
  readonly: ADD_STOP_MESSAGES.readonly,
  storage: "저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요",
};

/**
 * 그룹 만들기.
 * @returns {{ok: true, id: string} | {ok: false, reason: "full"|"invalid"|"exists"|"readonly"|"storage"}}
 */
export function addGroup(name) {
  if (!writable()) return { ok: false, reason: "readonly" };
  const d = ensure();
  const n = str(name, 20);
  if (!n) return { ok: false, reason: "invalid" };
  if (d.groups.some((g) => g.name === n)) return { ok: false, reason: "exists" };
  if (d.groups.length >= MAX_GROUPS) return { ok: false, reason: "full" };
  const id = newGroupId(new Set(d.groups.map((g) => g.id)));
  d.groups.push({ id, name: n });
  return commit() ? { ok: true, id } : { ok: false, reason: "storage" };
}

/** 그룹 이름 바꾸기 */
export function renameGroup(id, name) {
  if (!writable()) return { ok: false, reason: "readonly" };
  const d = ensure();
  const g = d.groups.find((x) => x.id === id);
  const n = str(name, 20);
  if (!g) return { ok: false, reason: "invalid" };
  if (!n) return { ok: false, reason: "invalid" };
  if (d.groups.some((x) => x.id !== id && x.name === n)) return { ok: false, reason: "exists" };
  if (g.name === n) return { ok: true, id };
  g.name = n;
  return commit() ? { ok: true, id } : { ok: false, reason: "storage" };
}

/** 그룹 삭제. 그 그룹을 가리키던 routes[].groupId는 모두 떼어낸다 (그룹 미지정으로) */
export function removeGroup(id) {
  if (!writable()) return false;
  const d = ensure();
  const before = d.groups.length;
  d.groups = d.groups.filter((g) => g.id !== id);
  if (d.groups.length === before) return false;
  pruneGroups(d);
  return commit();
}

/** 즐겨찾기 노선의 그룹 지정·해제. groupId가 null/빈 값이면 해제 */
export function setRouteGroup(key, routeId, groupId) {
  const s = findW(key);
  const r = s?.routes.find((x) => x.routeId === routeId);
  if (!r) return false;
  const id = str(groupId, 40);
  if (id && !ensure().groups.some((g) => g.id === id)) return false;
  if ((r.groupId || "") === id) return true;
  if (id) r.groupId = id;
  else delete r.groupId;
  return commit();
}

function syncRoute(target, r) {
  let changed = false;
  for (const f of ["routeNo", "routeType"]) {
    if (r[f] && target[f] !== r[f]) {
      target[f] = r[f];
      changed = true;
    }
  }
  return changed;
}

/**
 * 도착 정보 응답으로 knownRoutes 누적, 노선번호·정류장명 갱신.
 * 바뀐 게 있을 때만 저장한다. items: api.js 정규화 결과
 */
export function updateFromArrivals(key, items, nodeName) {
  const s = findW(key);
  if (!s) return false;
  let changed = false;
  for (const it of items) {
    const r = cleanRoute(it);
    if (!r) continue;
    const known = s.knownRoutes.find((x) => x.routeId === r.routeId);
    if (!known) {
      s.knownRoutes.push(r);
      changed = true;
    } else changed = syncRoute(known, r) || changed;
    const fav = s.routes.find((x) => x.routeId === r.routeId);
    if (fav) changed = syncRoute(fav, r) || changed;
  }
  if (s.knownRoutes.length > MAX_ROUTES) s.knownRoutes = s.knownRoutes.slice(-MAX_ROUTES);
  if (!s.name && nodeName) {
    s.name = str(nodeName);
    changed = true;
  }
  return changed && commit();
}

// ---------- 설정 ----------
const DEFAULT_SETTINGS = { version: 1, refreshSec: 30 };

export function getSettings() {
  try {
    const p = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    const refreshSec = REFRESH_CHOICES.includes(p?.refreshSec) ? p.refreshSec : DEFAULT_SETTINGS.refreshSec;
    return { ...DEFAULT_SETTINGS, refreshSec };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  if (!REFRESH_CHOICES.includes(next.refreshSec)) next.refreshSec = DEFAULT_SETTINGS.refreshSec;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* 무시 */
  }
  for (const fn of listeners) fn();
  return next;
}

// 다른 탭에서 바뀌면 다시 읽기
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === FAV_KEY || e.key === SETTINGS_KEY || e.key === null) {
      data = null;
      for (const fn of listeners) fn();
    }
  });
}
