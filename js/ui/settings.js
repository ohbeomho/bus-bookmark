// 설정 화면: 자동 새로고침 간격 (F-D3), 즐겨찾기 그룹 관리 (F-G1), 출근 목표 시간 (F-CM1).
// 출처·개인정보 안내(F-D5)는 index.html 정적 문구.
import { getSettings, setSettings } from "../store.js";
import { initGroupSettings } from "./groups.js";
import { initCommuteSettings } from "./commute.js";

export function initSettings(panel) {
  initGroupSettings(panel);
  // 출근 무지각 체크인은 즐겨찾기와 저장소가 다른 별도 기능이라 설정도 자기 모듈이 맡는다
  initCommuteSettings(panel);
  const radios = panel.querySelectorAll('input[name="refreshSec"]');
  const sync = () => {
    const cur = String(getSettings().refreshSec);
    radios.forEach((r) => (r.checked = r.value === cur));
  };
  radios.forEach((r) => r.addEventListener("change", () => r.checked && setSettings({ refreshSec: Number(r.value) })));
  sync();
  window.addEventListener("storage", sync);
}
