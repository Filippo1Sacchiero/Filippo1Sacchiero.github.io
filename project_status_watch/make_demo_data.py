"""Builds the demo project plan (data/project_plan.xlsx).

Everything here is made up: a fictional BI-platform rollout ("Project ATLAS")
at a fictional automotive supplier. No real company data is used.

Sheets
  Tasks     one row per task: workstream, owner, dates, budget, milestone flag
  Progress  one row per task per Friday: % complete and actual cost so far
  Risks     risk register: probability and impact (1-5), owner, mitigation
"""
from datetime import date, timedelta
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

OUT = Path(__file__).parent / "data" / "project_plan.xlsx"
FIRST_FRIDAY = date(2026, 6, 5)
LAST_FRIDAY = date(2026, 11, 27)

WORKSTREAMS = {
    "DP": "Data Platform",
    "DR": "Dashboards & Reports",
    "DG": "Data Governance",
    "CT": "Change & Training",
    "GL": "Go-Live",
}
OWNERS = {"DP": "A. Becker", "DR": "L. Rossi", "DG": "M. Schmidt", "CT": "S. Yilmaz", "GL": "J. Weber"}

# id, task, start, due, budget EUR, milestone, pace (actual/planned progress), cost factor (cost/earned value),
# optional date after which work stalls
D = date
TASKS = [
    ("DP-1", "Requirements and target architecture", D(2026, 6, 1), D(2026, 6, 26), 40000, False, 1.00, 1.00, None),
    ("DP-2", "Cloud environment setup", D(2026, 6, 29), D(2026, 8, 7), 60000, False, 1.00, 1.05, None),
    ("DP-3", "ERP data connectors", D(2026, 8, 3), D(2026, 10, 16), 90000, False, 0.86, 1.12, D(2026, 10, 30)),
    ("DP-4", "Data warehouse model", D(2026, 9, 7), D(2026, 11, 20), 80000, False, 0.92, 1.04, None),
    ("DP-5", "Platform ready for reporting", D(2026, 11, 23), D(2026, 12, 4), 10000, True, 0.55, 1.00, None),
    ("DR-1", "KPI catalogue agreed with the business", D(2026, 7, 6), D(2026, 8, 14), 50000, False, 1.00, 0.97, None),
    ("DR-2", "Sales dashboard", D(2026, 9, 14), D(2026, 11, 6), 70000, False, 1.00, 0.95, None),
    ("DR-3", "Production dashboard", D(2026, 10, 5), D(2026, 12, 11), 75000, False, 0.70, 1.02, None),
    ("DR-4", "Finance dashboard", D(2026, 11, 2), D(2027, 1, 15), 70000, False, 1.00, 1.00, None),
    ("DR-5", "Mobile report pack", D(2027, 1, 11), D(2027, 2, 19), 40000, False, 1.00, 1.00, None),
    ("DG-1", "Data ownership model", D(2026, 6, 15), D(2026, 7, 31), 30000, False, 1.00, 0.98, None),
    ("DG-2", "Data quality rules", D(2026, 8, 3), D(2026, 10, 30), 45000, False, 1.00, 1.00, None),
    ("DG-3", "Access and security concept", D(2026, 9, 1), D(2026, 12, 18), 35000, False, 1.04, 0.96, None),
    ("DG-4", "Governance board sign-off", D(2026, 12, 14), D(2026, 12, 18), 5000, True, 1.00, 1.00, None),
    ("CT-1", "Stakeholder map and communication plan", D(2026, 6, 8), D(2026, 7, 3), 20000, False, 1.00, 1.30, None),
    ("CT-2", "Key-user network", D(2026, 7, 6), D(2026, 9, 25), 35000, False, 1.00, 1.38, None),
    ("CT-3", "Training materials", D(2026, 10, 5), D(2026, 12, 18), 50000, False, 0.95, 1.35, None),
    ("CT-4", "Key-user training sessions", D(2027, 1, 11), D(2027, 2, 26), 60000, False, 1.00, 1.00, None),
    ("GL-1", "Cut-over plan", D(2026, 11, 16), D(2026, 12, 18), 25000, False, 1.00, 1.00, None),
    ("GL-2", "User acceptance test", D(2027, 1, 4), D(2027, 2, 12), 55000, False, 1.00, 1.00, None),
    ("GL-3", "Go-live", D(2027, 3, 1), D(2027, 3, 5), 10000, True, 1.00, 1.00, None),
    ("GL-4", "Hypercare", D(2027, 3, 8), D(2027, 3, 31), 30000, False, 1.00, 1.00, None),
]

RISKS = [
    ("R-01", "DP", "ERP vendor delivers the connector API later than agreed", 4, 4, "A. Becker",
     "Weekly call with the vendor; fallback: nightly file export", "Open"),
    ("R-02", "DR", "Production data quality too low for a reliable dashboard", 3, 4, "L. Rossi",
     "Data quality rules first on the production tables", "Open"),
    ("R-03", "CT", "Key users have no time during year-end closing", 4, 3, "S. Yilmaz",
     "Move training to January; short e-learning modules", "Open"),
    ("R-04", "GL", "Go-live overlaps with the start of the fiscal year", 2, 5, "J. Weber",
     "Freeze period agreed with Finance", "Open"),
    ("R-05", "DG", "Works council approval needed for access logging", 3, 3, "M. Schmidt",
     "Early briefing of the works council", "Open"),
    ("R-06", "DP", "Cloud running costs higher than planned", 2, 3, "A. Becker",
     "Monthly cost review; auto-shutdown of test systems", "Open"),
    ("R-07", "DR", "Licence order for the BI tool delayed", 3, 4, "L. Rossi",
     "Licences ordered in July", "Closed"),
]


def planned_pct(start, due, day):
    if day < start:
        return 0.0
    if day >= due:
        return 100.0
    return 100.0 * ((day - start).days + 1) / ((due - start).days + 1)


def fridays():
    d = FIRST_FRIDAY
    while d <= LAST_FRIDAY:
        yield d
        d += timedelta(days=7)


def progress_rows():
    rows = []
    for tid, _, start, due, budget, _, pace, cost_f, stall in TASKS:
        last = 0
        for fri in fridays():
            day = min(fri, stall) if stall else fri
            pct = planned_pct(start, due, day) * pace
            if pace >= 1 and day >= due:
                pct = 100
            pct = int(min(100, max(last, round(pct / 5) * 5)))  # people report in steps of 5 %
            last = pct
            cost = round(budget * pct / 100 * cost_f, -2)
            if fri >= start or pct:
                rows.append((fri, tid, pct, cost))
    return rows


def write_sheet(wb, title, header, rows, widths):
    ws = wb.create_sheet(title)
    ws.append(header)
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="1F3A5F")
    for r in rows:
        ws.append(list(r))
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    return ws


def main():
    wb = Workbook()
    wb.remove(wb.active)
    ws = write_sheet(
        wb, "Tasks",
        ["task_id", "workstream", "task", "owner", "start", "due", "budget_eur", "milestone"],
        [(t[0], WORKSTREAMS[t[0][:2]], t[1], OWNERS[t[0][:2]], t[2], t[3], t[4], "Y" if t[5] else "N") for t in TASKS],
        [9, 22, 40, 12, 12, 12, 12, 10],
    )
    for row in ws.iter_rows(min_row=2, min_col=5, max_col=6):
        for c in row:
            c.number_format = "yyyy-mm-dd"
    ws = write_sheet(wb, "Progress", ["week_ending", "task_id", "progress_pct", "actual_cost_eur"],
                     progress_rows(), [13, 9, 13, 16])
    for (c,) in ws.iter_rows(min_row=2, max_col=1):
        c.number_format = "yyyy-mm-dd"
    write_sheet(
        wb, "Risks",
        ["risk_id", "workstream", "description", "probability", "impact", "owner", "mitigation", "status"],
        [(r[0], WORKSTREAMS[r[1]], *r[2:]) for r in RISKS],
        [8, 22, 55, 12, 9, 12, 50, 9],
    )
    OUT.parent.mkdir(exist_ok=True)
    wb.save(OUT)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
