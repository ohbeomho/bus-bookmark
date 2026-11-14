// 작은 DOM 도우미. API·사용자 문자열은 textContent로만 넣는다 (innerHTML 사용 안 함).

/** h("button", { class: "x", onclick: fn, "aria-label": "..." }, child1, child2...) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

let toastTimer;
/** 화면 하단 알림 + 스크린리더 안내 (role=status) */
export function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  // 모달(바텀시트)이 열려 있으면 바깥은 inert라 보이지도·읽히지도 않으므로 열린 dialog 안으로 옮긴다
  const host = document.querySelector("dialog[open]") || document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

export const fmtClock = (ms) =>
  new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
