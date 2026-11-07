# happa V2: Test scenarios

_Product Lead, Round 3, 8 Nov 2026. These scenarios are the acceptance tests for V2 (mission Round 5). **Baselines** are the Round 1 executed runs (staff, owner and developer reports). **None of the V2 expectations has been run yet**; each phase's exit in `IMPLEMENTATION_PLAN.md` names the scenarios that must pass. A workflow is reported as tested only when it was executed (Playwright on emulators or a real phone) or verified in data._

**Environment for every automated run**: Firestore + Auth emulators with a demo project id (never production), the static server, Playwright at **phone 390×844 (touch)** and **desktop 1366×768**, English and Hindi. Tap counting uses Agent A's method so before/after compare: a tap = a click/focus/checkbox; a native `<select>` = 2 taps; keys = characters + Enter; human time ≈ 1.5 s per tap + 0.4 s per key.

---

## T1. Staff: "It's a busy day. Ten customers are waiting." (member role)

**Preconditions**: E2E seed (Rice, Wheat, Mustard; today's Rates set: Wheat sale ₹26, Rice sale ₹36, Wheat purchase ₹22, Rice purchase ₹30); signed in as the member; drawer open.

| # | Step | Round 1 baseline (phone) | V2 expected outcome | Pass criteria |
|---|---|---|---|---|
| T1.1 | Purchase from "Ramu Kisan": Wheat 4 bags (52, 51.5, 49, 50) @22 + Rice 2 bags (50, 48) @30; cash ₹3,000, rest as udhaar | 20 taps / 38 keys; rate typed; Save below the fold | App opens on Billing in the last mode; rates prefilled from today's list; ↵ adds bags, ↵ on empty weight adds the line; Split → Cash 3,000 → Rest as udhaar; sticky "Save · Split" | Total 7,395, labour 36, payable 7,359, due 4,359 stored; ≤ 16 taps |
| T1.2 | Walk-in retail: Wheat 10 kg, cash | 8 taps / 4 keys | Item chip → weight ↵ → (Cash) → "Save · Cash ₹260" | ≤ 5 taps; payment stored as cash 260 because Cash was tapped (not defaulted) |
| T1.3 | "Sita Devi": Rice 5 kg + Wheat 20 kg; online ₹500, rest udhaar | 14 taps / 19 keys; full name typed | "Sit" → suggestion "Sita Devi · owes …"; two lines; Split | ≤ 10 taps, ≤ 8 keys; one party (no new spelling) |
| T1.4 | The mistake: "Mohan" Wheat 15 kg typed at **260**, cash | One tap on OK saved ₹3,900 | Blocking sheet "15 kg × ₹260 = ₹3,900 · today ₹26 → ₹390" with **Fix rate** primary | Default path (↵ / primary) fixes the rate; a ₹3,900 bill is stored only after the explicit "Keep ₹260" (logged override; members per OD-02) |
| T1.5 | Retail via Print: "Gopal" Rice 3 kg, Online, Print | Toast "Sale saved and printed!" with no printer | Save & Print; post-save sheet; toast "Printer not connected — receipt shown" | Honest message; receipt preview correct; bill saved once |
| T1.6 | Correct the mistake (if it was kept): from the post-save sheet or Bills | 12 taps / 3 screens; Cash box showed 3,900 | "Edit this bill" → rate 26 → the boxes show Cash 390 and "give back ₹3,510 cash" → Save → reason | ≤ 7 taps from the sheet (≤ 10 from Bills); edit record with reason; stored cash 390 |
| T1.7 | Sita pays ₹100 cash later (Outstanding) | 5 taps / 7 keys; payment box below the fold | Outstanding opens on the remembered tab; search → party card → Receive → (Cash) → "Record ₹100 · Cash" | ≤ 6 taps; box above the fold at 360×640; one entry |
| T1.8 | Expense: Labour ₹300 cash, person "Hamal" | 6 taps / 13 keys | My day → Expense → (Labour paid) → 300 → (Cash) → Save (person under "More") | ≤ 5 taps without the person; ≤ 7 with it |
| T1.9 | Find Ramu's purchase and share it | 5 taps; "(COPY)" even on the first send | Bills → "Ramu" → row → Share (no Purchase/Sale choice first) | ≤ 4 taps; a resend from Bills is marked "(COPY)", while the first send from the post-save sheet is not |
| Σ | 5 bills + 2 partials + 1 fix + 1 later payment + 1 expense + 1 lookup | ≈ 88 taps, 126 keys, ≈ 4 min | | **≤ 65 taps**, ≤ 95 keys; every stored amount equals the expected value (emulator check) |

**Safety probes (same run, must all hold)**

| Probe | Expected |
|---|---|
| Filled entry row on Save / Print / WhatsApp | "Add Rice 4 kg × ₹36 = ₹144 to the bill?" — never silently added or dropped (P0.2) |
| No payment chip chosen | Save disabled with the hint; nothing preselected (PD-01) |
| Udhaar without a name | Blocked at the name field |
| "Seeta Devi" typed | "Did you mean Sita Devi (owes ₹200)?" |
| Clear with lines | Undo restores everything within 10 s |
| Leave Billing in Retail → Outstanding → back | Still Retail (D-5); same after reload |
| WhatsApp from the form | Saves first, then shares; never shares an unsaved bill |
| Double / triple tap on Save | Exactly one bill (unchanged) |

**Automation**: `tests/e2e/v2-busy-day.spec.js` (from Agent A's `probe-scripts/02-busy.js` and `03-validate.js`) with a tap/key counter helper; asserts stored docs in the emulator (`dev_retailSales`, `dev_purchases`, `dev_expenses`); runs at phone and desktop sizes; the desktop variant asserts the keyboard-only retail sale in ≤ 20 keys and 0 clicks. Phase: 0 (probes) and 3 (taps).

---

## T2. Owner: "It's the end of the month."

**Preconditions**: Agent B's emulator month (`round1/owner-work/seed-owner.js`): 117 purchases, 191 retail and 90 wholesale bills from 1 Sep to 7 Nov, later payments, a write-off, a voided bill, 112 business + 4 personal expenses, 5 withdrawals, 38 cash sessions, planted problems (Mustard below cost on 23 Oct, Rice bought at ₹45/kg on 28 Oct, ₹18,000 repair), rentals with 3 units and 2 tenants. Independent totals in `truth.json`. Signed in as the owner.

| # | Question | Baseline | V2 expected | Pass criteria |
|---|---|---|---|---|
| T2.1 | How much business did we do last month? | Money → Last month; purchases at y = 1,390 px under "Stock movement" | Overview → (Last month): Sales ₹31,62,392 · 136 bills and Purchases ₹29,01,998 · 59 bills on the first screen | ≤ 2 taps; equals `truth.json` |
| T2.2 | How much money did we collect? | Money in ₹24,54,898; no split | Money in ₹24,54,898 = with the bill + dues collected (₹7,59,454) | Split shown; M12a + M12b = M12 |
| T2.3 | How much did we spend? | "Spent" meant three things | "Spent (business) ₹42,499 · top: Repair"; personal ₹6,410 and withdrawals ₹23,000 only on Money › Spending | Labels distinct; equals truth |
| T2.4 | What is outstanding? | Outstanding opened on payables | To receive ₹17,25,188 (overdue per OD-08) · To pay ₹13,85,598 | ≤ 1 tap from Overview to the party list |
| T2.5 | How did we do vs last month? | Only hero %; Oct vs Sep needed date pickers ("Oct vs Oct" bug) | Every Overview and Money row shows "vs Sep"; Month report shows Oct and Sep columns | ≤ 2 taps to the Month report; no "not known" when Sep is in the window |
| T2.6 | Understand today in 30 seconds | Sales at y = 3,736 px | Overview (Today): sales, purchases, money in (split), out, spent, new udhaar, vs yesterday, attention | All on the first phone screen at 390×844 |
| T2.7 | Find unusual transactions | Repair and ₹45/kg rice not flagged | Attention / To do lists the ₹18,000 repair, the ₹45/kg rice purchase, Mustard below cost, any duplicate payment | All four planted items flagged; nothing flagged on the plain seed |
| T2.8 | Drill from a figure to its bills | 2 taps; raw `ui.finance.group_*` keys; "168 entries" vs "136 bills" | Same 2 taps; translated group names; "168 lines in 136 bills" | No raw key anywhere (text scan) |
| T2.9 | Find any bill of last month incl. wholesale ("Sharma") | 97 bills; "Sharma" not found | Bills → (Last month): 136 sale bills with ₹ total = M1; "Sharma" found; older months show a count before loading | Count shown before any older-month load |
| T2.10 | Labels tell the truth | False "Money in is below profit…"; "Paid" = purchase value; Cash In incl. opening | No false takeaway; "Bought for"; Opening as its own line | Metric audit (owner.md §3) has no ❌ except items waiting for OD-07/OD-08 |

**Automation**: `tests/e2e/v2-owner-month.spec.js` seeds with `seed-owner.js`, reads each figure by its `data-metric`/`data-metric-ref` and compares with `truth.json`; asserts element positions for T2.6; text scan for raw i18n keys. Phase: 1 (T2.8, T2.10), 2 (T2.1–T2.4, T2.6), 4 (T2.5, T2.7, T2.9).

---

## T3. Developer: "Two staff create transactions simultaneously. One payment fails halfway."

**Preconditions**: two Playwright contexts (Pixel 5) as Manager One and Staff One on the same emulator; interruption = let `documents:commit` reach the emulator, then drop the reply (`route.fetch()` + `route.abort('connectionreset')`), as in `round1/dev-artifacts/scenario.spec.js`.

| # | Case | Baseline | V2 expected | Pass criteria |
|---|---|---|---|---|
| T3.1 | Both save a credit retail bill at the same moment, 3 rounds | ✅ 6 unique numbers | Unchanged | Numbers unique; counter consistent |
| T3.2 | Triple click / double click Save | ✅ 1 bill each | Unchanged | Exactly one bill |
| T3.3 | Both record ₹200 on the same ₹360 bill | ✅ data; raw rules text for the loser | One accepted; the other sees "Someone just recorded ₹200. Due is now ₹160. Record ₹160 instead?" | One entry; no rules text anywhere in the UI |
| T3.4 | Both record ₹80 (both valid) | ❌ second refused with raw text | Second re-reads once and succeeds (due 360 → 200) or explains | Both entries recorded when both fit |
| **T3.5** | **Payment reply dropped after commit; user retries (at once, and after the list redraws)** | ❌ "Internet required"; retry made a **second ₹100 entry** | "Checking…" → "Already recorded at hh:mm"; a retry reuses the intent id | **Exactly one entry**; due ₹260; duplicate detector finds nothing |
| T3.6 | Audit of T3.5 | ❌ 2 payments, 1 audit entry | Audit written in the same transaction | Payments on the bill == `UPDATE_PAYMENT` audit entries |
| T3.7 | Bill save with commit replies dropped | ✅ 1 bill; 7.2 s; device-style number; number gap | "Checking… → Saved"; gap explained in the list (OD-10 A) | One bill; message within 3 s of reconnect |
| T3.8 | Staff offline 2 bills, manager online 1, reconnect | ✅ 4 bills unique | Unchanged; "Saved on this phone · will sync" | Unique numbers; no loss |
| T3.9 | Payment while offline | ✅ refused up front | "No internet: payment not recorded …" | Nothing queued (until OD-19) |
| T3.10 | Owner via SDK: zero a due without entry; change a total without an edit record; delete a non-voided bill | ⚠ all allowed | UI paths always write records (P0.4); after P5.3 the rules refuse all three | Phase 0: UI writes records; Phase 5: rules tests refuse |
| T3.11 | Open Billing, tap Retail, type immediately under 4× CPU | ❌ flipped to Purchase | Stays Retail | `race-billing-mode.spec.js` green |
| T3.12 | Duplicate-payment detector on seeded history (same amount, same bill, 3 min apart) | n/a | Flagged in Anomalies and on the Overview; `npm run audit:numbers` reports it | Detector unit + E2E |
| T3.13 | Old APK with queued offline bills after `minClientVersion` is raised (P5.2) | n/a | Old phone shows "Update the app to keep billing" before new bills; queued bills handled per the documented procedure | No silent loss in the E2E |

**Automation**: promote the developer harness to `tests/e2e/money-integrity.spec.js` (T3.1–T3.9, T3.11–T3.12) in the E2E shards; T3.10 and T3.13 as rules tests (`rules-tests/test.js`) and an E2E with a fake client version. Phase: 0 (T3.3–T3.6, T3.11, T3.12), 3 (T3.7), 5 (T3.10 rules, T3.13).

---

## T4. Rentals (real data in production; emulator only for tests)

**Preconditions**: owner creates 1 property, 3 units, 2 tenants via the UI (`round1/owner-work/rentals-owner.spec.js`); a rentals member exists.

| # | Step | Baseline | V2 expected | Pass criteria |
|---|---|---|---|---|
| T4.1 | Member records ₹4,000 for this month (prefilled ₹6,000) | ✅ 5 taps; receipt R-2026-0001 at once | Unchanged (best flow) | Receipt sheet with WhatsApp/Print/Image/PDF |
| T4.2 | Owner records ₹8,000 of arrears today; reads the Rent page | ❌ "Collected this month ₹0" | "This month's rent paid ₹…" (RENT-2) and, with OD-07 A, "Received this month ₹8,000" | Labels honest; RENT-20 oracle |
| T4.3 | Manager receipt sheet | "Cancel receipt" above "Cancel" | "Close"; void inside ⋯ | No void one tap away from close |
| T4.4 | Owner's Overview after T4.2 | Rentals behind the switch | Rentals card "as of …" with rent due and late units; tap opens Rentals | 0 `rent_` reads and no rentals module at start-up (`rentals-startup` tests) |
| T4.5 | Same rent amount recorded twice within 10 min on one charge | n/a | Duplicate warning at entry; detector flags past cases | Detector covers `rent_charges.payments` |
| T4.6 | Go-live wipe rehearsal on the emulator | n/a | `rent_*`, tenant links, rentals settings and `rentRole` survive the wipe | P0.3 keep-list test + rehearsal |
| T4.7 | Occupancy and vacancy (after P5.R2) | "3 units · 2 let" only | Occupancy 67 %, vacant unit with "vacant since" and lost rent | RENT-21+ oracle |

**Automation**: extend `tests/e2e/rentals-startup.spec.js` with T4.1–T4.4; unit/oracle tests for RENT-20+; wipe keep-list unit test. Phase: 0 (T4.6), 1 (T4.2–T4.3), 2 (T4.4), 0/5 (T4.5, T4.7).

---

## T5. Hindi

**Preconditions**: phone language Hindi; same seed as T1.

| # | Check | Expected |
|---|---|---|
| T5.1 | T1.2, T1.3, T1.4 and T1.7 in Hindi | Same tap counts as English; chips नकद / ऑनलाइन / उधार / बाँटें…; "+ बोरी"; "kg" (never किलो) |
| T5.2 | Typed-line prompt, extreme-rate sheet, post-save sheet, payment race message | Fully Hindi, amounts formatted the Indian way, no English fragments |
| T5.3 | Overview and Month report | Labels wrap above figures; no letter-spacing; figures identical to English |
| T5.4 | Single-language guard, i18n catalogue (incl. dynamic families) | Every new key exists in `en.js` and `hi.js` |
| T5.5 | axe in hi (phone + desktop) on Billing, My day, Overview, Outstanding, Bills | No violations |

**Automation**: the E2E `hi` project already runs axe and smoke; add T5.1–T5.3 as a Hindi variant of `v2-busy-day.spec.js` and `v2-owner-month.spec.js`; Jest guards for T5.4. Phase: every phase (new strings), full run at Phase 3 exit.

---

## T6. Themes and appearance

| # | Check | Expected |
|---|---|---|
| T6.1 | Appearance Light / Dark / System (Phase 3) | Switches without reload; System follows emulated `prefers-color-scheme`; existing `darkMode=true` users land in Dark; no flash on cold start (first-paint screenshot) |
| T6.2 | Token contrast unit test | Every text/background pair ≥ 4.5:1 for every shipped theme × mode (incl. Glass mesh stops) |
| T6.3 | axe contrast per batch | Every converted screen × theme × mode passes |
| T6.4 | Print and receipts | Identical output from Modern, a serif theme and an always-dark theme |
| T6.5 | Inline-colour guard | Baselines only go down; a new hex in `www/js` fails CI |
| T6.6 | Layout | billing-fold in Material and Cyberpunk; no size change from theme overrides |

**Automation**: Jest (`theme-contrast`, size guard, inline-colour guard), `tests/e2e/themes.spec.js`, print snapshot test. Phase: 3 (T6.1, T6.2, T6.5), 6 (T6.3, T6.4, T6.6).

---

## T7. Performance and reads

| # | Check | Expected |
|---|---|---|
| T7.1 | E2E read baselines per page and role | No page above baseline + 25 % (cap 300); Overview and My day add 0 reads |
| T7.2 | Start-up | Billing usable before Overview/My day code loads; nightly bench `firstTodayMs` and start-up reads not above today's trend |
| T7.3 | Bill finder | Default view 0 extra reads; older month shows its count before loading; never an "All time" load |
| T7.4 | First Print after login (P5.7) | Within budget online and offline with `printer.js` lazy + idle preload |
| T7.5 | Rentals | 0 rentals reads/modules at start-up; precache budget respected |

**Automation**: existing read-baseline and startup specs, nightly `bench.yml`, a new first-print spec. Phase: every phase.

---

## T8. Roles and security

| # | Check | Expected |
|---|---|---|
| T8.1 | Landing by role | Owner → Overview; manager and member → Billing; override from Roles & access works |
| T8.2 | Member never sees profit, stock value, net flow, labour or personal totals on My day | Text and `data-metric` scan |
| T8.3 | Member party Receive | Hidden unless OD-16 = A; when shown, uses the payments service ids |
| T8.4 | Wholesale in Bills | Only for users with the `wholesale` permission |
| T8.5 | Rules suite | 714+ rules tests green on prod and `dev_` (until P5.1); new rules each with allow and deny cases |
| T8.6 | CSP | Boot snippet hash updated once (P3.D3); csp.spec green; no inline handlers |

---

## T9. Regression net that must stay green on every PR

Jest (~3,890 tests incl. oracle AC1–AC13, property, characterisation, `rent-characterisation` snapshot), rules tests, architecture ratchet (firestore 0 outside repos; moneyMath, appStateWrite only down), `check:html-escape`, `check:rules-size`, `check:sw`, `check:lockfile`, typecheck, E2E 3 shards (smoke all pages × roles × sizes × languages, axe en/hi, billing-fold, read baselines, csp, rentals-startup), and the weekly mutation run (money modules ≥ 80 %).
