// 정류장 검색 (PRD F-S1~S4): 불러온 타일 안에서 이름 부분 일치·ARS 번호, 거리순.
// 같은 이름 정류장은 거리·방향·ARS를 함께 보여 구분한다.
// 지도 마커(캔버스)를 쓸 수 없는 스크린리더·키보드 사용자를 위해 "이 화면의 정류장" 목록도 여기서 보여 준다.
import { loadedRows, distanceM, direction, fmtDistance } from "../tiles.js";
import { h } from "./dom.js";

const MAX_RESULTS = 50;
const DEBOUNCE_MS = 250;

const norm = (s) => String(s).replace(/\s+/g, "").toLowerCase();

let input, box, opts, timer;

/**
 * opts: { getOrigin() → {lat, lng, label}, cityName(code), onPick(row), canSearch() → 안내 문구 | "",
 *         keepOpen: [Element] — 눌러도 "바깥"으로 치지 않을 요소 (예: 목록 버튼) }
 */
export function initSearch(form, resultsEl, options) {
  input = form.querySelector("input");
  box = resultsEl;
  opts = options;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(timer);
    run();
    box.querySelector(".result")?.focus();
  });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });
  // F-M7: 목록·검색 결과 패널 밖(지도 등)을 누르면 닫는다. 검색창·패널 안·keepOpen 요소는 제외.
  // capture 단계에서 보므로 Leaflet이 지도 이벤트를 막아도 받는다
  const inside = (t) => box.contains(t) || form.contains(t) || (opts.keepOpen || []).some((k) => k?.contains(t));
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!box.hidden && !inside(e.target)) closeResults();
    },
    true
  );
  for (const el of [input, box]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !box.hidden) {
        e.preventDefault();
        closeResults(true);
      }
    });
  }
}

export function closeResults(focusInput = false) {
  box.hidden = true;
  box.replaceChildren();
  if (focusInput) input.focus();
}

function run() {
  const q = input.value.trim();
  if (!q) return closeResults();
  const nq = norm(q);
  const digits = /^[\d-]+$/.test(q) ? q.replace(/-/g, "") : "";
  const seen = new Set();
  const hits = [];
  for (const r of loadedRows()) {
    const key = `${r[5]}:${r[0]}`;
    if (seen.has(key)) continue;
    // 이름 부분 일치, 숫자만 입력하면 ARS 번호 앞부분 일치도
    if (norm(r[1]).includes(nq) || (digits && r[4] && String(r[4]).startsWith(digits))) {
      seen.add(key);
      hits.push(r);
    }
  }
  show(hits, `'${q}' 검색 결과`, () => {
    const why = opts.canSearch?.();
    return why || `불러온 지역에 '${q}' 정류장이 없어요. 찾는 지역으로 지도를 옮겨 확대한 뒤 다시 검색해 주세요.`;
  });
}

/** 이 화면에 보이는 정류장 목록 (마커 대신 고를 수 있게) */
export function showNearby(rows) {
  input.value = "";
  show(rows, "이 화면의 정류장", () => opts.canSearch?.() || "이 화면에는 정류장이 없어요.");
  box.querySelector(".result, .btn")?.focus();
}

function show(rows, title, emptyText) {
  const o = opts.getOrigin();
  const list = rows
    .map((r) => ({ r, d: distanceM(o.lat, o.lng, r[2], r[3]) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_RESULTS);
  // 같은 이름이 여러 개인지 (구분 정보 강조)
  const nameCount = new Map();
  for (const { r } of list) nameCount.set(r[1], (nameCount.get(r[1]) || 0) + 1);

  const header = h(
    "div",
    { class: "results-head" },
    h(
      "p",
      { class: "results-title", role: "status" },
      list.length
        ? `${title} ${rows.length > MAX_RESULTS ? `${MAX_RESULTS}개 (가까운 순)` : `${list.length}개`} · ${o.label} 기준 거리`
        : title
    ),
    h("button", { class: "btn small", type: "button", onclick: () => closeResults(true) }, "닫기")
  );
  const items = list.map(({ r, d }) => {
    const dup = nameCount.get(r[1]) > 1;
    const where = `${o.label}에서 ${direction(o.lat, o.lng, r[2], r[3])}쪽 ${fmtDistance(d)}`;
    const sub = [r[4] ? `ARS ${r[4]}` : dup ? "ARS 없음" : "", where, opts.cityName(r[5])].filter(Boolean).join(" · ");
    return h(
      "li",
      null,
      h(
        "button",
        {
          class: "result",
          type: "button",
          onclick: () => {
            closeResults();
            input.blur();
            opts.onPick(r);
          },
        },
        h("span", { class: "result-name" }, r[1]),
        h("span", { class: "result-sub" }, sub)
      )
    );
  });
  box.replaceChildren(header, list.length ? h("ul", { class: "results" }, items) : h("p", { class: "hint" }, emptyText()));
  box.hidden = false;
}
