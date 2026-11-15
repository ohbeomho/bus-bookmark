// PWA 설치·업데이트 안내 (PRD 9장 P-2, P-4, P-5)
//  - 서비스워커 등록 + "새 버전이 있어요" 안내
//  - Android(Chromium): beforeinstallprompt를 저장해 두었다가 설정 화면의 "앱으로 설치" 버튼으로 보여 준다
//  - iOS Safari: 설치 이벤트가 없으므로 첫 방문에 1회 "공유 → 홈 화면에 추가" 안내
//  - 설정의 "앱 설치" 항목은 항상 보인다 (P-6): PWA 설명 + 지금 기기·브라우저에 맞는 설치 방법 한 줄.
//    문구는 index.html에 정적으로 있고(인라인 스크립트는 CSP에 막힘) 여기서는 data-os로 하나만 골라 보여 준다
import { h } from "./dom.js";

const IOS_TIP_KEY = "bus-bookmark:ios-install-tip";
const UPDATE_CHECK_MS = 60 * 60 * 1000; // 앱을 켜 둔 채 다시 볼 때 이 간격이 지났으면 새 버전 확인

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// ---------- 서비스워커 ----------
/** load 이벤트 이후에 등록한다 (첫 화면 로딩과 경쟁하지 않게). HTTPS 또는 localhost에서만 동작 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const bar = document.getElementById("update-banner");
  let reloading = false; // 이 페이지에서 "새로고침"을 눌렀을 때만 controllerchange에서 다시 불러온다

  const showUpdate = (worker) => {
    bar.hidden = false;
    const btn = bar.querySelector("button");
    btn.onclick = () => {
      btn.disabled = true;
      if (worker) {
        reloading = true;
        worker.postMessage({ type: "SKIP_WAITING" });
      } else location.reload();
    };
  };

  const register = () =>
    navigator.serviceWorker.register("sw.js").then((reg) => {
      // 이미 대기 중인 새 버전 (이전 방문에서 받아 둠)
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          // controller가 있을 때만: 첫 설치는 "새 버전"이 아니다
          if (w.state === "installed" && navigator.serviceWorker.controller) showUpdate(w);
        });
      });
      let last = Date.now();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - last > UPDATE_CHECK_MS) {
          last = Date.now();
          reg.update().catch(() => {}); // 오프라인이면 조용히 실패
        }
      });
    });

  // 새 SW가 제어권을 가져갔다
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return location.reload();
    // 다른 탭에서 업데이트를 적용한 경우: 이 페이지는 옛 버전 코드라 파일이 섞일 수 있으니 새로고침을 권한다
    if (hadController) showUpdate(null);
    hadController = true; // 첫 설치(clients.claim)는 안내하지 않는다
  });

  const go = () => register().catch((e) => console.warn("[sw] 등록 실패", e));
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}

// ---------- 설치 ----------
export function initInstall() {
  const btn = document.getElementById("install-btn");
  const how = document.getElementById("install-how");
  const done = document.getElementById("install-done");
  const tips = [...document.querySelectorAll(".install-tip[data-os]")];
  let deferred = null;

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const iosSafari = ios && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);

  /** 지금 기기·브라우저에 맞는 설치 방법 (UA 추정이라 틀릴 수 있어, 전체 목록도 펼쳐 볼 수 있게 둔다) */
  const platform = () => {
    if (deferred) return "prompt"; // 설치 이벤트를 받았으면 버튼 하나로 끝
    if (ios) return iosSafari ? "ios-safari" : "ios-other";
    if (/SamsungBrowser/.test(ua)) return "samsung";
    if (/Android/.test(ua)) return "android";
    if (/Firefox\//.test(ua)) return "unsupported"; // 데스크톱 Firefox는 PWA 설치 기능이 없다
    if (/Macintosh/.test(ua) && !/Chrome|Edg\//.test(ua)) return "mac-safari"; // 파일 메뉴 → Dock에 추가
    return "desktop";
  };

  const render = () => {
    const installed = isStandalone();
    done.hidden = !installed;
    how.hidden = installed;
    btn.hidden = !deferred || installed;
    const os = platform();
    for (const t of tips) t.hidden = installed || t.dataset.os !== os;
  };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // 브라우저 기본 배너 대신 설정 화면 버튼으로
    deferred = e;
    render();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    render();
  });
  matchMedia("(display-mode: standalone)").addEventListener?.("change", render);

  btn.addEventListener("click", async () => {
    if (!deferred) return;
    const p = deferred;
    deferred = null; // prompt()는 한 번만 쓸 수 있다
    render();
    p.prompt();
    await p.userChoice.catch(() => {});
  });

  render();
  if (iosSafari && !isStandalone()) showIosTip();
}

/** iOS Safari 첫 방문 1회. 보여 주는 순간 기록한다 (닫지 않고 지나가도 다시 뜨지 않음) */
function showIosTip() {
  try {
    if (localStorage.getItem(IOS_TIP_KEY)) return;
    localStorage.setItem(IOS_TIP_KEY, "1");
  } catch {
    return; // 저장이 막혀 있으면 매번 뜨게 되므로 아예 띄우지 않는다
  }
  const tip = document.getElementById("ios-tip");
  tip.replaceChildren(
    h("span", null, "홈 화면에 추가하면 앱처럼 열려요: 아래 공유 버튼(□↑)을 누르고 '홈 화면에 추가'를 선택하세요."),
    h("button", { class: "btn small", type: "button", onclick: () => (tip.hidden = true) }, "닫기")
  );
  tip.hidden = false;
}
