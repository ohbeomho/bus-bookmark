# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 현황

버스 즐겨찾기 PWA — 자주 타는 정류장·노선만 즐겨찾기해 두고 도착 정보를 바로 보는 모바일 웹앱. 전체 요구사항은 `버스즐겨찾기_PWA_PRD.md`(v0.3)가 기준 문서이며, 기능 ID(F-H1, F-M4, P-2 등)와 우선순위(P0/P1/P2)는 여기서 정의된다.

현재는 초기 단계로 `worker/worker.js`(Cloudflare Worker 프록시)만 구현되어 있다. 프론트엔드, `wrangler.jsonc`, 타일 전처리 스크립트는 아직 없으며 PRD 8장의 폴더 구조를 따라 만들 예정이다. git 저장소도 아직 아니다.

## 아키텍처

```
[PWA (정적 호스팅, Vanilla JS)]
   ├─ 정류장 타일 JSON ← 같은 사이트의 /data/tiles/ (빌드 시 생성한 정적 파일)
   └─ 도착 정보 ──→ [Cloudflare Worker /arrivals] ──→ [TAGO 버스도착정보 API]
                      SERVICE_KEY는 Worker Secret에만 보관
```

- **빌드 도구·번들러 없음**: ES Modules를 브라우저에서 직접 로드. npm 의존성을 들이지 말 것 (지도는 Leaflet + OSM을 CDN으로 사용 예정, 앱 코드 JS+CSS 압축 후 100KB 이하 목표).
- **서비스키는 프론트엔드에 절대 넣지 않는다**: 프론트엔드는 공공데이터포털을 직접 호출하지 않고 Worker(`https://bus-bookmark-worker.ohbeomho0322.workers.dev/arrivals?cityCode=&nodeId=`)만 호출한다. `js/config.js`에는 공개해도 되는 값(Worker 주소 등)만 둔다. 루트의 `.env`(`OPEN_API_KEY`)는 로컬 테스트용이며 배포 대상·커밋 대상이 아니다.
- **Worker** (`worker/worker.js`): `/arrivals` 외 경로는 404, `ALLOWED_ORIGINS`에 없는 Origin은 403, `cityCode`(숫자 1~9자리)·`nodeId`(영숫자 1~30자) 검증 실패는 400, IP당 분당 60건 초과는 429 `{"error":"rate_limited"}`, 업스트림 키 문제는 502 `{"error":"upstream_auth"}`, 한도 초과는 503 `{"error":"quota"}`, 그 밖의 업스트림 실패(6초 타임아웃 포함)는 502 `{"error":"upstream_failed"}`. 정상 TAGO JSON은 가공 없이 그대로 전달하고, 성공 응답은 15초 메모리 캐시한다(`X-Cache`). `SERVICE_KEY`에는 공공데이터포털의 **Decoding 키**를 넣는다(URLSearchParams가 인코딩하므로 Encoding 키를 넣으면 이중 인코딩됨). `ALLOWED_ORIGINS`는 `wrangler.jsonc`의 `vars`에 있으며 값은 `https://bus-bookmark.vercel.app,http://localhost:5500` (Vercel Preview 주소는 허용하지 않음). Observability는 `wrangler.jsonc`에서 **Logs만 켜고 Traces는 끈다** — Traces는 업스트림 fetch URL(쿼리에 `serviceKey`)을 기록할 수 있다. Worker 코드에 요청 URL을 `console.*`로 남기는 코드도 넣지 말 것.
- **데이터 연결**: 정류장 CSV의 도시코드 → API `cityCode`, 정류장번호 → API `nodeId`. 정류장을 지나는 노선 목록은 별도 데이터가 없어 API 응답(그 시점 운행 중인 노선만 포함)으로 얻고, 한 번 본 노선은 `knownRoutes`에 캐시한다. 노선은 `routeNo`가 아니라 `routeId`로 식별한다.
- **정류장 데이터**: 전국 CSV(EUC-KR 가능성)를 전처리해 0.05° 격자 타일 `data/tiles/{lat}_{lng}.json`(키 없는 배열 `[nodeId, 이름, 위도, 경도, ARS, cityCode]`)과 `index.json`(타일 목록·수집일·버전)으로 나눈다. 앱은 화면 범위의 타일만 받아 IndexedDB에 캐시하고, `index.json` 버전이 바뀌면 무효화한다.
- **배포 설정** (`vercel.json`, `.vercelignore`): CSP가 `'self'`와 Worker 주소만 허용한다. **지도(Leaflet CDN, OSM 타일)나 다른 외부 리소스를 추가하면 `vercel.json`의 CSP(`script-src`, `style-src`, `img-src`)도 함께 고쳐야 한다** — 안 고치면 배포본에서만 막히고 localhost에서는 안 보인다. 인라인 `<script>`/`style=` 속성도 CSP에 막힌다. 정류장 타일 파일명에는 버전이 없으므로 HTTP 캐시는 1일로 짧게 두고 `index.json`은 `no-cache`.
- **저장소**: 즐겨찾기·설정은 localStorage (스키마는 PRD 8.1, `version` 필드 포함), 정류장 타일은 IndexedDB.

## API 호출 시 지켜야 할 규칙

- TAGO 응답의 `item`은 1건이면 객체, 0건이면 빈 문자열로 올 수 있으므로 항상 배열로 정규화한다. `resultCode !== "00"`이면 오류 처리. `arrtime`은 초 단위(제주는 60초 배수). 응답은 `arrtime` 순이 아니므로 정렬한다. `routeno`는 지역에 따라 숫자(대전·제주)나 문자열("급행1", 대구)로 오므로 항상 `String()`. **같은 `routeid`가 한 응답에 여러 건(같은 노선의 다음 버스) 올 수 있다**(대구) — 노선별로 묶어 첫 버스와 다음 버스를 함께 표시하고, `routeid`가 한 번만 나온다고 가정하지 말 것.
- TAGO 개발계정 한도(하루 10,000건)를 **모든 사용자가 공유**하므로 호출 절약이 핵심 제약이다: 화면이 보일 때만 자동 새로고침(Page Visibility API), 간격 최소 30초, 수동 새로고침 10초 내 중복 무시, 접힌 정류장 카드는 호출 안 함, 새로고침 사이에는 `arrtime` 기준 화면 카운트다운만. 노선별 API(②)는 쓰지 않고 정류장별 목록 API(①) 1회로 처리한다.
- 추가 규칙 (PRD 4.5): 수동 새로고침 10초 쿨다운, 입력 없이 10분이면 자동 새로고침 일시정지, 연속 실패 시 30→60→120→300초 백오프, 한도 초과(503 `quota`) 시 10분 정지, 정류장 최대 20곳, 동시 요청 최대 4건. 새 호출 경로를 만들면 `js/api.js`의 `fetchArrivals`를 거쳐 이 규칙을 그대로 따르게 할 것.
- 타임아웃 8초, 일시적 실패(5xx·네트워크·타임아웃)만 1회 재시도(4xx·키 문제·한도 초과는 재시도 금지), 실패하면 마지막 성공 데이터를 흐리게 유지.
- 서비스워커에서 도착 정보(`*.workers.dev/arrivals`)는 **절대 캐시하지 않는다** — `sw.js` fetch 핸들러에서 `respondWith`를 부르지 않는다 (이 규칙을 깨는 변경 금지).
- **서비스워커(`sw.js`) 버전 관리**: 앱 파일(`index.html`, `css/`, `js/`, `icons/`, `manifest.webmanifest`)을 바꾸면 `sw.js`의 `VERSION`을 올린다 — 안 올리면 설치한 사용자는 옛 파일을 계속 본다. `js/`에 모듈을 추가·삭제하면 `sw.js`의 `SHELL` 목록도 고친다 (없는 파일이 있으면 install이 실패해 옛 버전이 유지됨).
- 정류장 타일(`data/tiles/*`)은 `js/tiles.js`가 IndexedDB에 `index.json` 버전과 함께 저장하므로 SW가 캐시하지 않는다. 앱 셸은 프리캐시, Leaflet CDN·OSM 지도 이미지(최대 200장)는 런타임 캐시.
- CSP `connect-src`는 SW의 fetch에도 적용되므로, SW가 새 출처를 가져오려면 `vercel.json`에도 그 출처를 넣는다.

## 로컬 개발

- 프론트엔드는 `http://localhost:5500`(VS Code Live Server 기본 포트)에서 띄운다. 이 Origin이 Worker의 `ALLOWED_ORIGINS`에 등록되어 있어 다른 포트를 쓰면 Worker가 403을 반환한다.
- 위치 권한·서비스워커는 HTTPS(또는 localhost)에서만 동작한다.
- 테스트·린트 설정은 아직 없다.

## 서브에이전트 (`.claude/agents/`)

PRD 단계별로 나눈 전용 에이전트가 있다. 해당 작업은 위임한다.

| 에이전트 | 모델 | 담당 |
|---|---|---|
| `api-verifier` | sonnet | Phase 0: Worker·TAGO 응답, 지원 지역, CSV↔API 연결 검증 → `docs/phase0-findings.md` |
| `tile-data-builder` | sonnet | Phase 1: `scripts/build-tiles.js`(Node, 의존성 없음)로 타일·index·cities 생성 |
| `worker-engineer` | sonnet | `worker/` 수정, wrangler 설정·배포 (배포는 사용자 확인 후) |
| `frontend-engineer` | opus | Phase 2 MVP: 홈·지도·검색·api/store/tiles 모듈 |
| `pwa-engineer` | sonnet | Phase 3: manifest, sw.js 캐시 전략, 설치 안내, Lighthouse |
| `browser-qa` | sonnet | Playwright 플러그인으로 모바일 화면 시나리오·오프라인·호출 빈도 검증 (읽기 전용) |
| `security-quota-reviewer` | opus | 키 노출·Worker 보안·트래픽 낭비·SW 캐시 실수 리뷰 (읽기 전용) |
