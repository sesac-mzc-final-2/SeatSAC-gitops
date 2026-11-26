#!/usr/bin/env python3
"""6.1.9 오류·보안 리포트 내보내기 (SeatSAC ADR-121) — Loki → 시간별 JSON 줄(gzip) 파일.

CronJob report-export의 initContainer가 실행한다. 표준 라이브러리만 쓴다(이미지에 pip 설치 없음).
S3 업로드는 같은 파드의 aws-cli 컨테이너가 OUT_DIR을 올린다 — 이 스크립트는 AWS 자격 증명을 쓰지 않는다.

  - 대상: namespace cinema-staging 로그 중 errorCategory가 있는 줄(SeatSAC conventions 6장)
  - 기간: 지난 EXPORT_HOURS개의 「끝난」 KST 정시 구간. 같은 시간 파일은 매번 통째로 다시 만든다(멱등) —
          밤에 노드가 꺼져 CronJob을 몇 번 건너뛰어도 아침 첫 실행이 앞 시간을 채운다(Loki 보관 7일 안)
  - 출력: OUT_DIR/dt=YYYY-MM-DD/HH.json.gz (KST 날짜·시) → S3 errors/dt=YYYY-MM-DD/HH.json.gz
          줄이 없는 시간은 파일을 만들지 않는다(ops-api 날짜 목록은 있는 dt=만 보인다)
  - 열: timestamp·service·level·errorCategory·status·path·traceId·message 만 남긴다(Glue 테이블 errors와 같다).
        userId·clientIp·토큰·질문 원문 같은 다른 필드는 버린다. message는 2,000자에서 자른다
"""
from __future__ import annotations

import gzip
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
FIELDS = ("timestamp", "service", "level", "errorCategory", "status", "path", "traceId", "message")
MESSAGE_MAX = 2000
PAGE_LIMIT = 5000  # Loki 기본 max_entries_limit_per_query


def hour_windows(now: datetime, hours: int) -> list[tuple[datetime, datetime]]:
    """지금(now) 바로 앞에서 끝난 KST 정시 구간 hours개, 오래된 것부터."""
    top = now.astimezone(KST).replace(minute=0, second=0, microsecond=0)
    return [(top - timedelta(hours=i), top - timedelta(hours=i - 1)) for i in range(hours, 0, -1)]


def to_row(line: str, stream: dict) -> dict | None:
    """로그 한 줄(JSON) → 리포트 행. errorCategory가 없거나 JSON이 아니면 None."""
    try:
        obj = json.loads(line)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict) or not obj.get("errorCategory"):
        return None
    row = {
        "timestamp": obj.get("timestamp"),
        "service": obj.get("service") or stream.get("app"),
        "level": obj.get("level"),
        "errorCategory": obj.get("errorCategory"),
        "status": obj.get("status"),
        "path": obj.get("path") or obj.get("route") or obj.get("uri"),
        "traceId": obj.get("traceId"),
        "message": obj.get("message"),
    }
    if isinstance(row["message"], str) and len(row["message"]) > MESSAGE_MAX:
        row["message"] = row["message"][:MESSAGE_MAX]
    if row["status"] is not None:
        row["status"] = str(row["status"])
    return {k: row[k] for k in FIELDS}


def loki_page(base: str, query: str, start_ns: int, end_ns: int) -> list[tuple[int, str, dict]]:
    params = urllib.parse.urlencode({
        "query": query, "start": start_ns, "end": end_ns,
        "limit": PAGE_LIMIT, "direction": "forward",
    })
    with urllib.request.urlopen(f"{base}/loki/api/v1/query_range?{params}", timeout=60) as resp:
        body = json.load(resp)
    if body.get("status") != "success":
        raise RuntimeError(f"Loki 응답 status={body.get('status')}")
    out = []
    for stream in body["data"]["result"]:
        labels = stream.get("stream", {})
        for ts, line in stream.get("values", []):
            out.append((int(ts), line, labels))
    out.sort(key=lambda x: x[0])
    return out


def fetch_window(base: str, query: str, start: datetime, end: datetime) -> list[dict]:
    """[start, end) 구간 전부. 한 번에 PAGE_LIMIT를 넘으면 마지막 시각 다음부터 이어 받는다."""
    start_ns = int(start.timestamp() * 1e9)
    end_ns = int(end.timestamp() * 1e9) - 1
    rows, seen = [], set()
    while start_ns <= end_ns:
        page = loki_page(base, query, start_ns, end_ns)
        for ts, line, labels in page:
            key = (ts, line)
            if key in seen:
                continue
            seen.add(key)
            row = to_row(line, labels)
            if row is not None:
                rows.append(row)
        if len(page) < PAGE_LIMIT:
            break
        start_ns = page[-1][0]  # 같은 ns의 나머지 줄을 놓치지 않게 마지막 시각부터 다시(seen으로 중복 제거)
        if len(page) == PAGE_LIMIT and page[0][0] == page[-1][0]:
            start_ns += 1  # 한 ns에 PAGE_LIMIT줄 — 다음으로 넘어간다(무한 반복 방지)
    return rows


def write_hour(out_dir: Path, start: datetime, rows: list[dict]) -> Path | None:
    if not rows:
        return None
    kst = start.astimezone(KST)
    path = out_dir / f"dt={kst:%Y-%m-%d}" / f"{kst:%H}.json.gz"
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return path


def main() -> int:
    base = os.environ.get("LOKI_URL", "http://loki.monitoring.svc:3100").rstrip("/")
    query = os.environ.get("EXPORT_QUERY", '{namespace="cinema-staging"} |= "errorCategory"')
    hours = int(os.environ.get("EXPORT_HOURS", "3"))
    out_dir = Path(os.environ.get("OUT_DIR", "/work/errors"))
    out_dir.mkdir(parents=True, exist_ok=True)

    total = 0
    for start, end in hour_windows(datetime.now(timezone.utc), hours):
        rows = fetch_window(base, query, start, end)
        path = write_hour(out_dir, start, rows)
        total += len(rows)
        print(json.dumps({"window": f"{start.astimezone(KST):%Y-%m-%dT%H}", "rows": len(rows),
                          "file": str(path.relative_to(out_dir)) if path else None}), flush=True)
    print(json.dumps({"done": True, "rows": total}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
