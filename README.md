# V2 Phase 1 screens (not for merge)

Before/after screenshots for the V2 Phase 1 PRs, from the E2E emulator seed plus a few bills (phone, owner).

## P1.1 (PR #378): Money and Insights labels
- `p1-1/money-cash-takeaway-{before,after}-en.png`: the false "Money in is below profit because ₹18,000 … still owed" sentence is gone.
- `p1-1/insights-bought-{before,after}-en.png` (+ `after-hi`): "Paid" → "Bought for", kg 1690 → 1,690.
- `p1-1/breakdown-sheet-{before,after}-en.png` (+ `after-hi`): raw `ui.finance.group_*` keys → "No groups / By item / By party / By day"; "Total of 3 entries" → "Total of 3 lines in 2 bills".

## P1.2 (Today and Cash labels)
- `p1-2/cash-status-{before,after}-en.png` (+ `after-hi`): Cash In ₹4,100 (opening ₹2,000 + added ₹500 included) → ₹1,600; Cash added on its own card; Available ₹4,100 unchanged.
- `p1-2/today-cash-in-{before,after}-en.png` (+ `after-hi`): Today's Cash In ₹1,600 (= the Cash page after).
- `p1-2/today-due-summary-{before,after}-en.png` (+ `after-hi`): "Due to Receive / Due to Pay" → "New udhaar today / New to pay today" (same ₹18,000 / ₹46,980).

## P1.3 (History › Sale with wholesale and a ₹ total)
- `p1-3/history-sale-month-{before,after}-en.png` (+ `after-hi`): This month, Sale: before 1 bill (retail only), no total; after 2 bills (Retail + Wholesale tags) · ₹19,600.
- `p1-3/history-sale-search-{before,after}-en.png` (+ `after-hi`): search "Gali": before nothing (the wholesale bill was not in History); after 1 bill · ₹19,200.

## P1.4 (one "overdue": bills more than 30 days old, OD-08)
E2E seed + old dues: retail Asha ₹1,500 (45 days) + ₹500 (5 days); wholesale Gali 4 ₹6,000 (40 days); purchase Ram 1 ₹9,000 (70 days); plus today's bills.
- `p1-4/today-reminders-{before,after}-en.png` (+ `after-hi`): headlines unchanged (₹2,000 / ₹6,000 / ₹55,980, the parties' whole dues); new "of which overdue (> 30 days)" ₹1,500 / ₹6,000 / ₹9,000 and "₹Y overdue" per party.
- `p1-4/insights-todo-{before,after}-en.png` (+ `after-hi`): same ₹7,500 / ₹9,000; text now "owe you ₹7,500 overdue (bills more than 30 days old)", "You owe 1 party" (was "1 parties").
- `p1-4/outstanding-sale-{before,after}-en.png` (+ `after-hi`): new "Overdue (> 30 days) ₹7,500" under ₹26,000 (= Insights = Today's 1,500 + 6,000); "₹Y overdue" on chase-first and party rows.
- `p1-4/outstanding-purchase-{before,after}-en.png` (+ `after-hi`): "Overdue (> 30 days) ₹9,000" under ₹55,980 (= Insights "You owe").

## P1.5 (Rentals: received this month and each tenant's month, OD-07)
Rentals data seeded: Gupta Bhawan, Ram (1A, ₹4,000) paid ₹8,000 today for the two months before this one, nothing for this month; Sita (2B, ₹6,000) paid ₹2,000 of this month; Om (Shop 3, ₹5,000) paid this month in full.
- `p1-5/rent-simple-{before,after}-en.png` (+ `after-hi`): "Collected ₹7,000 of ₹15,000" → "This month's rent: ₹7,000 paid of ₹15,000" (same number) and new "Received this month: ₹15,000" (8,000 + 2,000 + 5,000).
- `p1-5/rent-simple-tenants-{before,after}-en.png` (+ `after-hi`): each tenant's month: Ram "₹4,000 due", Sita "part paid, ₹2,000 of ₹6,000", Om "paid".
- `p1-5/rent-advanced-{before,after}-en.png` (+ `after-hi`): card "Collected this month" → "This month's rent paid" ₹7,000; new card "Received this month" ₹15,000; property line "₹7,000 paid".
