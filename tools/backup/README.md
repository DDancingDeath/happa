# Firestore backups

`.github/workflows/firestore-backup.yml` backs up Happa's production Firestore data (project `happa-bfc07`, from
`happa.config.json`; the guard refuses the old `aadhat-management` project).

## What runs when

| Run | When | What it exports |
|---|---|---|
| **Nightly** | every day except Sunday, 08:15 UTC = **13:45 IST** | every root collection except `dev_*` and `auditLogs`, `telemetry`, `tipHealth`, `tipFailures` |
| **Weekly** | Sunday (India date), same time | **everything** (all of the above plus `auditLogs`, `telemetry`, `tipHealth`, `tipFailures`) |
| Manual | Actions → *Firestore backup* → *Run workflow* → `mode` = `nightly` or `weekly` | as above |

- **Why 13:45 IST:** Firestore's free daily quota (Spark plan: 50,000 reads, 20,000 writes) resets at midnight
  Pacific time: 12:30 IST while California is on summer time (until 1 Nov 2026), 13:30 IST in winter. 13:45 IST is
  after the reset in both seasons, so the backup isn't starved by the day's app use. GitHub may start scheduled runs
  late (so far 6–7 hours); that is still the same quota day.
- **Why nightly skips the logs:** audit logs and the test-in-production counters grow fastest and were most of a
  run's reads in the old app (8,025 audit logs read every night). They change nothing in the business data, so once a
  week is enough. The weekly export is a **full** copy, not incremental: each artifact is kept 60 days, so an
  incremental chain would lose the oldest audit logs when its first artifact expires. A full weekly copy is always
  restorable on its own.
- **Every business collection is in the nightly export**: bills, items, stock, cash, expenses, `counters`,
  `settings`, `users` (+ `users/{uid}/preferences`), the bills' edit records (`<bills>/{id}/edits`), `rateStats`, `rateHistory`, `monthStats`, `anomalies`,
  `stockCheckpoints`, and all `rent_*` collections. `BACKUP_COLLECTIONS` in `backup-lib.js` lists every collection
  in `firestore.rules`; `tests/backup/backup-collections.test.js` fails if the rules gain a collection that isn't
  listed, and the export also backs up any collection Firestore has that the list doesn't name (with a warning in the
  run summary).

### Reads per run

A run reads each exported document once, plus about 1 read per 1,000 documents for the counts (each collection
counts as at least 1) and 1 per empty query. The run summary shows the total ("≈N reads"). Rough guide:

- nightly ≈ business documents + ~30;
- weekly ≈ all documents + ~30 (adds the audit logs, telemetry and TIP docs).

The size guard still applies to the nightly set: above `BACKUP_WEEKLY_ABOVE` (default 15,000) documents, scheduled
runs only happen on Sundays; above `BACKUP_HARD_MAX` (default 40,000) nothing runs unless forced (red run).

## How it is stored

Each run uploads one artifact, kept **60 days**, named `firestore-backup-<nightly|weekly>-<YYYY-MM-DD_HHMM IST>`:

- `firestore-backup-….json.gz.enc` — the backup JSON (`format: aadhat-backup-v1`), gzipped and **encrypted with
  AES-256** (`openssl enc -aes-256-cbc -pbkdf2 -iter 200000`) with the `BACKUP_PASSPHRASE` secret. The repository is
  public, so the data is never uploaded unencrypted.
- `manifest.json` — document counts per collection, the export mode and time, and the reads used. Counts only, no data.
- `SHA256SUMS` — checksums of both files.

The JSON holds `collections: { <name>: [{ id, data }] }`, `subcollections: { "users/preferences": [{ path, data }] }`
and the same counts as `manifest`. Timestamps are stored as `{__type: "timestamp", seconds, nanoseconds, iso}`.

## Checks and alerts

- **Offline restore check (every run):** the `verify` job downloads the artifact it just made and, with no Firebase
  credentials and no Firestore reads, checks SHA256SUMS, decrypts, gunzips, parses, checks every document (ids,
  duplicates, timestamps) and compares the counts with `manifest.json`. A failure turns the run red.
- **Failure alert:** if the scheduled backup fails, is skipped, or fails the check **two nights running**, the
  `alert` job opens an issue labelled `ops` in `DDancingDeath/happa` (or updates the open one's `Last failure:` line;
  it never comments). It closes itself when a later run succeeds. It never posts anywhere else.
- **Monthly restore drill:** `.github/workflows/backup-restore-drill.yml` runs on the 3rd of each month (and on
  demand). It takes the newest weekly artifact (else the newest nightly), runs the offline check, restores everything
  into a **Firestore emulator** (`demo-happa-drill`, never a real project) and reads every document back to compare
  it with the backup. A failed drill opens an `ops` issue. Once a quarter, also do the local drill below and open the
  app on the restored data. Pull requests that touch `tools/backup/` run the same pipeline (openssl encryption,
  offline check, emulator restore and read-back) on the synthetic fixture `tests/fixtures/migrate/backup-synthetic.json`.

GitHub turns off scheduled workflows in a repository with no activity for 60 days (it emails the owner first). If
that happens, re-enable them under Actions.

## One-time setup (owner)

1. **Passphrase:** repository secret `BACKUP_PASSPHRASE` (set). Keep a copy in your password manager; without it
   no backup can be decrypted.
2. **Service account:** the job uses `FIREBASE_BACKUP_SERVICE_ACCOUNT_HAPPA` when it exists, otherwise
   `FIREBASE_SERVICE_ACCOUNT_HAPPA` (today: `firebase-adminsdk-fbsvc@happa-bfc07.iam.gserviceaccount.com`, which has
   Cloud Datastore User). It needs to *read* Firestore: **Cloud Datastore Viewer** (`roles/datastore.viewer`) or
   Cloud Datastore User. Recommended later: a dedicated `firestore-backup@happa-bfc07.iam.gserviceaccount.com` with
   only `roles/datastore.viewer`, its JSON key saved as `FIREBASE_BACKUP_SERVICE_ACCOUNT_HAPPA`.
3. Optional repository *variables*: `BACKUP_WEEKLY_ABOVE` (15000), `BACKUP_HARD_MAX` (40000), `BACKUP_EXCLUDE`
   (comma-separated; only `notifications`, `autoSaves`, `drafts` or the log collections can be skipped, business
   collections are always backed up).

## Restore

Restoring from a nightly backup gives you all business data; take `auditLogs` / `telemetry` / `tipHealth` /
`tipFailures` from the latest **weekly** artifact if you need them.

### 1. Download and check (offline)

```sh
gh run list -R DDancingDeath/happa -w firestore-backup.yml          # pick a run
gh run download <run id> -R DDancingDeath/happa -D backup-dl         # outside the repo
cd backup-dl/firestore-backup-weekly-2026-11-01_1345
sha256sum -c SHA256SUMS
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/path/to/passphrase.txt \
  -in firestore-backup-weekly-2026-11-01_1345.json.gz.enc -out backup.json.gz
gunzip backup.json.gz                                                # -> backup.json
```

Or do all of that, plus the count check, in one step (Node 22+, no dependencies):

```sh
node tools/backup/verify-backup.js --dir backup-dl/firestore-backup-weekly-2026-11-01_1345 \
  --passphrase-file /path/to/passphrase.txt --out backup-dl/backup.json
```

On Windows use Git Bash for `sha256sum` / `openssl`. Keep decrypted files out of the repo (they are real shop data).

### 2. Drill into the Firestore emulator (safe, no real project)

```sh
cd tools/backup && npm ci && cd ../..
npx firebase-tools emulators:exec --only firestore --project demo-happa-drill \
  "node tools/backup/restore-firestore.js --in backup-dl/backup.json --emulator --project demo-happa-drill \
   --target prod --confirm-project demo-happa-drill --apply --check"
```

To look around in the app, start the emulator instead (`npx firebase-tools emulators:start --only auth,firestore
--project demo-happa-drill`), restore with `--target dev` (writes `dev_*`), serve `www/` and open
`http://localhost:<port>/?emulator=1` (the app uses `dev_` collections on localhost).

### 3. Restore into happa-bfc07 (production)

Only after a drill, ideally with every phone closed. Needs a key with Firestore **write** access (Cloud Datastore
User), e.g. `export GOOGLE_APPLICATION_CREDENTIALS=$PWD/key.json` (keep the key outside the repo).

```sh
node tools/backup/restore-firestore.js --in backup.json                       # dry run: counts per collection
node tools/backup/restore-firestore.js --in backup.json --apply                # into dev_* copies first, check them
node tools/backup/restore-firestore.js --in backup.json --collections items,purchases \
  --target prod --confirm-project happa-bfc07 --apply                         # then the real collections
```

The restore never deletes. It writes each document by its original id: same-id documents are overwritten, everything
else stays. To roll a collection back exactly, first delete the documents created after the backup. Each restored
document is one write (20,000/day free): a large restore may need to be split by `--collections` over several days,
or done on the Blaze plan.

### 4. Restore into a fresh project

1. Create the Firebase project, enable Firestore (same region if possible) and Authentication (Email/Password).
2. Deploy rules and indexes: `npx firebase-tools deploy --only firestore:rules,firestore:indexes --project <new id>`.
3. Create a service-account key with Cloud Datastore User in the new project and restore with
   `--target prod --confirm-project <new id> --apply` (as in step 3).
4. Auth accounts are **not** in the backup. User profiles in `users` are keyed by Auth uid, so either import the
   old accounts (`firebase auth:export users.json --project happa-bfc07`, then
   `firebase auth:import users.json --project <new id>` with the hash parameters from the old project's
   Authentication settings) or have everyone sign up again and fix their `users` documents.
5. Point the app at it: update `happa.config.json` and run `npm run apply:happa-config` (see `docs/happa-go-live.md`).

The in-app **Admin → Clear Data** backup file (JSON saved on the phone) uses the same format; restore it the same way
(no decryption step).

## Checking the numbers in a backup

`npm run audit:numbers -- backup.json` (from the repo root, after `npm ci`) recomputes every number the app shows
(`docs/calculations.md`) for each of the last 60 days, the last 24 months and all time, once with the independent oracle
and once with the app's own code, and lists every difference, the accounting checks (AC1–AC8) and data-quality problems
(unreadable dates, negative stock, duplicate bill numbers, case-variant party names, …). It works offline on the
decrypted file only and writes `NUMBER-AUDIT.md` next to it (never into the repo). Add `--bundle out/bundle.json` to
also check a migration bundle's opening records. Never commit the report or run it in CI: it is real shop data.

## Not covered

- Firebase **Auth** accounts are not part of Firestore and aren't exported (see "fresh project" above). User
  profiles in `users` are.
- Sub-collections: only those in `SUBCOLLECTIONS` (`users/preferences`, and the bill edit records
  `purchases/edits`, `retailSales/edits`, `wholesaleSales/edits`, #121; one collection-group query per
  sub-collection name). A new one in `firestore.rules` fails
  `tests/backup/backup-collections.test.js` until it is added there.
