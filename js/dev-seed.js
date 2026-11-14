// ===================== DEV-ONLY: 개발용 테스트 정류장 =====================
// 즐겨찾기가 비었을 때 빈 화면에 "[개발용] 테스트 정류장 추가" 버튼을 보여준다.
// localhost / 127.0.0.1 에서만 보인다.
// 지우는 방법: 이 파일을 삭제하고, js/app.js 에서 "DEV-ONLY" 표시가 있는 줄 2개를 지운다.
// ==========================================================================
import { tryAddStop, ADD_STOP_MESSAGES } from "./store.js";
import { h, toast } from "./ui/dom.js";

const DEV_STOP = { cityCode: 25, nodeId: "DJB8001793", name: "송강전통시장", routes: [] };

export function devSeedButton() {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return null;
  return h(
    "button",
    {
      class: "btn dev",
      type: "button",
      onclick: () => {
        const r = tryAddStop(DEV_STOP);
        if (!r.ok) toast(ADD_STOP_MESSAGES[r.reason]);
      },
    },
    "[개발용] 테스트 정류장 추가 (대전 송강전통시장)"
  );
}
