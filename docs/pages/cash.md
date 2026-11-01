# Cash (the drawer)

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [cash.hi.md](cash.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

Only cash counts here, for one day's cash session.

| On screen | How it is worked out |
|---|---|
| Cash sales, purchases (C1, C2) | Cash paid at save on that day's sales / purchases. |
| Expenses (C3) | That day's **cash** expenses, business and personal. |
| Due received / paid (C4, C5) | Cash part of that day's due payments. |
| Deposits (C6) | Cash added to the drawer. |
| Expected cash (C7) | Opening + cash sales + due received + deposits − cash purchases − due paid − expenses. |
| Difference (C8) | Counted cash − expected: short or extra. Within ₹1 it matches. |
| Counted cash (C9) | The last counted closing; it is the drawer part of Net worth. |
| Open for N hours (C10) | When today's cash has been open 14 hours or more, Close cash says so with the time it was opened. |

One session per day: the second phone joins it. Opening needs internet. A closed
day can't be reopened; a day closed without a count shows "Not counted" and can
be counted later.
