# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 현황

버스 즐겨찾기 PWA — 자주 타는 정류장·노선만 즐겨찾기해 두고 도착 정보를 바로 보는 모바일 웹앱. 전체 요구사항은 `버스즐겨찾기_PWA_PRD.md`(v0.6)가 기준 문서이며, 기능 ID(F-H1, F-M4, P-2 등)와 우선순위(P0/P1/P2)는 여기서 정의된다.

**2026-11-15 방향 전환**: 지원 지역을 **제주도(cityCode 39) 하나로 좁혔다.** 대전·대구 등 다른 TAGO 지원 지역과 서울(별도 API) 지원은 보류한다 — 멀티 지역 대응에 쓰던 여유를 아래 3개 신규 기능에 쓴다. 기존 멀티 지역 코드(dedup 정책, 지역별 응답 차이 대응 등)는 당장 걷어내지 않아도 되지만(제주 데이터에는 영향 없음), **새 코드를 "여러 지역 지원"을 전제로 설계하지 않는다.** 지도의 도시 선택 버튼·다이얼로그(구 F-L1, `js/ui/city-picker.js`)는 v0.6에서 제거했다 — 다시 넣지 말 것.

**신규 기능 (PRD 상세 참고)**
1. **도보 소요시간 기반 출발 안내**: **전부 자동 계산이다. 사용자가 직접 입력하는 값은 없다.** 현재 위치와 정류장 좌표의 거리로 매번 도보 시간을 추정한다(위치가 바뀌면 값도 바뀜, 저장 안 함). 이 값으로 각 노선 도착 예정에서 빼서 "지금 출발하면 탈 수 있는지/몇 분 후 출발해야 하는지"를 안내한다.
2. **즐겨찾기 그룹**: 즐겨찾기한 (정류장, 노선) 항목에 그룹을 지정할 수 있다. 같은 그룹 안에서 (도보 시간을 감안해) **가장 먼저 탈 수 있는 노선 하나**를 다른 노선보다 시각적으로 강조(더 크게) 표시한다.
3. **홈 화면 거리순 정렬**: 즐겨찾기 정류장 카드를 현재 위치에서 가까운 순으로 정렬한다. 기존엔 위치 권한을 지도 탭에서만 요청했는데, 이 기능 때문에 홈에서도 필요해졌다 — 권한 거부·실패 시 폴백(저장된 순서 유지)을 반드시 둔다.

Phase 0(API 검증)~Phase 3(PWA)는 끝난 상태이고, 위 3개가 다음 작업 단위다. 프론트엔드 MVP(홈·지도·검색), `worker/`, 타일 데이터(`data/tiles/`, `data/cities.json`), 서비스워커는 이미 구현돼 있다.

- **타일 데이터**: 지금은 제주 외 지역(대전 등)과 제외 정책(`docs/phase0-findings.md`)이 섞여 있는 상태다. 제주만 남기도록 `scripts/build-tiles.js`를 다시 돌릴 때는 `tile-data-builder`에게 맡기고, 이 CLAUDE.md의 "지원 지역" 관련 서술도 함께 갱신한다.
- **노선 유형별 색상** (`js/ui/home.js`의 `routeTypeClass`/`routeNoChip`, `css/style.css`의 `--rt-*`): 간선(파랑)·지선(초록, 외곽버스 포함)·급행(빨강)·관광순환(노랑, 810·820번)은 제주 실제 버스 도색과 맞춘 색이다(대전도 같은 체계라 코드는 그대로 둔다). 마을(주황)은 실제(적+노랑+흰색 다색)를 근사한 것, 좌석(청록)은 제주에서 관측된 적 없는 임의 배색이다. **색은 제주 노선번호 분류가 우선이다**(v0.6, 사용자 지정): 100번대 지선, 200·400번대 간선, 300번대 급행, 800번대 관광순환은 API `routetp`가 뭐라고 오든 번호대로 칠한다. 이 번호대 밖(500·600·700번대 등 미확인, 숫자 아닌 번호)만 `routetp` 문자열로 가르고, 그것도 없으면 500번대=간선, 600·700번대=지선 추정치로 폴백한다. 노선 유형 **라벨 글자**(`routeLabels`)는 여전히 API `routetp` 그대로다.

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

## 신규 기능 구현 메모

- **도보 소요시간** (F-W1, PRD 참고): **저장하지 않는다. 사용자 입력 UI도 없다.** 홈 렌더링 때마다 현재 위치↔정류장 좌표 거리(haversine) ÷ 평균 도보 속도(≈67m/분) × 보정계수(≈1.3)로 매번 새로 계산한다(위치 갱신 때마다 재계산). localStorage 스키마에 도보시간 관련 필드는 없다(그룹 필드만 v2에 추가, PRD 8.1). 위치 권한이 없으면 도보 안내 자체를 생략(기존 동작 유지, 에러 아님). 출발 안내는 "도착예정(분) − 자동 추정 도보 시간"(여유분)을 계산하되, **추정이 분 단위로 정확하지 않으므로 숫자로 안내하지 않고 말로만** 전한다: 여유분 < 0 "이미 늦었을 수도 있어요", 0~`WALK_SAFETY_MIN`(2분) 미만 "지금 출발해야 할 것 같아요", 그 이상 "지금 출발하면 여유로워요". 도보 시간 자체는 "도보 약 N분"으로 표시. 계산은 표시 단계에서만 하고 API 응답은 건드리지 않는다.
- **즐겨찾기 그룹** (F-G1): 즐겨찾기한 (정류장, 노선) 조합에 그룹 라벨(문자열, 예: "출근")을 붙일 수 있게 한다. 저장 스키마에 그룹 필드 추가가 필요하므로 이것도 버전업 대상. 그룹별로 "지금 탈 수 있는 노선 중 가장 빠른 것"(도보시간이 설정된 경우 그걸 뺀 뒤 가장 빠른 것)을 계산해 그 카드만 강조(`route-no`에 class 추가 등, 기존 `routeNoChip` 구조를 건드리지 않고 wrapper 레벨에서 처리하는 걸 권장). 서로 다른 정류장의 노선이 같은 그룹에 속할 수 있다 — 그룹 계산은 정류장 카드 단위가 아니라 전체 즐겨찾기 목록을 가로지르는 계산이 필요하다.
- **홈 화면 거리순 정렬** (F-H0): 즐겨찾기 정류장 목록을 현재 위치 기준 거리(단순 haversine, 정확한 경로 아님)로 정렬. 위치 권한을 홈에서도 요청해야 하므로 기존 "지도 탭 진입 시에만 요청" 정책을 바꾼다 — 권한 거부/실패 시 **반드시 폴백**(저장된 순서 그대로, 에러 없이 조용히)을 두고, 위치 요청 자체가 추가 API 호출(TAGO/Worker)을 유발하지 않는다는 점을 유지한다(Geolocation은 브라우저 API라 호출 한도와 무관).
- **홈 화면 날씨** (F-WX1): **Open-Meteo**(`api.open-meteo.com/v1/forecast`, 키 불필요)를 **Worker 없이 프론트에서 직접** 호출한다 — 보관할 서비스키가 없으므로 "서비스키는 Worker에만" 원칙이 애초에 적용 안 됨. 좌표는 `js/geo.js`의 현재 위치를 재사용하고, 없으면 `data/cities.json`의 제주 `center`로 폴백. **첫 호출은 `geo.ensurePosition()`을 기다린 뒤 한다**(바로 폴백으로 부르면 위치 허용 사용자도 늘 제주 기준 날씨가 먼저 뜸). 폴백으로 그렸거나 그리는 중에 위치가 오면 한 번 다시 받는다. 홈이 보일 때 1회 받고 활성 상태가 길면 30분 간격으로만 재호출(버스 30초 주기와 별개 타이머, 섞어 쓰지 말 것). 실패하면 날씨 영역을 그냥 숨긴다(에러 배너 없음 — 핵심 기능이 아니므로). 비/눈 판정: `current.precipitation > 0` 또는 `current.weather_code`가 비·눈·뇌우 코드(WMO 코드 51–67, 71–77, 80–86, 95–99)면 우산 안내. `vercel.json`의 CSP `connect-src`에 `https://api.open-meteo.com` 추가 필요.
- **다른 노선 출발 안내 흐리게** (F-H3a): 카드에 즐겨찾기 노선이 있으면 "다른 노선"(`.routes.others`)의 `.depart`를 연하게(`others.dim`). 즐겨찾기 노선이 없는 카드는 그대로.
- **지도 목록 패널 바깥 탭으로 닫기** (F-M7): `#search-results`(목록·검색 결과 공용)가 열려 있을 때 패널·검색창·"목록" 버튼 밖을 누르면 닫는다(`js/ui/search.js`).
- **출근 무지각 체크인** (F-CM1~F-CM4, PRD 4.6 참고): 버스 즐겨찾기와 **완전히 다른 도메인**이라 별도 localStorage 키 `bus-bookmark:commute`를 쓴다(`{version, targetTime, streak, lastResultDate, lastResult, history}`). 네트워크 호출이 전혀 없다(시각 비교 + 저장뿐) — TAGO/Worker/Open-Meteo 호출 예산과 무관. 하루에 한 번만 판정되도록 `lastResultDate`가 오늘이면 버튼 대신 그날 결과를 보여준다. 아직 기록 전이면 목표 시간까지 남은/지난 시간(분 단위, `checkIn`과 같은 "HH:MM" 기준)을 `.cm-left`에 보여 주고 홈의 1초 tick(`syncCommute`)에서 갱신한다. "탑승 완료" 누른 시각 ≤ 목표 시간이면 무지각(`streak += 1`), 넘으면 지각(`streak = 0`). "오늘은 쉬는 날"은 `streak`를 그대로 둔다. **앱을 아예 안 연 날은 평가하지 않는다**(자동 지각 처리 없음, 의도된 단순화). `history`(기록 있는 날만, 날짜순)에서 **최근 5개**를 동그라미로 표시: 무지각=초록, 지각=빨강, 쉬는 날=회색(색만으로 구분하지 않도록 `aria-label`에 상태·날짜 포함). 표시 위치는 홈 화면 날씨(F-WX1) 바로 아래.

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
