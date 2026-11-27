"""Project Status Watch: the status engine.

Reads the project plan (Excel), works out the status of every task and
workstream on a given day, and writes the results for the dashboard and the
weekly report. All numbers are computed here, in plain tested code; the AI
agent only runs this script and writes the texts around its results.

Usage
  python status_engine.py                       # status as of today
  python status_engine.py --date 2026-11-27     # status as of a given day
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

from openpyxl import load_workbook

HERE = Path(__file__).parent

# ---------------- Review rules (see README / the project page) ----------------
AT_RISK_GAP = 20        # at risk if actual progress is >= 20 points behind plan
DUE_SOON_DAYS = 7       # ... or due within 7 days ...
DUE_SOON_MIN = 80       # ... and less than 80 % done
RED_INDEX = 0.85        # SPI or CPI below this -> red
AMBER_INDEX = 0.95      # SPI or CPI below this -> amber
HIGH_RISK = 15          # open risk with probability x impact >= 15 -> at least amber

STATUS_ORDER = ["Late", "At risk", "On track", "Not started", "Done"]
RAG_ORDER = ["Red", "Amber", "Green"]


@dataclass
class Plan:
    tasks: list[dict]
    progress: dict[str, list[tuple[date, int, float]]]  # task_id -> [(week_ending, pct, cost)] sorted
    risks: list[dict]
    issues: list[str] = field(default_factory=list)      # problems found while reading


# ---------------- Reading the plan ----------------
def _d(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v).strip())


def _rows(ws):
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() for h in next(rows)]
    for r in rows:
        if r and any(v is not None for v in r):
            yield dict(zip(header, r))


def load_plan(path: Path) -> Plan:
    wb = load_workbook(path, data_only=True)
    tasks = []
    for r in _rows(wb["Tasks"]):
        tasks.append({
            "id": str(r["task_id"]).strip(),
            "workstream": str(r["workstream"]).strip(),
            "task": str(r["task"]).strip(),
            "owner": (str(r["owner"]).strip() if r["owner"] else ""),
            "start": _d(r["start"]),
            "due": _d(r["due"]),
            "budget": float(r["budget_eur"] or 0),
            "milestone": str(r["milestone"]).strip().upper() in ("Y", "YES", "TRUE", "1"),
        })
    progress: dict[str, list] = {}
    for r in _rows(wb["Progress"]):
        progress.setdefault(str(r["task_id"]).strip(), []).append(
            (_d(r["week_ending"]), int(r["progress_pct"] or 0), float(r["actual_cost_eur"] or 0)))
    for v in progress.values():
        v.sort()
    risks = []
    for r in _rows(wb["Risks"]):
        p, i = int(r["probability"]), int(r["impact"])
        risks.append({
            "id": str(r["risk_id"]).strip(), "workstream": str(r["workstream"]).strip(),
            "description": str(r["description"]).strip(), "probability": p, "impact": i, "score": p * i,
            "owner": str(r["owner"] or "").strip(), "mitigation": str(r["mitigation"] or "").strip(),
            "open": str(r["status"]).strip().lower() != "closed",
        })
    plan = Plan(tasks, progress, risks)
    plan.issues = validate(plan)
    return plan


def validate(plan: Plan) -> list[str]:
    """Data checks, so a typo in the sheet does not silently change the status."""
    issues = []
    ids = [t["id"] for t in plan.tasks]
    for tid in sorted({i for i in ids if ids.count(i) > 1}):
        issues.append(f"{tid}: task id used more than once")
    for t in plan.tasks:
        if t["due"] < t["start"]:
            issues.append(f"{t['id']}: due date is before the start date")
        if not t["owner"]:
            issues.append(f"{t['id']}: no owner")
        if t["budget"] <= 0:
            issues.append(f"{t['id']}: no budget")
    for tid, rows in plan.progress.items():
        if tid not in ids:
            issues.append(f"{tid}: progress reported for an unknown task")
        last = 0
        for week, pct, _ in rows:
            if not 0 <= pct <= 100:
                issues.append(f"{tid}: progress {pct}% on {week} is outside 0-100")
            elif pct < last:
                issues.append(f"{tid}: progress went down from {last}% to {pct}% on {week}")
            last = max(last, pct)
    for r in plan.risks:
        if not (1 <= r["probability"] <= 5 and 1 <= r["impact"] <= 5):
            issues.append(f"{r['id']}: probability and impact must be 1-5")
    return issues


# ---------------- Rules ----------------
def planned_pct(start: date, due: date, day: date) -> float:
    """Where the task should be on `day`, assuming steady work from start to due (both inclusive)."""
    if day < start:
        return 0.0
    if day >= due:
        return 100.0
    return 100.0 * ((day - start).days + 1) / ((due - start).days + 1)


def snapshot(rows, day: date) -> tuple[int, float]:
    """Latest reported (progress %, actual cost) on or before `day`."""
    pct, cost = 0, 0.0
    for week, p, c in rows or []:
        if week > day:
            break
        pct, cost = p, c
    return pct, cost


def task_status(start: date, due: date, pct: float, day: date) -> str:
    if pct >= 100:
        return "Done"
    if day > due:
        return "Late"
    if day < start and pct == 0:
        return "Not started"
    if planned_pct(start, due, day) - pct >= AT_RISK_GAP:
        return "At risk"
    if (due - day).days <= DUE_SOON_DAYS and pct < DUE_SOON_MIN:
        return "At risk"
    return "On track"


def ratio(a: float, b: float):
    return round(a / b, 3) if b else None


def earned_value(items) -> dict:
    """items: dicts with budget, planned, pct, cost. Classic earned-value figures."""
    bac = sum(t["budget"] for t in items)
    pv = sum(t["budget"] * t["planned"] / 100 for t in items)
    ev = sum(t["budget"] * t["pct"] / 100 for t in items)
    ac = sum(t["cost"] for t in items)
    spi, cpi = ratio(ev, pv), ratio(ev, ac)
    eac = ac + (bac - ev) / cpi if cpi else bac  # forecast at completion if cost efficiency stays the same
    return {"bac": round(bac), "pv": round(pv), "ev": round(ev), "ac": round(ac),
            "spi": spi, "cpi": cpi, "eac": round(eac), "vac": round(bac - eac)}


def workstream_rag(items, risks) -> tuple[str, list[str]]:
    """items: task results of one workstream. Returns (Red/Amber/Green, reasons)."""
    ev = earned_value(items)
    late = [t for t in items if t["status"] == "Late"]
    at_risk = [t for t in items if t["status"] == "At risk"]
    red, amber = [], []
    for t in late:
        if t["milestone"]:
            red.append(f"Milestone {t['id']} is late")
    if len(late) >= 2:
        red.append(f"{len(late)} tasks are late")
    for name in ("spi", "cpi"):
        v = ev[name]
        label = "Schedule (SPI)" if name == "spi" else "Cost (CPI)"
        if v is not None and v < RED_INDEX:
            red.append(f"{label} {v:.2f} below {RED_INDEX}")
        elif v is not None and v < AMBER_INDEX:
            amber.append(f"{label} {v:.2f} below {AMBER_INDEX}")
    if len(late) == 1 and not late[0]["milestone"]:
        amber.append(f"{late[0]['id']} is late")
    if at_risk:
        amber.append(f"{len(at_risk)} task{'s' if len(at_risk) > 1 else ''} at risk")
    for r in risks:
        if r["open"] and r["score"] >= HIGH_RISK:
            amber.append(f"High risk {r['id']} (score {r['score']})")
    if red:
        return "Red", red + amber
    if amber:
        return "Amber", amber
    return "Green", ["On plan"]


def worst(rags):
    return min(rags, key=RAG_ORDER.index) if rags else "Green"


def fmt_day(d: date) -> str:
    return f"{d.day} {d.strftime('%b %Y')}"


# ---------------- The review ----------------
def task_results(plan: Plan, day: date) -> list[dict]:
    out = []
    for t in plan.tasks:
        pct, cost = snapshot(plan.progress.get(t["id"]), day)
        planned = planned_pct(t["start"], t["due"], day)
        status = task_status(t["start"], t["due"], pct, day)
        if status == "Late":
            why = f"Was due {fmt_day(t['due'])}, {pct}% done ({(day - t['due']).days} days over)"
        elif status == "At risk" and planned - pct >= AT_RISK_GAP:
            why = f"Planned {planned:.0f}%, actual {pct}% ({pct - planned:.0f} pts)"
        elif status == "At risk":
            why = f"Due {fmt_day(t['due'])}, only {pct}% done"
        elif status == "Not started":
            why = f"Starts {fmt_day(t['start'])}"
        elif status == "Done":
            why = "Completed"
        else:
            why = f"Planned {planned:.0f}%, actual {pct}%"
        out.append({**t, "pct": pct, "cost": cost, "planned": round(planned, 1), "status": status, "why": why,
                    "cost_ratio": ratio(cost, t["budget"] * pct / 100) if pct else None})
    return out


def review(plan: Plan, day: date, with_history: bool = True) -> dict:
    tasks = task_results(plan, day)
    names = list(dict.fromkeys(t["workstream"] for t in tasks))
    workstreams = []
    for name in names:
        items = [t for t in tasks if t["workstream"] == name]
        risks = [r for r in plan.risks if r["workstream"] == name]
        rag, reasons = workstream_rag(items, risks)
        counts = {s: sum(t["status"] == s for t in items) for s in STATUS_ORDER}
        workstreams.append({"name": name, "owner": items[0]["owner"], "rag": rag, "reasons": reasons,
                            "counts": counts, **earned_value(items),
                            "progress": round(sum(t["budget"] * t["pct"] for t in items) / sum(t["budget"] for t in items), 1)})
    total = earned_value(tasks)
    counts = {s: sum(t["status"] == s for t in tasks) for s in STATUS_ORDER}
    project = {
        "rag": worst([w["rag"] for w in workstreams]), **total, "counts": counts,
        "progress": round(sum(t["budget"] * t["pct"] for t in tasks) / sum(t["budget"] for t in tasks), 1),
        "start": min(t["start"] for t in tasks), "end": max(t["due"] for t in tasks),
        "next_milestones": [
            {"id": t["id"], "task": t["task"], "due": t["due"], "status": t["status"]}
            for t in sorted(tasks, key=lambda t: t["due"]) if t["milestone"] and t["status"] != "Done"][:3],
    }
    result = {
        "status_date": day, "project": project, "workstreams": workstreams, "tasks": tasks,
        "risks": sorted(plan.risks, key=lambda r: (not r["open"], -r["score"])),
        "checks": plan.issues,
    }
    if with_history:
        result["changes"] = changes(plan, day, result)
        result["trend"] = trend(plan, day)
        result["reminders"] = reminders(tasks)
    return result


def changes(plan: Plan, day: date, now: dict) -> list[dict]:
    """What is different from the review one week earlier."""
    before = review(plan, day - timedelta(days=7), with_history=False)
    out = []
    old_ws = {w["name"]: w["rag"] for w in before["workstreams"]}
    for w in now["workstreams"]:
        if old_ws.get(w["name"]) != w["rag"]:
            out.append({"kind": "workstream", "id": w["name"], "from": old_ws.get(w["name"]), "to": w["rag"],
                        "text": f"{w['name']}: {old_ws.get(w['name'])} → {w['rag']}"})
    old = {t["id"]: t["status"] for t in before["tasks"]}
    for t in now["tasks"]:
        if old.get(t["id"]) != t["status"]:
            out.append({"kind": "task", "id": t["id"], "from": old.get(t["id"]), "to": t["status"],
                        "text": f"{t['id']} {t['task']}: {old.get(t['id'])} → {t['status']}"})
    return out


def trend(plan: Plan, day: date) -> list[dict]:
    """SPI, CPI and counts at every reporting Friday up to `day`."""
    weeks = sorted({w for rows in plan.progress.values() for w, _, _ in rows if w <= day})
    out = []
    for w in weeks:
        r = review(plan, w, with_history=False)
        p = r["project"]
        out.append({"week": w, "spi": p["spi"], "cpi": p["cpi"], "late": p["counts"]["Late"],
                    "at_risk": p["counts"]["At risk"], "progress": p["progress"], "rag": p["rag"]})
    return out


def reminders(tasks) -> list[dict]:
    """One draft reminder per owner with late or at-risk tasks. Drafts only: a person sends them."""
    by_owner: dict[str, list] = {}
    for t in tasks:
        if t["status"] in ("Late", "At risk"):
            by_owner.setdefault(t["owner"], []).append(t)
    out = []
    for owner, items in by_owner.items():
        items.sort(key=lambda t: STATUS_ORDER.index(t["status"]))
        out.append({"owner": owner, "tasks": [t["id"] for t in items]})
    return out


# ---------------- Output ----------------
def _json(o):
    if isinstance(o, date):
        return o.isoformat()
    raise TypeError(type(o))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plan", default=HERE / "data" / "project_plan.xlsx", type=Path)
    ap.add_argument("--date", default=None, help="status date YYYY-MM-DD (default: today)")
    ap.add_argument("--out", default=HERE / "output", type=Path)
    args = ap.parse_args(argv)
    day = date.fromisoformat(args.date) if args.date else date.today()

    from report import weekly_report, reminder_emails  # local module

    plan = load_plan(args.plan)
    result = review(plan, day)
    result["report"] = weekly_report(result)
    result["emails"] = reminder_emails(result)

    args.out.mkdir(parents=True, exist_ok=True)
    text = json.dumps(result, default=_json, indent=1, ensure_ascii=False)
    (args.out / "status.json").write_text(text, encoding="utf-8")
    (HERE / "data" / "status.js").write_text(
        "// Generated by status_engine.py. Do not edit by hand.\nwindow.PSW_DATA = " + text + ";\n", encoding="utf-8")
    (args.out / "weekly_report_draft.md").write_text(result["report"], encoding="utf-8")
    (args.out / "reminder_drafts.md").write_text(
        "\n\n---\n\n".join(f"To: {e['owner']}\nSubject: {e['subject']}\n\n{e['body']}" for e in result["emails"]),
        encoding="utf-8")
    p = result["project"]
    print(f"Status {fmt_day(day)}: project {p['rag']} · SPI {p['spi']} · CPI {p['cpi']} · "
          f"{p['counts']['Late']} late · {p['counts']['At risk']} at risk · {len(result['checks'])} data issues")


if __name__ == "__main__":
    main()
