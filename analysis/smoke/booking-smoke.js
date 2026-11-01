// booking 블루/그린 분석용 트래픽 (3.1.6). AnalysisTemplate booking-prepromotion의 Job이 preview Service로 직접 보낸다.
// 목적: preview 파드에 실제 요청을 흘려 Prometheus가 5xx·결제 실패 비율을 재게 하고,
//       응답이 기대한 상태(200)가 아니면 k6가 0이 아닌 코드로 끝나 Job(= preview-traffic 지표)을 실패시킨다.
//       404처럼 5xx가 아닌 고장(회차 조회 경로 깨짐 등)은 Prometheus 5xx 비율로는 안 보이기 때문이다.
// 데이터를 바꾸지 않는 조회만 보낸다. 결제 경로(선점→결제→취소)는 BKG-10(#37) 머지 후 분석 전용 회차로 추가한다(남궁일).
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.TARGET_URL || "http://booking-preview:8080";
// 요청 제한 시간: 기본 60초면 preview가 막 Ready가 된 순간의 연결 하나가 VU 1개를 30초 넘게 붙잡아 그동안 요청이 0건이 된다
const PARAMS = { timeout: "5s" };
const SCREENING_ID = __ENV.SMOKE_SCREENING_ID;
if (!SCREENING_ID) {
  throw new Error("SMOKE_SCREENING_ID가 없다 — 시드에 있는 실제 회차 ID를 AnalysisTemplate env로 넘긴다");
}

export const options = {
  vus: 1,
  duration: __ENV.DURATION || "6m",
  setupTimeout: "180s",   // 아래 setup()의 Ready 대기 150초 + 여유 (본 요청 시간 duration과 별도)
  summaryTrendStats: ["avg", "p(95)"],
  // 95% 미만이면 종료 코드 99 → Job 실패 → 분석 실패 (일시적인 1~2건은 봐준다)
  thresholds: { checks: ["rate>=0.95"] },
};

export function setup() {
  // 횟수가 아니라 시간으로 센다(요청이 timeout까지 걸리면 횟수 기준은 길어진다).
  // 150초 = startupProbe 최대(5초 × 30). AnalysisTemplate initialDelay 4m이 이 값을 전제로 한다
  const deadline = Date.now() + 150 * 1000;
  while (Date.now() < deadline) {
    const r = http.get(`${BASE}/actuator/health/readiness`, { timeout: "2s", tags: { name: "wait-ready" } });
    if (r.status === 200) return;
    sleep(2);
  }
  throw new Error("preview가 150초 안에 Ready가 되지 않았다");
}

export default function () {
  // BKG-01 좌석 현황: catalog 회차 확인(파드 캐시) → Valkey 선점 + RDS 확정 좌석 집계. 실제 회차여야 끝까지 탄다
  const seats = http.get(`${BASE}/screenings/${SCREENING_ID}/seats`, { ...PARAMS, tags: { name: "seats" } });
  check(seats, { "seats 200": (r) => r.status === 200 });
  // 내부 좌석 수(catalog → booking 경로와 같은 API): RDS 집계. 없는 회차도 200 + 0건
  const counts = http.get(`${BASE}/internal/screenings/seat-counts?ids=${SCREENING_ID}`, { ...PARAMS, tags: { name: "seat-counts" } });
  check(counts, { "seat-counts 200": (r) => r.status === 200 });
  sleep(1);
}
