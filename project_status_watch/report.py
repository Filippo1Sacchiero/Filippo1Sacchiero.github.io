"""Drafts written from the engine's results: the weekly status report and reminder emails.

These are first drafts. The agent reads them, may rephrase them, and a person
approves them before anything is sent.
"""
from datetime import date

from status_engine import fmt_day

ICON = {"Red": "🔴", "Amber": "🟠", "Green": "🟢"}


def lower_first(s: str) -> str:
    return s[:1].lower() + s[1:]


def eur(v: float) -> str:
    return f"€{v / 1000:,.0f}k"


def idx(v) -> str:
    return "n/a" if v is None else f"{v:.2f}"


def weekly_report(r: dict) -> str:
    p = r["project"]
    day: date = r["status_date"]
    late = [t for t in r["tasks"] if t["status"] == "Late"]
    risky = [t for t in r["tasks"] if t["status"] == "At risk"]
    lines = [
        f"# Project ATLAS · Weekly status report · {fmt_day(day)}",
        "",
        f"**Overall status: {ICON[p['rag']]} {p['rag']}** · {p['progress']:.0f}% complete · "
        f"schedule index (SPI) {idx(p['spi'])} · cost index (CPI) {idx(p['cpi'])}",
        "",
        "## Summary",
        "",
    ]
    reds = [w for w in r["workstreams"] if w["rag"] == "Red"]
    ambers = [w for w in r["workstreams"] if w["rag"] == "Amber"]
    if reds:
        lines.append("Needs a decision: " + "; ".join(f"**{w['name']}** ({lower_first(w['reasons'][0])})" for w in reds) + ".")
    if ambers:
        lines.append("To watch: " + "; ".join(f"{w['name']} ({lower_first(w['reasons'][0])})" for w in ambers) + ".")
    greens = [w["name"] for w in r["workstreams"] if w["rag"] == "Green"]
    if greens:
        lines.append("On plan: " + ", ".join(greens) + ".")
    lines.append(
        f"Budget: {eur(p['ac'])} spent of {eur(p['bac'])}. At the current cost efficiency the forecast at "
        f"completion is {eur(p['eac'])} ({'+' if p['vac'] < 0 else '−'}{eur(abs(p['vac']))} vs budget).")
    lines += ["", "## Workstreams", "", "| Workstream | Status | Progress | SPI | CPI | Why |", "|---|---|---|---|---|---|"]
    for w in r["workstreams"]:
        lines.append(f"| {w['name']} | {ICON[w['rag']]} {w['rag']} | {w['progress']:.0f}% | {idx(w['spi'])} | "
                     f"{idx(w['cpi'])} | {'; '.join(w['reasons'])} |")
    if late or risky:
        lines += ["", "## Late and at-risk tasks", ""]
        for t in late + risky:
            lines.append(f"- **{t['id']} {t['task']}** ({t['owner']}): {t['status'].lower()}. {t['why']}.")
    changes = r.get("changes") or []
    if changes:
        lines += ["", "## Changes since last week", ""]
        lines += [f"- {c['text']}" for c in changes]
    top = [x for x in r["risks"] if x["open"]][:3]
    if top:
        lines += ["", "## Top risks", ""]
        for x in top:
            lines.append(f"- **{x['id']}** ({x['workstream']}, score {x['score']}): {x['description']}. "
                         f"Mitigation: {x['mitigation']}.")
    ms = p["next_milestones"]
    if ms:
        lines += ["", "## Next milestones", ""]
        lines += [f"- {m['id']} {m['task']}: {fmt_day(m['due'])} ({m['status'].lower()})" for m in ms]
    if r["checks"]:
        lines += ["", "## Data checks", ""] + [f"- {c}" for c in r["checks"]]
    lines += ["", "---", "*Draft prepared by the Project Status Watch agent. To be checked by the project manager before it is sent.*", ""]
    return "\n".join(lines)


def reminder_emails(r: dict) -> list[dict]:
    by_id = {t["id"]: t for t in r["tasks"]}
    out = []
    for rem in r["reminders"]:
        items = [by_id[i] for i in rem["tasks"]]
        bullet = "\n".join(f"- {t['id']} {t['task']}: {t['status'].lower()}. {t['why']}." for t in items)
        body = (
            f"Hello {rem['owner']},\n\n"
            f"in this week's status review ({fmt_day(r['status_date'])}) these tasks need attention:\n\n"
            f"{bullet}\n\n"
            "Could you send me an updated finish date and what you need to get back on plan by Tuesday? "
            "If the plan in the tracker is out of date, an update there is enough.\n\n"
            "Thank you,\nFilippo"
        )
        subject = f"Project ATLAS: {len(items)} task{'s' if len(items) > 1 else ''} need{'s' if len(items) == 1 else ''} an update"
        out.append({"owner": rem["owner"], "subject": subject, "body": body, "tasks": rem["tasks"]})
    return out
