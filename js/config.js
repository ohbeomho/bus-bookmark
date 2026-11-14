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
