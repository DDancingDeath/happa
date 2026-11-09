# Design: show the first screen from the phone's cache (#59)

Status: **design only, nothing built yet.** This is the next start-up step for #59, after the
start-up weight work (#403, #406) and the listener heal (`docs/performance-budget.md`, "Start-up
with all history in the phone's cache").

**Goal:** a phone that has opened the app before shows the first screen from Firestore's offline
cache, without waiting for the server's answers. Figures that the server has not confirmed yet are
marked as such. The budget is 2.5 s from tapping the icon until billing can be used
(`performance-budget.md`). The nightly `firstTodayMs` was 5.8 s on 9 Nov.

## How start-up waits today

1. `main.js` (lines 527-536) waits for `FirebaseService.setupRealtimeListeners()` and
   `BillingManager.loadItemFrequency()` before it draws anything.
2. `setupRealtimeListeners()` (`firebase/core/listeners.js`) first waits for the stock checkpoint
   (`listenCheckpoint`), because the history window's start depends on it. Then it starts 14
   history listeners. For each bill collection these are the window query plus the `openDue`,
   `paidAt` and pinned dues queries.
3. Each listener counts as ready once the server answers. When the phone has cached data, it is
   ready at the latest `FIRST_SNAPSHOT_CACHED_WAIT_MS` (2.5 s) after its cache answer; with an
   empty cache the limit is `FIRST_SNAPSHOT_SERVER_WAIT_MS` (10 s) (`listeners.js:187-197`,
   `realtime.js:131-133`). The checkpoint uses the same rule (`stock-checkpoint.js`).
4. After the listeners, `main.js:629` waits for `BillingManager.checkAutoSave()`. Only then does
   it hide the loading overlay and record `app-shown` (`main.js:652-653`).

## Measurements

**Setup.** The multi-year benchmark (`npm run bench`) uses a 3-year shop of 8,266 documents and
an owner reopening the app, with the CPU slowed 4× and the listener heal finished before each
reopen. For this design it ran on a temporary branch with extra logging, which is now deleted:

- per listener: when it subscribed, when its first cache answer and first server answer came, and
  when it became ready;
- the startup marks, plus marks for the auto-save check and the item-order read;
- reopens alternated between the current code and prototype switches (see "Options").

It ran three times on CI (Actions runs 42579383783, 42580127662 and 42580660035, each on a
different runner) and three times locally (Windows DevBox, Chromium, the same 4× CPU).

### Where the time goes (current code)

These are typical reopens close to the nightly median. Times are in seconds from the start of the
page load; "took" is the time since the previous row.

| Step | CI at | CI took | Local at | Local took |
|---|---|---|---|---|
| SDK and app modules loaded | 0.48 | 0.48 | 0.52 | 0.52 |
| Sign-in restored (`auth`) | 0.70 | 0.22 | 0.76 | 0.24 |
| Profile (from the cache) | 0.77 | 0.08 | 0.84 | 0.09 |
| Items and the stock checkpoint confirmed by the server; history listeners start | 0.96 | 0.19 | 1.01 | 0.17 |
| **Cache answers of the 14 history listeners, one after another** | 3.35 | **2.39** | 3.71 | **2.70** |
| … of which the retail sales `openDue` query alone (939 documents) | | 1.13 | | 1.33 |
| First server answer | 3.43 | 0.08 | 3.79 | 0.08 |
| **Server answers of the 14 listeners, one after another** | 5.40 | **1.97** | 6.13 | **2.34** |
| Draw the first screen, auto-save read, overlay hidden (`app-shown`) | 5.60 | 0.20 | 6.39 | 0.27 |
| Open Today until its figures are drawn (`todayOpenMs`) | 5.66 | 0.07 | 6.45 | 0.06 |

**One CI reopen, per listener** (`app-shown` at 5.85 s). All 14 history listeners subscribed at
1.07 s.

| Listener | Cache answer at | Docs | Server answer at | Ready because |
|---|---|---|---|---|
| Purchases | 1.22 | 69 | 3.61 | server |
| Purchases dues (openDue) | 1.63 | 325 | 3.99 | server |
| Purchases dues (paidAt) | 1.69 | 0 | 4.01 | server |
| Retail sales | 1.88 | 137 | 4.19 | server |
| Retail sales dues (openDue) | 3.05 | 939 | 5.25 | server |
| Retail sales dues (paidAt), (pinned) | 3.19, 3.24 | 0, 16 | 5.27, 5.31 | server |
| Sales, dues (openDue), (paidAt) | 3.29–3.43 | 16, 81, 0 | 5.35–5.50 | server |
| Expenses, personal, stock adjustments, withdrawals | 3.47–3.52 | 40, 0, 1, 2 | 5.55–5.62 | server |

What this shows:

- **Auth, the profile and the checkpoint take under 1 s.** Drawing the screen takes about 0.2 s,
  and opening Today about 0.06 s. Almost all of the 5.6 s is spent waiting on the 14 listeners.
- **The SDK answers the listeners one at a time.** It works through all the cache answers first
  (about 2.4 s on CI and 2.7 s locally). It sends a query to the server only after that query's
  cache answer, so the first server answer comes about 0.08 s after the last cache answer, and the
  server answers then also come one at a time (about 2 s). This matches the SDK behaviour
  described in `performance-budget.md`.
- **The 2.5 s cap rarely decides anything on CI.** The emulator is on the same machine, so most
  listeners are ready through their server answer. In some runs a listener was ready through
  `cache-timeout` 2.5 s after its cache answer, up to 1.8 s before its server answer.
  On a phone the server answers also wait on the network, so this cap is reached more often. The
  emulator understates the server part.
- **A cache-ready gate on its own gains little or nothing.** In the prototype where each listener
  is ready at its cache answer ("0" below), the `listeners` mark moved from 5.4 s to 3.4 s on CI,
  but `app-shown` stayed at 5.6–5.9 s (locally 7.20 vs 7.15 s and 5.92 vs 6.67 s). The cause is `checkAutoSave()` (`main.js:629`). It does a server-first
  `.get()` of `autoSaves/{uid}` (`repos/bill-drafts.js:89`), which queues in the SDK behind the 14
  server answers, and the overlay waits for it. The item-order `.get()`
  (`repos/bill-drafts.js:100`) is a server-first read too. It is answered at 0.7–1.4 s, around
  when the history listeners start, so it holds nothing today. Once the history listeners stop holding
  start-up (option B), though, it does.
- **The nightly noise (4.0–8.2 s) comes from the runner.** The whole timeline stretches with it.
  The share each step takes stays about the same.

### Reads

In every mode the read meter counted 1,647–1,656 reads up to the point where reads stopped.
Reopens of the current code vary within the same range. The one exception is a local run of B:
its count stopped at 12, because the meter's quiet period ended before any server answer arrived,
so it is not comparable. On CI, B counted 1,656. The prototypes change when start-up
stops waiting. They don't change which queries run, so they don't change what is billed.

## Options

These were measured as prototype switches on the temporary branch. Each figure is the median
`app-shown` of 3 reopens, in seconds. `firstTodayMs` is 0.05–0.09 s more.

| Option | CI run 1 | CI run 2 | CI run 3 | Local runs |
|---|---|---|---|---|
| Today: wait for the server (2.5 s cap after a cache answer) | 6.24 | 5.64 | 4.62 | 7.15 · 6.67 · 7.47 |
| "0": ready at the cache answer, nothing else changed | 5.89 | 5.66 | — | 7.20 · 5.92 |
| **A**: ready at the cache answer, and the auto-save read no longer holds the overlay | — | **3.42** | **2.78** | 3.76 · 4.37 |
| A, and the item-order read is not awaited either | — | — | 2.76 | 4.54 |
| **B** (prototype): the first screen waits only for items, the checkpoint and the profile | — | 3.32 ¹ | **0.72** ² | 1.25 ² |

¹ The item-order read was still awaited, and it queued behind the history cache answers.
² Today's figures were complete only at the last cache answer (2.7 s on CI run 3, 4.5 s
locally). Opened before that, Today drew partial figures that looked final.

### A. Show the first screen from the cache answers, then mark the figures "updating…"

On a phone with a warm cache, a listener is ready at its first cache answer, so start-up continues
once all of them have answered from the cache. The server answers arrive later as ordinary
changes, through the path the 2.5 s cap already uses today: `onData(changes, true)` →
`markDirty` → the open page is redrawn. Until every listener has a server answer, money figures
carry an "updating…" mark. A phone with an empty cache keeps the 10 s wait for the server.

- **Gain:** CI `app-shown` 5.64 → 3.42 s and 4.62 → 2.78 s (−39 % and −40 %). Locally 6.67 →
  3.76 s and 7.47 → 4.37 s (−44 % and −41 %). On a phone the gain should be larger, because the server part
  there includes the network.
- **Cost:** none in reads. The code change is small and stays inside the data layer, `main.js`
  and an "updating…" chip.
- **Limit:** it stays above 2.5 s on slower runners, because about 2.4 s of serial cache answers
  remain (retail sales `openDue` alone takes 1.1 s).

### B. Show Billing before the history listeners answer

The first screen (Billing) waits only for items, the checkpoint, the profile and the item order.
Every other page waits for its own collections' cache answers.

- **Gain:** Billing at about 0.7 s on CI and 1.25 s locally. Today is not faster than with A:
  its figures need every bill collection's window and dues (`performance-budget.md`, "Looked at
  and not done").
- **Cost:** every page that reads history must tell "not loaded yet" apart from "zero" (Today,
  Outstanding, History, Money, Statements, Insights, Stock, Parties). Billing's "Already owes"
  line and the next-bill-number hint would also start empty. In the prototype, Today opened at
  0.7 s and drew partial sales as if they were final, which is exactly the risk below. This is
  an M–L change across many pages.

### C. Make the cache answers cheaper (not measured)

One example: a stored dues summary instead of loading every open bill, which would make the
939-document `openDue` answer smaller. This changes the data model and the stock and dues
calculations, so it needs its own design. It is listed as the follow-up after A.

### Rejected

- **Wait for the server, but shorten the 2.5 s cap.** On CI the cap rarely decides anything (see
  above), and it still shows cached figures as final.
- **Start Today's listeners first.** Measured before, in `performance-budget.md`: Today needs
  all of them.

## Correctness risks and how A handles them

1. **Stale money figures shown as final.** The cache can miss bills, payments or cash entries
   made on another phone since this phone last synced. Mitigation:
   - The data layer keeps a per-session freshness state: `cache` while any listener has only a
     cache answer, `server` once every listener has had a server answer (a failed optional
     listener counts as answered), and `offline`. It sends an event when the state changes
     (`utils/events.js`, for example `DATA_FRESHNESS_CHANGED`); pages never ask Firestore.
   - While the state is `cache` and the phone is online:
     - the header pill (`ui/sync-status.js`) shows "Updating…";
     - Today, Outstanding, Money and Billing's "Already owes" line show a small "updating…" next
       to their totals.
   - After 15 s without a server answer, the text becomes "Not updated since <time>". The time
     comes from the existing `asOfText` and `happa.serverDataAt`.
   - An unchanged server answer has no `docChanges()` and redraws nothing. That is why the
     marks follow the freshness event, not a redraw.
2. **A cached snapshot missing new bills.**
   - **Display:** covered by the mark above. The server answer then adds the bills as normal
     changes.
   - **Derived data written from cached rows:** this is the real danger. It already exists today
     whenever the 2.5 s cap fires, and A would make it common. Every writer of derived data must
     wait for the `server` state:

     | Writer | Today |
     |---|---|
     | Stock checkpoint maintenance | Safe: returns `'waiting'` unless every stock listener has a server answer (`stock-checkpoint.js:387`) |
     | Month snapshots | Safe: refuse snapshots that came from the cache (`history-window.js:450`) |
     | Rate-trends roll-forward | Safe: checks `historyServerSynced()` |
     | Legacy backfills | Safe: written only after a server snapshot |
     | **Personal expense day totals** | **Gap:** `rebuildPersonalExpenseDays` (`listeners.js:355`, `repos/expenses.js:286`) relies on `personalRowsLoaded()`, which only checks `live.delivered` and is also true for a cache answer. It can "fix" the shared day totals from stale rows. It must require `live.server`. |
     | TIP number checks, daily anomaly scan | To be checked in PR 2. They should start only in the `server` state, so they don't report false mismatches. |
   - **The next-bill-number hint** (`renderBillNumber`) is only a hint. A saved bill's number
     comes from the counter transaction (`docs/architecture.md`, item 10), so a stale cache can't
     give two bills the same number.
3. **The warn-never-block rule (owner, 8 Nov).** Checks that run on cached data may only warn.
   - Oversell is the one stock check that blocks. While the state is `cache`, stock is treated as
     approximate (the existing `stockApproximate` path, `bill-checks.js:247-250`), so oversell
     warns and offers "Yes, it's right"; it never blocks.
   - The duplicate-bill warning (same party, items and total within 120 s) may miss a bill from
     another phone that the cache doesn't have yet. That only means a warning not shown.
   - Money that would be corrupted is still refused by the server-side transactions, not by the
     cache. For example, a payment above the bill's due is checked against the server copy inside
     the payment transaction (`modules/outstanding.js`, the `exceeds-due` check, run through
     `repos/bill-payments.js`).
4. **Several phones out of step.** Phone A shows "Already owes ₹500" from its cache while phone
   B recorded the payment a minute ago. The "updating…" mark on that line covers it. A payment
   taken on phone A runs a transaction against the server copy, so it can't overpay the bill.
   The window lasts until the server answers: about 2 s on CI, longer on mobile data.
5. **Read cost must not rise.** A keeps the same queries and subscriptions, and the measured reads
   were the same in every mode. PR 1 even removes one read per open (the item-order `.get()`;
   the `itemFrequency/global` listener already reads the same document). The E2E read baselines
   and the bench's `startupReads` check this.
6. **Offline.**
   - Unchanged when the phone knows it is offline (`navigator.onLine === false`): ready at the
     cache answer, the pill shows "Offline · as of <time>".
   - Better on a weak connection that claims to be online. Today each listener waits up to 2.5 s
     with nothing on screen; with A the screen shows straight away with "updating…", which turns
     into "Not updated since <time>".
   - A phone with an empty cache (first sign-in, or cleared storage) has no warm cache. It keeps
     the 10 s wait for the server, so a fresh phone never shows ₹0 as final.
7. **Jank while the server answers arrive.** The SDK processes the server answers on the main
   thread for about 2 s after the screen appears (with the CPU slowed 4×). Typing during that
   time may lag. PR 3 measures input delay in the bench (time from a key press to the field
   showing it, during the server phase). It must stay under 100 ms; if it doesn't, the server
   answers are handled in idle time.

## Recommendation: option A, in three PRs

A halves start-up for a small change that stays mostly inside the data layer. It is honest about
freshness and keeps reads as they are. B is faster only for Billing, puts every page at risk of
showing partial figures as final, and doesn't help Today. B or C stay as the follow-ups once A has
landed and the bench shows the serial cache answers as the remaining cost.

### PR 1: one-shot server reads stop holding the first screen (perf, `www/`, small)

- Stop awaiting `checkAutoSave()` before hiding the overlay. The banner is already non-blocking
  (#117). Auto-save writes (`autoSaveToCloud` / `deleteAutoSave`) and `openLaunchShortcut()` wait
  for the check to finish, so an auto-save that hasn't been offered yet is never overwritten.
- Drop the startup `loadItemFrequency()` `.get()`. Take the item order from the
  `itemFrequency/global` listener's snapshot instead: the `ITEM_FREQUENCY_CHANGED` handler in
  `billing.js` sets `itemFrequency` from the event's data, which also keeps the order live across
  phones.
- **Tests:**
  - Jest: an auto-save write waits for the recovery check, and the item order comes from the
    event.
  - The existing E2E for auto-save restore and the item order stays green.
  - Read baselines −1 per open.
- **Expected gain:** 0.1–0.25 s on its own (the gap between `listeners` and `app-shown`, 0.20 s on
  CI and 0.27 s locally) and one read per open. It is also what lets PR 3 pay off: without it, the
  cache gate gains little or nothing (CI 5.66 vs 5.64 s).
- Not a money PR: merge after review.

### PR 2: know when the data is confirmed by the server (data layer and safety, no timing change)

- Add the freshness state and event (risk 1).
- Make `personalRowsLoaded()` / `rebuildPersonalExpenseDays` require `live.server`. This fixes the
  existing gap after the 2.5 s cap.
- Start the TIP number checks and the anomaly scan only in the `server` state.
- Treat stock as approximate while the state is `cache` (oversell warns only).
- **Tests:**
  - Jest: the freshness changes (cache → server, offline, a failed optional listener).
  - Jest: the day totals are not rebuilt from cache-only rows.
  - Jest: oversell warns, never blocks, while the state is `cache`.
  - E2E: none needed.
- **Expected gain:** none. It makes PR 3 safe and closes the existing gap.
- Touches the stock and money checks: **orchestrator review**, don't self-merge.

### PR 3: show the first screen from the cache (the switch)

- With a warm cache, the listeners and the checkpoint are ready at their first cache answer
  (`FIRST_SNAPSHOT_CACHED_WAIT_MS` 2500 → 0). Keep the 10 s server wait for a cold cache.
- Add the "Updating…" pill and the "updating…" marks on Today, Outstanding, Money and the "Already
  owes" line, plus "Not updated since <time>" after 15 s. Text goes through `t()`, with new keys
  in `en.js` and `hi.js`.
- Update `performance-budget.md` and the `firstTodayMs` budget once the trend settles.
- **Tests:**
  - Jest: a listener is ready at its cache answer with a warm cache and waits for the server
    with a cold one; the chip text in each state.
  - E2E: a reopen shows the first screen, and the "Updating…" chip goes away after the server
    answers.
  - E2E: a bill added by "another phone" (an emulator write while the page is closed) is on
    Today after the server answer, and the figures were marked "updating…" before it.
  - E2E: an offline reopen (`context.setOffline(true)`) shows the cached figures with "Offline ·
    as of".
  - Bench: `appShownMs`, `firstTodayMs` and `startupReads` (must not rise), plus the input delay
    of risk 7.
- **Expected gain:** CI `app-shown` and `firstTodayMs` about −40 % (5.6 → about 3.4 s on a typical
  runner, 2.8 s on a fast one). Phones should gain more.
- Shows money figures before the server confirms them: **orchestrator review**.

After PR 3, measure a cold start on the reference phone (release-checklist §7). That is still
open on #59.
