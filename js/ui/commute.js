// 출근 무지각 체크인 UI (F-CM1~F-CM4, PRD 4.6)
//  - 홈: 날씨(#weather) 바로 아래 영역(#commute)에 연속 무지각 일수(F-CM4)와
//        "탑승 완료"(F-CM2)·"오늘은 쉬는 날"(F-CM3) 버튼. 오늘 이미 기록했으면 버튼 대신 그날 결과.
//  - 설정: "출근 목표 시간"(F-CM1) 입력. 목표 시간이 없으면 홈 영역은 통째로 숨긴다.
// 저장·판정은 전부 js/commute.js (네트워크 호출 없음, 별도 localStorage 키).
import * as commute from "../commute.js";
import { h, toast } from "./dom.js";

let el = null;
let shownDate = null; // 마지막으로 그린 날짜 (자정을 넘기면 다시 그린다)

// ---------- 문구 ----------

const streakText = (streak) => (streak > 0 ? `연속 무지각 ${streak}일째` : "아직 무지각 기록이 없어요");

// 최근 기록 동그라미 (F-CM4): 초록=무지각, 빨강=지각, 회색=쉬는 날.
// 색만으로 구분하지 않는다 — 동그라미 안에 보이는 기호를 넣고, 스크린리더에는 "11월 15일 무지각"처럼 읽힌다
const RESULT_MARK = { ontime: ["✓", "무지각"], late: ["✕", "지각"], off: ["–", "쉬는 날"] };

/** "2026-11-15" → "11월 15일" (형식이 아니면 원문 그대로) */
function fmtDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return String(date || "");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
}

/** 최근 기록(최신순) 동그라미 목록. 기록이 없으면 null */
function historyDots() {
  const recent = commute.recentHistory();
  if (!recent.length) return null;
  return h(
    "ul",
    { class: "cm-dots", "aria-label": "최근 기록 (최신순)" },
    recent.map((e) => {
      const [mark, label] = RESULT_MARK[e.result] || ["?", "기록"];
      return h(
        "li",
        { class: "cm-dot", "data-result": e.result },
        h("span", { class: "cm-mark", "aria-hidden": "true" }, mark),
        h("span", { class: "sr-only" }, `${fmtDate(e.date)} ${label}`)
      );
    })
  );
}

/** 오늘 기록 → 화면 문구. 시각이 없는 옛 기록·쉬는 날은 시각 없이 */
function resultText({ result, time }) {
  if (result === "off") return "오늘은 쉬는 날로 기록했어요";
  if (result === "late") return time ? `오늘은 ${time}에 탑승해서 지각으로 기록됐어요` : "오늘은 지각으로 기록됐어요";
  return time ? `오늘 ${time}에 탑승 완료 · 무지각이에요` : "오늘 탑승 완료 · 무지각이에요";
}

// ---------- 홈 영역 ----------

function render() {
  if (!el) return;
  const state = commute.getCommute();
  // F-CM1: 목표 시간을 정하기 전에는 체크인 UI(연속 일수 포함)를 보여 주지 않는다.
  // 설정 화면의 "출근 무지각 체크인" 항목에서 시작할 수 있다
  if (!state.targetTime) {
    shownDate = null;
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  const now = new Date();
  shownDate = commute.dateKey(now);
  const today = commute.todayResult(now);

  const nodes = [
    // F-CM4: 연속 무지각 일수 + 옆에 최근 기록 5개 동그라미
    h("div", { class: "cm-head" }, h("p", { class: "cm-streak" }, streakText(state.streak)), historyDots()),
  ];
  if (today) {
    nodes.push(h("p", { class: "cm-done" }, resultText(today)));
  } else {
    nodes.push(
      h("p", { class: "cm-target" }, `오늘 목표 ${state.targetTime}까지 탑승하면 무지각이에요`),
      h(
        "div",
        { class: "cm-actions" },
        h("button", { class: "btn primary", type: "button", onclick: onCheckIn }, "탑승 완료"),
        h("button", { class: "btn", type: "button", onclick: onDayOff }, "오늘은 쉬는 날")
      )
    );
  }
  el.replaceChildren(...nodes);
  el.hidden = false;
}

function onCheckIn() {
  const res = commute.checkIn();
  if (!res.ok) return render(); // 자정을 넘겼거나 다른 탭에서 이미 기록함 → 화면만 맞춘다
  toast(
    res.result === "ontime"
      ? `무지각이에요 · 연속 ${res.streak}일째`
      : "목표 시간을 넘겨 지각으로 기록했어요 · 연속 일수는 0부터 다시"
  );
  // 저장 알림(subscribe)으로 다시 그려진다
}

function onDayOff() {
  const res = commute.markDayOff();
  if (!res.ok) return render();
  toast("오늘은 쉬는 날로 기록했어요 · 연속 일수는 그대로예요");
}

/** 홈 패널의 체크인 영역을 연결한다 (home.js가 1회 호출) */
export function initCommute(node) {
  el = node || null;
  commute.subscribe(render);
  render();
}

/**
 * 날짜가 바뀌었으면 다시 그린다 (홈을 열어 둔 채 자정을 넘긴 경우).
 * home.js의 1초 tick에서 부르지만 날짜 문자열 비교뿐이라 거의 비용이 없다.
 */
export function syncCommute() {
  if (!el || el.hidden || !shownDate) return;
  if (shownDate !== commute.dateKey()) render();
}

// ---------- 설정 화면 (F-CM1) ----------

export function initCommuteSettings(panel) {
  const input = panel.querySelector("#commute-target");
  const clearBtn = panel.querySelector("#commute-clear");
  const note = panel.querySelector("#commute-note");
  if (!input) return;

  const sync = () => {
    const state = commute.getCommute();
    if (document.activeElement !== input) input.value = state.targetTime || "";
    clearBtn.hidden = !state.targetTime;
    note.textContent = state.targetTime
      ? `${streakText(state.streak)}. 홈 화면에서 '탑승 완료'를 누르면 ${state.targetTime} 이하일 때 무지각으로 기록돼요.`
      : "목표 시간을 정하면 홈 화면에 '탑승 완료' 버튼과 연속 무지각 일수가 나타나요.";
  };

  input.addEventListener("change", () => {
    // type=time의 값은 "HH:MM" 또는 ""(지움). 형식이 아니면 commute.js가 무시한다
    commute.setTargetTime(input.value || null);
    sync();
  });
  clearBtn.addEventListener("click", () => {
    commute.setTargetTime(null);
    input.value = "";
    sync();
    toast("출근 목표 시간을 지웠어요");
  });
  commute.subscribe(sync);
  sync();
}
