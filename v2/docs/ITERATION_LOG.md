# happa V2: Iteration log

_Kept by the Product Lead. One entry per iteration (observe → identify → debate → propose → implement → test → review). Records improvements, remaining problems, regressions, changed acceptance criteria and reprioritisation._

---

## Iteration 0 — discovery, cross-review and design proposal (7–8 Nov 2026)

**Baseline**: `DDancingDeath/happa` `main` at `ddff5704` (PR #369). Live build `20261106v-92-money-insights` era; APK rc8; go-live on hold; rentals data real.

### Round 1 — independent discovery (executed on local emulators; no production access)

| Agent | What was done | Key results |
|---|---|---|
| A Staff / cashier | Busy-day script on phone and desktop as a member (5 bills, 2 partials, 1 fix, 1 later payment, 1 expense, 1 lookup), validation probes, keyboard path, Hindi, rentals receipts | ≈ 88 taps / 126 keys / ~4 min for the script. 28 findings (S-1…S-28). Worst: a typed line silently dropped (S-1), a 10× rate saved with one tap (S-16), wrong cash shown during an edit (S-15), WhatsApp sends an unsaved bill (S-10). Best flows: bag weights, Rest → Due, Rentals receipt sheet |
| B Owner / analyst | Seeded a 10-week month (398 bills, expenses, cash sessions, planted problems, rentals), compared every figure with independent totals | **Every checked figure was correct.** 25 findings (O-1…O-25). Worst: owner lands on Billing and Today fails the 30-second test (O-1/O-2); a false causal takeaway (O-3); mislabels (O-4, O-5, O-11, O-12); no wholesale in History (O-9); labour possibly double-counted (O-6) |
| C Developer | Metrics of the tree, two-user money scenario with dropped replies, rules forgeries, start-up requests | Bills never duplicated; **payments double-recorded after a lost reply (D-1)**; raw rules errors (D-2); audit gaps and owner edits without records (D-3); timer resets flip Billing to Purchase (D-5); rules at 94 % of budget (D-16); styling debt blocks theming (D-12). 21 findings |

### Round 2 — cross-review

- **Agreed by all three**: D-1 is P0; D-5 is one line hit by all three agents; S-1 must never drop silently; S-3 name suggestions before any parties migration; role-based homes; one bill finder; workflow fixes before visual themes.
- **Conflicts raised** (staff K-1…K-12, owner K-1…K-11, developer K-1…K-10), the main ones: default payment; auto-add vs ask for a typed line; rate prefill source; offline due payments; what Today is; parties (transactions vs batched writes, stored balances vs derived); member read access; `minClientVersion` vs queued offline bills; theme count; printer loading; labour; discounts/returns/commission; rentals on the owner's landing; one home per figure vs an Overview.

### Round 3 — Product Lead design proposal (this folder)

- Resolutions recorded in `PRODUCT_DECISIONS.md` (PD-01…PD-31) with each agent's arguments; **21 owner decisions** listed with recommended defaults (OD-01…OD-21).
- Key calls: **no silent payment default** (one-tap chips, amount on Save); **ask** about a typed line; rates only from today's list with a blocking extreme-rate confirm; payments stay online-only for now; **Overview for the owner, Counter (Billing + My day) for managers and members**, figures as references to their homes; cached rentals card; one bill finder without all-history loads; parties in three phases with offline-safe batched writes; **12 themes kept as the goal but staged** after a "no new inline colours" guard.
- Plan: `IMPLEMENTATION_PLAN.md`, Phases 0–6 in small PRs with owner flags, reads and rules impact, lanes for parallel work.
- Tests: `TEST_SCENARIOS.md` T1–T9 (busy day, month end, concurrency/failed payment, rentals, Hindi, themes, performance, roles, regression).

### Fixes in flight at the end of Iteration 0

| Plan id | Fix | Owner of the work | State |
|---|---|---|---|
| P0.1 | D-1 payment idempotency (intent id outside the DOM, "maybe saved" check) + D-2 friendly concurrent-payment message | agent fix-double-pay | In progress (PR not yet open at the time of writing) |
| P0.2 | S-1 typed-line prompt on Save/Print/WhatsApp + D-5 Billing mode no longer overridden + honest WhatsApp/print messages | agent fix-billing-safety | In progress (PR not yet open) |
| P0.3 | Go-live wipe keeps rentals data | agent wipe-keep-rentals | Draft PR #370 |

Also open in the repo and relevant to V2 (not part of this exercise): rentals redesign PRs #363, #364, #367, #368 (V2 rentals work waits for them); #356 sleek pass (draft; DIRECTION recommends superseding it — owner's call); #208 platform design (draft).

### Remaining problems (carried into Iteration 1)

- Everything in `PRODUCT_DISCOVERY.md` §7 except P-1…P-5 (in flight).
- Owner decisions OD-01…OD-21 unanswered.
- Not yet covered by any agent run: Hindi on the owner pages (only from an earlier review), manager and member views of the owner pages, anomaly detection on bills saved through the UI (Agent B seeded directly).

### Regressions

None (no V2 code merged yet).

### Acceptance criteria set in this iteration

- T1 busy day ≤ 65 taps with zero silently wrong bills; T2 five month-end questions ≤ 3 taps each and equal to independent totals; T3 exactly one payment entry after a dropped reply and no raw errors; T4 rentals labels honest and 0 start-up reads; T5 Hindi parity; T6 contrast per theme × mode; T7 no read regressions.

### Next (Iteration 1)

1. Merge P0.1–P0.3 after review; run T3.3–T3.6, T3.11 and T4.6.
2. Start Phase 1 labels in parallel (P1.1–P1.5, P1.7, P1.9, P1.10 need no owner answer).
3. Present `OWNER_SUMMARY.md` to the owner; apply answers (or "go") to OD-01…OD-21.
4. Start P0.4/P0.5 after P0.1 merges; P2.1 after P0.2 merges; P2.3–P2.5 and P3.D1 can start now (new files).
