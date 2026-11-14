// 버스 도착정보 프록시 (Cloudflare Workers)
// - 서비스키는 코드에 넣지 않고, Cloudflare 대시보드의 Secret(SERVICE_KEY)에 저장합니다.
// - 프론트엔드 호출 예: https://<워커주소>/arrivals?cityCode=25&nodeId=DJB8001793

// 내 사이트 주소만 허용 (배포 후 실제 주소로 바꾸세요. 로컬 개발용 주소도 함께)
const ALLOWED_ORIGINS = [
  "https://내아이디.github.io", // TODO: 배포 후 실제 주소로 바꾼 뒤 cloudflare에서 수정
  "http://localhost:5500",
];

const API_URL =
  "https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== "/arrivals") {
      return new Response("Not found", { status: 404, headers: cors });
    }

    // 다른 사이트에서 이 함수를 가져다 쓰는 것을 막음
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response("Forbidden", { status: 403, headers: cors });
    }

    const cityCode = url.searchParams.get("cityCode");
    const nodeId = url.searchParams.get("nodeId");
    if (!/^\d{1,9}$/.test(cityCode || "") || !/^[A-Za-z0-9]{1,30}$/.test(nodeId || "")) {
      return new Response("Bad request", { status: 400, headers: cors });
    }

    // SERVICE_KEY에는 공공데이터포털의 'Decoding' 키를 저장 (URLSearchParams가 인코딩해 줌)
    const params = new URLSearchParams({
      serviceKey: env.SERVICE_KEY,
      cityCode,
      nodeId,
      numOfRows: "100",
      _type: "json",
    });

    try {
      const res = await fetch(`${API_URL}?${params}`);
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "upstream_failed" }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },
};
