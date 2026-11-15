// 공개해도 되는 설정만 둔다. 서비스키·공공데이터포털 주소는 절대 넣지 않는다 (Worker Secret에만 있음).
export const WORKER_URL = "https://bus-bookmark-worker.ohbeomho0322.workers.dev";

// 호출 절약 규칙 (PRD 4.5)
export const REQUEST_TIMEOUT_MS = 8000; // 요청 1회 타임아웃
export const RETRY_DELAY_MS = 1000; // 재시도 전 대기
export const MAX_CONCURRENT_REQUESTS = 4; // 동시에 보내는 도착 정보 요청 수 상한
export const MIN_GAP_MS = 10000; // 같은 정류장 10초 내 중복 호출 무시
export const MANUAL_REFRESH_COOLDOWN_MS = 10000; // 수동 새로고침(버튼·당겨서) 후 다시 누를 수 있을 때까지
export const MIN_AUTO_REFRESH_SEC = 30; // 자동 새로고침 최소 간격
export const FAIL_BACKOFF_SEC = [30, 60, 120, 300]; // 연속 실패 횟수(0,1,2,3+)별 자동 새로고침 최소 간격
export const IDLE_PAUSE_MS = 10 * 60 * 1000; // 사용자 입력이 없으면 자동 새로고침을 멈출 때까지
export const QUOTA_PAUSE_MS = 10 * 60 * 1000; // 하루 한도 초과 응답 후 자동 새로고침을 멈추는 시간
export const STALE_AFTER_MS = 3 * 60 * 1000; // 이보다 오래된 도착 정보는 흐리게 표시

// 저장 데이터 상한 (PRD 8.1)
export const MAX_STOPS = 20; // 즐겨찾기 정류장 수
export const MAX_ROUTES = 100; // 정류장당 즐겨찾기 노선 수, knownRoutes 수
export const MAX_GROUPS = 20; // 즐겨찾기 그룹 수 (F-G1)

// 도보 소요시간 자동 추정 (F-W1). 저장하지 않고 렌더링마다 현재 위치로 다시 계산한다
export const WALK_SPEED_M_PER_MIN = 67; // 평균 도보 속도 (시속 약 4km)
export const WALK_DETOUR_FACTOR = 1.3; // 직선거리 → 실제 걷는 거리 보정
export const WALK_MAX_M = 3000; // 이보다 멀면 "걸어가는 정류장"으로 보지 않고 안내를 생략한다
export const WALK_SAFETY_MIN = 2; // 그룹 최속(F-G2)을 고를 때 이만큼 여유가 있어야 "넉넉히 탈 수 있다"고 본다
export const GEO_TIMEOUT_MS = 8000; // 위치 1회 요청 타임아웃 (실패하면 조용히 폴백)
export const GEO_FRESH_MS = 2 * 60 * 1000; // 이보다 오래된 위치는 다시 요청 (홈이 보이는 동안 주기적으로)
export const GEO_STALE_MS = 5 * 60 * 1000; // 이보다 오래된 위치로는 거리·도보 안내를 하지 않는다 (움직였을 수 있음)
export const GEO_RETRY_MS = 5 * 60 * 1000; // 위치를 못 받은 뒤 다시 시도할 때까지
export const GEO_MAX_FAILS = 3; // 연속 실패가 이만큼이면 이 세션에서는 자동 요청을 멈춘다

// 홈 화면 날씨 (F-WX1). Open-Meteo는 키가 필요 없어 Worker를 거치지 않고 프론트에서 직접 부른다.
// TAGO/Worker 호출 한도와 무관하며, 버스 도착 정보와는 별개 타이머로 돈다.
export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
export const WEATHER_REFRESH_MS = 30 * 60 * 1000; // 홈이 계속 보여도 이 간격으로만 다시 받는다
export const WEATHER_RETRY_MS = 5 * 60 * 1000; // (자동 재시도까지 실패한 뒤) 홈 재진입 등으로 다시 시도할 수 있을 때까지
export const WEATHER_RETRY_ONCE_MS = 30 * 1000; // 실패하면 이만큼 뒤 한 번만 다시 시도
export const WEATHER_TIMEOUT_MS = 6000; // 1회 요청 타임아웃 (초과하면 실패 문구)
export const WEATHER_RAIN_PROB = 60; // 오늘 남은 시간의 시간별 강수확률 최댓값(%)이 이 이상이면 약한 우산 안내
export const FALLBACK_CITY_CODE = 39; // 위치를 모를 때 쓰는 기본 좌표의 도시 (제주, data/cities.json의 center)
