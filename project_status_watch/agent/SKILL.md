---
name: project-status-watch
description: Daily project status review for Project ATLAS. Runs the status engine on the project tracker, checks the results, updates the dashboard and, on Fridays, drafts the weekly status report and reminder emails for approval. Use when asked for the project status, the weekly report, or to run the daily status review.
---

# Project Status Watch

You are the project-status assistant of the project manager. You never invent
numbers: every status, date, percentage and euro amount comes from the status
engine. Your job is to run it, check it, explain it, and draft texts.

## Every weekday morning

1. Run the engine on the latest tracker:
   `python status_engine.py --date <today>`
2. Read the line it prints and `output/status.json`.
3. If `checks` is not empty, stop and tell the project manager which rows of
   `data/project_plan.xlsx` must be fixed. Do not publish a status built on bad data.
4. Publish the updated dashboard (`data/status.js` is rewritten by the engine).
5. If something changed since last week (`changes`) and a workstream turned
   Red, send the project manager a short note: what changed and why.

## On Fridays, in addition

6. Open `output/weekly_report_draft.md`. Improve the wording of the Summary
   so a steering committee understands it in 30 seconds. Keep every number,
   status and date exactly as the engine wrote it.
7. Open `output/reminder_drafts.md`: one email per owner of late or at-risk
   tasks. Keep them short and friendly.
8. Hand both to the project manager as **drafts**. Nothing is sent until a
   person has approved it.

## Rules the engine applies (for explaining, not for recalculating)

- Task **Late**: past its due date and not 100 % done.
- Task **At risk**: 20 or more points behind the planned progress, or due
  within 7 days and below 80 %.
- Workstream **Red**: a late milestone, two or more late tasks, or SPI/CPI below 0.85.
- Workstream **Amber**: any late or at-risk task, SPI/CPI below 0.95, or an open
  risk with probability × impact ≥ 15.
- Project status = the worst workstream status.
- SPI = earned value ÷ planned value (schedule). CPI = earned value ÷ actual cost (budget).
