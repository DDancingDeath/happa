# Rentals

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [rentals.hi.md](rentals.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

Separate from the shop: rent money never counts in shop figures.

| On screen | How it is worked out |
|---|---|
| Rent this month, collected, still due (RENT-1 to RENT-3) | This month's charges, what was paid on them, and the difference. |
| Total due (RENT-4) | What every month up to now still owes, moved-out tenants included. |
| Per tenant (RENT-5) | A month is Late after its due day (default the 10th), Part paid when partly paid. |
| Rent increase due (RENT-6) | One year after the start (or the last change): rent × (1 + increase %). Only a reminder. |
| Electricity (RENT-7) | Meter billed by us: (current − previous reading) × rate per unit, whole rupees. |
| First month (RENT-11) | The full rent by default; with "Pro-rate first month" ticked, only the days from the start date. |
| Change of unit (RENT-13) | "Pro-rate move month" is ticked by default: the old unit is charged up to the day before the move and the new unit from the move day. A move on the 1st: the new unit pays the whole month. |
| Receipts (RENT-12) | Numbered R-year-number, one per payment; a cancelled one keeps its number. |
| Deposit held (RENT-14) | Tenants › 💰 Deposit: what the tenant gave as deposit, minus what was adjusted against unpaid rent and what was refunded. Adjusting pays that month (no receipt). Anyone with a rentals role records; only you edit or remove an entry. Not Aadhat cash. |
| Advance (RENT-16) | Paying more than a month's due first pays the unpaid months, oldest first (the app shows the split before saving). What is left after the latest month is an advance that pays next month's rent as soon as that month starts (no receipt for it; the payment's receipt shows the advance). On a change of unit it pays the new unit's first month; if the tenant moves out with an advance left, it is added to their deposit. |
| Expenses and net (RENT-17, RENT-18) | Properties › 💸 Expenses: repairs, property tax, maintenance, insurance, broker or other paid for a property (or one unit). The Rent page shows this month's expenses and the net (collected − expenses) in all and per property. Anyone with a rentals role adds one; only you change or remove one. Not Aadhat cash. |
| Deposits held (RENT-15) | Tenants › Deposits held: every deposit still held and their total. |
| Agreement (on a tenant) | Tenants › 📄 Agreement (you and rentals managers): the month the agreement ends and the notice period in months. The start month and the yearly increase % are the lease's own. The tenant row shows "agreement till …". |
| Rent agreements and increases on Today (REM-4) | People with a rentals role see on Today the agreements ending this month or in the next 2 months (or already ended), with the month the notice must be given by, and the rent increases due. As the Rent page last saw them on this phone this month. |
| Yearly report (RENT-19) | Properties › 📊 Yearly report (you and rentals managers): for each property and month of the financial year (or a calendar year): rent, collected, still due, expenses (of which property tax) and net (collected − expenses), with the year's total. **Download CSV** is for you only; give it to your accountant for the rent received and the property tax. |
