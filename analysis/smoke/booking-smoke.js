// booking 블루/그린 분석용 트래픽 (3.1.6). AnalysisTemplate booking-prepromotion의 Job이 preview Service로 직접 보낸다.
// 목적: preview 파드에 실제 요청을 흘려 Prometheus가 5xx·결제 실패 비율을 재게 하고,
//       응답이 기대한 상태(200)가 아니면 k6가 0이 아닌 코드로 끝나 Job(= preview-traffic 지표)을 실패시킨다.
//       404처럼 5xx가 아닌 고장(회차 조회 경로 깨짐 등)은 Prometheus 5xx 비율로는 안 보이기 때문이다.
//
// 두 갈래가 있다.
//   ① 조회 (항상) — 데이터를 바꾸지 않는다. SMOKE_SCREENING_ID
//   ② 결제 (SMOKE_PAY_SCREENING_ID가 있을 때만) — 선점 → 거절 카드 결제. 아래 「결제 갈래」 참고
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.TARGET_URL || "http://booking-preview:8080";
const SCREENING_ID = __ENV.SMOKE_SCREENING_ID;
if (!SCREENING_ID) {
  throw new Error("SMOKE_SCREENING_ID가 없다 — 시드에 있는 실제 회차 ID를 AnalysisTemplate env로 넘긴다");
}

// ── 결제 갈래 ─────────────────────────────────────────────────────────────────
// 왜 필요한가: booking 자동 롤백 조건이 booking_payment_call_total{result=~"timeout|error"} 비율인데,
//   조회만 보내면 분모가 0이라 「결제 호출 0건이면 통과」로 빠진다. 즉 payment 연결이 깨진 버전도 통과한다.
// 왜 거절 카드인가(끝 0000 → CARD_DECLINED, ADR-13): 승인하면 좌석이 영구히 팔려 상영관이 비고
//   확정 알림(SQS)까지 나간다. 거절은 좌석이 바로 풀려 다음 주기가 같은 좌석을 다시 쓸 수 있고,
//   result=declined 는 롤백 판정에서 제외되는 값이라 정상 동작이 롤백을 유발하지 않는다.
//   그러면서 booking → payment 왕복은 실제로 타므로 timeout·error 는 그대로 드러난다.
// 왜 회차를 따로 받나: 선점은 startsAt > now 만 되므로(400 SCREENING_STARTED) 조회용 지난 회차를 쓸 수 없다.
//   SMOKE_PAY_SCREENING_ID 는 「시드에 있는 미래 회차」여야 한다(런북 6-D-0).
// 비어 있으면 이 갈래를 아예 돌지 않는다 — 시드 적재·검증 전에는 켜지 않는다.
const PAY_SCREENING_ID = __ENV.SMOKE_PAY_SCREENING_ID || "";
// 몇 번째 주기마다 결제를 태울지. 1주기 ≈ 1초라 3이면 4분 30초에 약 30건 — 비율 분모로 충분하고
// 남는 데이터(거절 결제 행)도 배포당 30건 수준이다
const PAY_EVERY = Number(__ENV.SMOKE_PAY_EVERY || "3");
// Gateway를 지나지 않고 booking에 직접 보내므로 X-User-Id를 직접 넣는다(UUID가 아니면 401).
// 분석 전용 가짜 사용자다 — Cognito 계정이 아니고 비밀도 아니다. 회차당 선점 1건 규칙 때문에 고정값을 쓴다.
const SMOKE_USER_ID = __ENV.SMOKE_USER_ID || "00000000-0000-4000-8000-00000000c1a0";
// 끝 네 자리가 0000이면 거절 (ADR-13)
const DECLINED_CARD = { number: "4242424242420000", expiry: "12/30", holder: "SMOKE" };

export const options = {
  vus: 1,
  duration: __ENV.DURATION || "4m30s",
  summaryTrendStats: ["avg", "p(95)"],
  // 95% 미만이면 종료 코드 99 → Job 실패 → 분석 실패 (일시적인 1~2건은 봐준다)
  thresholds: { checks: ["rate>=0.95"] },
};

/** 멱등 키용 UUID v4 모양. k6 런타임에 따라 crypto가 없을 수 있어 Math.random으로 만든다 */
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const userHeaders = () => ({ "X-User-Id": SMOKE_USER_ID, "X-User-Role": "USER" });

function body(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

const errorCode = (response) => {
  const parsed = body(response);
  return parsed && typeof parsed.code === "string" ? parsed.code : "";
};

/** 선점을 풀어 다음 주기가 ACTIVE_HOLD_EXISTS로 막히지 않게 한다 */
function releaseHold(bookingId) {
  http.del(`${BASE}/bookings/${bookingId}/hold`, null, {
    headers: { ...userHeaders(), "Idempotency-Key": uuid() },
    tags: { name: "release" },
  });
}

/** 첫 AVAILABLE 좌석 ID (없으면 null) */
function firstAvailableSeat(screeningId) {
  const response = http.get(`${BASE}/screenings/${screeningId}/seats`, { tags: { name: "pay-seats" } });
  if (!check(response, { "pay-seats 200": (r) => r.status === 200 })) return null;
  const parsed = body(response);
  const seats = parsed && Array.isArray(parsed.seats) ? parsed.seats : [];
  const free = seats.find((seat) => seat.status === "AVAILABLE");
  return free ? free.seatId : null;
}

function payPath() {
  const seatId = firstAvailableSeat(PAY_SCREENING_ID);
  // 좌석이 전부 차 있으면 이번 주기는 넘긴다 (고장이 아니다)
  if (seatId === null) return;

  const hold = http.post(
    `${BASE}/seats/hold`,
    JSON.stringify({ screeningId: Number(PAY_SCREENING_ID), seatIds: [seatId] }),
    {
      headers: { ...userHeaders(), "Content-Type": "application/json", "Idempotency-Key": uuid() },
      tags: { name: "hold" },
    },
  );

  const code = hold.status === 409 ? errorCode(hold) : "";
  if (code === "ACTIVE_HOLD_EXISTS") {
    // 지난 주기(또는 abort된 분석)가 남긴 선점 — 풀고 다음 주기에 다시 한다. 고장이 아니다
    const details = body(hold);
    const left = details && Array.isArray(details.details) ? details.details : [];
    const found = left.find((detail) => detail.field === "bookingId");
    if (found) releaseHold(found.value);
    return;
  }
  // 분석 중에 사람이 같은 좌석을 잡는 경우도 고장이 아니다
  if (code === "SEAT_UNAVAILABLE") return;

  if (!check(hold, { "hold 201": (r) => r.status === 201 })) return;

  const booking = body(hold);
  const bookingId = booking ? booking.bookingId : null;
  if (bookingId === null) {
    check(null, { "hold 응답에 bookingId": () => false });
    return;
  }

  // 거절 카드 — booking → payment 왕복을 타고, 응답은 200 + PAYMENT_FAILED 여야 한다
  const pay = http.post(`${BASE}/bookings/${bookingId}/pay`, JSON.stringify({ method: "CARD", card: DECLINED_CARD }), {
    headers: { ...userHeaders(), "Content-Type": "application/json", "Idempotency-Key": uuid() },
    tags: { name: "pay" },
  });

  const settled = check(pay, {
    "pay 200": (r) => r.status === 200,
    "pay 거절로 끝남": (r) => {
      const parsed = body(r);
      return Boolean(parsed) && parsed.status === "PAYMENT_FAILED";
    },
  });

  // 거절이면 좌석이 이미 풀렸다. 그 밖이면(503 PAYMENT_RESULT_UNKNOWN 등) 선점이 남아 다음 주기를 막는다
  if (!settled) releaseHold(bookingId);
}

export default function () {
  // BKG-01 좌석 현황: catalog 회차 확인(파드 캐시) → Valkey 선점 + RDS 확정 좌석 집계. 실제 회차여야 끝까지 탄다
  const seats = http.get(`${BASE}/screenings/${SCREENING_ID}/seats`, { tags: { name: "seats" } });
  check(seats, { "seats 200": (r) => r.status === 200 });
  // 내부 좌석 수(catalog → booking 경로와 같은 API): RDS 집계. 없는 회차도 200 + 0건
  const counts = http.get(`${BASE}/internal/screenings/seat-counts?ids=${SCREENING_ID}`, { tags: { name: "seat-counts" } });
  check(counts, { "seat-counts 200": (r) => r.status === 200 });

  if (PAY_SCREENING_ID && __ITER % PAY_EVERY === 0) payPath();

  sleep(1);
}
