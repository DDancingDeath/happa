# Firestore read budget

The Spark plan gives the whole project **50,000 document reads a day**, shared by
every phone, the website, previews and the backup jobs. It resets at midnight
Pacific time (about 12:30 IST in summer, 13:30 IST in winter). When it runs out,
phones keep working from their offline copy and queue their writes, but nothing
new loads until the reset (#159).

## What happened on 2026-10-21 (old app)

The old project ran out of reads on 2026-10-21. The usage graph can't be read
from here (the Cloud Monitoring API needs a billing account), so the cause is
inferred from what changed that day:

- the v1.4.0 stock rebuild (stock version 2 → 3): each owner/manager phone read
  the full bill history once after updating;
- preview channels and test sessions reading the real data on every open;
- many app opens during testing and merges (~450 reads each with the recent-history window).

What was changed since: the stock rebuild is shared through a lease (one phone
rebuilds and writes the checkpoint, the others wait for it), previews and
localhost use the `dev_` test data, the cash page reads 5–38 documents instead of
~1,800 (#38, #40), and the nightly backup skips audit and telemetry (~132 reads).

## Guards in the app

| Guard | What it does | Code |
|---|---|---|
| Read meter | Counts the billed reads of this session per source (Diagnostics → "Data reads this session") | `firebase/firestore-meter.js`, `utils/quota-guard.js` |
| Quota banner | A quota error shows one banner per session ("Daily free data limit reached …"); writes stay queued | `utils/quota-guard.js` |
| Heavy session | Past 3,000 reads in one session: a console warning and a telemetry warning | `HEAVY_SESSION_READS` |
| Session cap | Past 10,000 reads in one session, after a quota error, or while the kill switch is on, the optional background reads stop for the session: the legacy-timestamp scan and the rate-trends roll-forward | `SESSION_READ_CAP`, `backgroundReadsAllowed()` |
| Kill switch | `settings/app.pauseBackgroundReads: true` (Firebase console) stops those background reads on every phone at its next open; delete the field to undo. While it is on, records written by outdated app versions (no numeric `timestamp`) can be missing from history, dues and stock until the weekly full rebuild, so turn it off again soon | `FirebaseService.loadAppSettings()` |
| Alerts | TIP check `SessionReads`: every sign-in records its reads until the first screen (warn above 1,000, fail above 2,500; listeners answered from the offline copy are counted later, so this can be low); a heavy session and a quota error are failures. The daily TIP job opens a `tip-auto` issue when they repeat, and App health shows them | `tip/scenarios/session-reads.js` |
| Read budget in CI | The E2E smoke fails a page that reads more than its baseline (+25%) | `tests/e2e/read-baselines.json` |

## When the quota runs out

1. Tell the shop to keep billing: bills save on the phone and sync after the reset.
2. Don't open the app on many devices or run backups until the reset.
3. After the reset, App health and the `tip-auto` issue show which check and
   version read too much; Diagnostics on a heavy phone shows the top sources.
4. If one phone keeps reading a lot, set `pauseBackgroundReads: true` on
   `settings/app` until it is fixed.
