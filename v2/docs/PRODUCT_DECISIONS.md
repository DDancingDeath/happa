# happa V2: Product decisions (decision log)

_Product Lead, Round 3, 8 Nov 2026. Each entry records a conflict between the three agents, their positions with evidence, the resolution, the reason, and whether the **owner** must approve. Agent A = staff/cashier, B = owner/financial analyst, C = developer/architect. Sources: `round1/*.md`, `round2/*-review.md`. Plan references (P0.1 …) point to `IMPLEMENTATION_PLAN.md`._

Principles used to resolve (mission §5–6): **business correctness first, then the counter's speed, then engineering cost.** A shortcut that stores a wrong fact is rejected even if it saves a tap. No financial calculation changes silently; no data is deleted; migrations are planned before code.

Owner flag legend: **OWNER** = needs the owner's approval before it ships; **owner may override** = Product Lead decided, the owner can change it; **—** = no owner approval needed (labels, bugs, internal engineering).

---

## Decision log

### PD-01 Default payment on a bill
| | |
|---|---|
| A (staff) | Default retail to "Cash, full amount"; one tap to change. Every retail bill today needs a tick (S-2, S-17) |
| B (owner) | **No silent default.** A forgotten tap would record a credit sale as cash (the receivable disappears), a UPI sale as cash (drawer shortage blamed on the cashier) and inflate Money in (C-S2) |
| C (dev) | A wrong default is worse than none: it feeds drawer expected cash (C1–C7) and Money in (M12); rules refuse cash on back-dated bills for non-owners, so a defaulted Cash would fail there (C-A1) |
| **Resolution** | **No preselected method.** Replace the tick boxes with one-tap chips **[Cash] [Online] [Udhaar] [Split…]**, nothing selected. The chosen method and amount appear on the Save button: **"Save · Cash ₹3,900"**. "Rest → Due" stays inside Split. Party-pay uses the same chips, nothing preselected |
| Rationale | One tap instead of today's 1–3 keeps most of A's saving, and every stored payment is a choice somebody made. The amount on the button is a last check |
| Owner | **owner may override** (OD-01). If the owner wants a default, the only acceptable form is: retail, no party name, today's date, flagged `paymentDefaulted: true` on the bill |
| Plan | P3.B5 |

### PD-02 A typed line that was not added
| | |
|---|---|
| A | Auto-add it on Save, or ask (S-1) |
| B | Ask; a silent add is as dangerous as a silent drop (a leftover weight from the last customer) (C-S1) |
| C | Agrees; one check in the shared save path (dev review §1a) |
| **Resolution** | **Ask, never silently add or drop**: "Add Rice 4 kg × ₹36 = ₹144 to the bill?" [Add] [Discard]. Same on Print and WhatsApp |
| Rationale | Both silent options can store a wrong bill; the question costs one tap only when the row is filled |
| Owner | — |
| Plan | P0.2 (**in flight**, agent fix-billing-safety) |

### PD-03 Rate prefill and the extreme-rate guard
| | |
|---|---|
| A | Prefill today's or the last rate; make "Fix rate" primary for ≥ 5×; maybe block members (S-4, S-16) |
| B | Prefill from **today's Rates list only**; a last-used or per-party rate repeats one-off discounts and typos; record when the cashier changes it (C-S4) |
| C | Prefill from rates already in memory, 0 reads; the guard is client policy in `bill-checks.js`, overrides already audited (`OVERRIDE_CHECK`) (dev review §1a) |
| **Resolution** | Prefill **only from today's Rates list**, selected so typing replaces it. A changed rate is **visibly marked** ("changed from ₹26") and the line stores `rateEdited: true`. The existing ×2 inline warning stays. An **extreme rate** (default proposal: ≥ 5× or ≤ ⅕ of today's rate, or outside the item's last-30-day range by that factor) becomes a **blocking confirm** that shows the computed line amount ("15 kg × ₹260 = ₹3,900. Usual ₹26 → ₹390"), with **"Fix rate" as the primary button**. Confirming is logged as an override |
| Rationale | One source of truth for rates (the owner sets them); a wrong 10× bill distorts sales, margins, rate trends and the drawer for a month |
| Owner | **OWNER**: the threshold and whether members may confirm or are blocked (OD-02) |
| Plan | P3.B4 |

### PD-04 Recording due payments offline
| | |
|---|---|
| A | Needed at peak hours on a weak signal (S-20) |
| B | Not before idempotency is fixed; offline payments multiply D-1 (C-S20) |
| C | A queued update is checked by the rules on the server's current version and can be refused silently at sync; proposes "payment intents" (C-A2), L-sized, ~2 KB rules |
| **Resolution** | **Payments stay online-only for now** (owner decision #143 A). Revisit "payment intents" only after D-1 has shipped and rules room exists (P5.1). Meanwhile the message is honest ("No internet: payment not recorded. Note it and record it when online") |
| Rationale | The money trail must be right before it can be queued |
| Owner | **OWNER, later** (OD-19) |
| Plan | P5.6 (conditional) |

### PD-05 Home screen by role; Overview and "one home per figure"
| | |
|---|---|
| A | Members need a "Counter" (drawer, my bills, four actions), not an owner dashboard; Billing must stay the member's landing and nothing may load before the bill form (S-23, C-O1) |
| B | The owner needs an Overview that passes the 30-second test (O-1, O-2) |
| C | Landing by role is cheap (0 reads); Overview values clash with the "one home per figure" registry unless decided (K-3) |
| **Resolution** | **Owner** lands on an **Overview**: today's sales and purchases, collections split into "with the bill" and "old dues collected", spending, to receive / to pay, attention items, compared with yesterday or last month. **Every figure is a link to its home page** (rendered as a `data-metric-ref` reference, as Money already does) — no new homes. New figures (the collections split) get spec IDs and oracle tests. **Members and managers** land on the **Counter**: Billing first (remembered mode), and the second tab becomes **My day** (drawer, my bills today, my reminders, Receive udhaar, Expense). Managers also see the shop figures their permissions already allow. The last Billing mode and the last Outstanding tab are **remembered per phone** |
| Rationale | One product, two front doors; the calc layer feeds both, no new reads; the registry rule stays intact |
| Owner | **owner may override** (OD-20; Roles & access setting) |
| Plan | P2.1–P2.5 |

### PD-06 Rentals on the owner's Overview
| | |
|---|---|
| A | Neutral; after recording arrears the cashier must see "Received today", not ₹0 |
| B | The owner needs rentals status without switching business (O-22) |
| C | Rentals code and `rent_*` reads must never load at start-up (`rentals-startup.test.js`) (C-B1) |
| **Resolution** | A **cached rent summary card** (0 reads: the REM-2 snapshot Today already keeps, with "as of" time; later 1 read of a `rent_summary/current` doc written by the Rentals page). Tapping opens Rentals (lazy). Rent is **never added** to shop totals |
| Rationale | Gives the owner the picture at no start-up cost |
| Owner | — (the card is display; showing both businesses together is what the owner asked for in O-22) |
| Plan | P2.4, P5.R1 |

### PD-07 One bill finder
| | |
|---|---|
| A | Search first, newest first, one tap opens; no period/group pickers above the list (C-O6) |
| B | One finder across purchase/retail/wholesale with ₹ totals and filters (O-9) |
| C | "All time" costs ~7k reads and ~9 s; load older months on demand with a count (C-B5) |
| **Resolution** | **One finder** for purchase, retail and wholesale (wholesale only for users with the `wholesale` permission), with a ₹ total of what is listed. **Loaded months are instant; older months load on demand, showing the count first** ("Load Sep · ≈ 142 bills"); a full bill number is looked up directly (1 read). **No all-history load.** Two presets of one component: counter (search + type chips) and owner (plus period, party, item, paid-by, status) |
| Rationale | Investigation and daily lookup are the same feature; the read budget is protected |
| Owner | — (owner decision #125 already favoured wholesale on shared lists) |
| Plan | P1.7 (quick part), P4.5 |

### PD-08 Parties (#139)
| | |
|---|---|
| A | Autocomplete now; parties must never block offline billing; create parties implicitly; batched writes, not transactions (C-D6) |
| B | Stage it; a stored balance is a second source of truth; merges only from an owner-reviewed list (C-D6) |
| C | `parties` + `partyId` + balances; one `partyIndex` doc (+1 read per open) (D-6, C-A3) |
| **Resolution** | **P1**: name suggestions and "did you mean Sita Devi (owes ₹200)?" from bills already loaded (0 reads, no migration). **P2**: a `partyIndex` document plus `parties/{id}`, and `partyId` on new bills, created implicitly on first save; old bills stay name-only; owner-reviewed set-up and merges (`docs/parties-design.md` §12). **P3**: running balances **only** with a daily reconciliation check (balance = sum of the party's open dues), filed as an anomaly; screens read balances only after a clean record. **All party writes are offline-safe batched increments, not transactions** |
| Rationale | Fixes split udhaar now; the data model change is reversible and checked before anyone relies on it |
| Owner | P1: —. **P2 and P3: OWNER** (migration plan, merges, §13 questions; OD-15) |
| Plan | P3.B2, P5.4, P5.5 |

### PD-09 Members' read access to bills
| | |
|---|---|
| A | Members need bills to work (History, own edits, dues, duplicate check) and type purchase rates anyway (C-D14) |
| B | Hiding in the UI is not privacy; make it explicit (C-S23) |
| C | Accept, or later serve members from summaries (D-14, L) |
| **Resolution** | **Unchanged.** Members keep read access; profit and stock value stay hidden on screen. Recorded as a known limitation in `docs/role-permissions.md` |
| Owner | owner informed (accepts today's behaviour) |
| Plan | — |

### PD-10 `minClientVersion` enforced by the rules
| | |
|---|---|
| A | Old APKs with queued offline bills would be refused on sync; the customer has a bill the shop lost (C-D15) |
| B | Required before any new field ships (D-15) |
| C | Rules compare with `settings/app.minClientVersion` (D-15) |
| **Resolution** | Enforce in rules **only after every phone is on the new APK and its offline queue is drained**. Documented procedure: (1) release the APK; (2) App health shows each phone's version and pending writes; (3) the app blocks **new** bills on old versions with "Update the app to keep billing" before they are created; (4) when every phone shows the new version and 0 pending, the owner raises the value; (5) the rules check ships in the next rules PR. E2E case: old-version queued bill → raise → reconnect |
| Owner | **OWNER** performs step 4 |
| Plan | P5.2 |

### PD-11 Themes
| | |
|---|---|
| Owner (brief) | 12 selectable themes + Light / Dark / System (`redesign-master-prompt.md`) |
| A | Neutral; a high-contrast "sunlight" mode matters more than a 7th decorative theme; workflow fixes first (C-D12) |
| B | 2–3 themes; feature count is not quality |
| C | 12 × 2 = 21 combinations multiply QA; don't extend the inline-colour bridge; ratchet first (D-12, §5) |
| **Resolution** | Keep the owner's goal of **12 themes, staged**. Phase 3 builds the **theme engine** with **Modern Minimal** as the default and **Light / Dark / System**, after a CI guard "**no new inline colours**". The other 11 ship in **batches** in Phase 6; each batch must pass the token contrast test and **axe contrast for every theme × mode** on converted screens. The dark bridge is not extended to other themes; it only shrinks. A "Sunlight" high-contrast theme is offered as a candidate for batch 1 |
| Rationale | Honours the owner's request without letting styling debt multiply |
| Owner | **OWNER**: batch order and default appearance (OD-12) |
| Plan | P3.D1–P3.D3, P6.3–P6.5 |

### PD-12 Printer module loading
| | |
|---|---|
| A | The first Print of the morning must not wait (C-D13) |
| C | 79 KB eager at start-up (D-13) |
| **Resolution** | Preload `printer.js` **in the background after login when the phone is idle**, if the precache/bytes budget allows; otherwise load it when Billing opens. Add an E2E budget for "first Print after login" |
| Owner | — |
| Plan | P5.7 |

### PD-13 Owner's own edits; write-off
| | |
|---|---|
| B | Zeroing a due without a write-off hides a bad debt and overstates profit (D-3 / S7) |
| C | Audit inside the transaction; rules should require records for the owner too (D-3) |
| **Resolution** | The owner's edits **always write an edit/audit record** — no silent zeroing (client now; rules later). **Write-off becomes an explicit action** ("Write off ₹X as bad debt", with reason), shown as bad debt in profit |
| Owner | Audit record: —. Rules enforcement for the owner: **OWNER** (OD-14). Write-off presentation: **OWNER** (OD-13) |
| Plan | P0.4, P4.8, P5.3 |

### PD-14 Business-rule questions that only the owner can answer
Labour accounting, commission, discounts/returns, rent "collected", one overdue definition, expense categories, number gaps, round-off, cheques, the rate-guard threshold and the theme order. Each has a recommended default in the table below. **Nothing that changes a calculation is built before the answer.**

### PD-15 Immediate correctness quick wins
| | |
|---|---|
| B | Labels and a false insight are wrong on screen today; they need no services layer (C-D-seq) |
| C | Agrees; batch them (dev review §4 #2) |
| **Resolution** | Ship now, no owner approval (labels and bugs; **no number changes**): remove the false "money in is below profit" sentence (O-3); fix the "Paid" column (O-4); relabel Rentals "Collected this month" (O-5, label only); Today "Due to Receive" → "New udhaar today" (O-12); Cash page "Cash In" vs opening balance (O-11); raw i18n keys in the drill-down (O-10); History › Sale includes wholesale with totals (O-9 part); overdue labels that say which question each figure answers (O-13; one definition only if numbers don't change, else OD-08) |
| Owner | — (each label PR updates `calculations.md` and the page docs en + hi) |
| Plan | P1.1–P1.10 |

### PD-16 Sequencing
| | |
|---|---|
| B | A parallel "truth in labels" track; Overview early (K-6) |
| C | Services, navigation state, ratchets and kit before screens (dev §6) |
| A | Workflow fixes before themes |
| **Resolution** | Phase 0 safety (in flight) → Phase 1 labels **in parallel** (different files) → Phase 2 remembered state + homes → Phase 3 billing speed **and** the design-system foundation side by side → Phase 4 owner analysis → Phase 5 platform → Phase 6 visual rollout and themes. File-disjoint PRs may run in parallel; one implementer per file area |
| Owner | — |

### PD-17 Services layer scope and the write outcome
| | |
|---|---|
| A | No more confirm dialogs on the main path; "unconfirmed" must be checked by the app, not the cashier (C-D8, K-11) |
| B | Services for money writes only, not read paths (C-D8) |
| C | `services/` with one `WriteOutcome {saved, savedOnPhone, unconfirmed, refused}` (D-8) |
| **Resolution** | **Services for money writes only** (payments, bills, cash, expenses). Read view-models stay thin adapters over the existing calc. Normal "saved" is a toast + the post-save sheet; "unconfirmed" **auto-checks the server** and says "Already recorded at 12:31 by …" or "Not recorded — try again"; it asks the user only if the server can't be reached at all |
| Owner | — |
| Plan | P0.1 (payments), P3.S1 (bills) |

### PD-18 Outstanding first view
| | |
|---|---|
| A | Search → party → Receive; analysis folded for the cashier; remember the tab (S-19, K-2) |
| B | Receivables first with aging for the owner (O-14) |
| **Resolution** | Remember the last tab per phone; the first-time default is Sales (receivables), after which the tab last used on that phone wins. Member preset: search and party cards first, aging and analysis folded; owner preset: aging open. "Mark as cleared" moves into a "⋯" menu |
| Owner | — |
| Plan | P2.1, P2.6 |

### PD-19 Members receiving one payment across a party's bills
| | |
|---|---|
| A | Yes (S-19); the party-pay path already keeps idempotent entry ids |
| B | Only through the same payment service (C-S19) |
| C | Technically safe after D-1 (dev review §1a) |
| **Resolution** | Allowed **only after** the payments service (P0.1) is in place, through that service |
| Owner | **OWNER** (owner limited it in #152; OD-16) |
| Plan | P2.6 (behind the owner's answer) |

### PD-20 "Month close"
| | |
|---|---|
| A | "Close" sounds like locking; a lock would refuse in-window edits (C-O3) |
| B | Promote ST2 with last month's column (O-8) |
| **Resolution** | A **report**, shown as **"Month report"** (Hindi "महीने का हिसाब"): this month next to last month, every row tappable. **No locking** |
| Owner | — |
| Plan | P4.2 |

### PD-21 Correcting a paid bill
| | |
|---|---|
| A | The edit screen shows the old cash amount (S-15) |
| B | ₹3,510 left the drawer with no recorded outflow (C-S15 agreement) |
| C | Display is pure (`editSplitFor`); a drawer refund leg is a ₹-calc decision |
| **Resolution** | Now: the edit shows the re-settled split live and a line **"Total ₹3,900 → ₹390: give back ₹3,510 cash"**; "Edit last bill" from the post-save sheet. Later, if approved: record a "given back" drawer leg automatically |
| Owner | Display: —. Drawer leg: **OWNER** (OD-18) |
| Plan | P3.B9 |

### PD-22 Duplicate payments: guard and detector
| | |
|---|---|
| A | Warn at entry: "₹100 was recorded on this bill 40 s ago by Staff One — record another?" (staff review §3.1) |
| B | Find past cases: two payments on one bill with the same amount within 10 minutes (C-D1) |
| **Resolution** | Both. Entry warning (warn-only) and a detector over loaded data (Anomalies item + `npm run audit:numbers`), including rentals charges |
| Owner | — |
| Plan | P0.5 |

### PD-23 Unusual expenses and purchase rates
| | |
|---|---|
| A | Catch the typo at entry with a warn-only line (C-O2b) |
| B | Detect after the fact in Insights › To do (O-17) |
| C | Two small pure detectors with spec IDs, not inside the 304-line `detectAnomalies` |
| **Resolution** | Both: inline "Usually ₹1,200–2,000 for Repair" at entry (never blocking for normal amounts) and To do / Overview attention items for the period |
| Owner | Thresholds: owner may override (defaults in P4.4) |
| Plan | P4.4 |

### PD-24 Expense categories
| | |
|---|---|
| A | Chips for speed (S-22) |
| B | A controlled list; free text splits "Labor/Labour/labour" (C-S22) |
| **Resolution** | Chips from an **owner-maintained list** with "Other: …" free text; old rows grouped case-insensitively for display now (no data change); a `categoryId` added by an owner-reviewed mapping later (old `type` kept) |
| Owner | **OWNER** (the list and the mapping; OD-09) |
| Plan | P3.B10, P4.6 |

### PD-25 Udhaar without a real name
| | |
|---|---|
| B | Require a real name for a due sale (O-21) |
| A | Already required by a hard rule; "Walk-in" is only how a missing name is shown on old/seeded bills (C-O2) |
| **Resolution** | No new rule. Legacy no-name dues are shown as **"No name (old bills)"**, not as a party to chase. The rules check "due > 0 needs a name" comes only after `minClientVersion` is enforced |
| Owner | — |
| Plan | P1.8, P5.3 |

### PD-26 Labour, commission, discounts, returns, round-off
| | |
|---|---|
| A | No blank fields on the busiest form; compute like labour (C-O4) |
| B | Explicit fields; workarounds corrupt margins and dues (C-S28) |
| C | Each changes BF-TOTAL / profit and needs rules bytes; free rules room first (C-A4, C-B2) |
| **Resolution** | **Ask the owner first** (OD-03 … OD-06). Anything approved is computed from a setting where possible (shown with its working, editable), gets its own spec ID + oracle, and ships after rules room (P5.1) if it needs rules. Labour step 1 (display-only reconciliation) can ship before |
| Owner | **OWNER** |
| Plan | P4.7, P4.9 |

### PD-27 Profit on the Overview
| | |
|---|---|
| C | A one-day profit at average cost swings and misleads (C-B8) |
| **Resolution** | No "profit today" headline. Profit for week/month, labelled **"(estimate)"** with its caveat once, one tap away on Money |
| Owner | — |
| Plan | P2.3, P1.9 |

### PD-28 Collection rate
| | |
|---|---|
| B | Add a collection-rate ratio (O-15) |
| C | Needs receivables as of the period start, not stored for older months (C-B4) |
| **Resolution** | Ship the split of Money in first; add the ratio only after `ar/ap` are stored in month snapshots, with its base shown |
| Owner | — |
| Plan | P4.3 (later) |

### PD-29 Online sub-methods and cheques
| | |
|---|---|
| A | Align with Rentals (Cash/UPI/Bank/Cheque); maybe a UPI QR (S-21) |
| B | Record the Online method (UPI default) for reconciliation (C-S17) |
| C | Additive `mode` field, no rule bytes; a cheque is not money until it clears (C-A5) |
| **Resolution** | UPI QR with the amount in the post-save sheet when a UPI id is set (display only, existing encoder). The Online sub-method and cheque handling wait for the owner |
| Owner | **OWNER** (OD-11, OD-21) |
| Plan | P3.B7; later P4.9 |

### PD-30 Bill-number gaps
| | |
|---|---|
| C | Counter retries burn numbers; allocate inside the create transaction (D-4) |
| A | Keep the offline path instant and "Next bill no." visible (C-D4) |
| B | Gaps look like deleted bills to an auditor |
| **Resolution** | Recommended: gaps are acceptable and **explained** ("number not used: the phone retried"); build the in-transaction allocation only if the owner says gaps are not acceptable |
| Owner | **OWNER** (OD-10) |
| Plan | P5.8 (conditional) |

### PD-31 Cash and bank reconciliation
| | |
|---|---|
| B | Per-period cash & bank reconciliation (O-16) |
| A | Drawer close must not get longer (C-O5) |
| C | Bank balances are hand-typed; only the drawer can be reconciled from data (C-B7) |
| **Resolution** | A read-only **drawer reconciliation** for a period (opening count → in / out → Cash Added / withdrawals → closing count) inside the Month report. Bank only if the owner later chooses "Bank deposit" (#110 B) |
| Owner | — (bank: owner decision #110 already open) |
| Plan | P4.2 |

---

## OWNER DECISIONS NEEDED

Reply with the number and a letter, e.g. "OD-01 A, OD-02 A, …", or just **"go"** to accept every recommended default (★). Items marked *later* are only needed before their phase.

| # | Question | Options | ★ Recommended default | Changes money? | Needed by |
|---|---|---|---|---|---|
| OD-01 | Should a bill start with a payment method already chosen? | **A** none chosen; one tap on Cash / Online / Udhaar, amount shown on Save · **B** Cash pre-chosen for unnamed retail bills dated today (flagged on the bill) | ★ A | B changes what is recorded as received | Phase 3 |
| OD-02 | Extreme rate: when must the cashier confirm a rate, and may members confirm it? | Threshold: **A** ≥ 5× or ≤ ⅕ of today's rate (or outside the 30-day range by that factor) · **B** ≥ 10× / ≤ ⅒. Members: **1** may confirm (logged, shown to you) · **2** blocked | ★ A1 | No (a check) | Phase 3 |
| OD-03 | Labour: are labourers paid out of the labour deducted from farmers, and are those wages also entered as "Labour" expenses? | **A** first show "Labour: deducted ₹X · paid ₹Y · difference" (display only); decide later whether the difference counts in profit · **B** also count the difference in profit now · **C** labour wages are never entered as expenses (remove the suggestion) | ★ A | B changes profit (M6) | Phase 4 |
| OD-04 | Does the shop earn commission (₹ per quintal or a %) apart from trading margin? | **A** no · **B** yes: computed like labour from a setting, its own revenue line | ★ A (nothing built) | B adds revenue | Phase 4 |
| OD-05 | Discounts and returns | **A** returns as a dated return bill linked to the original; no separate discount (use round-off) · **B** also a discount field with a limit · **C** neither (today) | ★ A | Yes (sales, stock, dues) | Phase 4 |
| OD-06 | Round-off: may the cashier round a retail bill down? | **A** yes, up to ₹10, shown on the bill as its own line · **B** up to ₹__ · **C** no | ★ A | Yes (bill total) | Phase 4 |
| OD-07 | Rent "collected this month" | **A** show both: "Received this month" (all rent money dated this month) and "This month's rent paid" · **B** only the second (today, relabelled) | ★ A | New figure, no change to existing ones | Phase 1 |
| OD-08 | One meaning of "overdue" | **A** overdue = bills older than 30 days; party lists show "party total ₹X · of which overdue ₹Y" · **B** a party is overdue when its oldest bill is > 30 days, counting its whole due | ★ A | Changes which figure is called overdue | Phase 1–4 |
| OD-09 | Expense categories | **A** a fixed list you can edit (Labour paid, Tea/food, Transport, Electricity, Repair, Rent, Other) + you approve a mapping of old free-text types · **B** keep free text | ★ A | Groups change; totals don't | Phase 4 |
| OD-10 | Bill numbers with gaps (a number skipped when a phone retries) | **A** acceptable, explained in the bill list · **B** must be strictly consecutive (bigger change) | ★ A | No | *later* |
| OD-11 | Cheques on Aadhat bills | **A** record as Online on the day the cheque clears (no new status) · **B** a "cheque pending" state | ★ A | B changes collection timing | *later* |
| OD-12 | Themes: order and default look | Batch 1 Nordic, Nature, Dark, Midnight (+ "Sunlight" high-contrast?), batch 2 Vintage, Classic, Premium, batch 3 Glass, Material, Fluent, Cyberpunk. Default appearance: **A** Light (today) · **B** follow the phone (System) | ★ this order, with Sunlight; A | No | Phase 6 |
| OD-13 | Write-off as its own action ("Write off ₹X as bad debt", with reason), shown as bad debt in profit | **A** yes · **B** keep "Mark as cleared" as today | ★ A | Profit presentation | Phase 4 |
| OD-14 | Should the database rules also force **your own** edits and deletes to leave a record (protects you and the accountant if your login is misused)? | **A** yes · **B** no, app-side record only | ★ A | No | Phase 5 |
| OD-15 | Parties (customers/suppliers as records, #139) | **A** go ahead in phases with the defaults in `docs/parties-design.md` §13; you review merges · **B** not now | ★ A | Migration (additive) | Phase 5 |
| OD-16 | May members take one payment across a customer's several bills (oldest first)? | **A** yes, after the payment fix · **B** owner/manager only (today) | ★ A | No | Phase 2 |
| OD-17 | A separate free Firebase project for testing (#72), to free database-rules space | **A** yes · **B** no | ★ A | No | Phase 5 |
| OD-18 | When a paid bill is corrected downwards, record the cash given back in the drawer automatically? | **A** yes · **B** no (expected cash just drops) | ★ A | Drawer figures | Phase 3–4 |
| OD-19 | Udhaar payments without internet (queued, "waiting to sync") | **A** decide after the payment fix ships · **B** never | ★ A | Timing of collections | *later* |
| OD-20 | Home screens: you open on the Overview; managers and members open on Billing with "My day" | **A** yes · **B** change per role in Roles & access | ★ A | No | Phase 2 |
| OD-21 | Record the kind of Online payment (UPI / bank) on Aadhat bills | **A** later, UPI by default · **B** never | ★ A | No (a sub-split) | *later* |

Decided already and **not** reopened: rounding to whole rupees (#129), calendar periods (#76), midnight-to-midnight days (#108), "Cash Added" (#110 A), void with reason for expenses (#112 A), rentals data is real and never wiped (7 Nov 2026). The receipt language that Agent A asked about (S-12) is already a shop-wide receipt setting (`receiptLang` in `services/printer.js`), so it needs no new decision; the post-save sheet only has to say which language will print.
