# Firestore backups

`.github/workflows/firestore-backup.yml` backs up the production Firestore data:

- **When:** every day at 13:45 IST (shortly after Firestore's free daily read quota resets at midnight Pacific, so the backup isn't starved by the day's app use), plus on demand (Actions → *Firestore backup* → *Run workflow*).
- **What:** every root collection except `dev_*`. That includes bills, items, stock adjustments, cash, expenses, users, audit logs, counters and so on. It is one JSON file (`format: aadhat-backup-v1`) with Firestore Timestamps stored as `{__type: "timestamp", seconds, nanoseconds, iso}`.
- **How it is stored:** gzipped, then **encrypted with AES-256** (`openssl enc -aes-256-cbc -pbkdf2 -iter 200000`) using the `BACKUP_PASSPHRASE` secret. It is uploaded as a workflow artifact and kept for **60 days**. The repository is public, so the archive is never uploaded unencrypted. Without the passphrase, the file is useless.
- **Failures:** a failed run (missing secret, no permission, size guard tripped) turns the run red. GitHub emails the repo owner about failed scheduled runs.

## One-time setup (owner)

1. **Passphrase.** Settings → Secrets and variables → Actions → *New repository secret*. Name it `BACKUP_PASSPHRASE` and use a long random value. **Store it in your password manager.** Without it, no backup can be decrypted.
2. **Service account with Firestore read access.**
   - The job backs up Happa's project (`happa.config.json`; the workflow refuses `aadhat-management`). By default it uses the `FIREBASE_SERVICE_ACCOUNT_HAPPA` secret, the one used for hosting deploys. That account was created by `firebase init hosting:github` and normally only has Hosting roles. Check it in Google Cloud Console → IAM, and if needed grant **Cloud Datastore Viewer** (`roles/datastore.viewer`).
   - **Recommended instead:** create a dedicated read-only account, e.g. `firestore-backup@happa-bfc07.iam.gserviceaccount.com`, with only `roles/datastore.viewer`. Create a JSON key for it and save it as the secret `FIREBASE_BACKUP_SERVICE_ACCOUNT_HAPPA`. The workflow prefers that secret when it exists, so the deploy key doesn't also need data access.
3. Optional repository *variables* (Settings → Variables):
   - `BACKUP_WEEKLY_ABOVE` (default `15000`)
   - `BACKUP_HARD_MAX` (default `40000`)
   - `BACKUP_EXCLUDE`: comma-separated collection ids to skip, e.g. `notifications,autoSaves`
4. Run the workflow once by hand and check that an artifact appears.

## Free-quota guard (Spark plan)

A full export reads every document once. The free tier allows **50,000 document reads/day**, shared with the app. The script counts documents first; aggregate counts cost about 1 read per 1,000 documents. Then:

| Documents | Scheduled run | Manual run |
|---|---|---|
| ≤ `BACKUP_WEEKLY_ABOVE` (15,000) | every night | runs |
| above that, ≤ `BACKUP_HARD_MAX` (40,000) | **Sundays only** (weekly) | runs |
| > `BACKUP_HARD_MAX` | fails (red run, email) | only with *force* |

At about 15k documents, a nightly backup uses about 30% of a day's free reads. Watch Firebase Console → Usage. If the shop grows past this, either back up weekly, raise the limit on the Blaze plan, or switch to the managed export (`gcloud firestore export`, Blaze only).

## Restore

1. **Download** the artifact from the run page (Actions → run → *Artifacts*). You need repo read access and must be logged in. Unzip it.
2. **Check and decrypt**:
   ```sh
   sha256sum -c SHA256SUMS
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
     -in firestore-backup-2026-10-22_0300.json.gz.enc -out backup.json.gz
   gunzip backup.json.gz        # -> backup.json
   ```
   `openssl` asks for the passphrase. On Windows, use Git Bash.
3. **Restore drill into `dev_*`**. This is safe: production is untouched.
   ```sh
   cd tools/backup && npm ci && cd ../..        # needs Node 22+
   # key with Firestore write access, e.g. downloaded to key.json
   export GOOGLE_APPLICATION_CREDENTIALS=$PWD/key.json
   node tools/backup/restore-firestore.js --in backup.json                 # dry run: shows counts
   node tools/backup/restore-firestore.js --in backup.json --apply         # writes dev_<collection>
   ```
   Then open the app on `localhost`, which uses the `dev_` collections, and check bills, stock and dues. Doing this drill once a month confirms the backups are usable.
4. **Restore into production** (only after a drill, ideally with every phone closed):
   ```sh
   node tools/backup/restore-firestore.js --in backup.json --collections items,purchases \
     --target prod --confirm-project happa-bfc07 --apply
   ```
   The restore never deletes anything. It writes each backed-up document by its original id: same-id documents are overwritten, everything else stays. To roll a collection back exactly, first delete the documents created after the backup, or restore into `dev_*` and compare.

The in-app **Admin → Clear Data** backup file (JSON saved on the phone) uses the same format. Restore it the same way (no decryption step).

## Not covered

- Firebase **Auth** accounts are not part of Firestore and aren't exported. User profiles in `users` are.
- Sub-collections: the app doesn't use any. If one is added later, extend `export-firestore.js`.
