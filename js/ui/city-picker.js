// 도시 선택 (PRD F-L1): 시/도 → 시/군을 고르면 data/cities.json의 bbox(또는 center)로 지도를 옮긴다.
// cities.json에는 시/도가 없어서 도시코드 앞자리로 묶는다 (31 경기, 32 강원 … 38 경남).
// 특별시·광역시·제주(두 자리 코드)는 그 자체가 광역 단위라 시/군 하위 목록이 없다 — 시/도 드롭다운에서 바로 선택한다.
import { h } from "./dom.js";

const PROVINCES = {
  31: "경기도",
  32: "강원특별자치도",
  33: "충청북도",
  34: "충청남도",
  35: "전북특별자치도",
  36: "전라남도",
  37: "경상북도",
  38: "경상남도",
};
const isMetro = (code) => code < 100;

/**
 * dlg: <dialog>, cities: loadCities() 결과, onPick(city)
 */
export function openCityPicker(dlg, cities, onPick) {
  const metros = cities.filter((c) => isMetro(c.code)).sort((a, b) => a.code - b.code);
  const groups = new Map(); // province name -> 시/군 목록
  for (const c of cities) {
    if (isMetro(c.code)) continue;
    const p = PROVINCES[Math.floor(c.code / 1000)] || "기타";
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(c);
  }

  const provSel = h("select", { id: "city-prov" }, [
    ...metros.map((c) => h("option", { value: `m:${c.code}` }, c.name)),
    ...[...groups.keys()].map((p) => h("option", { value: `p:${p}` }, p)),
  ]);
  const citySel = h("select", { id: "city-city" });
  const cityField = h("label", { class: "field", for: "city-city" }, "시/군", citySel);
  const fill = () => {
    const v = provSel.value;
    if (v.startsWith("m:")) {
      cityField.hidden = true;
      citySel.replaceChildren();
    } else {
      cityField.hidden = false;
      const list = groups.get(v.slice(2)) || [];
      citySel.replaceChildren(...list.map((c) => h("option", { value: String(c.code) }, c.name)));
    }
  };
  provSel.addEventListener("change", fill);
  fill();

  const body = dlg.querySelector(".sheet-body");
  body.replaceChildren(
    h("h2", { id: "city-sheet-title" }, "도시 선택"),
    ...(cities.length
      ? [
          h("p", { class: "hint" }, "정류장 정보를 지원하는 도시만 있어요. 고른 도시로 지도를 옮겨요."),
          h("label", { class: "field", for: "city-prov" }, "시/도", provSel),
          cityField,
          h(
            "button",
            {
              class: "btn primary",
              type: "button",
              onclick: () => {
                const v = provSel.value;
                const code = v.startsWith("m:") ? v.slice(2) : citySel.value;
                const c = cities.find((x) => String(x.code) === code);
                dlg.close();
                if (c) onPick(c);
              },
            },
            "이 도시로 이동"
          ),
        ]
      : [h("p", { class: "note" }, "도시 목록을 불러오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.")]),
    h("button", { class: "btn", type: "button", onclick: () => dlg.close() }, "닫기")
  );
  if (!dlg.open) dlg.showModal();
  provSel.focus();
}
