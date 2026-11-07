# happa V2: User personas

_Product Lead, Round 3. Built from what the three agents did and saw in the running app (`round1/*.md`), not from imagination. Names are illustrative._

The app has three daily users and two indirect ones. The same product must make all three daily users happy: **the counter must be fast and hard to get wrong, the owner must trust the numbers in 30 seconds, and every number must start true at the counter.**

---

## 1. Ravi: counter member (cashier)

| | |
|---|---|
| Role in the app | Member (`role = 'staff'`; the UI never says "staff") |
| Device | Mid-range Android phone (360–412 px), one hand, often outdoors in the mandi yard (bright sunlight), weak mobile signal at peak hours. Sometimes the shop PC (desktop keyboard) |
| Language | Hindi or English, chosen per phone. Uses Hindi grain words (बोरी, उधार) even in English mode |
| Experience | Uses the app all day; no training budget; learns by doing |

**Goals**
1. Serve the next customer fast: a walk-in cash sale in ~10 seconds, a 40-bag farmer purchase without losing a bag.
2. Never make a wrong bill, and fix one quickly when it happens.
3. Take udhaar payments, pay farmers, record an expense, open and close the drawer.
4. Send the bill on WhatsApp or print it right after saving.

**A busy day (from Agent A's run)**
- 07:30 opens the drawer (Today › Cash sub-tab; hidden today, S-23).
- 08:00–12:00 farmers arrive with 4–40 bags each. Purchase bills with bag weights, labour, part cash and "rest due" (B1: ~40 s each).
- Walk-in retail all day (B2: ~15 s, 8 taps; ticking Cash every time, S-2).
- Customers paying old udhaar (5 taps each, one bill at a time, online only; S-19, S-20).
- Tea, labour and transport expenses (S-22).
- A customer comes back: "you charged me ₹3,900 for 15 kg" (B4 → FIX: 12 taps, 3 screens, wrong cash shown; S-15, S-16).
- Evening: count and close the drawer.

**Pain points today**: silently dropped line (S-1), wrong-rate modal with OK as primary (S-16), Save below the fold (S-6), no name suggestions (S-3), payment ticks (S-17), mode flipping back to Purchase (D-5), nothing to do after Save (S-11), Clear without undo (S-7), aging panels hiding the payment box (S-19), raw error text on a payment race (D-2).

**What V2 must feel like for Ravi**
- The bill form is ready when the app opens, in the mode he used last.
- Names, rates and items are suggested; Enter adds a line; the total and **Save · Cash ₹390** are always visible at the bottom.
- After Save: a sheet with WhatsApp / Print / Edit / New bill.
- The app stops him only when something is really wrong, and then says how much ("15 kg × ₹260 = ₹3,900; usual ₹26 → ₹390. Fix rate?").
- Udhaar: search → party → Receive.

**Success measures**: busy-day script ≤ 65 taps (today ≈ 88), zero silently wrong bills, correction ≤ 7 taps from the post-save sheet, no training needed for the new screens (`TEST_SCENARIOS.md` T1).

---

## 2. Meena: manager

| | |
|---|---|
| Role | Manager (`role = 'manager'`), sometimes also a rentals manager (`rentRole`) |
| Device | Phone at the counter; the shop PC for corrections and wholesale |
| Language | Hindi or English |

**Goals**
1. Run the counter when the owner is away: billing, wholesale, payments to farmers, party-level receive, edits and voids in the window.
2. Keep the drawer right; explain differences at close.
3. Chase overdue customers and suppliers (Outstanding, reminders, statements).
4. Record rent and meter readings for tenants (Rentals).

**Pain points today**: the same counter issues as Ravi; lands on Billing but needs a quick shop picture without the owner's full dashboard; Outstanding resets to Purchases every visit (O-14, D-5); the rentals receipt sheet puts "Cancel receipt" (void) right above "Cancel" (S-25); wholesale bills missing from History (O-9).

**What V2 must feel like for Meena**: Counter first (Billing, remembered mode), "My day" for the drawer and her bills, and, where her permissions allow, the shop figures on Today. Outstanding remembers its tab. One bill finder for every bill type.

---

## 3. Seth-ji: owner

| | |
|---|---|
| Role | Owner (`role = 'owner'`); also the only person who controls roles, exports and deletes |
| Device | Phone most of the day (checks between meetings); the desktop at month end and with the accountant |
| Language | Mostly English for numbers, Hindi for chat; reads both |
| Businesses | Aadhat (grain) and Rentals (his shops and flats; real data) |

**Goals**
1. **In 30 seconds**: how did we do today, how much money came in (and from what), what did we spend, who owes us, what needs attention.
2. **At month end**: business done (sales and purchases), money collected, money spent, outstanding, profit (estimate), compared with last month, and why things changed.
3. Find problems without reading hundreds of bills: wrong rates, sales below cost, unusual expenses, duplicate payments, overdue parties.
4. Trust every number: each figure means one thing, is labelled honestly and leads to its bills.
5. Rentals at a glance: rent received, arrears, late units, occupancy, without mixing rent with shop money.

**His day / month (from Agent B's run)**
- Morning: opens the app → lands on Billing → More → Money (4 taps) or scrolls Today for ~4 screens to find sales (O-1, O-2).
- Month end: 4 Money tabs plus Compare & share plus Statements (O §2: ~1–1.5 min; Oct vs Sep side by side needs date pickers, O-7).
- Investigations: Anomalies, Insights › To do; History misses wholesale (O-9).

**Pain points today**: a false explanation on Money › Cash (O-3); mislabels that understate rent received and overstate "Paid" (O-4, O-5); three overdue totals (O-13); labour possibly double-counted (O-6); collections not split (O-15); his own corrections leave no trail (D-3).

**What V2 must feel like for the owner**
- He opens the app on an **Overview**: today vs yesterday (or this month vs last month), money in split into "with bill" and "old dues", spending, to receive / to pay, attention items and a Rentals card.
- Every figure is a link to its home page and from there to the bills.
- A **Month report** shows this month next to last month, every row tappable.
- Nothing on screen claims a cause the data doesn't prove.

**Success measures**: the five month-end questions answered from one screen in ≤ 3 taps each, every figure equal to an independent total, drill to a bill in ≤ 2 taps (`TEST_SCENARIOS.md` T2).

---

## 4. Indirect users

| Persona | Relationship | What matters |
|---|---|---|
| **Customers and farmers** | Receive the WhatsApp bill or printed receipt; pay udhaar | A correct bill sent **after** it is saved, a real bill number, no "(COPY)" on the first send, the right amount on the receipt |
| **Tenants** | Never log in; get WhatsApp receipts and an optional read-only link `/r/<token>` | Correct receipts; the link stays fast and private |
| **Accountant** | Receives exports and statements from the owner | Stamped exports, consecutive or explained bill numbers, an audit trail for every correction |
| **Developer / maintainer (Agent C's view)** | Builds and supports the app | Small PRs, one place for each money write (services), tests that catch wrong money, no fight with styling debt |

---

## 5. Platform and language matrix

| | Phone (Android APK, 360–430 px) | Desktop / web (≥ 1024 px) | Hindi |
|---|---|---|---|
| Member | Primary. One hand, touch, decimal keypad | Occasional; keyboard path must work (today 34 keys + 1 click for a sale) | Must be as fast as English; labels above inputs; "kg" always |
| Manager | Primary | Wholesale, corrections, statements | Same |
| Owner | Overview, Outstanding, approvals | Month report, Money, exports, Settings | Reads both; figures identical |
