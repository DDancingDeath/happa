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
- "Save draft" keeps an unfinished bill; an unsaved bill is offered back at the
  next start.
- **Voice** (VB-1; off until switched on in Settings › Voice billing): tap 🎤 and
  say the item, weight and rate. The app shows what it heard and fills the line
  only after OK; voice never adds to the bill or saves. See
  [voice-billing.md](../voice-billing.md).
