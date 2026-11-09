# Performance budget

What "fast enough" means for happa on the shop's phones, and where each number
is measured (#120, #59). The budgets are targets for a mid-range Android phone on
mobile data. Record real-phone numbers in the timings table of
[release-checklist.md](release-checklist.md) at every release.

## Budgets

| What | Budget | Measured by |
|---|---|---|
| Cold start: tap the icon until billing can be used | ≤ 2.5 s | Release checklist timings (stopwatch); Diagnostics → "Startup timings" (`app-shown`) |
| App start in the field: from loading the profile after sign-in to the first screen (SDK load and restoring the sign-in not included) | warn above 6 s, fail above 15 s | TIP `AppStart` (App health; `tip-auto` issues) |
| Save a bill: tap Save until the success message | ≤ 1.5 s | Release checklist timings; TIP `BillSave` durations in App health (until the server confirms) |
| Today page ready: open Today until its figures stop changing (it draws from memory first, then redraws after reading today's cash sessions) | ≤ 0.5 s for the first draw; ≤ 2 s on mobile data for the final figures | Release checklist timings (by eye) |
| Firestore reads | CI: page baselines + 25 % (hard cap 300 per page). Field: from sign-in to the first screen warn above 1,000 / fail above 2,500; whole session fail above 3,000 | `tests/e2e/read-baselines.json` (E2E smoke); TIP `SessionReads` ([read-budget.md](read-budget.md)) |
| Requests before the login screen | 1 stylesheet (tested); 3 templates (by design, not tested) | `load-perf.test.js`; `SHELL_TEMPLATES` in `utils/template-loader.js` |

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

## Start-up with all history in the phone's cache (#59)

The benchmark (3-year shop, 4x slower CPU) showed the app in ~9 s once the stock
checkpoint is stored, against ~6 s before it is. On a reopen the data listeners are
answered from the Firestore cache one after another (the SDK runs them on one queue, and
sends each query to the server only after its cache answer), then the server answers
arrive. Timing one reopen per listener and reading the SDK's stored queries (IndexedDB
`targets`) showed why the cache answers are slow:

- The SDK answers a query from the cache through the documents it last knew matched only
  when the stored query has a server-consistent ("limbo-free") version; it then also loads
  every document of the collection cached after that version. Otherwise it scans the
  whole collection. On the web it stores that version only when a document of the query
  changes or when the query's last listener goes away (`TODO(b/272564316)` in the SDK's
  `local_store_impl.ts`, still there in 12.x).
- The `paidAt` and pinned dues queries rarely change, so they scanned the whole
  collection on every open (retail sales: ~4,250 documents, twice).
- The stock rebuild's full read puts all older bills into the cache after the window and
  dues queries were stored, so those loaded almost the whole collection as well (retail
  window: 4,135 of 4,254 documents). History "All time" does the same. A new month's
  window is a new query and scans everything too.

**Listener heal (`firebase/core/target-heal.js`).** After the first screen, when idle, each
history listener whose stored query is new, or whose collection a server read has filled
since, is re-subscribed once: the old subscription's end makes the SDK store the version,
and the new one resumes (the server sends only changes; the read meter counts none). Its
first snapshot is compared with what the app has (`realtime.js` `resyncSnapshot`), so
pages get only real changes, never a reload of the list. localStorage
(`happa.listenTargets`) keeps per query when it was healed and per collection when a server
read last returned documents, so a phone heals only after such a read or a new month. It
heals nothing on the memory cache (persistence off: the SDK would drop the documents) or
with another tab of the app open (the SDK may keep the query, storing nothing).
Probe on one CI runner (reopen, 4x CPU): cache answers 3.4 s → 1.9 s, first screen
5.8–6.3 s → 4.4–4.6 s.

**Looked at and not done:**

- *A newer SDK with cache indexes* (`enablePersistentCacheIndexAutoCreation`,
  `setIndexConfiguration`): only in the modular API; the compat builds have neither, up to
  13.1.0 (checked the gstatic file), so it means moving every Firestore call to the modular
  API. It would also help slowly: the SDK's index backfiller indexes 50 documents a minute
  (`index_backfiller.ts`), about 3 hours of open app for this shop, and the stored-version
  rule above is unchanged.
- *Keeping old history out of the cache* (a second Firestore instance or a smaller LRU
  cache): the rebuild's resume (#159) takes its finished pages from this cache, offline
  History would show less, and once healed the listeners no longer scan the collection,
  so a smaller cache saves little.
- *Starting Today's listeners first and the rest later*: Today needs every bill
  collection's window and dues (sales, money in from older bills, the collect / pay
  reminders), so Today would wait just as long; only the billing screen would come earlier,
  and its "Already owes" line needs the dues too.
- *A shorter wait for the server after a cache answer*: shows older figures first.

## Regressions

- Reads: the E2E smoke fails a page that reads more than its baseline + 25 % (at
  least 1 read), or more than 300.
- Start-up shape: `load-perf.test.js` fails if `index.html` links more than the
  one stylesheet again.
- Field timings: TIP `AppStart`, `BillSave` and `SessionReads` show slow or heavy
  versions in App health, and repeated failures open `tip-auto` issues.
- Lab timings: the nightly multi-year benchmark (`bench.yml`, see below) fails on a
  large slowdown.
- jsdom timing checks were left out on purpose: CI machines vary too much for
  millisecond limits to be reliable, so they would fail at random.

### Nightly benchmark gate (#120)

The nightly benchmark (`npm run bench`, `.github/workflows/bench.yml`) adds a row to
`bench-trend.csv` on the `bench-trend` branch and checks `firstTodayMs`,
`historyLoadMs` and `startupReads` (`tools/bench/budgets.json`):

- **Over its budget:** a warning only.
- **Over its hard limit:** a warning the first night. If the next run is over it
  too, the job fails (after it has pushed the trend). The hard limit is the
  lower of:
  - 1.5× the figure's budget;
  - 1.5× the median of that figure in the last 7 runs, used once at least 5 of
    them have it.

  The limits are set in `_gate` in `budgets.json`.

**Why 1.5× and two runs in a row.** The trend from 2 to 9 Nov 2026 was noisy on the
same code: `firstTodayMs` ran from 4.0 to 8.2 s and `historyLoadMs` from 5.6 to
14.0 s. Against the median of the previous 7 runs, the worst single night was
1.35×. A limit of 1.25× would already have failed on 9 Nov: `historyLoadMs` was
1.34× and then 1.26× on two nights in a row, still below the 14.0 s of 4 Nov. At 1.5×, a
real slowdown of about half again or more fails within two nights, and no night so
far comes close. A lasting slowdown that is accepted stops failing once it has
become the median (after about four nights), unless it is over 1.5× the budget. Change the limits only after
re-checking them against the trend (`tests/ci/bench-record.test.js` replays it).

**Checking the gate.** Run the benchmark by hand (Actions › Multi-year load
benchmark › Run workflow) with `simulate_slowdown` set, for example to `2`. This
multiplies the timings of this run and of the last trend row, and the job must
fail. A run without the input must pass. A manual run on a branch other than
`main`, or with `simulate_slowdown`, is checked against a copy of the trend and
never pushes it.
