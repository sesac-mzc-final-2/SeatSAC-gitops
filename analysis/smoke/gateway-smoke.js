// gateway 블루/그린 분석용 트래픽 (3.1.6). AnalysisTemplate gateway-prepromotion의 Job이 preview Service로 직접 보낸다.
// 인증 없는 조회만 보낸다(토큰을 Job에 두지 않는다). /api 접두사는 gateway가 지운다(StripPrefix=1).
// 응답이 200이 아니면(라우트·StripPrefix가 깨져 404 등) k6가 0이 아닌 코드로 끝나 Job(= preview-traffic 지표)을 실패시킨다.
// 5xx 비율 판정은 Prometheus 지표가 한다.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.TARGET_URL || "http://gateway-preview:8080";

export const options = {
  vus: 1,
  duration: __ENV.DURATION || "4m30s",
  summaryTrendStats: ["avg", "p(95)"],
  thresholds: { checks: ["rate>=0.95"] },   // 95% 미만이면 종료 코드 99 → 분석 실패
};

export default function () {
  const movies = http.get(`${BASE}/api/movies?page=0&size=5`, { tags: { name: "movies" } });   // → catalog
  check(movies, { "movies 200": (r) => r.status === 200 });
  const theaters = http.get(`${BASE}/api/theaters`, { tags: { name: "theaters" } });           // → catalog
  check(theaters, { "theaters 200": (r) => r.status === 200 });
  sleep(1);
}
