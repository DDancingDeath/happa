# happa V2 — summary for the owner

**What we found.** Three reviewers tested the app on test copies (never your real data): a cashier, an owner/accountant and a developer.
- **Your numbers are right.** Every figure we checked matched our own independent totals.
- **Three ways money could go wrong**, all being fixed now: (1) a payment saved during a network drop could be recorded twice when retried; (2) an item typed but not added to the bill was silently left off; (3) Billing could jump back to Purchase while someone was typing a sale. The go-live data wipe is also being changed so **rentals data is always kept**.
- **The counter is slower than it should be**: ~88 taps for a busy-day test. No name or rate suggestions; Save is below the screen; nothing to tap after saving; a 10× wrong rate passes with one tap.
- **You can't see the business in 30 seconds**: you open on Billing, today's sales are 4 screens down, some labels mislead (one sentence on Money gives a wrong reason; rent "collected" shows ₹0 after rent came in), and wholesale bills are missing from History.

**What V2 will feel like**
- **At the counter**: the app opens on Billing in the mode last used. Names, rates and items are suggested. The total and **"Save · Cash ₹390"** stay at the bottom. After saving: WhatsApp / Print / Edit / New bill. The app stops the cashier only for real mistakes, and shows the money: "15 kg × ₹260 = ₹3,900; today's rate gives ₹390 — Fix rate?". A "My day" tab shows the cash drawer, their bills and their reminders. Target: about 25 % fewer taps, and no silently wrong bill.
- **For you**: you open on an **Overview**: sales and purchases, money in (with the bill / old dues), spending, to receive / to pay, compared with yesterday or last month, what needs attention, and a Rentals card. Every number opens its bills. A **Month report** shows this month next to last month. One search finds any bill: purchase, retail or wholesale.
- **Look**: the clean "Bahi" design, with Light / Dark / System first. Your 12 themes come in batches, each checked for readability.

**Plan** (small steps, each tested and reviewed)
0. Safety fixes (in progress now). 1. Fix misleading labels. 2. Your Overview and the counter's My day; the app remembers screens. 3. Faster billing, and the new design base. 4. Comparisons, Month report, bill search, unusual-expense checks. 5. Customer records (parties), database clean-up, rentals extras. 6. All screens in the new design, then the themes.

**Decisions needed.** Reply **"go"** to accept every ★ default, or change any (e.g. "OD-02 B"). Full list: `PRODUCT_DECISIONS.md`.

| # | Question | ★ Recommended |
|---|---|---|
| OD-01 | Pre-select a payment method? | No. One tap on Cash / Online / Udhaar |
| OD-02 | Extreme rate check | Confirm when ≥ 5× or ≤ ⅕ of today's rate; members may confirm, and you see it |
| OD-03 | Labour | First show "deducted · paid · difference"; profit unchanged for now |
| OD-04 | Do you earn commission? | No (nothing built) |
| OD-05 / 06 | Returns; round-off | Returns as a return bill; round-off up to ₹10, shown on the bill |
| OD-07 | Rent "collected" | Show "Received this month" and "This month's rent paid" |
| OD-08 | "Overdue" | Bills older than 30 days; party total shown separately |
| OD-09 | Expense types | A fixed list you can edit; you approve how old types map |
| OD-10 / 11 | Bill-number gaps; cheques | Gaps OK and explained; a cheque counts as Online when it clears |
| OD-12 | Themes | Batches: Nordic, Nature, Dark, Midnight (+ a sunlight theme) → Vintage, Classic, Premium → Glass, Material, Fluent, Cyberpunk; default Light |
| OD-13 / 14 | Write-off; records for your own edits | A "Write off as bad debt" action; your edits are always recorded |
| OD-15 / 16 / 17 | Customer records; members take one payment for several bills; free test project | Yes, in phases (you review merges); yes, after the payment fix; yes |
| OD-18 / 19 / 21 | Cash given back on a corrected bill; offline payments; UPI type | Record it automatically; decide later; later |
| OD-20 | Home screens | You → Overview; managers and members → Billing |
