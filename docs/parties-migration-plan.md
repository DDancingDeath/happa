# Parties migration plan (#139 phase 2 proposal, no writes)

Status: **proposal for the owner**. Nothing in this PR writes to Firestore: it adds an offline dry
run (`node tools/migrate/migrate.js parties`, [tools/migrate/README.md](../tools/migrate/README.md))
and this plan. Design: [parties-design.md](parties-design.md) (sections 2, 3, 8 and the open
questions in section 13).

## What the dry run shows

Input: the decrypted backup the nightly export already makes (`tools/backup/export-firestore.js`,
format `aadhat-backup-v1`, the same file `migrate.js plan` reads). **0 Firestore reads, 0 writes.**

| Output | What it is |
|---|---|
| Proposed parties | One per PARTY key (case, spaces and Unicode form ignored, as today) with a due that `plan` carries as an opening record (`--scope all`: every named bill). `name` = the most used spelling; other spellings → `aliases`; `type` customer / supplier / both from the bill lists; newest bill phone → `legacyPhone`; a spelled Hindi name as a suggestion only |
| `partyId` | `'p-'` + the first 16 hex digits of SHA-256(salt + U+0000 + PARTY key). Stable for a salt (kept in the private output, reused with `--salt-from`), independent of the side and of the spelling shown, can't be traced back to the name, and matches the rules' `^[A-Za-z0-9_-]{1,40}$` |
| Possible duplicates | Pairs found by the billing "Did you mean" matcher (`utils/party-match.js`: Hindi / Latin transliteration, "ji" / "bhai" / "seth", spacing, doubled letters, 1–2 letter typos). Ranked: **high** (same name in a loose spelling), **medium** (1 letter apart), **low** (one name starts the other, or 2 letters apart: can be two people). Each says which party would stay (more bills, then the larger due) and the combined due. **Never merged automatically** |
| Bills and dues per party | Bill counts per list, carried due bills, dues (purchase = payable; retail + wholesale = receivable). The dues are the ones `plan` carries, picked with `plan`'s own rules and options (`carriedDueSets` in `lib/plan.js`: `--mode`, `--carry-payables`, `--include-hidden-wholesale-dues`, default off: payables and wholesale bills not made on the Wholesale page are **not carried**, and wholesale uses the old Wholesale page rule). Per list, Σ parties + "No name" must equal the opening records `buildPlan` makes with the same options; the run says `OK` / `MISMATCH` (exit 1 on a mismatch) and also prints the Outstanding total of the same bills and how much of it is **not carried** |

## Steps (with the section 13 defaults)

Prerequisites: phase 1 (one name matcher, on `main`), phase 2 rules + repository (`parties` and
`partyIndex` collections, backup list, Clear Data) and phase 8 (the migration writes parties).
Until those are merged no step below can write anything.

1. **Dry run on the latest backup.** Owner (or the orchestrator on the owner's machine) runs
   `parties --in <backup>` with the **same options** the real `plan` will use (default: none) and keeps `parties-dryrun.json` and `parties-review.csv` in the private
   folder (e.g. `Q:\aadhat-data`), never in the repo.
2. **Owner checks the totals.** Each list (purchase / retail / wholesale) must read `OK`: the
   parties' dues plus "No name" equal the opening records `plan` would write with those options.
   The same line shows the Outstanding total of those bills and the part **not carried**: with the
   defaults that is every payable (the owner said none are due; `--carry-payables` carries them)
   and the wholesale bills not made on the Wholesale page (`--include-hidden-wholesale-dues`).
   The owner confirms the carried totals match the old app's Outstanding and Wholesale pages for
   the same date and decides on anything not carried before step 4.
3. **Owner reviews the duplicates** in the CSV (high first). Default (question 8): **suggest only,
   the owner confirms each merge**; nothing is merged by the tool. Two different people with one
   name (question 4): give one a distinguishing name later ("Ramesh (Kheda)"); old bills stay with
   the first.
4. **Plan with the same salt and options.** `migrate.js plan --salt-from parties-dryrun.json` (phase 8) proposes
   the same parties with the same ids, and every opening record gets its party's `partyId` on
   creation (a field on a create, no edit record).
5. **Apply** (phase 8, existing `apply` with its budget and cursor): writes the party docs and one
   `partyIndex/main` directory doc. `apply` deletes migration parties (`p-*`) no longer in the
   bundle. Bills are **never rewritten**.
6. **After go-live**, the owner merges the confirmed duplicates on the Parties page (phase 7):
   3 writes per merge, undoable (question 3: **yes, owner only, with a reason**).

Defaults applied (section 13; no answer = these):

| # | Default used |
|---|---|
| 1 | Everyone who bills may create a party by typing a new name; the owner merges duplicates |
| 2 | A `both` party keeps two balances (to pay, to receive), no netting; the dry run reports them separately |
| 3 | Owner may undo a merge, with a reason |
| 4 | Same-name different people: one gets a distinguishing name; old bills stay with the first |
| 5 | Phone optional |
| 6 | Old-app phones carried as `legacyPhone` (no recorded consent), owner can remove; ask at the next visit |
| 7 | Phone kept until the owner removes it; Parties page reminder after 12 months with no bill |
| 8 | Near-duplicates are suggested only; the owner confirms each merge |
| 9 | Members see phones as today (no separate contacts doc) |
| 10 | Hindi name optional; the dry run only suggests a spelling, the migration does not write it |
| 11 | Wholesale dues on Outstanding unchanged until #125 is answered; wholesale dues are listed separately |

## What is written (later phases, not this PR)

| Write | Count | When |
|---|---|---|
| `parties/{p-…}` | 1 per proposed party (default scope: names with a carried due; a few hundred at most) | `apply` |
| `partyIndex/main` | 1 | `apply` |
| `partyId` on opening records | 0 extra (a field on the opening record's create) | `apply` |
| Existing bills, edit records | 0 | never |

Reads: 0 for the dry run and `plan` (offline backup file); `apply` adds no reads for parties. On
the phones the directory costs +1 read per app start (design section 7). Writes fit easily in
`apply`'s 12,000 per run (Spark: 20,000 a day).

## Rollback

- Before `apply`: nothing to undo (the dry run and `plan` write only local files).
- After `apply`: delete the `parties/p-*` docs and `partyIndex/main` (parties + 1 deletes, owner or
  the migration service account, same tooling as `wipe`). Opening records keep their `partyId`;
  with the party gone the resolver falls back to the bill's name (design section 3, rules 2–3), so
  every figure equals today's. A rerun of `apply` with the same bundle recreates the same ids.
- A wrong merge after go-live: unmerge on the Parties page (3 writes, exact).

## Owner decision

Approve: yes/no
