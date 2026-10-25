# Move to the shop's own Firebase project (#15)

This tool copies what the shop needs into a **new Firebase project** for the new app, **Happa**. The old app, the old site (`aadhat-management.web.app`) and the old project (`aadhat-management`) **stay as they are**: nothing here changes them.

It never reads the old project. Its only input is a **decrypted backup** made by `tools/backup` (see `tools/backup/README.md`). The old project's free read quota is not used.

- `plan` (offline): backup.json → `out/bundle.json` (the documents to write) and `out/report.md` (counts and totals only, no names; safe to paste into a PR).
- `apply`: writes the bundle into the new project. **Dry run by default**; writing needs `--yes`.

Needs Node 22.12+ (the tool imports the app's own `www/js/utils` so the numbers match the app).

```sh
cd tools/migrate && npm ci && cd ../..
node tools/migrate/migrate.js plan  --in backup.json
node tools/migrate/migrate.js apply --bundle tools/migrate/out/bundle.json --project happa-bfc07             # dry run
node tools/migrate/migrate.js apply --bundle tools/migrate/out/bundle.json --project happa-bfc07 --key key.json --yes
```

`tools/migrate/out/` is git-ignored. The bundle holds shop data (names, phones, users): keep it private and delete it after cutover. Never commit a service-account key.

## What is carried

| What | How | Flag (default first) |
|---|---|---|
| History | **Fresh start**: old bills are not copied; the old project and the encrypted backup are the archive | `--mode fresh` / `full` (copies every bill as is, no opening balances) |
| Items page | `items` copied as is, same ids | `--copy items,users,rateHistory,itemFrequency` |
| Users | `users` profile docs as is (roles, status), same uids; logins move with `auth:import` below | (part of `--copy`) |
| Outstanding (retail) and Wholesale → Outstanding | one **opening record per old unpaid bill**, see below | always in `fresh` mode |
| Wholesale dues that no page shows (bills not made on the Wholesale page) | **not carried**; the report lists their count and total under "Not carried (owner to decide)" | `--include-hidden-wholesale-dues` carries them to Wholesale → Outstanding |
| Supplier payables | **checked only**: the report shows the total (should be ₹0) and warns otherwise | `--carry-payables` to carry them like receivables |
| Buying and rate patterns | `rateStats` built from **all** old bills, weekly + monthly, plus `rateStats/_meta` | `--no-rate-stats` |
| Rate history | `rateHistory` copied as is | (part of `--copy`) |
| Item order in the billing list | `itemFrequency` copied as is | (part of `--copy`) |
| Settings | `settings/*` (labour rate, heavy-packet weight, bill-check limits, …) minus project-specific fields (`minClientVersion`, `enforceClientVersion`, anything naming the old project) | `--no-settings` |
| Bill numbers | **continue**: today's counters (`counters/{P,S,W}YYYYMMDD`) are carried, so a same-day cutover goes on from the last number | `--bill-numbers continue` / `restart` |
| Opening stock | **not carried**: set it by hand in Happa (runbook below) | – |
| Opening cash, party list | **not carried** (fresh start) | – |
| `dev_*` collections | never | `apply --dev` writes everything into `dev_<name>` for a rehearsal |

Bill numbers are per day (`S20261025-001`), so numbers made in Happa never clash with the old numbers that opening records keep.

### Opening records (dues)

One bill-shaped document **per old unpaid bill**, in the collection the due lived in (`retailSales`, `wholesaleSales` with `source: 'sales-tab'`, or `purchases`), id `opening-<type>-<old bill id>`:

```js
{
  billNumber /* the old number */, customerName, customerPhone /* the bill's, else the party's: WhatsApp reminder */,
  date /* the old date, as stored */, timestamp /* the old bill time */, type, items: [],
  total: 0, cashPayment: 0, onlinePayment: 0,
  dueAmount: <open amount>, payment: { cash: 0, online: 0, due: <open amount>, total: 0 },
  openDue: true, cleared: false, clientVersion: 3,
  openingBalance: { migrated: true, kind: 'receivable', billType, amount, billTotal, paidBefore,
                    asOf, fromProject, sourceBillId }
}
```

- Outstanding, its age groups, the party due under the name field, WhatsApp reminders, statements, payments and write-offs already read `payment.due` / `dueAmount` and the bill number and date, so they show exactly what the old app showed. Bills are picked and grouped as the pages do (`buildAging`; Wholesale uses its own rule, `wholesaleOutstanding`).
- `total` is 0 and there are no lines, so Finance, Reports and stock never count the old sales a second time. Money received later counts on the day it is received, as for any due.
- App change: Outstanding and Wholesale → Outstanding show the open amount as the bill total and a line "From the old app: bill total ₹…, paid before the move ₹…".

`plan` cross-checks, re-reading the records with the app's own code: same total, same parties and per-party totals, same age groups as the old pages; monthly rate buckets = the app's own monthly aggregation (`rate-trends.js`); weekly kg = monthly kg.
### Buying and rate patterns

`rateStats/{itemId}_{YYYY}`: weekly buckets `w<Monday YYYY-MM-DD>` (IST weeks starting Monday; a week belongs to its Monday's year) and monthly buckets `m<YYYY-MM>`, each `{ purchase, retail, wholesale: {kg, amount, min, max, avg, bills}, bills }`. This is the layout of the Rate trends rework (branch `feat/rate-trends-items-rate`): **merge that PR first**. `lib/rate-stats.js` `buildRateStatsDocs()` is the one function to switch to its exported aggregation. `rateStats/_meta` gets `backfillDone: true` plus `cutoff` (backup time); the new app must only roll forward bills after `cutoff`.

### Write budget (Spark: 20,000 writes/day)

The report gives the total writes. `apply` writes in batches of 400 and stops at `--budget` (default 18,000 per run, leaving room for the shop's own writes). Run the same command the next day to continue: the cursor file (`out/bundle.json.<project>.cursor.json`) remembers where it stopped. Every write is a `set()` at a fixed id, so a rerun is harmless.

A new `plan` makes a new bundle; continue with `--restart` (idempotent). Opening records that already have a payment or were cleared in Happa are **never overwritten**, and opening records whose bill is no longer due are removed.

`apply` refuses `aadhat-management` and a key that belongs to another project.

## Logins (Firebase Auth)

The app signs in with **email and password only** (`www/js/auth/authentication.js`). Move the accounts with the same uids (the `users/{uid}` docs depend on them). This reads Auth, not Firestore, so it does not touch the Firestore quota.

1. Old project console → Authentication → Users → ⋮ (top right of the table) → **Password hash parameters**. Copy `base64_signer_key`, `base64_salt_separator`, `rounds`, `mem_cost`.
2. Export and import:
   ```sh
   firebase auth:export users.json --format=json --project aadhat-management
   firebase auth:import users.json --hash-algo=SCRYPT \
     --hash-key=<base64_signer_key> --salt-separator=<base64_salt_separator> \
     --rounds=<rounds> --mem-cost=<mem_cost> --project happa-bfc07
   ```
3. Sign in to Happa with one account first. Wrong parameters mean nobody can sign in (fix: re-import with the right ones, or "Forgot password").
4. Delete `users.json` (it holds password hashes).

## Cutover (data steps)

The go-live runbook is **`docs/happa-go-live.md`** in the Happa PR (#231). It covers the project `happa-bfc07`, `happa.config.json`, signing (`HAPPA_*` secrets, `Happa.apk`), the workflow and `.firebaserc` switch, and the merge order. This section is only the data part: run it at that runbook's step 6 ("Stop billing in the old app and run the migration").

1. Rules and indexes are already deployed to `happa-bfc07` (go-live step 5). Get a key for a migration service account in `happa-bfc07` with **Cloud Datastore User** (`roles/datastore.user`). Keep it on your computer only and delete it after cutover.
2. **Rehearse** (any time before): run `plan` and `apply --dev` with a recent backup, open Happa on localhost, check Items, Outstanding, Wholesale → Outstanding, Rate trends and Settings, then delete the `dev_*` collections in `happa-bfc07`.
3. At the cut-off: close the cash session in the old app. From then on **the shop stops billing in the old app**: a bill saved there does not appear in Happa. Take the final backup (go-live step 6.2), download, check and decrypt it (`tools/backup/README.md`).
4. **Migrate**:
   ```sh
   node tools/migrate/migrate.js plan --in backup.json            # read out/report.md: totals, "Not carried", warnings, writes
   node tools/migrate/migrate.js apply --bundle tools/migrate/out/bundle.json --project happa-bfc07            # dry run
   node tools/migrate/migrate.js apply --bundle tools/migrate/out/bundle.json --project happa-bfc07 --key key.json --yes
   ```
   Then move the logins (above). `plan`/`apply` can be **rerun just before go-live** (add `--restart` for a new bundle) to pick up the latest items, dues, settings and patterns. Rerun only before Happa is in use: a rerun rewrites items, users, settings and rate patterns.
5. **Set opening stock** per item in Happa: Stock → Stock Adjustment → type **Set**, the counted kg, and **Rate (₹/kg)** = the average cost. The stock replay uses that rate as the cost of the stock, so cost of goods sold and profit work from the first sale.
6. **Re-enter shop name and UPI id in Happa Settings on each device.** They live on the phone, not in Firestore, so they are not carried. Printer, language, dark mode and the Hindi-names option are per phone too.
7. **Check** in Happa: sign in as each role; Items count; Outstanding and Wholesale → Outstanding totals and age groups equal the report; a reminder and a statement for one party; Rate trends shows the history; a test bill gets the next number.
8. Keep the final backup archive (encrypted, as the workflow made it) and the passphrase in the password manager. The old app, site and project stay as they are; nothing in this tool changes them.

Optional: the owner can send a notice with the Happa download link from the old app's inbox.