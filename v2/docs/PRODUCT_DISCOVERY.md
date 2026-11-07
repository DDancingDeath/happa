# happa V2: Product discovery (as-is)

_Product Lead synthesis, Round 3, 8 Nov 2026. Sources: Round 1 reports by Agent A (staff/cashier, `round1/staff.md`), Agent B (owner/financial analyst, `round1/owner.md`) and Agent C (developer/architect, `round1/dev.md`); Round 2 cross-reviews (`round2/*-review.md`); `redesign/direction/DIRECTION.md`; the owner's decision files. The code was checked in a read-only clone of `DDancingDeath/happa` at `ddff5704` (main, PR #369)._

**How to read the evidence tags.** IDs such as **S-1**, **O-3** and **D-1** point to the finding with that ID in the staff, owner or developer report. **[EXEC]** means an agent did it in the running app on local emulators. **[CODE]** means it was read from the source. A screenshot path such as `img/…` points to a copy in this folder.

---

## 1. What happa is

happa runs a **mandi aadhat** (grain trading: buying from farmers, selling retail and wholesale) and a separate **Rentals** business (the owner's shops and flats), in one app. It works in English or Hindi, one language at a time.

| Item | As-is |
|---|---|
| Platforms | One vanilla-JS PWA (`www/`, no bundler, no framework). It ships as an Android APK (Capacitor, package `com.happa`, prereleases rc1–rc8) and as a website/PWA on desktop (`myhappa.web.app`) |
| Backend | Firebase project `happa-bfc07` on the **Spark plan**: 50,000 reads a day for the whole project, no Cloud Functions, no Storage. Firestore compat SDK 10.7.1 with IndexedDB persistence (offline-first) |
| Size | 232 JS files, 71,291 lines (pages 21k, calc/utils 20k, data layer 7k, i18n 6k, rentals 4.7k); 23 HTML templates; 32 CSS files built into one `app.css` (D §1.1) |
| Quality net | ~3,890 Jest tests (oracle, property, characterisation), 714 Firestore rules tests, 14 Playwright specs with read budgets, axe and a billing-fold check, a nightly multi-year benchmark, weekly mutation testing (money modules ≥ 80 %), an architecture ratchet, an enforced CSP, nightly encrypted backups and a monthly restore drill (D §1.1, §2) |
| Status | Go-live is **on hold** (owner, 29 Oct). Aadhat data in production is test data and is wiped at go-live. **Rentals data is real** (owner, 7 Nov 2026) and must never be wiped |

---

## 2. Modules and screens

| Module | Screens (bottom bar / More) | Who uses it | Notes |
|---|---|---|---|
| **Billing** | Purchase (from farmers) and Retail sale on one page with a mode pill | Everyone (landing page for everyone, `main.js:570`) | Bag-by-bag weights, automatic labour on purchases, drafts, auto-save, voice (off by default) |
| **Wholesale** | Sale, history and dues of wholesale buyers | Owner/manager by default (`wholesale` permission) | 92 % of sales value in Agent B's month (O-9) |
| **Today** | Summary (money flow, reminders, day report, per-type totals) and Cash (drawer) | Everyone (bottom bar) | Shared tab: an owner dashboard that members also see (S-23, O-1) |
| **History** | Purchase or Sale list, search, date presets, bill details, edit, void, reprint, share | Everyone | "Sale" is retail only (O-9) |
| **Outstanding** | Purchases (payables) / Sales (receivables), aging buckets, who to chase, by party, receive/pay, remind, statement | Everyone; party-level Receive is owner/manager only | Opens on Purchases (O-14) |
| **Money** | Profit, Cash, Spending, Worth tabs; period picker with comparisons; drill-down sheet | Owner/manager | Behind More |
| **Insights** | To do, Items, Parties, Seasons/Trends | Owner/manager | Behind More |
| **Statements** | Month statement (ST2), party statement (ST3), exports | Owner | Behind More |
| **Stock, Rates, Expenses** | Stock levels and counts, item rates, expense entry | Mixed | Expenses is behind More (S-22) |
| **Anomalies, App health, Admin, Diagnostics, Settings, Ask** | Checks, telemetry, users and roles, data tools | Mostly owner | |
| **Rentals** | Rent, Tenants, Properties, receipts, deposits, advances, expenses, yearly report, tenant link `/r/<token>` | Owner + helpers with a `rentRole` | Lazy-loaded behind a business switch; 0 reads at start-up |

---

## 3. Roles

| Role | Stored as | Can do (summary) | Enforced where |
|---|---|---|---|
| Owner | `users.role = 'owner'` | Everything, including roles, exports, deleting voided bills | Rules + UI |
| Manager | `role = 'manager'` | Most pages, edit/void any bill in the window, party-level receive | Rules + UI (`settings/app.roleAccess`) |
| Member (the cashier; internal `staff`) | `role = 'staff'` | Bills, own edits/voids within 2 days, due payments per bill, expenses, cash drawer; profit and stock value hidden on screen | Writes: rules. Reads: **members can read every bill through the SDK**; hiding is UI-only (D-14) |
| Rentals roles | `users.rentRole = manager \| member` | Record rent, tenants, leases; only the owner deletes and sets access | Rules |

The UI never shows the word "staff" (`AGENTS.md`). The edit window is counted from the server's `createdAt`. Members can back-date only 2 days, and only the owner may record cash on a back-dated bill (`noBackdatedCash`; staff report P15, dev review C-A1).

---

## 4. Data model (summary)

| Family | Collections (each has a `dev_` twin for previews) | Key facts |
|---|---|---|
| Bills | `purchases`, `retailSales`, `wholesaleSales` (+ `edits/{n}`) | Three shapes. The money is in `total`/`billTotal`/`grandTotal`/`amountPayable`/`saleTotal` (legacy order rules) and `payment{cash,online,due,total,writtenOff}`, where **`payment.total` means "received so far", not the bill total** (D-17). `payments[]` entries (id, amount, cash, online, `at`, and a locale-string `date`), `openDue`, `paidAt`, void fields, four time fields. **The party is free text** (`customerName`/`partyName`); there is no parties collection yet (D-6, #139, `docs/parties-design.md`) |
| Money | `expenses`, `personalExpenses`, `withdrawals`, `cashManagement`/`cashSessions` | Void, never delete. Expense **type is free text** ("Labor", "Labour", "मजदूरी" become separate rows, owner review C-S22) |
| Stock and rates | `items`, `stockAdjustments`, `stockCheckpoints`, `rateHistory`, `rateStats`, `monthStats`, `itemFrequency` | Checkpoint + replay at average cost. `monthStats/{YYYY-MM}` snapshots hold M1…M16 per month (dev review §0) |
| Operations | `users`, `settings`, `counters`, `drafts`, `autoSaves`, `notifications`, `reminders`, `anomalies`, `auditLogs`, `telemetry`, … | Bill numbers from a per-day counter transaction with a device-number fallback (D-4) |
| Rentals | `rent_properties`, `rent_units`, `rent_tenants`, `rent_leases`, `rent_charges` (`{leaseId}_{YYYY-MM}`), `rent_receipts`, `rent_deposits`, `rent_expenses`, `rent_settings`, `rent_counters`, `rent_public` | **Real data.** Separate money; never added to Aadhat totals (`rentals-agent-context.md` §3.2) |

**Read model: every phone computes everything.** At sign-in each phone listens to all history since the 1st of last month, plus older open dues and bills paid inside the window (`listeners.js:271-330`). Today, Money, Outstanding and Insights are derived in memory. Consequence: any figure for this month or last month costs **0 extra reads**; older months cost 1 read per month from snapshots; "All time" history costs ~7,046 reads and ~9.4 s (dev review §0). A cold open costs ~1,550–1,680 reads on the 3-year bench, ~85 % of them old unpaid bills (D-7).

**Write model.** New bills: client id, a create-only transaction online with a 3 s fallback to a queued write, queued offline ("Saved on this phone"). Edits: a checked transaction plus an `edits/{n}` record. Due payments: an online-only transaction on the bill, with the cash-session leg in the same transaction; the audit log is a separate write afterwards (D §1.2, D-3).

**Constraints every V2 change must respect** (D §5): Spark reads; rules at **118,594 of 126,000 bytes** (checked: `firestore.rules` is 118,594 bytes); offline-first bills; CSP (no inline scripts, no external fonts); no build step; triple cache bump per `www/` PR; one language per screen; every displayed figure has a spec ID and an oracle test, and one home template (`utils/metric-registry.js`); canvas receipts untouched by themes; Rentals never loaded at start-up; Rentals precache has **285 bytes** free.

---

## 5. Core workflows (as executed)

| Workflow | Steps today | Measured | Source |
|---|---|---|---|
| Purchase from a farmer (2 items, 6 bags, part cash, rest due) | Mode → name → item → **type rate** → weights (Enter per bag) → Add to Bill ×2 → Cash amount → Rest → Due → scroll → Save | ~16–20 taps, 38 keys, ~40 s | S B1 [EXEC] |
| Walk-in retail, cash | Retail tab → item → rate → weight → Add to Bill → **tick Cash** → scroll → Save | 8 taps, 4 keys, ~15 s | S B2 [EXEC] |
| Correct a wrong bill | History → Sale → search → open → Edit → line → rate → Add → Save → reason → OK | 12 taps over 3 screens, ~45 s; the Cash box shows the old amount during the edit | S FIX, S-15 [EXEC] |
| Customer pays old udhaar | Outstanding → search → amount → Record | 5 taps, online only | S PAY, S-20 |
| Expense | More → Expenses → type → amount → Save | 5–6 taps | S EXP |
| Find and resend a bill | History → choose Purchase/Sale → search → bill no. → Share | 5 taps; text marked "(COPY)" even on the first send | S FIND, S-11 |
| Rent payment | Rentals → Record payment (amount prefilled) → Save → receipt sheet with WhatsApp/Print/Image/PDF | 5 taps; **the best flow in the app** | S P11 [EXEC] |
| Owner month-end (5 questions) | More → Money → Last month → Profit / Cash / Spending / Worth tabs → Compare & share for Oct vs Sep | ~8 taps + scroll, 1–1.5 min; "Oct vs Sep" side by side needs ~8 more taps and date pickers | O §2 rows 1–5b [EXEC] |
| Owner "today in 30 s" | Today → scroll ~4 phone screens | **Fails**: sales at y = 3,736 px on a phone | O-1, `img/owner-today-first-screen.png` |
| Two users pay the same bill at once / reply lost | Outstanding payment from two phones; network drop after commit | Bills never duplicated; **payments double-recorded on retry**; loser sees raw rules text | D §3 S3–S5 [EXEC] |

---

## 6. What works and must be preserved

| # | Strength | Evidence |
|---|---|---|
| W1 | Bag-by-bag weight entry with live packet count and kg; automatic labour (₹6 × heavy bags) | S P1–P2 |
| W2 | Hard rules block bad bills (no payment, due without a name, unbalanced split); double-tap Save makes one bill | S P4–P5, D S2 |
| W3 | "Already owes ₹x on n bills" hint while typing a known name | S P6, `img/staff-party-owes-hint.png` |
| W4 | Bill integrity under concurrency and offline: unique numbers, exactly one bill per tap, offline sync without collision | D §3 S1, S2, S5 |
| W5 | Edits keep a reason and a record; void, never delete; member edit window | S P8, D §2.8 |
| W6 | **Every figure has a definition, a spec ID, an oracle test and one home**; the owner's independent totals matched every screen | O §1.1, D §2.2 |
| W7 | Revenue, collections, cash and profit already live in separate places (Money tabs); profit is honest about unknown cost | O §1.2–1.3 |
| W8 | Drill-down from a headline to the bill in 2 taps | O §1.4 |
| W9 | Month statement (ST2): the best end-of-month page | O §1.6, `img/owner-month-statement-desktop.png` |
| W10 | Outstanding as a collections tool (aging, who to chase, remind, statement) | O §1.5 |
| W11 | Rentals: separate money, receipt sheet right after payment, lazy loading | S P11, O §1.9, `img/staff-rent-receipt.png` |
| W12 | Hindi is complete and natural; one language per screen | S P12, `img/staff-hi-billing.png` |
| W13 | Repository boundary, calc discipline, strict rules for non-owners (11 of 12 forgeries refused), release engineering, backups | D §2 |
| W14 | Offline-first states ("Saved on this phone, will sync") | S P14, D §2.7 |

---

## 7. Pain points (consolidated, de-duplicated)

Severity: **H** = money can be wrong or work is lost; **M** = slow or confusing; **L** = polish. "Agents" lists who raised it (A staff, B owner, C developer).

| # | Pain point | Sev. | Agents | Evidence |
|---|---|---|---|---|
| P-1 | **An interrupted payment is shown as failed although it was saved; a retry records it twice** (customer credited ₹200 for ₹100) | **H** | C, A, B | D-1 S4, `img/dev-interrupted-payment.png` — **fix in flight** |
| P-2 | A concurrent valid payment is refused with raw rules text ("evaluation error at L1665:24") | M | C, A, B | D-2 S3, `img/dev-concurrent-payment-raw-error.png` — **fix in flight** |
| P-3 | **A typed line not "Added to Bill" is silently dropped on Save** (under-billing) | **H** | A, B, C | S-1, `img/staff-unadded-line.png` — **fix in flight** |
| P-4 | Billing silently flips back to Purchase (timer reset in `navigation.js:223`); Outstanding resets to Purchases (`:239`) | **H** (wrong bill type) | C, A, B | D-5 R1, `img/dev-mode-flipped-to-purchase.png` — **mode fix in flight** |
| P-5 | WhatsApp on the bill form sends an **unsaved** bill; "Sale saved and printed!" when nothing printed | H/M | A | S-10, S-12, `img/staff-print-preview.png` — **message fix in flight** |
| P-6 | Audit is a best-effort write after the money write; the owner can zero a due or change a total with no record | M | C, B | D-3, D S7 |
| P-7 | A ×10 wrong rate passes with one tap ("OK" is primary) | **H** | A, B | S-16, `img/staff-wrong-rate-modal.png` |
| P-8 | Editing a paid bill shows the old cash amount; ₹3,510 to hand back is invisible | **H** (drawer) | A, B | S-15, `img/staff-edit-loaded.png` |
| P-9 | No name suggestions; a typo splits one customer's udhaar into two parties | **H** | A, B, C | S-3, D-6 |
| P-10 | No default/one-tap payment; ticks and amounts drift out of sync; 7 controls for "cash, full" | M | A (B, C object to a silent default) | S-2, S-17 |
| P-11 | Rate never prefilled; item silently preselected; "Add" vs "Add to Bill"; Save ~1.9 screens below the fold | M | A | S-4, S-5, S-6, S-9 |
| P-12 | Nothing to do after Save; resending needs History and is marked "(COPY)" | M | A | S-11 |
| P-13 | "Clear" wipes the bill with no undo | **H** (lost work) | A | S-7 |
| P-14 | Everyone lands on Billing; the owner's figures are behind More; Today fails the 30-second test for the owner and is an owner dashboard for members | **H** | B, A | O-1, O-2, S-23, `img/staff-today-member.png` |
| P-15 | **False insight**: "Money in is below profit because ₹X is still owed" (wrong noun, unsupported cause) | **H** (trust) | B | O-3, `takeaways.js:58-62` (checked) |
| P-16 | Mislabels: Insights "Paid" is purchase value; Rentals "Collected this month ₹0" after ₹8,000 received; Today "Due to Receive" is new udhaar only; Cash page "Cash In" includes the opening balance; raw `ui.finance.group_*` keys; "168 entries" vs "136 bills" | M–H | B | O-4, O-5, O-10, O-11, O-12 (checked: `en.js:2649`, `finance-breakdown-sheet.js:225`); `img/owner-sales-drilldown.png`, `img/owner-rent-simple.png` |
| P-17 | Three different "overdue" totals for one question | M | B | O-13 |
| P-18 | "vs previous" only on each tab's hero; Oct-vs-Sep needs date pickers; "not known" until snapshots roll | **H** | B | O-7, O-8, `img/owner-money-lastmonth.png` |
| P-19 | History › Sale is retail only (wholesale missing); no ₹ total, no filters; only the bill-number link opens a bill | **H** | B, A | O-9, S-13, `img/owner-history-sales.png` |
| P-20 | Money in does not separate "paid with the bill" from "old dues collected" | M | B | O-15 |
| P-21 | Labour may be double-counted or under-credited (expense type "Labor" + deductions from farmers) | **H** (profit) | B, A | O-6, staff review §1 |
| P-22 | No anomaly for unusual expenses or purchase rates | M | B, A | O-17 |
| P-23 | Outstanding: analysis panels push the payment box below the fold for a cashier; party receive is owner/manager only | M | A | S-19, `img/staff-outstanding-sita.png` |
| P-24 | Due payments, edits and voids need the internet | M | A | S-20, owner decision #143 A |
| P-25 | Expense entry: 6 fields, free-text type, behind More | L/M | A, B | S-22, C-S22 |
| P-26 | Discounts, round-off and returns have no fields; workarounds distort rates and dues | M | A, B, C | S-28, C-S28, C-A4 |
| P-27 | No commission income modelled (if the shop earns any) | ? | B | O-25 |
| P-28 | Rentals: no occupancy %, vacancy or rent trend; rentals not visible from the owner's home | M | B | O-22, O-23 |
| P-29 | Styling debt blocks theming: 498 `style="` in JS, 306 hard-coded colours in JS, 75–107 dark-mode bridge selectors | **H** for the redesign | C | D-12, DIRECTION §1 |
| P-30 | Rules budget nearly full (94 %), client-version gate client-side only, member read access UI-only | M | C | D-14, D-15, D-16 |
| P-31 | Start-up weight: both language catalogues, printer module eager, 193 module requests; first Today 4–6 s at 4× CPU | M | C | D-7, D-13 |
| P-32 | Bill-number gaps after counter retries; online bills sometimes get device numbers | L–M | C | D-4 |

---

## 8. Duplicated functionality and unnecessary complexity

- **Purchase and Retail forms** duplicate 16 code blocks and behave differently after "Add to Bill" (D-11, S-8).
- **Three draft mechanisms** for one unfinished bill (Save draft, Drafts list, auto-save recovery) (S §4.4).
- **Two bill lists**: History (purchase/retail) and Wholesale › History (O-9).
- **Three overdue totals** and two "Cash In" figures for the same day (O-11, O-13).
- **Payment block**: 3 checkbox + amount pairs, "Total Paid", "Not split yet", "Rest → Due" for the common "cash, full" case (S §4.1).
- **Timer-driven page resets**: 6 `setTimeout` calls in `ui/navigation.js` (checked: lines 223–252) reset page state on every visit.
- **Money flows inside page modules** (payments, cash legs, write-offs in `outstanding.js`), so the same rules are re-implemented per screen (D-8).

---

## 9. Assumptions and uncertainties

| # | Assumption / uncertainty | How we treat it |
|---|---|---|
| U1 | Most retail sales are paid in full at the counter; wholesale is often on credit; online (UPI) is a large share of money in | Agent B's month was synthetic (96 % online). We do **not** assume a cash default; see PD-01 |
| U2 | The shop does not earn a separate commission (no fields exist) | Owner decision OD-04; nothing is built until answered |
| U3 | Labour wages are sometimes entered as "Labor" expenses | Owner decision OD-03; display-only reconciliation first |
| U4 | Members need read access to bills to work (History, edits, dues, duplicate check) | Accepted (PD-09) |
| U5 | Real counter network is weak at peak hours | Offline payments stay out until D-1 ships and rules room exists (PD-04) |
| U6 | Tap counts and human times are estimates from automation (1.5 s per tap, 0.4 s per key) | Targets in `TEST_SCENARIOS.md` use the same method so before/after are comparable |
| U7 | Agent B's data was seeded straight into Firestore; some "not known" comparisons came from that | Fix is still planned (snapshot roll at idle start-up), but the severity on real use is lower |
| U8 | Hindi was executed by Agent A only (phone); Agent B's Hindi notes come from an earlier review | Hindi scenario added to `TEST_SCENARIOS.md` |
| U9 | Rentals production data is real; rentals redesign PRs #363, #364, #367, #368 are open | V2 rentals work is sequenced after them and coordinated through the orchestrator |
