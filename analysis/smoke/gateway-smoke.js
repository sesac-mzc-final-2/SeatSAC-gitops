// gateway 블루/그린 분석용 트래픽 (3.1.6). AnalysisTemplate gateway-prepromotion의 Job이 preview Service로 직접 보낸다.
// 인증 없는 조회만 보낸다(토큰을 Job에 두지 않는다). /api 접두사는 gateway가 지운다(StripPrefix=1).
// 응답이 200이 아니면(라우트·StripPrefix가 깨져 404 등) k6가 0이 아닌 코드로 끝나 Job(= preview-traffic 지표)을 실패시킨다.
// 5xx 비율 판정은 Prometheus 지표가 한다.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.TARGET_URL || "http://gateway-preview:8080";
// 요청 제한 시간: 기본 60초면 preview가 막 Ready가 된 순간의 연결 하나가 VU 1개를 30초 넘게 붙잡아 그동안 요청이 0건이 된다
const PARAMS = { timeout: "5s" };

export const options = {
  vus: 1,
  duration: __ENV.DURATION || "5m30s",
  setupTimeout: "200s",   // 아래 setup()의 Ready 대기 (본 요청 시간 duration과 별도)
  summaryTrendStats: ["avg", "p(95)"],
  thresholds: { checks: ["rate>=0.95"] },   // 95% 미만이면 종료 코드 99 → 분석 실패
};

// 분석은 preview 확장과 동시에 시작한다(Ready 전) → preview가 Ready가 될 때까지 기다린 뒤 본 요청을 보낸다.
// 기다리는 동안의 connection refused가 checks(95%)를 깎지 않게 하려는 것. actuator 요청은 preview-requests 지표에서 빠진다
export function setup() {
  for (let i = 0; i < 90; i++) {   // 2초 × 90 = 최대 180초 (startupProbe 최대 150초 + 여유)
    const r = http.get(`${BASE}/actuator/health/readiness`, { timeout: "2s", tags: { name: "wait-ready" } });
    if (r.status === 200) return;
    sleep(2);
  }
  throw new Error("preview가 180초 안에 Ready가 되지 않았다");
}

export default function () {
  const movies = http.get(`${BASE}/api/movies?page=0&size=5`, { ...PARAMS, tags: { name: "movies" } });   // → catalog
  check(movies, { "movies 200": (r) => r.status === 200 });
  const theaters = http.get(`${BASE}/api/theaters`, { ...PARAMS, tags: { name: "theaters" } });           // → catalog
  check(theaters, { "theaters 200": (r) => r.status === 200 });
  sleep(1);
}
