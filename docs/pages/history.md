# History

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [history.hi.md](history.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

Every saved bill, newest first, with its total, paid and due. Bill details show
the lines, labour and payable, how it was paid, later payments, write-offs and
every edit (who, when, why). A bill can be **voided** (with a reason) within the
role's edit window; only the owner deletes, and only a voided bill. A void needs no
owner approval, but one by anyone except an owner shows on the owner's Today (Day report,
medium) with who voided it and the reason, and stays in the audit log.
A bill that stored no total shows **—** instead of ₹0, and a date the app can't
read shows **Date?** next to it.
**Edit** first reads the bill again from the server: if it was changed on another
phone (a payment, an edit or a void) the app asks before loading the latest copy.
