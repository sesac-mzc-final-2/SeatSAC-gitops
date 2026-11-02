#!/usr/bin/env python3
"""신호등 대시보드·기록 규칙 검사 (3.1.7). 로컬과 CI(gitops-validate)가 같은 스크립트를 쓴다.

  python3 observability/tests/check.py

promtool 은 PATH 의 promtool(또는 환경변수 PROMTOOL), 없으면 docker 이미지 prom/prometheus 로 돌린다.
검사:
  1. 대시보드 JSON 형식 (panel id 중복 없음, Prometheus/CloudWatch 데이터소스 uid)
  2. 대시보드의 모든 PromQL 문법 (Grafana 변수 $__range 는 치환)
  3. 기록 규칙 문법 + 단위 테스트 (tests/rules.test.yaml)
  4. 대시보드 쿼리를 합성 데이터로 계산해 기대값과 비교 — '트래픽 없음=회색(-1)', '5xx 없어도 0%', 신호등은 시리즈 1개
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]          # observability/
DASH = ROOT / "dashboards" / "seatsac-traffic-light.json"
PROMTOOL_IMAGE = "prom/prometheus:v3.5.0"


def promtool(args, cwd):
    exe = os.environ.get("PROMTOOL") or shutil.which("promtool")
    if exe:
        cmd = [exe, *args]
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if not shutil.which("docker"):
        sys.exit("promtool 도 docker 도 없다. PROMTOOL=/path/promtool 로 지정한다")
    cmd = ["docker", "run", "--rm", "-v", f"{cwd}:/t", "-w", "/t", "--entrypoint", "promtool", PROMTOOL_IMAGE, *args]
    return subprocess.run(cmd, capture_output=True, text=True)


def fail(msg, proc=None):
    print(f"✗ {msg}")
    if proc is not None:
        print((proc.stdout + proc.stderr).strip()[-3000:])
    sys.exit(1)


def collect_queries(dash):
    found, ids = {}, []

    def walk(panels):
        for p in panels:
            ids.append(p["id"])
            for t in p.get("targets", []):
                ds = t.get("datasource", p.get("datasource", {}))
                if ds.get("type") == "prometheus":
                    found[(p["title"], t["refId"])] = t["expr"].replace("[$__range]", "[10m]").replace("$__interval", "1m")
                elif ds.get("type") == "cloudwatch":
                    if ds.get("uid") != "cloudwatch":
                        fail(f"CloudWatch 데이터소스 uid 가 cloudwatch 가 아니다: {p['title']}")
                else:
                    fail(f"알 수 없는 데이터소스: {p['title']} {ds}")
            walk(p.get("panels", []))

    walk(dash["panels"])
    return found, ids


def main():
    dash = json.loads(DASH.read_text(encoding="utf-8"))
    queries, ids = collect_queries(dash)
    if len(ids) != len(set(ids)):
        fail("panel id 중복")
    if not dash.get("uid"):
        fail("dashboard uid 없음")
    print(f"✓ 대시보드 JSON: 패널 {len(ids)}개, Prometheus 쿼리 {len(queries)}개")

    rule = yaml.safe_load((ROOT / "prometheusrule.yaml").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        tmp.chmod(0o755)
        yaml.safe_dump({"groups": rule["spec"]["groups"]}, (tmp / "cinema-rules.yaml").open("w", encoding="utf-8"), allow_unicode=True)

        # 2. 대시보드 PromQL 문법
        recs = [{"record": f"dash:q{i}", "expr": e} for i, e in enumerate(queries.values())]
        yaml.safe_dump({"groups": [{"name": "dash", "rules": recs}]}, (tmp / "dash-rules.yaml").open("w", encoding="utf-8"), allow_unicode=True)
        p = promtool(["check", "rules", "dash-rules.yaml"], tmp)
        if p.returncode:
            fail("대시보드 PromQL 문법 오류", p)
        print("✓ 대시보드 PromQL 문법")

        # 3. 기록 규칙
        p = promtool(["check", "rules", "cinema-rules.yaml"], tmp)
        if p.returncode:
            fail("기록 규칙 문법 오류", p)
        shutil.copy(ROOT / "tests" / "rules.test.yaml", tmp / "rules.test.yaml")
        p = promtool(["test", "rules", "rules.test.yaml"], tmp)
        if p.returncode:
            fail("기록 규칙 단위 테스트 실패", p)
        print("✓ 기록 규칙 문법·단위 테스트")

        # 4. 대시보드 쿼리 값 검증
        ns = 'namespace="cinema-staging"'

        def s(name, labels, vals):
            return {"series": f"{name}{{{ns},{labels}}}", "values": vals}

        inp = [
            # catalog: 정상 1건/초, 5xx 시리즈 없음
            s("http_server_requests_seconds_count", 'application="catalog",uri="/movies",method="GET",status="200"', "0+15x80"),
            s("http_server_requests_seconds_bucket", 'application="catalog",uri="/movies",method="GET",le="0.1"', "0+15x80"),
            s("http_server_requests_seconds_bucket", 'application="catalog",uri="/movies",method="GET",le="+Inf"', "0+15x80"),
            # booking: /seats/hold 1건/초, 지연 100~250ms 구간
            s("http_server_requests_seconds_count", 'application="booking",uri="/seats/hold",method="POST",status="200"', "0+15x80"),
            s("http_server_requests_seconds_bucket", 'application="booking",uri="/seats/hold",method="POST",le="0.1"', "0+0x80"),
            s("http_server_requests_seconds_bucket", 'application="booking",uri="/seats/hold",method="POST",le="0.25"', "0+15x80"),
            s("http_server_requests_seconds_bucket", 'application="booking",uri="/seats/hold",method="POST",le="+Inf"', "0+15x80"),
            # gateway: 5xx 10%
            s("http_server_requests_seconds_count", 'application="gateway",uri="/x",method="GET",status="200"', "0+13.5x80"),
            s("http_server_requests_seconds_count", 'application="gateway",uri="/x",method="GET",status="500"', "0+1.5x80"),
            s("http_server_requests_seconds_bucket", 'application="gateway",uri="/x",method="GET",le="0.1"', "0+15x80"),
            s("http_server_requests_seconds_bucket", 'application="gateway",uri="/x",method="GET",le="+Inf"', "0+15x80"),
            # 캐시 hit 3 : miss 1, 결제 approved 9 : error 1
            {"series": 'catalog_cache_requests_total{result="hit"}', "values": "0+30x80"},
            {"series": 'catalog_cache_requests_total{result="miss"}', "values": "0+10x80"},
            {"series": 'booking_payment_call_total{result="approved"}', "values": "0+9x80"},
            {"series": 'booking_payment_call_total{result="error"}', "values": "0+1x80"},
        ]

        def one(title, value, ref="A"):
            return {"expr": queries[(title, ref)], "eval_time": "15m", "exp_samples": [{"labels": "{}", "value": value}]}

        def scaled(title, value, ref="A"):
            """부동소수점 오차(0.0499999…)를 피하려고 1000배 후 반올림해서 비교한다"""
            return {"expr": f"round(({queries[(title, ref)]}) * 1000)", "eval_time": "15m",
                    "exp_samples": [{"labels": "{}", "value": round(value * 1000)}]}

        cases = [
            one("user", -1),                         # 트래픽 없는 서비스 = 회색
            one("catalog", 0),                       # 정상
            one("gateway", 2),                       # 5xx 10% = 장애
            one("booking", 0),                       # 지연 242ms < 300ms = 정상
            one("캐시 적중률", 0.75),
            one("결제 timeout·error 비율", 0.1),
            # booking+gateway 5xx: gateway 1.5/15 가 5xx, booking 은 0 → 합계 비율 1.5/30 = 5%
            scaled("오류율 (선택한 시간 범위)", 0.05),
        ]
        # API 표 5xx 비율: 5xx 시리즈가 없는 API 도 0 으로 나와야 한다(사라지면 표에서 빠진다)
        api_b = queries[("API별 요청 수 · 5xx 비율 · p95", "B")]
        cases.append({"expr": api_b, "eval_time": "15m", "exp_samples": [
            {"labels": '{application="booking", method="POST", uri="/seats/hold"}', "value": 0},
            {"labels": '{application="catalog", method="GET", uri="/movies"}', "value": 0},
            {"labels": '{application="gateway", method="GET", uri="/x"}', "value": 0.1},
        ]})
        # 선점 p95: 100~250ms 버킷 선형 보간 = 0.1 + 0.15 × 0.95 = 0.2425
        cases.append({"expr": queries[("좌석 선점 p95", "A")], "eval_time": "15m",
                      "exp_samples": [{"labels": "{}", "value": 0.2425}]})
        spec = {"rule_files": ["cinema-rules.yaml"], "evaluation_interval": "30s",
                "tests": [{"interval": "15s", "input_series": inp, "promql_expr_test": cases}]}
        yaml.safe_dump(spec, (tmp / "dash.test.yaml").open("w", encoding="utf-8"), allow_unicode=True, width=10 ** 6)
        p = promtool(["test", "rules", "dash.test.yaml"], tmp)
        if p.returncode:
            fail("대시보드 쿼리 값 검증 실패", p)
        print("✓ 대시보드 쿼리 값 검증 (합성 데이터)")
    print("모두 통과")


if __name__ == "__main__":
    main()
