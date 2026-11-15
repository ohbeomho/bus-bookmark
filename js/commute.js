// 출근 무지각 체크인 저장소 (F-CM1~F-CM4, PRD 4.6)
//
// 버스 즐겨찾기(js/store.js)와는 **완전히 다른 도메인**이라 모듈도 localStorage 키도 따로 둔다.
//  - 키: "bus-bookmark:commute" (즐겨찾기 키와 섞이지 않는다)
//  - 네트워크 호출이 전혀 없다: Date와 localStorage만 쓴다. TAGO/Worker/Open-Meteo 호출 예산과 무관하다.
//  - 손상된 데이터는 **조용히 기본값으로 리셋**한다. 즐겨찾기처럼 백업을 남기지 않는다
//    (잃어도 치명적이지 않은 기록이고, 백업 규칙이 늘면 오히려 잃기 쉬운 쪽의 코드가 복잡해진다).
//    대신 JSON.parse 실패나 이상한 값이 앱을 죽이지 않게 모든 읽기를 한 번 정제한다.
//  - 하루 한 번만 판정한다: lastResultDate가 오늘이면 그날 결과를 보여 주고 버튼을 막는다.
//  - **앱을 안 연 날은 평가하지 않는다** (자동 지각 처리 없음, PRD 4.6의 의도된 단순화).
//    history도 같은 규칙이다: 기록한 날만 들어가므로 "최근 5개"는 달력 5일이 아니라 기록 5건이다.

const KEY = "bus-bookmark:commute";
export const COMMUTE_VERSION = 1;
const HISTORY_MAX = 30; // 저장 상한 (화면에는 최근 5개만 쓰지만 몇 주치는 남겨 둔다)
export const HISTORY_SHOW = 5; // 홈에서 동그라미로 보여 줄 개수 (F-CM4)

const RESULTS = new Set(["ontime", "late", "off"]);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // "HH:MM" (24시간)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // 로컬 날짜 "YYYY-MM-DD"
const MAX_STREAK = 100000; // 말이 안 되는 큰 값이 들어와도 화면이 깨지지 않게

const listeners = new Set();
let data = null;

const pad = (n) => String(n).padStart(2, "0");

/** 로컬 기준 오늘 날짜 "YYYY-MM-DD" (UTC로 바꾸지 않는다: 자정 경계가 사용자 시계와 같아야 한다) */
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 로컬 기준 현재 시각 "HH:MM" */
export const timeKey = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "HH:MM" → 자정부터의 분. 형식이 아니면 null */
export function minutesOf(hhmm) {
  if (!TIME_RE.test(String(hhmm || ""))) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

const defaults = () => ({
  version: COMMUTE_VERSION,
  targetTime: null,
  streak: 0,
  lastResultDate: null,
  lastResult: null,
  // 선택 필드: 탑승 완료를 누른 시각 "HH:MM". 그날 결과 문구("오늘 08:12에 탑승 완료…")에만 쓰고,
  // 없으면 시각 없는 문구로 떨어진다 (옛 데이터·쉬는 날은 null)
  lastResultTime: null,
  // 기록이 있는 날만 날짜 오름차순으로. 화면(F-CM4)은 뒤에서 5개를 최신순으로 쓴다
  history: [],
});

/** history 정제: 형식이 맞는 항목만, 날짜당 하나, 오름차순, 뒤에서 HISTORY_MAX개 */
function cleanHistory(list) {
  const byDate = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== "object") continue;
    const date = String(e.date || "");
    const result = String(e.result || "");
    if (!DATE_RE.test(date) || !RESULTS.has(result)) continue;
    byDate.set(date, { date, result }); // 같은 날짜가 여러 번이면 마지막 것
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(-HISTORY_MAX);
}

/** 어떤 입력이 와도 현재 스키마로 만든다 (이상한 값은 조용히 버린다) */
function clean(raw) {
  const out = defaults();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

  if (TIME_RE.test(String(raw.targetTime || ""))) out.targetTime = String(raw.targetTime);

  const streak = Number(raw.streak);
  out.streak = Number.isFinite(streak) && streak > 0 ? Math.min(Math.floor(streak), MAX_STREAK) : 0;

  const date = String(raw.lastResultDate || "");
  const result = String(raw.lastResult || "");
  // 날짜와 결과는 짝이다. 한쪽만 있으면 그날 기록이 없는 것으로 본다
  if (DATE_RE.test(date) && RESULTS.has(result)) {
    out.lastResultDate = date;
    out.lastResult = result;
    if (result !== "off" && TIME_RE.test(String(raw.lastResultTime || ""))) {
      out.lastResultTime = String(raw.lastResultTime);
    }
  }

  out.history = cleanHistory(raw.history);
  // 마지막 기록이 history에 빠져 있으면(옛 데이터·부분 손상) 채워 둔다
  if (out.lastResultDate && !out.history.some((e) => e.date === out.lastResultDate)) {
    out.history = cleanHistory([...out.history, { date: out.lastResultDate, result: out.lastResult }]);
  }
  return out;
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return defaults(); // 개인정보 보호 모드 등 localStorage 사용 불가
  }
  if (raw == null) return defaults();
  try {
    return clean(JSON.parse(raw));
  } catch {
    return defaults(); // 손상된 JSON: 조용히 기본값 (앱이 죽지 않는 것이 중요)
  }
}

function ensure() {
  if (!data) data = load();
  return data;
}

function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* 저장 공간 부족 등: 이번 세션 화면에는 반영되지만 다음에 열면 없다 (치명적이지 않다) */
  }
  for (const fn of listeners) fn();
}

// 다른 탭에서 바뀌면 다시 읽어 알린다 (설정 탭과 홈이 다른 창에 열려 있을 수 있다)
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== KEY) return;
    data = load();
    for (const fn of listeners) fn();
  });
}

// ---------- 공개 API ----------

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 현재 상태 (복사본) */
export const getCommute = () => {
  const d = ensure();
  return { ...d, history: d.history.map((e) => ({ ...e })) };
};

/** 최근 기록 n개를 **최신순**으로 (F-CM4의 동그라미). 기록이 있는 날만 들어 있다 */
export const recentHistory = (n = HISTORY_SHOW) => ensure().history.slice(-n).reverse().map((e) => ({ ...e }));

/** 목표 시간이 설정돼 있으면 true. 아니면 체크인 UI 자체를 보여 주지 않는다 (F-CM1) */
export const isEnabled = () => !!ensure().targetTime;

/**
 * 출근 목표 시간 설정 (F-CM1). "HH:MM" 또는 null(해제).
 * 해제해도 기록(streak·그날 결과)은 지우지 않는다 — 다시 설정하면 이어서 센다.
 * @returns 저장했으면 true
 */
export function setTargetTime(value) {
  const d = ensure();
  const next = value == null || value === "" ? null : TIME_RE.test(String(value)) ? String(value) : undefined;
  if (next === undefined) return false; // 형식이 아닌 입력은 무시
  if (d.targetTime === next) return true;
  d.targetTime = next;
  commit();
  return true;
}

/**
 * 그날의 판정을 기록한다 (탑승 완료·쉬는 날 공통). history에도 같은 항목을 쌓고 HISTORY_MAX개로 자른다.
 * 하루 한 번만 불리지만, 같은 날짜가 또 들어와도 history에 중복으로 쌓이지 않게 한 번 더 막는다.
 */
function record(d, date, result, time) {
  d.lastResultDate = date;
  d.lastResult = result;
  d.lastResultTime = time;
  d.history = d.history.filter((e) => e.date !== date);
  d.history.push({ date, result });
  if (d.history.length > HISTORY_MAX) d.history = d.history.slice(-HISTORY_MAX);
}

/** 오늘(로컬) 이미 기록했으면 { result, time } , 없으면 null */
export function todayResult(now = new Date()) {
  const d = ensure();
  if (!d.lastResultDate || d.lastResultDate !== dateKey(now)) return null;
  return { result: d.lastResult, time: d.lastResultTime };
}

/**
 * 탑승 완료 (F-CM2). 누른 **그 순간의 시각**을 목표 시간과 비교한다.
 *  - 목표 시간 이하 → "무지각", streak += 1
 *  - 넘으면        → "지각", streak = 0
 * 오늘 이미 기록이 있으면 아무것도 바꾸지 않는다 (하루 한 번).
 * @returns { ok, reason?, result?, time?, streak? }
 */
export function checkIn(now = new Date()) {
  const d = ensure();
  if (!d.targetTime) return { ok: false, reason: "no_target" };
  if (todayResult(now)) return { ok: false, reason: "done" };
  const time = timeKey(now);
  const ontime = minutesOf(time) <= minutesOf(d.targetTime);
  record(d, dateKey(now), ontime ? "ontime" : "late", time);
  d.streak = ontime ? Math.min(d.streak + 1, MAX_STREAK) : 0;
  commit();
  return { ok: true, result: d.lastResult, time, streak: d.streak };
}

/**
 * 오늘은 쉬는 날 (F-CM3). 그날을 "쉬는 날"로 기록하되 **연속 일수는 그대로 둔다**
 * (늘리지도, 0으로 되돌리지도 않는다).
 */
export function markDayOff(now = new Date()) {
  const d = ensure();
  if (!d.targetTime) return { ok: false, reason: "no_target" };
  if (todayResult(now)) return { ok: false, reason: "done" };
  record(d, dateKey(now), "off", null);
  commit(); // streak은 건드리지 않는다
  return { ok: true, result: "off", streak: d.streak };
}
