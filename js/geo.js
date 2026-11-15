// 현재 위치 공유 모듈 (F-H8 거리순 정렬, F-W1 도보 소요시간 자동 추정)
//
// - 위치는 메모리에만 둔다. 저장하지도, 기기 밖으로 보내지도 않는다 (Worker에는 cityCode·nodeId만 간다).
// - Geolocation은 브라우저 API라 TAGO/Worker 호출 한도와 무관하다 — 이 모듈 때문에 도착 정보 호출이 늘지 않는다.
// - 요청은 한 번에 하나만 보내고(pending 공유) 결과를 구독자에게 알린다. 홈의 거리순 정렬과
//   도보 시간 추정이 같은 위치 값을 쓰므로 위치 요청이 중복되지 않는다.
// - 실패(권한 거부·시간 초과·미지원)는 오류가 아니다: 조용히 null로 두고 호출한 쪽이 폴백한다.
// - 오래된 위치로는 안내하지 않는다: 받은 지 GEO_STALE_MS가 지난 위치는 "위치 모름"과 같게 취급한다
//   (사용자가 그사이 움직였을 수 있다. 홈이 보이는 동안은 GEO_FRESH_MS 간격으로 다시 받아 둔다).
// - 권한 창을 거부하거나 그냥 무시하면 이 세션에서는 자동 요청을 멈춘다. 다시 쓰려면 지도 탭의
//   '내 위치' 버튼을 누르면 되고(사용자가 직접 요청한 것이라 권한 창이 떠도 괜찮다), 그때 받은
//   위치가 setPosition으로 공유되면서 차단도 풀린다.
import {
  WALK_SPEED_M_PER_MIN,
  WALK_DETOUR_FACTOR,
  WALK_MAX_M,
  GEO_TIMEOUT_MS,
  GEO_FRESH_MS,
  GEO_STALE_MS,
  GEO_RETRY_MS,
  GEO_MAX_FAILS,
} from "./config.js";

const listeners = new Set();
let pos = null; // { lat, lng, at }
let pending = null;
let failedAt = 0; // 마지막 실패 시각 (GEO_RETRY_MS 동안 다시 묻지 않는다)
let fails = 0; // 연속 실패 횟수
let blocked = false; // 이 세션 동안 자동 요청 중단 (거부·무시·연속 실패)

/** 위치를 받은 지 GEO_STALE_MS가 안 지났으면 true */
const fresh = (now = Date.now()) => !!pos && now - pos.at < GEO_STALE_MS;

/**
 * 지금 쓸 수 있는 현재 위치 {lat, lng} 또는 null.
 * 오래된 위치(GEO_STALE_MS 초과)는 null로 돌려준다 — 옛 위치로 거리·도보를 안내하지 않기 위함.
 */
export const getPosition = () => (fresh() ? { lat: pos.lat, lng: pos.lng } : null);

/** 위치가 바뀌면 호출된다. 해제 함수를 돌려준다 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const notify = () => {
  for (const fn of listeners) fn(getPosition());
};

/** 다른 화면(지도)이 받은 위치를 공유해 같은 값을 쓰게 한다. 자동 요청 차단도 함께 푼다 */
export function setPosition(p) {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
  pos = { lat: p.lat, lng: p.lng, at: Date.now() };
  blocked = false;
  failedAt = 0;
  fails = 0;
  notify();
}

/**
 * 권한 창이 뜬 채로 답이 없었거나(무시) 거부된 상태면 이 세션에서는 자동 요청을 멈춘다.
 * 권한이 이미 'granted'인데 시간만 초과한 것(실내 GPS 지연 등)은 차단하지 않고 재시도에 맡긴다.
 * Permissions API가 없는 브라우저(Safari 등)는 상태를 알 수 없으므로 안전하게 차단한다
 * — 권한 창이 반복해서 뜨는 쪽이 더 나쁘다. 지도의 '내 위치' 버튼으로 언제든 다시 쓸 수 있다.
 */
async function blockUnlessGranted() {
  let state = null;
  try {
    state = (await navigator.permissions?.query({ name: "geolocation" }))?.state ?? null;
  } catch {
    state = null;
  }
  if (state !== "granted") blocked = true;
}

/** 실패 처리: 재시도 간격을 두고, 연속 실패가 쌓이면 이 세션에서는 그만 묻는다 */
function fail(permissionDenied) {
  failedAt = Date.now();
  fails++;
  if (permissionDenied || fails >= GEO_MAX_FAILS) blocked = true;
}

/**
 * 현재 위치를 1회 요청한다. 실패해도 reject하지 않고 null로 끝난다 (에러 없이 폴백).
 * 최근 GEO_FRESH_MS 안에 받은 위치가 있으면 다시 묻지 않는다.
 * @returns {Promise<{lat:number,lng:number}|null>}
 */
export function ensurePosition() {
  const now = Date.now();
  if (pos && now - pos.at < GEO_FRESH_MS) return Promise.resolve(getPosition());
  if (pending) return pending;
  if (!navigator.geolocation) return Promise.resolve(getPosition());
  // 거부·무시당했으면 다시 묻지 않는다 (권한 창을 반복해서 띄우지 않게)
  if (blocked || (failedAt && now - failedAt < GEO_RETRY_MS)) return Promise.resolve(getPosition());

  pending = new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pending = null;
      resolve(value);
    };
    const timer = setTimeout(() => {
      // 시간 초과: 권한 창을 띄워 놓고 사용자가 답하지 않은 경우가 많다 → 세션 동안 자동 요청 중단
      fail(false);
      blockUnlessGranted();
      finish(getPosition()); // 아는 위치(없거나 오래됐으면 null)로 폴백
    }, GEO_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPosition({ lat: p.coords.latitude, lng: p.coords.longitude });
        if (done) return notify(); // 권한 창에 늦게 답한 경우: 구독자에게만 알린다
        finish(getPosition());
      },
      (e) => {
        fail(e?.code === 1); // 1 = PERMISSION_DENIED
        finish(getPosition());
      },
      { enableHighAccuracy: false, maximumAge: GEO_FRESH_MS, timeout: GEO_TIMEOUT_MS }
    );
  });
  return pending;
}

/** 두 지점 사이 직선거리(m). 경로 탐색이 아니라 단순 haversine */
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 현재 위치에서 정류장까지 직선거리(m). 위치나 좌표가 없으면 null */
export function distanceTo(stop, p = getPosition()) {
  if (!p || stop?.lat == null || stop?.lng == null) return null;
  return distanceM(p.lat, p.lng, stop.lat, stop.lng);
}

/**
 * 도보 소요시간 자동 추정(분, F-W1). 저장하지 않고 호출할 때마다 현재 위치로 다시 계산한다.
 * 직선거리 × 보정계수 ÷ 평균 도보 속도, 올림. 아주 가까우면 0분.
 * 위치가 없거나 너무 멀면(WALK_MAX_M 초과) null — 호출한 쪽은 도보 안내를 생략한다.
 */
export function walkMinutes(stop, p = getPosition()) {
  const d = distanceTo(stop, p);
  if (d == null || d > WALK_MAX_M) return null;
  return Math.ceil((d * WALK_DETOUR_FACTOR) / WALK_SPEED_M_PER_MIN);
}

/** 거리 표시 문구 (m / km) */
export const fmtDistance = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`);
