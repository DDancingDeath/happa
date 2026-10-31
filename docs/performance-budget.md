# Performance budget

What "fast enough" means for happa on the shop's phones, and where each number
is measured (#120, #59). The budgets are targets for a mid-range Android phone on
mobile data. Record real-phone numbers in the timings table of
[release-checklist.md](release-checklist.md) at every release.

## Budgets

| What | Budget | Measured by |
|---|---|---|
| Cold start: tap the icon until billing can be used | ≤ 2.5 s | Release checklist timings (stopwatch); Diagnostics → "Startup timings" (`app-shown`) |
| App start in the field | warn above 6 s, fail above 15 s | TIP `AppStart` (App health; `tip-auto` issues) |
| Save a bill: tap Save until the success message | ≤ 1.5 s | Release checklist timings; TIP `BillSave` durations in App health (until the server confirms) |
| Today page ready | ≤ 0.5 s after it opens | Release checklist (by eye; data is already in memory) |
| Firestore reads per app open | page baselines + 25 % (hard cap 300 per page) in CI; warn above 1,000 / fail above 2,500 in the field | `tests/e2e/read-baselines.json` (E2E smoke); TIP `SessionReads` ([read-budget.md](read-budget.md)) |
| Stylesheet / template requests before the login screen | 1 stylesheet, 3 templates | `load-perf.test.js`, `template-loader.test.js` |

## Lab numbers

Playwright, Chromium at 390 px, CPU slowed 4×, warm open through the service
worker, signed out, median of 10 (PR #209):

| | Before #209 | After |
|---|---|---|
| First contentful paint | 756 ms | 536 ms |
| Firebase sign-in check starts | 1,080 ms | 667 ms |

These are relative numbers for comparing changes, not phone timings.

## Item picker: no 200-item cap

The issue proposed capping the item autocomplete at the 200 most-used items.
Billing's item picker is a `<select>` sorted by use (most used first), not a
free-text datalist, so a cap would hide items with no way to search for them. The
shop has about 45 items, and building the list is instant at that size. Revisit
only if the item list grows past a few hundred: then add a search box first and
cap the list after it.

## Regressions

- Reads: the E2E smoke fails a page that reads more than its baseline.
- Start-up shape: the tests above fail if the start-up loads more stylesheets
  or templates again.
- Field timings: TIP `AppStart`, `BillSave` and `SessionReads` show slow or heavy
  versions in App health, and repeated failures open `tip-auto` issues.
- jsdom timing checks were left out on purpose: CI machines vary too much for
  millisecond limits to be reliable, so they would fail at random.
