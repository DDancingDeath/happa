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
