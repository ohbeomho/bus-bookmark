// 버스 도착정보 프록시 (Cloudflare Workers)
// - 서비스키는 코드에 넣지 않고, Cloudflare Secret(SERVICE_KEY, 공공데이터포털 Decoding 키)에 저장합니다.
// - 허용 출처는 wrangler.jsonc의 vars.ALLOWED_ORIGINS(쉼표 구분)에서 읽습니다.
// - 프론트엔드 호출 예: https://<워커주소>/arrivals?cityCode=39&nodeId=JEB405000001
// - 제주 전용(cityCode 39, nodeId "JEB"+숫자 9자리)만 받는다. 그 밖의 입력은 업스트림을 부르지 않고 400 —
//   존재하지 않는 정류장 ID로 TAGO 하루 한도(모든 사용자 공유)를 쓰는 것을 줄인다

const API_URL =
  "https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList";

const JEJU_CITY_CODE = "39";
const JEJU_NODE_RE = /^JEB\d{9}$/; // data/tiles의 제주 정류장 4,352개가 모두 이 형식

const UPSTREAM_TIMEOUT_MS = 6000; // 클라이언트 타임아웃(8초)보다 짧게
const CACHE_TTL_MS = 15000;
const CACHE_MAX_ENTRIES = 500;

// 모듈 범위 캐시: 같은 isolate 안에서만 공유됨 (isolate가 바뀌면 비어 있을 수 있음)
const cache = new Map(); // key -> { body, expires }  (Map은 삽입 순서 유지 -> 오래된 것부터 삭제)
const inflight = new Map(); // key -> { promise: Promise<{ status, body, cacheable }>, started }
const INFLIGHT_MAX_AGE_MS = 7000; // 이보다 오래된 공유 항목은 무시하고 지움
const FAILED_RESULT = { status: 502, body: JSON.stringify({ error: "upstream_failed" }), cacheable: false };

// IPv6는 /64(앞 4개 hextet)로 묶어서 rate limit 키로 쓴다. IPv4와 알 수 없는 형식은 그대로 쓴다.
export function rateLimitKey(ip) {
  if (!ip || !ip.includes(":")) return ip || "unknown";
  let addr = ip.split("%")[0].toLowerCase();
  // 끝이 IPv4 표기(::ffff:1.2.3.4)면 hextet 두 개로 바꾼다
  const m = addr.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m && m[1] === "::ffff:") return m.slice(2).join("."); // IPv4-mapped는 IPv4로
  if (m) {
    const [a, b, c, d] = m.slice(2).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return ip;
    addr = m[1] + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return ip;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function parseAllowedOrigins(env) {
  // vars가 없거나 비어 있으면 빈 목록 = 모두 거부
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function jsonError(status, error, headers) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.body;
}

function cacheSet(key, body) {
  cache.delete(key);
  cache.set(key, { body, expires: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

const KEY_ERROR_RE = /SERVICE[ _]?KEY/i;
const QUOTA_RE = /LIMITED_NUMBER_OF_SERVICE_REQUESTS|REQUEST[ _]?LIMIT|TRAFFIC[ _]EXCEEDED/i;

// 업스트림을 호출하고 { status, body, cacheable } 로 정리한다. 예외 메시지·URL은 절대 밖으로 내보내지 않는다.
async function callUpstream(env, cityCode, nodeId) {
  const failed = FAILED_RESULT;
  const auth = { status: 502, body: JSON.stringify({ error: "upstream_auth" }), cacheable: false };
  const quota = { status: 503, body: JSON.stringify({ error: "quota" }), cacheable: false, retryAfter: "600" };

  if (!env.SERVICE_KEY) return auth;

  // SERVICE_KEY에는 'Decoding' 키를 저장 (URLSearchParams가 인코딩해 줌)
  const params = new URLSearchParams({
    serviceKey: env.SERVICE_KEY,
    cityCode,
    nodeId,
    numOfRows: "100",
    _type: "json",
  });
  // 업스트림 주소는 고정한다. 환경변수로 바꿀 수 있게 하면 서비스키가 다른 주소로 나갈 수 있다.
  const base = API_URL;

  let res, text;
  try {
    res = await fetch(`${base}?${params}`, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    text = await res.text();
  } catch (e) {
    return failed; // 타임아웃·네트워크 오류 (e.message에는 URL이 들어갈 수 있어 사용하지 않음)
  }

  if (res.status === 401 || res.status === 403) return auth;
  if (res.status === 429) return quota;

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // JSON이 아님 (공공데이터포털은 키·한도 오류를 HTTP 200 XML로 주기도 함)
  }

  if (json === null || typeof json !== "object") {
    if (QUOTA_RE.test(text)) return quota;
    if (KEY_ERROR_RE.test(text)) return auth;
    return failed;
  }

  const code = String(json?.response?.header?.resultCode ?? json?.resultCode ?? "");
  if (code === "22") return quota;
  if (["30", "31", "32", "33"].includes(code)) return auth; // 키 관련 오류: 본문은 넘기지 않음
  if (!res.ok) return failed;
  if (code === "00") return { status: 200, body: text, cacheable: true };

  // 그 밖의 비정상 코드는 프론트 계약상 200으로 그대로 전달 (캐시하지 않음)
  return { status: 200, body: text, cacheable: false };
}

export default {
  async fetch(request, env, ctx) {
    const allowed = parseAllowedOrigins(env);
    const origin = request.headers.get("Origin") || "";
    const originOk = allowed.includes(origin);

    // 허용된 Origin에만 CORS 헤더를 붙인다 (오류 응답 429/503 포함)
    const cors = { "Vary": "Origin", "Cache-Control": "no-store" };
    if (originOk) {
      cors["Access-Control-Allow-Origin"] = origin;
      cors["Access-Control-Allow-Methods"] = "GET, OPTIONS";
      cors["Access-Control-Max-Age"] = "86400";
      cors["Access-Control-Expose-Headers"] = "X-Cache, Retry-After";
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/arrivals") {
      return new Response("Not found", { status: 404, headers: cors });
    }

    // 허용되지 않은 출처 차단 (서버 간 호출로 위조 가능하므로 아래 rate limit이 보완)
    if (!originOk) {
      return new Response("Forbidden", { status: 403, headers: cors });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: { ...cors, Allow: "GET, OPTIONS" } });
    }

    const cityCode = url.searchParams.get("cityCode");
    const nodeId = url.searchParams.get("nodeId");
    // 제주 전용: cityCode는 정확히 "39"("039" 같은 변형은 캐시 키 중복이라 거부), nodeId는 "JEB"+숫자 9자리
    if (cityCode !== JEJU_CITY_CODE || !JEJU_NODE_RE.test(nodeId || "")) {
      return new Response("Bad request", { status: 400, headers: cors });
    }

    // IP당 호출 제한 (캐시 HIT도 포함해서 센다). 바인딩이 없거나 오류면 제한 없이 통과.
    if (env.RATE_LIMITER) {
      const ip = rateLimitKey(request.headers.get("CF-Connecting-IP"));
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          return jsonError(429, "rate_limited", { ...cors, "Retry-After": "60" });
        }
      } catch (e) {
        // 제한기 오류 때문에 정상 사용자를 막지 않음
      }
    }

    const key = `${cityCode}:${nodeId}`;
    const cached = cacheGet(key);
    if (cached !== null) {
      return new Response(cached, {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "X-Cache": "HIT" },
      });
    }

    // 같은 키의 동시 요청은 업스트림 호출 하나를 공유
    let entry = inflight.get(key);
    if (entry && Date.now() - entry.started > INFLIGHT_MAX_AGE_MS) {
      inflight.delete(key); // 멈춘 항목은 버리고 새로 시작
      entry = undefined;
    }
    if (!entry) {
      const mine = { started: Date.now() };
      mine.promise = callUpstream(env, cityCode, nodeId)
        .catch(() => FAILED_RESULT)
        .then((r) => {
          if (r.cacheable) cacheSet(key, r.body);
          return r;
        })
        .finally(() => {
          if (inflight.get(key) === mine) inflight.delete(key);
        });
      inflight.set(key, mine);
      // 시작한 요청의 클라이언트가 끊겨도 작업이 끝까지 가도록 함
      ctx.waitUntil(mine.promise);
      entry = mine;
    }

    // 기다리는 쪽은 7초까지만 기다린다
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(FAILED_RESULT), INFLIGHT_MAX_AGE_MS);
    });
    const r = await Promise.race([entry.promise, timeout]);
    clearTimeout(timer);

    const headers = { ...cors, "Content-Type": "application/json; charset=utf-8", "X-Cache": "MISS" };
    if (r.retryAfter) headers["Retry-After"] = r.retryAfter;
    return new Response(r.body, { status: r.status, headers });
  },
};
