// 즐겨찾기 그룹 UI (F-G1). 그룹 선택 드롭다운(홈·지도 바텀시트)과 설정 화면의 그룹 관리.
// 그룹 계산(F-G2: 그룹 안에서 가장 빨리 탈 수 있는 노선)은 홈 렌더링이 맡는다 (js/ui/home.js).
import * as store from "../store.js";
import { MAX_GROUPS } from "../config.js";
import { h, toast } from "./dom.js";

const NEW = "__new"; // 드롭다운의 "새 그룹 만들기" 항목 값

function guard() {
  if (!store.isReadOnly()) return false;
  toast(store.ADD_STOP_MESSAGES.readonly);
  return true;
}

/** 이름을 물어보고 그룹을 만든다. 성공하면 새 그룹 id, 아니면 null */
export function promptNewGroup() {
  if (guard()) return null;
  if (store.isGroupsFull()) {
    toast(store.GROUP_MESSAGES.full);
    return null;
  }
  const name = prompt(`새 그룹 이름 (예: 출근). 최대 ${MAX_GROUPS}개까지 만들 수 있어요.`, "");
  if (name == null) return null; // 취소
  const res = store.addGroup(name);
  if (!res.ok) {
    toast(store.GROUP_MESSAGES[res.reason] || "그룹을 만들지 못했어요");
    return null;
  }
  return res.id;
}

/**
 * 즐겨찾기 노선의 그룹 선택 드롭다운 (F-G1).
 * 별표 토글 바로 옆에 두고, 즐겨찾기한 노선에만 보여 준다.
 * @param key 정류장 키, route {routeId, routeNo, groupId}
 */
export function groupSelect(key, route, fkey) {
  const groups = store.getGroups();
  const cur = route.groupId || "";
  const sel = h(
    "select",
    {
      class: "group-select",
      "aria-label": `${route.routeNo || "?"}번 그룹`,
      "data-fkey": fkey,
    },
    h("option", { value: "" }, groups.length ? "그룹 없음" : "그룹 지정"),
    groups.map((g) => h("option", { value: g.id, selected: g.id === cur }, g.name)),
    h("option", { value: NEW }, "+ 새 그룹 만들기…")
  );
  sel.value = groups.some((g) => g.id === cur) ? cur : "";
  sel.addEventListener("change", () => {
    if (guard()) return (sel.value = cur);
    if (sel.value === NEW) {
      const id = promptNewGroup();
      sel.value = id || cur; // 취소·실패하면 원래 값으로 되돌린다
      if (id) store.setRouteGroup(key, route.routeId, id);
      return;
    }
    store.setRouteGroup(key, route.routeId, sel.value || null);
  });
  return sel;
}

/** 설정 화면의 그룹 관리 (목록·이름 변경·삭제·추가) */
export function initGroupSettings(panel) {
  const listEl = panel.querySelector("#group-list");
  const addBtn = panel.querySelector("#group-add");
  const countEl = panel.querySelector("#group-count");
  if (!listEl) return;

  const render = () => {
    const groups = store.getGroups();
    const ro = store.isReadOnly();
    addBtn.disabled = ro || groups.length >= MAX_GROUPS;
    countEl.textContent = `${groups.length} / ${MAX_GROUPS}`;
    if (!groups.length) {
      listEl.replaceChildren(
        h("li", { class: "group-empty" }, "아직 그룹이 없어요. 그룹을 만들면 즐겨찾기 노선마다 그룹을 고를 수 있어요.")
      );
      return;
    }
    listEl.replaceChildren(
      ...groups.map((g) =>
        h(
          "li",
          { class: "group-item" },
          h("span", { class: "group-name" }, g.name),
          h(
            "button",
            {
              class: "btn small",
              type: "button",
              disabled: ro,
              "aria-label": `${g.name} 그룹 이름 바꾸기`,
              onclick: () => {
                const name = prompt("그룹 이름", g.name);
                if (name == null) return;
                const res = store.renameGroup(g.id, name);
                if (!res.ok) toast(store.GROUP_MESSAGES[res.reason] || "이름을 바꾸지 못했어요");
              },
            },
            "이름 변경"
          ),
          h(
            "button",
            {
              class: "btn small danger",
              type: "button",
              disabled: ro,
              "aria-label": `${g.name} 그룹 삭제`,
              onclick: () => {
                if (!confirm(`'${g.name}' 그룹을 삭제할까요? 이 그룹으로 지정한 노선은 '그룹 없음'이 돼요. 즐겨찾기는 지워지지 않아요.`)) return;
                store.removeGroup(g.id);
                toast("그룹을 삭제했어요");
              },
            },
            "삭제"
          )
        )
      )
    );
  };

  addBtn.addEventListener("click", () => promptNewGroup());
  store.subscribe(render);
  render();
}
