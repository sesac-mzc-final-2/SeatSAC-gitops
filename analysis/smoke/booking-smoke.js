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
import exec from "k6/execution";

const BASE = __ENV.TARGET_URL || "http://booking-preview:8080";
// 요청 제한 시간: 기본 60초면 preview가 막 Ready가 된 순간의 연결 하나가 VU 1개를 30초 넘게 붙잡아 그동안 요청이 0건이 된다
const PARAMS = { timeout: "5s" };
// 결제는 booking → payment(연결 1초·응답 3초, 타임아웃이면 같은 paymentId로 1회 재호출 → 조회)를 타서
// payment가 느리기만 해도 5초를 넘을 수 있다. 그때 k6가 먼저 끊으면 booking 지표는 정상인데 Job만 실패한다
const PAY_PARAMS = { timeout: "12s" };
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
// 몇 번째 주기마다 결제를 태울지. 1주기 ≈ 1초(sleep 1 + 요청)라 3이면 분당 약 20건, 6분에 최대 약 120건 —
// 1분 창 비율의 분모로 충분하다. 남는 데이터는 거절 결제 행(payment_db)이 배포당 100건 안팎이다
const PAY_EVERY = Number(__ENV.SMOKE_PAY_EVERY || "3");
// 0·음수·숫자 아님이면 `__ITER % PAY_EVERY === 0`이 늘 거짓이라 결제를 조용히 건너뛴다 →
// 결제 호출 0건은 롤백 판정에서 「통과」라 payment 연결이 깨진 버전도 넘어간다. 켰을 때는 시작 전에 멈춘다
if (PAY_SCREENING_ID && !(Number.isInteger(PAY_EVERY) && PAY_EVERY >= 1)) {
  throw new Error(`SMOKE_PAY_EVERY가 1 이상의 정수가 아니다('${__ENV.SMOKE_PAY_EVERY}')`);
}
// Gateway를 지나지 않고 booking에 직접 보내므로 X-User-Id를 직접 넣는다(UUID가 아니면 401).
// 분석 전용 가짜 사용자다 — Cognito 계정이 아니고 비밀도 아니다. 회차당 선점 1건 규칙 때문에 고정값을 쓴다.
const SMOKE_USER_ID = __ENV.SMOKE_USER_ID || "00000000-0000-4000-8000-00000000c1a0";
// 끝 네 자리가 0000이면 거절 (ADR-13)
const DECLINED_CARD = { number: "4242424242420000", expiry: "12/30", holder: "SMOKE" };

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
    ...PARAMS,
    headers: { ...userHeaders(), "Idempotency-Key": uuid() },
    tags: { name: "release" },
  });
}

/** 첫 AVAILABLE 좌석 ID (없으면 null) */
function firstAvailableSeat(screeningId) {
  const response = http.get(`${BASE}/screenings/${screeningId}/seats`, { ...PARAMS, tags: { name: "pay-seats" } });
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
      ...PARAMS,
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
  // 본문은 있는데 bookingId가 빠진 경우(undefined)도 같이 잡는다 — 아니면 /bookings/undefined/pay를 부른다.
  // 계약상 필수 필드라 빠졌으면 응답 형식이 깨진 버전이다. check 하나로는 조회 check에 묻혀 95%를 넘고
  // 결제 0건이라 결제 실패율도 통과하므로, 그 자리에서 테스트를 멈춰 Job(= 분석)을 실패시킨다
  if (bookingId == null) {
    check(null, { "hold 응답에 bookingId": () => false });
    exec.test.abort("hold 201 응답에 bookingId가 없다 — 선점 응답 형식이 계약(HoldResult)과 다르다");
  }

  // 거절 카드 — booking → payment 왕복을 타고, 응답은 200 + PAYMENT_FAILED 여야 한다
  const pay = http.post(`${BASE}/bookings/${bookingId}/pay`, JSON.stringify({ method: "CARD", card: DECLINED_CARD }), {
    ...PAY_PARAMS,
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
  const seats = http.get(`${BASE}/screenings/${SCREENING_ID}/seats`, { ...PARAMS, tags: { name: "seats" } });
  check(seats, { "seats 200": (r) => r.status === 200 });
  // 내부 좌석 수(catalog → booking 경로와 같은 API): RDS 집계. 없는 회차도 200 + 0건
  const counts = http.get(`${BASE}/internal/screenings/seat-counts?ids=${SCREENING_ID}`, { ...PARAMS, tags: { name: "seat-counts" } });
  check(counts, { "seat-counts 200": (r) => r.status === 200 });

  if (PAY_SCREENING_ID && __ITER % PAY_EVERY === 0) payPath();

  sleep(1);
}
