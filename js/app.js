// 앱 진입점: 하단 탭 전환(해시 라우팅), 화면 표시 상태(Page Visibility) 관리
import { initHome, setHomeActive, onOnline, onOffline, primeArrivals, peekArrivals } from "./ui/home.js";
import { initSettings } from "./ui/settings.js";
import { initInstall, registerServiceWorker } from "./ui/install.js";

const TABS = ["home", "map", "settings"];
const TITLES = { home: "즐겨찾기", map: "지도", settings: "설정" };
const main = document.getElementById("main");

const currentTab = () => {
  const t = location.hash.slice(1);
  return TABS.includes(t) ? t : "home";
};

// 홈 탭이 보이고 페이지가 화면에 있을 때만 자동 새로고침·카운트다운
const updateActive = () => setHomeActive(currentTab() === "home" && document.visibilityState === "visible");

function showTab() {
  const tab = currentTab();
  for (const t of TABS) {
    document.getElementById(`panel-${t}`).hidden = t !== tab;
    const link = document.querySelector(`.tabbar a[href="#${t}"]`);
    if (t === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.getElementById("app-title").textContent = TITLES[tab];
  document.body.dataset.tab = tab;
  main.scrollTop = 0;
  updateActive();
  // 지도·위치 권한은 지도 탭을 처음 열 때 시작한다 (앱 시작 시 요청하지 않음).
  // 지도 모듈은 홈 첫 화면에 필요 없으므로 이때 불러온다
  if (tab === "map") {
    import("./map.js")
      .then((m) => m.showMap(document.getElementById("panel-map"), { onArrivals: primeArrivals, peekArrivals }))
      .catch((e) => console.error("[app] 지도 모듈을 불러오지 못했습니다", e));
  } else if (tab === "settings") showTilesDate();
}

/** 설정의 정류장 데이터 수집일 (F-D5) */
function showTilesDate() {
  const el = document.getElementById("tiles-date");
  import("./tiles.js").then((t) => t.loadIndex()).then(
    (m) => (el.textContent = m.collectedAt || "알 수 없음"),
    () => (el.textContent = "확인하지 못함")
  );
}

function updateOnline() {
  document.getElementById("offline-banner").hidden = navigator.onLine !== false;
}

initHome(document.getElementById("panel-home"));
initSettings(document.getElementById("panel-settings"));
initInstall();
registerServiceWorker();

window.addEventListener("hashchange", showTab);
document.addEventListener("visibilitychange", updateActive);
window.addEventListener("online", () => {
  updateOnline();
  onOnline();
});
window.addEventListener("offline", () => {
  updateOnline();
  onOffline();
});

updateOnline();
showTab();
