# happa V2: UX redesign

_Product Lead, Round 3, 8 Nov 2026. Information architecture, navigation and screen designs for V2, resolving the three agents' findings (`PRODUCT_DISCOVERY.md`) and decisions (`PRODUCT_DECISIONS.md`). The visual language is the **"Bahi"** direction (`redesign/direction/DIRECTION.md`): quiet chrome, numbers first, colour only for meaning, one obvious next step. Mock images referenced below are copies in `img/`; they are illustrative (their figures are examples, and V2 changes some controls — noted where it matters)._

Wireframes are text so they can be reviewed in a PR. `[ ]` = control, `( )` = chip, `▸` = navigates, `⋯` = overflow menu, `↵` = Enter.

---

## 1. Design goals

| Goal | Measure (see `TEST_SCENARIOS.md`) |
|---|---|
| The counter is fast and hard to get wrong | Busy-day script ≤ 65 taps (today ≈ 88); no bill stored with a silently dropped line, a silent payment method or an unconfirmed 5× rate |
| The owner understands the business in 30 seconds | Today / this month on one phone screen; month-end questions ≤ 3 taps each; every figure 2 taps from its bills |
| Numbers are honest | Revenue, collections, cash and profit never share a label; estimates say "(estimate)"; nothing on screen claims a cause the data can't prove |
| Nothing new costs reads at start-up | Overview, My day, suggestions and comparisons use data already on the phone; Rentals stays lazy |
| One system, many themes | Every new screen uses tokens and the component kit only (no inline colours), so the 12 themes and Light/Dark/System work without per-screen work |

---

## 2. Information architecture and navigation

### 2.1 Phone (Android APK and narrow web, < 600 px; tablet 600–1023 keeps the tab bar)

Bahi shell (DIRECTION §3.6, §5): a title app bar (title · sync pill · bell), a 5-item bottom tab bar, and **More** as a bottom sheet (`img/mock-phone-more.png`). The second tab is **role-aware**; everything else is shared.

| Tab | Owner | Manager | Member (cashier) |
|---|---|---|---|
| 1 | Billing | **Billing (landing)** | **Billing (landing)** |
| 2 | **Today = Overview (landing)** | Today = My day + the shop figures the manager's permissions allow | Today = **My day** |
| 3 | Bills (the bill finder; was History) | Bills | Bills |
| 4 | Outstanding (owner preset) | Outstanding (owner preset) | Outstanding (counter preset) |
| 5 | More (sheet) | More | More |

**More sheet**, grouped (Bahi icon grid): *Money* — Money, Month report, Insights, Statements · *Records* — Wholesale, Expenses, Cash drawer, Stock, Rates · *Manage* — Anomalies, App health, Settings, Admin · business switch **Aadhat ▾ / Rentals**. Members see only what their permissions allow (unchanged `roleAccess`); Expenses and Cash drawer are also one tap away from My day.

**Landing and remembered state** (PD-05, P2.1–P2.2):
- Owner → Overview; manager and member → Billing. The owner can change the landing per role in Settings › Roles & access (0 reads: `settings/app` is already read).
- Remembered per phone (`localStorage`, 0 reads): Billing mode (Purchase / Retail), Outstanding tab (Purchases / Sales) and filter, Bill finder type chips, Overview period. First-ever default: Billing = Purchase (today's behaviour), Outstanding = Sales.
- No timer resets: a page shows the state it was left in (fixes D-5 for every page).

### 2.2 Desktop and wide web (≥ 1024 px)

Bahi desktop shell (`img/mock-desktop-billing.png`, `img/mock-desktop-today.png`): a 248 px sidebar (64 px rail at 1024–1279) with the workspace switch "happa · Aadhat ▾", grouped navigation and Alt+N hints; a 60 px page header (title, segmented mode/tabs, ghost actions, sync, bell).

| Sidebar group | Items (role-filtered) |
|---|---|
| Counter | Billing (Alt+1), Today (Overview / My day) (Alt+2), Bills (Alt+3), Outstanding (Alt+4), Wholesale, Expenses, Cash drawer |
| Money | Money, Month report, Insights, Statements |
| Records | Stock, Rates, Anomalies |
| Manage | Settings, Roles & access, App health, Admin |

Desktop layouts are two-column: Billing = entry and lines | a sticky 380 px summary with the payment chips and Save; Overview = KPI strip | attention and Rentals column; Bill finder = a table with a detail pane.

### 2.3 Rentals

Unchanged entry (business switch, lazy load, 0 start-up reads). The owner's Overview shows a **cached rent card** (PD-06). Rentals screens are being redesigned in open PRs #363/#367/#368; V2 only adds the figure fixes and the improvements in `IMPLEMENTATION_PLAN.md` Phase 5.

---

## 3. Screen designs

### 3.1 Counter: Billing (phone, retail sale)

Basis: `img/mock-phone-billing-bill.png` and `img/mock-phone-hi-billing.png`. **Change from the mock**: the payment block is chips, not three "Fill" rows; the Save button carries the method and amount.

```
┌────────────────────────────────────────────┐
│ Billing                     ☁ Synced   🔔  │ app bar
│ ( ● Purchase )( ● Retail sale )   Drafts ⋯ │ mode: remembered per phone
│ Next bill no. S-20261108-004 (given on save)│
│                                            │
│ Customer                                   │
│ [ Sit|                              👤 ]   │
│   Sita Devi · owes ₹200 on 1 bill       ▸  │ suggestions from loaded bills
│   Sitaram · no dues                     ▸  │ (0 reads; sorted by last use)
│                                            │
│ Item   ( Wheat )( Rice )( Mustard )( 🔍 )   │ top items, nothing preselected
│ Rate  [ ₹ 26.00 ]  today's rate            │ prefilled from today's Rates list
│ Weight [ 20         kg ]  [ + Bag ]        │ ↵ on a weight = add bag;
│                                            │ ↵ on an empty weight = add line
│ On this bill · 2                   25 kg   │
│ Rice     5 kg × ₹36.00          ₹180   ✕   │
│ Wheat   20 kg × ₹26.00          ₹520   ✕   │
│                                            │
│ Payment                                    │
│ ( Cash )  ( Online )  ( Udhaar )  ( Split… )│ nothing preselected (PD-01)
│ Notes · Date  ▾                            │ folded
├────────────────────────────────────────────┤
│ Total               [WA] [🖨] [ Save · Cash ₹700 ] │ sticky action bar
│ ₹700                                       │ (Save disabled until a method)
└────────────────────────────────────────────┘
```

**Purchase mode** adds, above Payment: `Purchase total ₹7,395 · Labour 6 × 6 −₹36 (switch, editable) · Payable ₹7,359`. After "Add to bill" both modes keep the item and clear rate and weight (one behaviour, S-8).

**Split…** opens the familiar boxes, with plain words (S-25):

```
│ Cash    [ ₹ 3,000 ]                        │
│ Online  [ ₹       ]                        │
│ Udhaar  [ ₹ 4,359 ]   [ Rest as udhaar ]   │
│ Left to pay ₹0 ✓                           │
├────────────────────────────────────────────┤
│ Payable ₹7,359    [WA] [🖨] [ Save · Split ] │
```

**States and guards**

| Situation | What the cashier sees | Rule |
|---|---|---|
| A filled entry row on Save / Print / WhatsApp | Sheet: "Add **Rice 4 kg × ₹36 = ₹144** to the bill?" **[Add]** (primary) [Discard] | PD-02 (in flight, P0.2) |
| Rate changed from today's list | The rate field shows "changed from ₹26"; the line shows a small "edited rate" tag | PD-03, stored `rateEdited` |
| Rate ≥ 5× or ≤ ⅕ of today's rate (OD-02) | Blocking sheet: "**15 kg × ₹260 = ₹3,900.** Today's rate ₹26 → ₹390." **[Fix rate]** (primary) [Keep ₹260] | PD-03; override logged |
| No method chosen | Save stays disabled; hint above the bar: "Choose Cash, Online or Udhaar" | today's hard rule |
| Udhaar without a name | "Enter the name — udhaar needs a customer/supplier" at the name field | today's hard rule |
| Name close to a known party | Under the name: "Did you mean **Sita Devi** (owes ₹200)?" [Use] | P3.B2, warn only |
| Clear tapped | The bill clears; toast "Bill cleared · **Undo**" for 10 s; auto-save kept until then | P3.B8 |
| Offline | Save works; the outcome says "Saved on this phone · will sync" | unchanged |

### 3.2 Counter: Billing (desktop)

```
┌ Sidebar ┬───────────────────────────────────────────────┬──────────────────────────┐
│ Counter │ Billing   ( Purchase  Alt+P )( Retail  Alt+R ) │ Bill summary             │
│ Billing │ Customer [ Sita Devi ▾ ] owes ₹200            │ Rice   5 kg × 36    ₹180 │
│ Today   │ Item [ Rice ▾ ] Rate [ 36.00 ] Weight [ 5 ]  │ Wheat 20 kg × 26    ₹520 │
│ Bills   │ ↵ add bag · ↵ on empty weight adds line       │ ───────────────────────  │
│ …       │ Lines table (item, kg, bags, rate, amount, ✕) │ Total             ₹700   │
│         │                                               │ (Cash Alt+C)(Online Alt+O)│
│         │                                               │ (Udhaar Alt+U)(Split Alt+S)│
│         │                                               │ [ Save · Online ₹700 ]   │
│         │                                               │  Ctrl+S save · Ctrl+P print│
└─────────┴───────────────────────────────────────────────┴──────────────────────────┘
```

Keyboard-only retail sale target: **≤ 20 keystrokes, 0 clicks** (today 34 + 1 click, S P13).

### 3.3 Post-save sheet (new; copies the Rentals receipt pattern, S P11)

```
┌────────────────────────────────────────────┐
│ ✓ Saved · S-20261108-004                   │
│ Sita Devi · ₹700                           │
│ Online ₹500 · Udhaar ₹200                  │
│                                            │
│ [ WhatsApp ]  [ Print ]  [ UPI QR ₹500 ]   │ QR only when a UPI id is set
│                                            │
│ [ Edit this bill ]      [ New bill ▸ ]     │ New bill = primary, also ↵
└────────────────────────────────────────────┘
```

- The sheet title follows the **write outcome** (PD-17), one component for every save:

| Outcome | Title | Notes |
|---|---|---|
| saved | ✓ Saved · bill no. | Toast-weight; ↵ or tapping outside starts a new bill |
| savedOnPhone | ✓ Saved on this phone · will sync | Device bill number shown as today |
| unconfirmed | Checking with the server… → then "✓ Already saved at 12:31" or "Not saved — Save again" | The app checks by itself; asks only if the server can't be reached |
| refused | ⚠ Not saved: *reason in plain words* | Never raw error text (D-2) |

- **WhatsApp on the bill form = Save & WhatsApp** (like Print = Save & Print); an unsaved bill is never shared (S-10). The first send is not marked "(COPY)"; reprints are (S-11).
- Print result is honest: "Printed" / "Printer not connected — receipt shown" (S-12, in flight P0.2).

### 3.4 My day (manager and member, tab 2)

```
┌────────────────────────────────────────────┐
│ Today   Sun, 8 Nov              ☁ Synced 🔔 │
│ Cash drawer                                │
│ Open since 07:32 · expected ₹4,210  [Close]│ or "Not open yet  [Open cash]"
│                                            │
│ ( Receive udhaar ) ( Pay supplier ) ( Expense )│ quick actions
│                                            │
│ My bills today · 14                 ₹9,880 │
│ S-…-014  Sita Devi      ₹700  Online+Udhaar ▸│ tap = details (Reprint/Share/Edit)
│ S-…-013  Walk-in        ₹390  Cash        ▸│
│ … Show all                                 │
│                                            │
│ My reminders · 2                           │
│ Collect from Ramesh · ₹1,200 · 34 days    ▸│
└────────────────────────────────────────────┘
```

Figures: drawer C7 (home: Cash) shown as a reference; "My bills today" is a filter of T19 by `createdBy` (new spec ID T19m with an oracle). No profit, net flow, personal-expense or labour figures on My day. A manager additionally sees a "Shop today" section with the figures their permissions already allow, as references to their homes.

### 3.5 Overview (owner, tab 2 and landing)

Basis: `img/mock-phone-today.png` (hero, attention list, business grid). **Changes from the mock**: the hero is *business done* and *money in*, each with a comparison; money in is split; figures are references to their homes.

```
┌────────────────────────────────────────────┐
│ Overview                     ☁ Synced  🔔  │
│ ( Today )( This week )( This month )( Last month )( FY ) ▸ │ remembered
│ as of 09:12 · updating…                    │ cached first paint, then live
│                                            │
│ Business done                vs yesterday  │
│ Sales      ₹31,780  · 22 bills   ▲ 12%   ▸ │ T2 → Today / M1 → Money
│ Purchases  ₹25,720  ·  4 bills   ▼ 8%    ▸ │ T1 → Today / M16 → Money
│                                            │
│ Money in   ₹38,200                ▲ 5%   ▸ │ T10 / M12 → Money › Cash
│   with the bill  ₹29,400 · dues collected ₹8,800 │ T20+T13 / M12a+M12b (new IDs)
│   cash ₹14,516 · online ₹23,684            │
│ Money out  ₹25,720                       ▸ │ T11 / M13
│ Spent (business) ₹1,250 · top: Labour      ▸│ T4 / M4 → Money › Spending
│                                            │
│ To receive ₹17,25,188 · overdue ₹8,42,300 ▸│ O4 (+ I10 per OD-08) → Outstanding
│ To pay     ₹13,85,598                     ▸│ O3 → Outstanding
│ New udhaar today ₹6,112                   ▸│ T15 (relabelled)
│ Profit this month (estimate) ₹3,36,000    ▸│ M6 → Money › Profit (not shown for Today)
│                                            │
│ Needs attention · 4                        │
│ ⚠ 1 rate 10× usual on S-…-009             ▸│ high/medium only; low behind a count
│ ⚠ ₹100 recorded twice on S-…-002          ▸│ duplicate-payment detector (P0.5)
│ ⚑ Cash not closed yesterday               ▸│
│ ● 3 parties overdue > 30 days             ▸│
│                                            │
│ Rentals · as of 8 Nov 08:15                ▸│ cached card, 0 reads; tap = Rentals
│ Rent due ₹20,000 · 2 units late            │ never added to shop totals
└────────────────────────────────────────────┘
```

Rules for the Overview:
- **No new homes.** Every figure is a `data-metric-ref` reference that links to its home (`utils/metric-registry.js`). New figures — T20 "with the bill today", M12a "money in with the bill", M12b "dues collected", the comparison deltas if not already specified — get spec IDs in `docs/calculations.md` and oracle tests.
- **Comparisons**: Today vs yesterday; This week vs last week; This month vs the same days of last month ("vs 1–8 Oct", O-19); Last month vs the month before; FY vs last FY (snapshots, 1 read per month). When a comparison isn't ready: "working it out…", never a guess.
- **Labels**: "Sales" is revenue (credit included); "Money in" is collections; "Profit (estimate)" is the only profit; personal expenses and withdrawals appear only on Money › Spending.
- **Desktop**: a KPI strip (Sales, Purchases, Money in, Money out, To receive, To pay) with comparisons, then two columns: left = the Money-in split and spending; right = Needs attention and the Rentals card.

### 3.6 Month report (the "Month close"; a report, not a lock — PD-20)

Basis: the existing ST2 Month statement (`img/owner-month-statement-desktop.png`).

```
┌────────────────────────────────────────────┐
│ Month report   ‹ October 2026 ›   [Share ▾]│ WhatsApp · Print · CSV (owner)
│                     Oct        Sep    Change│
│ Business done                              │
│ Sales           31,62,392  27,40,110  +15% ▸│ M1 → bills sheet
│ Purchases       29,01,998  25,88,400  +12% ▸│ M16
│ Profit                                     │
│ Cost of what was sold …                   ▸│ M2
│ Business expenses   42,499     30,120  +41% ▸│ M4 → by category
│ Bad debts written off   0          0       │ M5
│ Profit (estimate) 3,36,000  4,36,000  −23% ▸│ M6 + caveat once
│ Money                                      │
│ Money in        24,54,898  …               ▸│ M12
│   with the bill 16,95,444 · dues collected 7,59,454 │ M12a / M12b
│ Money out       22,60,140  …               ▸│ M13
│ Cash drawer: opening → in/out → added/withdrawn → closing count ▸│ read-only (PD-31)
│ Position (end of month)                    │
│ To receive 17,25,188 · To pay 13,85,598    ▸│ O4 / O3 (end-of-month values only where stored)
│ Stock at start / end                       ▸│ M17
│ What changed most: Repair +₹18,000; Wheat sales −₹1.2 L ▸│ from data, ranked by ₹ change
└────────────────────────────────────────────┘
```

"What changed most" lists the biggest ₹ changes by item, party and expense category, taken from data; it never states a cause.

### 3.7 Bill finder (tab 3, "Bills"; PD-07)

Counter preset (members; search first):

```
┌────────────────────────────────────────────┐
│ Bills                                      │
│ [ 🔍 Name, bill no. or item          ]     │ / focuses on desktop
│ ( All )( Purchase )( Retail )( Wholesale ) │ wholesale only with permission
│ Today · 14 bills                    ₹9,880 │ ₹ total of what is listed
│ S-…-014  Sita Devi   Retail   ₹700  Udhaar ₹200 ▸│ whole row opens the bill
│ P-…-006  Ramu Kisan  Purchase ₹7,359 Due ₹4,359 ▸│
│ …                                          │
│ Older: [ Load October · ≈ 136 bills ]      │ count first, then load on demand
└────────────────────────────────────────────┘
```

Owner preset adds, folded under "Filters": period, party, item, paid by (cash / online / udhaar), status (open due, written off, voided, edited, rate edited). Typing a full bill number looks it up directly (1 read). Loaded months (this and last) are instant. No "All time" load.

**Bill details** (S-14): party → total / paid / due → items → actions (Reprint, Share, Edit, Void, ⋯); trace id and timestamps under "More details".

### 3.8 Outstanding (tab 4; PD-18)

Basis: `img/mock-phone-outstanding.png` (Bahi) and today's owner view `img/owner-outstanding.png`; the counter problem is `img/staff-outstanding-sita.png`.

Counter preset (members):

```
┌────────────────────────────────────────────┐
│ Outstanding  ( Sales )( Purchases )        │ remembered per phone
│ [ 🔍 Search party ]                        │
│ Sita Devi · ₹1,200 on 3 bills · oldest 34 d│
│   [ Receive ]  (Remind)  ⋯                 │ Receive = across bills, oldest first
│ Ramesh · ₹600 on 1 bill · 12 d             │   (members: only if OD-16 = A)
│   [ Receive ]                              │
│ ▸ Aging and who to chase (folded)          │
└────────────────────────────────────────────┘
```

Receive sheet: amount, chips (Cash / Online), nothing preselected; "Record ₹600 · Cash". Outcomes:

| Case | Message |
|---|---|
| Saved | "₹600 recorded · due now ₹600" with **Undo** only where the rules allow (owner/manager) |
| Someone else just paid | "Someone just recorded ₹200 on this bill. Due is now ₹160. Record ₹160 instead?" [Record ₹160] [Cancel] (D-2, in flight) |
| Same amount recorded < 10 min ago | "₹100 was recorded on this bill 40 s ago by Staff One. Record another ₹100?" (P0.5) |
| Reply lost | "Checking…" → "Already recorded at 12:31" (no second entry; D-1, in flight) |
| No internet | "No internet: payment not recorded. Note it and record it when online." (payments stay online-only, PD-04) |

Owner preset: receivables first, aging buckets and "Who to chase first" open, statements and reminders per party, "Mark as cleared" → "⋯ › Write off as bad debt" (OD-13). Legacy dues with no name show as "No name (old bills)" and are not chased (PD-25).

### 3.9 Expense (quick entry)

```
│ Expense                                    │
│ ( Labour paid )( Tea )( Transport )( Repair )( Other… ) │ owner list (OD-09); frequent first
│ Amount [ ₹ 300 ]   usually ₹200–400 for Labour paid │ warn-only hint (P4.4)
│ Paid by ( Cash )( Online )                 │
│ ▸ Person, date, remarks                    │ folded
│                                [ Save ₹300 Cash ] │
```

### 3.10 Settings › Appearance (Phase 3) and Theme Gallery (Phase 6)

Phase 3 ships **Appearance: ( Light )( Dark )( System )** with Modern Minimal; existing `darkMode` users land in Dark. Phase 6 adds the gallery with live previews, "Previewing Vintage · Cancel · Apply" and Reset to default (`img/mock-phone-theme-gallery.png`, `img/mock-themes-overview-light.png`), one batch at a time (PD-11).

---

## 4. Interaction patterns

| Pattern | Rule |
|---|---|
| **One primary** | One filled button per screen, always reachable (sticky action bar on the phone, summary footer on desktop) |
| **Remembered state** | Pages restore their last mode, tab, filters and period per phone; no timer resets; first-time defaults per role |
| **Choose, don't assume** | Money facts (payment method, write-off, extreme rate) are explicit choices; speed comes from one-tap chips and prefilled *suggestions*, never silent defaults |
| **Block vs warn** | Block only when the stored bill would be wrong or incomplete (no method, udhaar without name, unadded filled line, extreme rate); everything else is an inline warning that never interrupts |
| **Show the money in every confirm** | Every confirm shows the amount it is about ("Add Rice 4 kg × ₹36 = ₹144?", "15 kg × ₹260 = ₹3,900") |
| **Undo over confirm** | Reversible actions (Clear, dismiss) get a 10 s Undo instead of a dialog |
| **Write outcomes** | Four outcomes, one component, plain words, never raw errors; "unconfirmed" is checked by the app |
| **References, not copies** | A figure shown outside its home is a reference with a link; each figure has one meaning and one label everywhere |
| **Honest freshness** | Cached figures say "as of 09:12"; comparisons not ready say "working it out…" |
| **Sheets on phone, dialogs on desktop** | Phone: bottom sheets (Back closes them first); ≥ 600 px: centred dialogs; Esc closes; focus is trapped |
| **Empty / loading / error** | Skeleton lines per section; empty state with one action; error notice with Retry; no full-screen spinner except blocking saves |
| **Toasts** | ≤ 4 s, cleared on page change, never cover the action bar (S-26) |
| **Offline** | Bills and expenses save offline; payments, edits and voids say up front that they need internet |
| **Accessibility** | 44 px targets on the phone, visible focus in every theme, `inputmode="decimal"` on money and weight, `aria-live` totals, axe AA in en and hi |

**Desktop shortcuts** (listed in `?` help):

| Key | Action |
|---|---|
| Alt+P / Alt+R | Purchase / Retail mode |
| ↵ on a weight / ↵ on an empty weight | Add a bag / add the line |
| Alt+C / Alt+O / Alt+U / Alt+S | Cash / Online / Udhaar / Split |
| Ctrl+S (or Ctrl+↵) / Ctrl+P | Save / Save & print |
| ↵ in the post-save sheet | New bill |
| Ctrl+Z (within 10 s of Clear) | Undo clear |
| / · ? · Esc · Alt+1…9 | Search · help · close · pages |

---

## 5. Language and copy

- One language per screen; every new string is a `t()` key in `en.js` and `hi.js`; "kg" always; labels above inputs; no uppercase or letter-spacing; Hindi labels at weight 400 (DIRECTION §3.2–3.3).
- Plain words replace jargon (S-25, O-19): "Not split yet" → **"Left to pay"**; "Rest → Due" → **"Rest as udhaar"**; "Cost of goods sold" → **"Cost of what was sold"**; "Due to Receive" (today) → **"New udhaar today"**; "Collected this month" (rent) → **"This month's rent paid"** (+ "Received this month", OD-07); Rentals receipt "Cancel" → **"Close"**, void inside ⋯.
- Proposed Hindi for the new controls (to be aligned with the existing `hi.js` terms in the PR): नकद (Cash), ऑनलाइन (Online), उधार (Udhaar), बाँटें… (Split…), "बाकी उधार में" (Rest as udhaar), "+ बोरी" (+ Bag), "आज का हिसाब" (My day), "महीने का हिसाब" (Month report), "सारांश" (Overview).

---

## 6. Alignment with the Bahi visual direction

| Bahi element (DIRECTION) | Used in V2 |
|---|---|
| Layered tokens, Modern Minimal default, `data-theme` / `data-appearance` / `data-mode` | Phase 3 foundation (P3.D2–P3.D3); all new screens use tokens only |
| Numbers first, tabular figures, muted ₹ | Overview, Month report, action bar total |
| Mode dots (purchase indigo, retail green, wholesale violet, rentals cyan) | Billing mode, bill finder type chips, Rentals card |
| Dues in ink, amber after 30 days, red after 90 | Outstanding, Overview "overdue" |
| Sticky action bar; one primary | Billing (with the method on Save), post-save sheet |
| Sheet, Notice, Metric, Panel + Row, Segmented control, Chips | Component kit P3.D4, extended with **KpiTile** (figure + comparison + link), **RecordsSheet** (filtered list + ₹ total, from `finance-breakdown-sheet`), **Caveat**, **OutcomeBanner**, **ConfirmSheet** |
| Icon sprite instead of emoji | Action bar, tab bar, attention items (P3.D4 subset, the rest in Phase 6) |
| 12 themes × Light/Dark/System, gallery, previews | Engine in Phase 3, themes in batches in Phase 6 (PD-11) |
| Print and receipts untouched | Unchanged: canvas receipts never read tokens |

What V2 changes in the mocks: the payment "Fill" rows (`img/mock-phone-billing-bill.png`) become chips; "Net cash today" as the Today hero (`img/mock-phone-today.png`) becomes "Business done" + "Money in" with comparisons for the owner, and My day for the counter; the mock figure "2 bills not split" is not used (it would be a new figure with no decision behind it).
