// 도착 정보 API (PRD 8.2). Worker(/arrivals)만 호출한다. 서비스키 관련 코드는 없다.
import { WORKER_URL, REQUEST_TIMEOUT_MS, RETRY_DELAY_MS, MIN_GAP_MS, MAX_CONCURRENT_REQUESTS } from "./config.js";

/**
 * kind (retryable = 1회 재시도 대상):
 *  origin        403 허용 출처 문제 (개발자 설정)
 *  bad_request   400 잘못된 정류장 정보
 *  rate_limited  429 Worker의 IP당 호출 제한
 *  upstream_auth 502 {"error":"upstream_auth"} 서비스키 문제 (Worker 설정)
 *  quota         503 {"error":"quota"} 또는 TAGO resultCode "22": 하루 한도 초과
 *  upstream      그 밖의 비 2xx. 5xx(502 upstream_failed, 522 등)만 retryable
 *  network       네트워크 오류·오프라인 (retryable)
 *  timeout       8초 초과 (retryable)
 *  parse         본문이 JSON이 아님. "<"로 시작하는 XML 게이트웨이 오류는 재시도 안 함
 *  api           그 밖의 TAGO resultCode !== "00"
 */
export class ArrivalsError extends Error {
  constructor(kind, message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = "ArrivalsError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

const QUOTA_CODE = "22"; // LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR

/** TAGO 응답 → 정렬된 도착 목록. item이 배열/객체/빈 문자열 어느 형태든 배열로 만든다. */
export function normalizeArrivals(json) {
  const resp = json?.response;
  const code = resp?.header?.resultCode;
  if (code === QUOTA_CODE) throw new ArrivalsError("quota", "TAGO 하루 호출 한도 초과");
  if (code !== "00") {
    throw new ArrivalsError("api", `TAGO 오류 ${code ?? "?"}: ${resp?.header?.resultMsg ?? "응답 형식 오류"}`);
  }
  const it = resp?.body?.items?.item; // items가 ""이면 undefined
  const list = it == null ? [] : Array.isArray(it) ? it : [it];

  let nodeName = "";
  const items = [];
  for (const x of list) {
    if (!x || typeof x !== "object" || x.routeid == null) continue;
    const arrTime = Number(x.arrtime);
    if (!nodeName && x.nodenm) nodeName = String(x.nodenm);
    items.push({
      routeId: String(x.routeid),
      routeNo: String(x.routeno ?? ""), // 숫자로 오므로 항상 문자열로
      routeType: String(x.routetp ?? ""),
      arrTime: Number.isFinite(arrTime) ? arrTime : null, // 초
      prevStations: Number.isFinite(Number(x.arrprevstationcnt)) ? Number(x.arrprevstationcnt) : null,
      lowFloor: String(x.vehicletp ?? "").includes("저상"),
    });
  }
  // 응답 순서가 arrtime 순이 아니므로 정렬 (시간 없는 항목은 뒤로)
  items.sort((a, b) => (a.arrTime ?? Infinity) - (b.arrTime ?? Infinity));
  return { items, nodeName };
}

/** Worker 오류 본문 {"error":"..."}의 코드. 평문·빈 본문이면 "" */
function errorCode(text) {
  try {
    const e = JSON.parse(text)?.error;
    return typeof e === "string" ? e : "";
  } catch {
    return "";
  }
}

/** 비 2xx 응답 → ArrivalsError. 지금 Worker(403/400/502)와 새 Worker(429/502 upstream_auth/503 quota) 모두 처리 */
function httpError(status, text) {
  const code = errorCode(text);
  if (status === 403) {
    console.error(
      `[api] 403 Forbidden: 현재 출처(${location.origin})가 Worker ALLOWED_ORIGINS에 없습니다. ` +
        "로컬은 http://localhost:5500 에서 실행하세요."
    );
    return new ArrivalsError("origin", "허용되지 않은 출처", { status });
  }
  if (status === 400) return new ArrivalsError("bad_request", "잘못된 정류장 정보", { status });
  if (status === 429) return new ArrivalsError("rate_limited", "요청이 너무 많음", { status });
  if (code === "upstream_auth") {
    console.error("[api] 502 upstream_auth: Worker의 서비스키 문제입니다 (Worker Secret의 키·활용신청 상태 확인).");
    return new ArrivalsError("upstream_auth", "서비스키 문제", { status });
  }
  if (code === "quota") return new ArrivalsError("quota", "TAGO 하루 호출 한도 초과", { status });
  // 5xx(502 upstream_failed, 522 등 에지 오류)만 재시도. 404 등은 재시도해도 같은 결과
  return new ArrivalsError("upstream", `HTTP ${status}`, { status, retryable: status >= 500 });
}

// ---------- 동시 요청 상한 (모든 호출 경로 공통) ----------
let running = 0;
const waiting = [];
async function withSlot(fn) {
  if (running >= MAX_CONCURRENT_REQUESTS) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function requestOnce(cityCode, nodeId) {
  const url = `${WORKER_URL}/arrivals?cityCode=${encodeURIComponent(cityCode)}&nodeId=${encodeURIComponent(nodeId)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(url, { signal: ctrl.signal, cache: "no-store", credentials: "omit" });
    text = await res.text(); // 본문 읽기까지 타임아웃에 포함
  } catch (e) {
    if (e?.name === "AbortError") throw new ArrivalsError("timeout", "응답 시간 초과", { retryable: true });
    throw new ArrivalsError("network", "네트워크 오류", { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw httpError(res.status, text);

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const body = text.trimStart();
    // 200인데 XML(공공데이터포털 게이트웨이 오류): 다시 보내도 같은 결과라 재시도 안 함
    if (body.startsWith("<")) {
      if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS|ReasonCode>\s*22\s*</.test(body)) {
        throw new ArrivalsError("quota", "TAGO 하루 호출 한도 초과", { status: res.status });
      }
      throw new ArrivalsError("parse", "XML 오류 응답", { status: res.status });
    }
    throw new ArrivalsError("parse", "JSON이 아닌 응답", { status: res.status, retryable: true });
  }
  return normalizeArrivals(json);
}

const inflight = new Map(); // key → Promise
const lastStart = new Map(); // key → ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (cityCode, nodeId) => withSlot(() => requestOnce(cityCode, nodeId));

/**
 * 정류장 도착 정보 조회.
 * - 같은 정류장 요청이 진행 중이면 그 Promise를 공유한다.
 * - 같은 정류장을 10초 안에 다시 부르면 호출하지 않고 null을 돌려준다 (중복 무시).
 * - 일시 오류(네트워크·타임아웃·5xx·XML이 아닌 비 JSON)는 1회 재시도한다.
 * - 동시에 나가는 요청은 MAX_CONCURRENT_REQUESTS건까지 (나머지는 대기).
 * @returns {Promise<{items: Array, nodeName: string, fetchedAt: number} | null>}
 */
export function fetchArrivals(cityCode, nodeId) {
  const key = `${cityCode}:${nodeId}`;
  if (inflight.has(key)) return inflight.get(key);
  const now = Date.now();
  if (now - (lastStart.get(key) ?? -Infinity) < MIN_GAP_MS) return Promise.resolve(null);
  lastStart.set(key, now);

  const p = (async () => {
    try {
      return { ...(await once(cityCode, nodeId)), fetchedAt: Date.now() };
    } catch (e) {
      if (!(e instanceof ArrivalsError) || !e.retryable || navigator.onLine === false) throw e;
      await sleep(RETRY_DELAY_MS);
      return { ...(await once(cityCode, nodeId)), fetchedAt: Date.now() };
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

/** 마지막 호출 시작 시각 (스케줄러가 참고) */
export const lastRequestAt = (cityCode, nodeId) => lastStart.get(`${cityCode}:${nodeId}`) ?? 0;
