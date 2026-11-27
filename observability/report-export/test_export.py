#!/usr/bin/env python3
"""export.py 단위 테스트 — Loki 없이 가짜 응답으로. python3 -m unittest observability/report-export/test_export.py"""
import gzip
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export  # noqa: E402


def line(**kw):
    return json.dumps(kw)


class HourWindows(unittest.TestCase):
    def test_finished_kst_hours_oldest_first(self):
        now = datetime(2026, 11, 26, 18, 7, tzinfo=timezone.utc)  # KST 11/27 03:07
        w = export.hour_windows(now, 3)
        self.assertEqual([f"{s.astimezone(export.KST):%m-%d %H}" for s, _ in w], ["11-27 00", "11-27 01", "11-27 02"])
        self.assertTrue(all((e - s).total_seconds() == 3600 for s, e in w))

    def test_current_hour_is_appended_up_to_now(self):
        now = datetime(2026, 11, 26, 18, 27, tzinfo=timezone.utc)  # KST 11/27 03:27
        w = export.hour_windows(now, 3, current=True)
        self.assertEqual([f"{s.astimezone(export.KST):%H}" for s, _ in w], ["00", "01", "02", "03"])
        self.assertEqual(w[-1][1], now)  # 진행 중인 시간은 지금까지만
        # 정시 딱 맞으면 진행 중인 구간이 비어 더하지 않는다
        on_the_hour = datetime(2026, 11, 26, 18, 0, tzinfo=timezone.utc)
        self.assertEqual(len(export.hour_windows(on_the_hour, 3, current=True)), 3)


class ToRow(unittest.TestCase):
    def test_keeps_only_report_columns(self):
        row = export.to_row(line(timestamp="t", level="WARN", service="gateway", errorCategory="SECURITY",
                                 status=401, route="/api/seats/hold", traceId="a" * 32, message="m",
                                 userId="u-1", clientIp="***", reason="INVALID_TOKEN"), {})
        self.assertEqual(list(row), list(export.FIELDS))
        self.assertEqual(row["status"], "401")
        self.assertEqual(row["path"], "/api/seats/hold")
        self.assertNotIn("userId", row)
        self.assertNotIn("clientIp", row)

    def test_skips_lines_without_category_or_not_json(self):
        self.assertIsNone(export.to_row(line(message="ok", level="INFO"), {}))
        self.assertIsNone(export.to_row(line(errorCategory=""), {}))
        self.assertIsNone(export.to_row("plain text errorCategory", {}))
        self.assertIsNone(export.to_row("[1,2]", {}))

    def test_service_from_stream_and_message_cut(self):
        row = export.to_row(line(errorCategory="INTERNAL", message="x" * 5000), {"app": "booking"})
        self.assertEqual(row["service"], "booking")
        self.assertEqual(len(row["message"]), export.MESSAGE_MAX)


class FetchAndWrite(unittest.TestCase):
    def test_paginates_and_dedupes(self):
        start = datetime(2026, 11, 27, 1, tzinfo=export.KST)
        base_ns = int(start.timestamp() * 1e9)
        first = [(base_ns + i, line(errorCategory="TIMEOUT", message=str(i)), {}) for i in range(export.PAGE_LIMIT)]
        second = [first[-1], (base_ns + 10**9, line(errorCategory="TIMEOUT", message="last"), {})]
        with mock.patch.object(export, "loki_page", side_effect=[first, second]) as page:
            rows = export.fetch_window("http://loki", "q", start, start.replace(hour=2))
        self.assertEqual(page.call_count, 2)
        self.assertEqual(len(rows), export.PAGE_LIMIT + 1)  # 겹친 마지막 줄은 한 번만

    def test_same_time_and_line_in_two_streams_are_two_rows(self):
        start = datetime(2026, 11, 27, 1, tzinfo=export.KST)
        ts = int(start.timestamp() * 1e9)
        same = line(errorCategory="TIMEOUT", message="x")
        page = [(ts, same, {"app": "booking"}), (ts, same, {"app": "gateway"})]
        with mock.patch.object(export, "loki_page", return_value=page):
            rows = export.fetch_window("http://loki", "q", start, start.replace(hour=2))
        self.assertEqual(len(rows), 2)

    def test_full_page_at_one_instant_fails_instead_of_dropping(self):
        start = datetime(2026, 11, 27, 1, tzinfo=export.KST)
        ts = int(start.timestamp() * 1e9)
        page = [(ts, line(errorCategory="TIMEOUT", message=str(i)), {}) for i in range(export.PAGE_LIMIT)]
        with mock.patch.object(export, "loki_page", return_value=page):
            with self.assertRaises(RuntimeError):
                export.fetch_window("http://loki", "q", start, start.replace(hour=2))

    def test_write_hour_kst_partition_and_empty(self):
        start = datetime(2026, 11, 26, 16, tzinfo=timezone.utc)  # KST 11/27 01시
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(export.write_hour(Path(d), start, []))
            p = export.write_hour(Path(d), start, [{"errorCategory": "AUTH", "message": "한글"}])
            self.assertEqual(p.relative_to(d).as_posix(), "dt=2026-11-27/01.json.gz")
            with gzip.open(p, "rt", encoding="utf-8") as f:
                self.assertEqual(json.loads(f.readline())["message"], "한글")


if __name__ == "__main__":
    unittest.main()
