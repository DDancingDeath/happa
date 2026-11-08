# Outstanding (and Wholesale › Outstanding)

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [outstanding.hi.md](outstanding.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

| On screen | How it is worked out |
|---|---|
| Purchase dues per party (O1) | Sum of the due on that supplier's purchases. |
| Sale dues per party (O2) | Sum of the due on that customer's sales. Sales shows **All** (retail and wholesale), **Retail** or **Wholesale**; in All each bill has a Retail / Wholesale tag. Wholesale › Outstanding still lists the wholesale dues too. |
| Payables / receivables totals (O3, O4) | Sum over all parties. The All total is the same as "To receive" on Money › Worth. |

Recording a payment (DUE-CHECK): cash and online in whole rupees, never more than
the due. Names match with case and extra spaces ignored (PARTY).

A payment is recorded once (DUE-PAY). If the phone gets no answer, it checks the bill and says
whether the payment was recorded; it does not ask to enter it again while it may be saved. The
same amount entered again on that bill is never recorded twice (after 10 minutes the app asks
whether it is another payment). If another phone recorded a
payment on the bill at the same moment, this one is not recorded: the message shows the due now.

A due that will never come is taken off with **Write off as bad debt** (on bills to receive), with a
reason: the bill shows it as written off, the customer's statement keeps it, and Money counts it as a
bad debt that lowers the profit (M5). A due never just disappears: it goes down only by a payment, a
write-off or a recorded bill edit, for the owner too (owner decision, 8 Nov 2026).
