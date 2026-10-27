// booking 블루/그린 분석용 트래픽 (3.1.6). AnalysisTemplate booking-prepromotion의 Job이 preview Service로 직접 보낸다.
// 목적은 "preview 파드에 실제 요청을 흘려 5xx·결제 실패 비율을 잴 수 있게" 하는 것 — 판정은 Prometheus 쿼리가 한다.
// 그래서 이 스크립트에는 임계값(thresholds)이 없고 오류가 나도 0으로 끝난다(오류율 판정을 k6가 하면 두 곳에서 갈린다).
// 데이터를 바꾸지 않는 조회만 보낸다. 결제 경로(선점→결제→취소)는 BKG-10(#37) 머지 후 남궁일과 함께 추가한다.
import http from "k6/http";
import { sleep } from "k6";

const BASE = __ENV.TARGET_URL || "http://booking-preview:8080";
const SCREENING_ID = __ENV.SMOKE_SCREENING_ID || "1";

export const options = {
  vus: 1,
  duration: __ENV.DURATION || "3m30s",
  noConnectionReuse: false,
  summaryTrendStats: ["avg", "p(95)"],
};

export default function () {
  // BKG-01 좌석 현황: Valkey + RDS + (파드 캐시 없으면) catalog 내부 호출까지 탄다. 없는 회차는 404(5xx 아님)
  http.get(`${BASE}/screenings/${SCREENING_ID}/seats`, { tags: { name: "seats" } });
  // 내부 좌석 수(catalog → booking 경로와 같은 API): RDS 조회
  http.get(`${BASE}/internal/screenings/seat-counts?ids=${SCREENING_ID}`, { tags: { name: "seat-counts" } });
  sleep(1);
}
