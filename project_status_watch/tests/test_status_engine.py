"""One test per review rule. Run with:  python -m pytest tests"""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from status_engine import (  # noqa: E402
    Plan, earned_value, load_plan, planned_pct, review, snapshot, task_status, validate, workstream_rag,
)
from report import reminder_emails, weekly_report  # noqa: E402

D = date
START, DUE = D(2026, 11, 2), D(2026, 11, 11)  # 10 days, both inclusive


def task(tid="T-1", ws="WS", start=START, due=DUE, budget=1000, milestone=False, owner="A. Owner"):
    return {"id": tid, "workstream": ws, "task": f"Task {tid}", "owner": owner, "start": start, "due": due,
            "budget": budget, "milestone": milestone}


def item(status, milestone=False, tid="T-1", budget=1000, planned=50, pct=50, cost=500):
    return {"id": tid, "status": status, "milestone": milestone, "budget": budget, "planned": planned,
            "pct": pct, "cost": cost}


# ---------- planned progress ----------
def test_planned_is_zero_before_start():
    assert planned_pct(START, DUE, D(2026, 11, 1)) == 0


def test_planned_counts_start_and_due_day():
    assert planned_pct(START, DUE, START) == 10       # day 1 of 10
    assert planned_pct(START, DUE, D(2026, 11, 6)) == 50


def test_planned_is_full_from_due_date():
    assert planned_pct(START, DUE, DUE) == 100


# ---------- task status ----------
def test_done_wins_even_after_due_date():
    assert task_status(START, DUE, 100, D(2026, 12, 1)) == "Done"


def test_late_when_past_due_and_not_done():
    assert task_status(START, DUE, 95, D(2026, 11, 12)) == "Late"


def test_not_late_on_the_due_date_itself():
    assert task_status(START, DUE, 95, DUE) != "Late"


def test_not_started_before_start():
    assert task_status(START, DUE, 0, D(2026, 10, 30)) == "Not started"


def test_at_risk_from_exactly_20_points_behind_plan():
    start, due, day = D(2026, 11, 2), D(2026, 12, 1), D(2026, 11, 16)  # day 15 of 30 -> planned 50 %
    assert planned_pct(start, due, day) == 50
    assert task_status(start, due, 30, day) == "At risk"     # exactly 20 behind counts
    assert task_status(start, due, 31, day) == "On track"


def test_at_risk_when_due_within_7_days_and_below_80():
    start, due = D(2026, 10, 1), D(2026, 11, 30)
    day = D(2026, 11, 23)  # 7 days before due; planned ~ 88 %
    assert task_status(start, due, 79, day) == "At risk"
    assert task_status(start, due, 80, day) == "On track"


# ---------- snapshots ----------
def test_snapshot_takes_latest_report_on_or_before_day():
    rows = [(D(2026, 11, 6), 20, 100.0), (D(2026, 11, 13), 50, 300.0)]
    assert snapshot(rows, D(2026, 11, 12)) == (20, 100.0)
    assert snapshot(rows, D(2026, 11, 13)) == (50, 300.0)
    assert snapshot(rows, D(2026, 11, 1)) == (0, 0.0)


# ---------- earned value ----------
def test_earned_value_indices():
    ev = earned_value([item("On track", budget=1000, planned=50, pct=40, cost=500)])
    assert ev["pv"] == 500 and ev["ev"] == 400 and ev["ac"] == 500
    assert ev["spi"] == 0.8 and ev["cpi"] == 0.8
    assert ev["eac"] == 500 + 600 / 0.8   # spent so far + remaining work at current efficiency


def test_earned_value_without_cost_has_no_cpi():
    ev = earned_value([item("Not started", planned=0, pct=0, cost=0)])
    assert ev["spi"] is None and ev["cpi"] is None and ev["eac"] == ev["bac"]


# ---------- workstream RAG ----------
def test_green_when_everything_on_plan():
    assert workstream_rag([item("On track")], [])[0] == "Green"


def test_red_when_a_milestone_is_late():
    rag, why = workstream_rag([item("Late", milestone=True)], [])
    assert rag == "Red" and "Milestone" in why[0]


def test_amber_when_one_normal_task_is_late():
    assert workstream_rag([item("Late")], [])[0] == "Amber"


def test_red_when_two_tasks_are_late():
    assert workstream_rag([item("Late", tid="A"), item("Late", tid="B")], [])[0] == "Red"


def test_amber_when_a_task_is_at_risk():
    assert workstream_rag([item("At risk")], [])[0] == "Amber"


def test_cost_index_thresholds():
    assert workstream_rag([item("On track", pct=50, cost=560)], [])[0] == "Amber"   # CPI 0.89
    assert workstream_rag([item("On track", pct=50, cost=600)], [])[0] == "Red"     # CPI 0.83


def test_high_open_risk_makes_amber_closed_does_not():
    risk = {"id": "R", "score": 16, "open": True}
    assert workstream_rag([item("On track")], [risk])[0] == "Amber"
    assert workstream_rag([item("On track")], [{**risk, "open": False}])[0] == "Green"


# ---------- data checks ----------
def test_validation_finds_bad_rows():
    plan = Plan(
        tasks=[task("A", due=D(2026, 10, 1)), task("B", owner=""), task("B")],
        progress={"A": [(D(2026, 11, 6), 50, 0), (D(2026, 11, 13), 30, 0)], "X": [(D(2026, 11, 6), 120, 0)]},
        risks=[],
    )
    issues = " | ".join(validate(plan))
    for text in ("used more than once", "before the start", "no owner", "went down", "unknown task", "outside 0-100"):
        assert text in issues


# ---------- whole review on the demo data ----------
def test_demo_review_end_to_end():
    plan = load_plan(Path(__file__).resolve().parents[1] / "data" / "project_plan.xlsx")
    assert plan.issues == []
    r = review(plan, D(2026, 11, 27))
    rag = {w["name"]: w["rag"] for w in r["workstreams"]}
    assert rag == {"Data Platform": "Red", "Dashboards & Reports": "Amber", "Data Governance": "Green",
                   "Change & Training": "Red", "Go-Live": "Green"}
    assert r["project"]["rag"] == "Red"
    assert {c["id"] for c in r["changes"] if c["kind"] == "task"} == {"DP-4", "DP-5", "DR-3"}
    assert r["trend"][-1]["week"] == D(2026, 11, 27)
    report = weekly_report(r)
    assert "Overall status: 🔴 Red" in report and "DP-3" in report
    emails = reminder_emails(r)
    assert {e["owner"] for e in emails} == {"A. Becker", "L. Rossi"}
