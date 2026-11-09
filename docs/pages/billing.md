# Billing (purchase, retail sale) and Wholesale

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [billing.hi.md](billing.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

While a bill is being typed:

- **Customer / supplier name**: typing lists the names already on the bills on this phone
  (purchases for a supplier, retail sales for a customer), newest first, with what is open
  on them, the same amount as the "Already owes" line (PARTY). Latin and Hindi spellings
  find each other ("ramesh" finds "रमेश कुमार"). Tap a name, or pick it with ↓ ↑ and Enter
  (Esc closes the list). Nothing extra is read from the internet. After you leave the
  field, a new name close to a known one ("Seeta Devi", "Sita Devi Ji") shows "Did you mean
  Sita Devi?": **Use** takes the known name, "Yes, it's right" keeps yours. It never stops
  the bill.
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
- **A very different rate** (BF-RATECHECK): a rate at least 5× today's rate of the
  item on the Rates page, or at most ⅕ of it, asks before the line is added and shows
  the money: "15 kg × ₹260.00 = ₹3,900. Today's rate ₹26.00 would give ₹390."
  **Fix rate** is the default; "Yes, ₹260.00 is right" adds the line and records who
  confirmed it. The owner sees every confirmed rate on Today's Day report and in Anomalies.
- **A very heavy bag** (BF-BAGCHECK): one bag (purchase) or packet (retail) weight above
  100 kg asks when it is added: "Bag weight 485 kg — usually under 100 kg. Did you mean
  48.5?" **Fix weight** is the default; "Yes, 485 kg" adds it and records who confirmed
  it. A retail weight typed without packets is the line's total and wholesale kg are
  totals: they are not asked. The owner sees every confirmed bag on Today's Day report and in Anomalies.
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
  say the item, weight and rate. Several lines can be said in one go ("… and …"),
  and "customer" before a name fills the customer. The app shows what it understood
  (and reads it aloud, unless muted in the dialog) and acts only after OK: one line
  fills the form, several ticked lines are added to the bill. Voice never saves. See
  [voice-billing.md](../voice-billing.md).
