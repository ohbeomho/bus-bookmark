# bus-bookmark

자주 타는 버스 정류장과 노선만 즐겨찾기해 두고, 도착 정보를 바로 보는 모바일 웹앱(PWA)입니다.

- 운영 주소: https://bus-bookmark.vercel.app (Vercel, 연결 예정)
- 기준 문서: [`버스즐겨찾기_PWA_PRD.md`](버스즐겨찾기_PWA_PRD.md) · 개발 규칙: [`CLAUDE.md`](CLAUDE.md) · API 검증 결과: [`docs/phase0-findings.md`](docs/phase0-findings.md)

## 구조

```
[PWA (Vercel 정적 배포, Vanilla JS, 빌드 없음)]
   ├─ 정류장 타일 JSON ← 같은 사이트의 data/tiles/ (빌드 시 생성한 정적 파일)
   └─ 도착 정보 ──→ [Cloudflare Worker /arrivals] ──→ [TAGO 버스도착정보 API]
                      서비스키는 Worker Secret에만 보관
```

| 경로 | 내용 |
|---|---|
| `index.html`, `css/`, `js/` | 앱 (ES Modules를 브라우저에서 직접 로드, npm 의존성 없음) |
| `manifest.webmanifest`, `icons/`, `favicon.ico` | PWA 매니페스트와 아이콘 |
| `data/tiles/`, `data/cities.json` | 정류장 타일(0.05° 격자)과 지원 도시 목록 — `scripts/build-tiles.js`로 생성 |
| `worker/` | Cloudflare Worker 프록시 (`worker.js`, `wrangler.jsonc`) |
| `scripts/` | 데이터·아이콘 생성 스크립트 (배포 대상 아님) |
| `vercel.json`, `.vercelignore` | Vercel 헤더(CSP·캐시)와 배포 제외 목록 |

지원 지역은 **제주(cityCode 39) 하나**입니다(PRD v0.5, 4.4절). 다른 TAGO 지역·서울(별도 API)은 보류 상태이며, 조사·구현은 `feature/seoul-support` 브랜치와 `docs/phase0-findings.md`·`docs/phase0-seoul-findings.md`에 남아 있습니다.

## 로컬 실행

앱은 반드시 **`http://localhost:5500`** 에서 띄워야 합니다. Worker가 이 주소만 개발용으로 허용하므로 다른 포트에서는 도착 정보 요청이 403으로 막힙니다.

- VS Code Live Server(기본 포트 5500), 또는
- 저장소 루트에서 `python -m http.server 5500`

위치 권한과 서비스워커는 HTTPS 또는 localhost에서만 동작합니다.

## 도착 정보 프록시 (Cloudflare Worker)

TAGO 서비스키를 브라우저에 노출하지 않기 위해 Worker가 대신 호출합니다.

```powershell
cd worker
npx wrangler login                    # 처음 한 번
npx wrangler secret put SERVICE_KEY   # 공공데이터포털 "Decoding" 키 입력 (Encoding 키 아님)
npx wrangler deploy
```

- 엔드포인트: `GET /arrivals?cityCode={도시코드}&nodeId={정류장ID}`
- 허용 출처는 `wrangler.jsonc`의 `vars.ALLOWED_ORIGINS`에 있습니다. 바꾸면 다시 배포해야 합니다.
- IP당 분당 60건 제한, 같은 정류장 15초 캐시, 오류 응답 형식은 PRD 4.3을 참고하세요.
- 로컬 실행(`npx wrangler dev`)에는 `worker/.dev.vars`에 `SERVICE_KEY=...`가 필요합니다. 이 파일은 커밋하지 않습니다.

> TAGO 개발계정 한도(하루 10,000건)는 **모든 사용자가 함께 씁니다.** 호출을 늘리는 변경은 PRD 4.5의 호출 절약 규칙을 먼저 확인하세요.

## 정류장 데이터 갱신

원본은 공공데이터포털의 [국토교통부_전국 버스정류장 위치정보](https://www.data.go.kr/data/15067528/fileData.do) CSV입니다(EUC-KR, 로그인 후 다운로드).

1. CSV를 `data/raw/`에 둡니다. 이 폴더는 커밋하지 않습니다.
2. 타일을 다시 만듭니다.
   ```powershell
   node scripts/build-tiles.js                   # data/cities.json의 지원 도시 기준
   node scripts/build-tiles.js --refresh-cities  # TAGO 도시코드 목록도 다시 받을 때 (.env의 OPEN_API_KEY 필요)
   ```
3. `data/tiles/`, `data/tiles/index.json`, `data/cities.json`, `data/excluded-stops.json`이 갱신됩니다. `index.json`의 `version`이 바뀌면 앱이 기존 타일 캐시를 버리고 새로 받습니다.
   - 스크립트는 먼저 `SUPPORTED_CITY_CODES` 상수(현재 `[39]`, 제주만)로 CSV 행을 지역 필터링한 뒤, 그 위에 두 가지 제외 정책을 적용합니다: **정책 1**(같은 이름·좌표인데 nodeId/cityCode만 다른 중복 그룹에서, 자신의 cityCode 주류 nodeId 접두사와 다른 행), **정책 2**(`data/cities.json`에 없는 cityCode — 지금은 `SUPPORTED_CITY_CODES`가 이미 TAGO 지원 도시만 가리켜 실제로 걸러지는 행은 없지만, 다른 지역을 다시 지원할 때를 대비해 코드는 남겨둡니다). 제외된 행 전체 목록은 `data/excluded-stops.json`에 남습니다(배포 대상 아님, `.vercelignore` 참고). 근거는 [`docs/phase0-findings.md`](docs/phase0-findings.md)의 "중복 정류장 검증" 절 참고.

아이콘을 다시 만들 때는 `node scripts/build-icons.js`를 실행합니다.

## 배포 (Vercel)

빌드 단계가 없는 정적 사이트입니다. Vercel에서 저장소를 연결하면 루트 폴더가 그대로 배포됩니다.

- `.vercelignore`가 원본 데이터·스크립트·Worker·문서를 배포에서 뺍니다.
- `vercel.json`이 CSP와 캐시 헤더를 설정합니다. **외부 리소스(지도 CDN, 지도 타일 등)를 추가하면 CSP도 함께 고쳐야** 배포본에서 막히지 않습니다.
- 운영 주소가 `https://bus-bookmark.vercel.app`가 아니게 되면 Worker의 `ALLOWED_ORIGINS`를 바꾸고 다시 배포하세요. Preview 배포 주소는 허용하지 않으므로 Preview에서는 도착 정보가 나오지 않습니다.

## 데이터 출처

- 국토교통부 (TAGO) 버스도착정보 — 공공데이터포털
- 국토교통부 전국 버스정류장 위치정보 — 공공데이터포털
- 지도: © OpenStreetMap contributors
