# Billing (purchase, retail sale) and Wholesale

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [billing.hi.md](billing.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

While a bill is being typed:

- **Line amount** (BF-LINE) = kg × rate, rounded to the rupee.
- **Bill total** (BF-TOTAL) = the sum of the lines.
- **Labour** (BF-LAB) = labour rate × heavy packets (above 30 kg by default),
  unless typed by hand. **Payable** (BF-PAYABLE) = bill total − labour.
- **Cash / Online / Due** (BF-SPLIT): must add up to the payable (purchase) or
  total (sale) within ₹1, or the bill is not saved. A tick fills the whole
  amount; "Rest → Due" puts what is left in Due.
- **Wholesale profit** (WS-PROFIT) = total − cost (kg × the item's current
  average cost) − expenses. Shown as "—" when an item's cost is not known (never
  bought, no opening stock).
- **A line typed but not added** (BF-PENDING): Save or Print never drops it. A
  complete line (item, rate, weight) asks "Add this line and save" or "Discard
  line and save"; a half-typed one is named and the bill waits.
- **Share draft (not saved)**: sends the bill on the form to WhatsApp without
  saving it; the message itself says "DRAFT, not saved". Save first to record it.
- **Print** saves the bill, then prints it. With no printer connected the
  receipt is only shown as a picture, and the message says "Not printed".
- "Save draft" keeps an unfinished bill; an unsaved bill is offered back at the
  next start. If that bill was saved meanwhile, Restore (or loading the draft)
  offers to open the saved bill instead of saving it again; an unsaved edit goes
  back on its bill, and if the bill changed since (a payment or an edit) the app
  first asks, showing both totals (BF-RESTORE).
- **Voice** (VB-1; off until switched on in Settings › Voice billing): tap 🎤 and
  say the item, weight and rate. The app shows what it heard and fills the line
  only after OK; voice never adds to the bill or saves. See
  [voice-billing.md](../voice-billing.md).
