// gateway 블루/그린 분석용 트래픽 (3.1.6). AnalysisTemplate gateway-prepromotion의 Job이 preview Service로 직접 보낸다.
// 인증 없는 조회만 보낸다(토큰을 Job에 두지 않는다). /api 접두사는 gateway가 지운다(StripPrefix=1).
// 판정은 Prometheus 쿼리가 한다 → 임계값 없음, 오류가 나도 0으로 끝난다.
import http from "k6/http";
import { sleep } from "k6";

const BASE = __ENV.TARGET_URL || "http://gateway-preview:8080";

export const options = {
  vus: 1,
  duration: __ENV.DURATION || "3m30s",
  summaryTrendStats: ["avg", "p(95)"],
};

export default function () {
  http.get(`${BASE}/api/movies?page=0&size=5`, { tags: { name: "movies" } });   // → catalog
  http.get(`${BASE}/api/theaters`, { tags: { name: "theaters" } });             // → catalog
  sleep(1);
}
