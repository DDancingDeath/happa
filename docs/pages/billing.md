# Billing (purchase, retail sale) and Wholesale

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [billing.hi.md](billing.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

Managers and members open the app on Billing; the owner opens on Today. A reload keeps the page you were on, so a bill being typed stays.

While a bill is being typed:

- **Customer name** (Purchase and Retail sale both say "Customer"): typing lists the names already on the bills on this phone
  (purchases on Purchase, retail sales on Retail sale), newest first, with what is open
  on them, the same amount as the "Already owes" line (PARTY). Latin and Hindi spellings
  find each other ("ramesh" finds "रमेश कुमार"). Tap a name, or pick it with ↓ ↑ and Enter
  (Esc closes the list). Nothing extra is read from the internet. After you leave the
  field, a new name close to a known one ("Seeta Devi", "Sita Devi Ji") shows "Did you mean
  Sita Devi?": **Use** takes the known name, "Yes, it's right" keeps yours. It never stops
  the bill.
- **Contact button** (next to the name): picks a name from the phone's contacts. In the Android
  app the phone asks once for the Contacts permission on the first tap; if it was refused, the
  app says where to allow it (phone Settings › Apps › this app › Permissions › Contacts). In
  Chrome on Android it opens Chrome's contact list. Elsewhere (computer, iPhone, other browsers)
  the tap says picking contacts isn't available and puts you in the name field. The field is filled
  as **Name - Number** (e.g. "Ramesh - 9876543210": the first mobile number, an Indian number as 10
  digits; the name alone when there is no number, the number alone when there is no name), and that
  is the name saved on the bill. Older bills under the plain name still show: the "Already owes" line
  falls back to them, marked "(older bills)", and the suggestions and "Did you mean" offer the plain
  name; nothing is merged by itself. Hidden for roles with
  Phone contacts off (Settings › Roles & access).
- **Line amount** (BF-LINE) = kg × rate, rounded to the rupee.
- **Bill total** (BF-TOTAL) = the sum of the lines.
- **Labour** (BF-LAB) = labour rate × heavy packets (above 30 kg by default),
  unless typed by hand. **Payable** (BF-PAYABLE) = bill total − labour.
- **Cash / Online / Due** (BF-SPLIT): must add up to the payable (purchase) or
  total (sale) within ₹1, or the bill is not saved. "Fill" puts the whole
  amount in that row; "Rest → Due" puts what is left in Due.
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
- **The usual rate** (BF-USUAL): at Save a rate more than 2× (or under ½ of) the usual rate
  warns, always with the unit: "Wheat: ₹50/kg is 2.1× the usual ₹24/kg". The usual rate is the
  item's rate on the Rates page; only with none there, the middle rate of its last 10 bills (at
  least 3, leaving out voided bills and bills that already carry a rate warning), so one wrong bill
  never becomes "usual". The warnings of all lines show as one "Check rates" message.
- **A per-quintal rate** (BF-UNITSLIP): a rate 50–200× the usual one says "₹2,400/kg looks like a
  per-quintal rate — usually ₹24/kg" and offers **Use ₹24/kg** (at Add to bill it puts the rate in
  the box; on a bill line it changes that line). The bill's rate column says "Rate ₹/kg".
- **Share draft (not saved)**: the WhatsApp icon is always in the bottom row (with no lines yet it
  says "No items in bill"); it sends the bill on the form without saving it, and the message itself
  says "DRAFT, not saved". Save first to record it. Both say "Customer".
- **Save & print** saves the bill, then prints it. In the Android app with no printer to print on,
  it asks first: **Save only**, or Cancel to connect the printer in Settings. A print that fails
  after the save keeps the bill saved and shows the picture with Print to try again.
- **Back-dated**: a bill for another day than today shows "Back-dated: 12 Nov" beside the total
  (and on the date line), day and month always.
- **Numbers typed in Hindi**: digits typed on a Hindi keyboard (१२३) go into the boxes as 123.
  Cash, Online and Due show commas the Indian way (1,25,000) once you leave the box.
- **Last saved**: after Save a strip above the form shows the bill number, party, total and Due
  (or "saved on phone, not sent yet" offline) with **Print**, **WhatsApp** and **Open**, until the
  next save on that form (× hides it). Purchase, Retail sale and Wholesale have the same strip.
- **Undo**: removing a bill line (×), a weight chip or a draft, and **Clear**, show "Removed … · Undo"
  for about 6 seconds. Clear says what goes ("3 lines, ₹16,191 will be removed") and offers **Keep as
  draft**; it is last in the ⋯ menu, after a line, in red.
- **One message per problem**: a problem shows once, at its field or bill line (no toast over the
  form, no "2 problems" banner unless the problem has no field). Save then reads **Fix 2** in red and
  takes you to the first problem; it never looks disabled. Once anything is in Due, the name box
  says "needed if anything is in Due".
- **Each line once**: a line's bag / packet weights are one small line under the item ("3 packets:
  52.5 · 48 · 50.5"); tap the line to change it. Cash, Online, "Total paid / received" and Due
  always show, each with **Fill**; Retail's "Sale total" (always the same as Total receivable) is not shown.
  Labour reads "7 bags over 30 kg × ₹6 = ₹42" (the bill and the slip keep "6 × 7").
- **Drafts**: this form's drafts first, each with its lines and amount (or "1 weight, no lines yet")
  and the Customer; drafts with nothing in them are not listed. Drafts belong
  to the one who saved them.
- **Wholesale** uses the same form as Billing: the field names on the fields, Weight in kg, a tap on
  a line to change it, Notes behind **Add note** and the day behind **Change date**; Expenses and the
  profit are folded under **Expenses and profit**; the recent bills show only when there are some.
- **Share draft (not saved)**: sends the bill on the form to WhatsApp without
  saving it; the message itself says "DRAFT, not saved". Save first to record it.
- **Print** saves the bill, then prints it. With no printer connected the
  receipt is only shown as a picture, and the message says "Not printed".
- **Printer button** (top bar, next to the bell; Billing and Wholesale, Android app only): a dot shows the
  Bluetooth printer (green connected, amber connecting, grey saved but not connected, none when no printer is saved).
  A tap opens the printer controls of Settings › Printing & receipts in a sheet over the bill: switch on, status,
  saved printers (**Connect** with one tap), Scan, Test print, Disconnect. Closing the sheet leaves the bill as it was.
  The website has no Bluetooth printing, so the button is not shown there.
- "Save draft" keeps an unfinished bill; an unsaved bill is offered back at the
  next start. If that bill was saved meanwhile, Restore (or loading the draft)
  offers to open the saved bill instead of saving it again; an unsaved edit goes
  back on its bill, and if the bill changed since (a payment or an edit) the app
  first asks, showing both totals (BF-RESTORE).
- **A short form**: the bill's lines and "Total packets" show once a line is added; "Not split yet"
  shows only while Cash + Online + Due do not add up to the bill; Labour shows its working and amount only when
  switched on. Notes and "Print in bill" are behind **Add note** (open by themselves when the bill has a note).
  The bill is for today ("Today"); the owner can tap **Change date** to pick another day ("Back-dated: 12 Nov"). Save draft and Clear
  (which asks first when the bill has lines) are in the ⋯ menu beside Purchase / Retail sale; **Drafts** is there too, with
  its count, only when there are drafts (a number on ⋯ shows how many). Each field's name (Customer, Item, Rate,
  Weight) sits on the field's top edge and stays there after typing. On a phone the "Next bill no." hint is left out, and Save and Print are the same width. On every
  screen the Save / Print row starts with the bill's total: a short label (Payable / Receivable, 14 px) over the amount in large bold figures.
- **Voice** (VB-1, #498; off until switched on in Settings › Billing tools › Voice billing): **hold** 🎤
  and speak, let go when done (a quick tap listens to the first pause). Say the bill in any order, in one
  hold or several: the party ("Ramesh se", "customer Ramesh", "Ramesh ko"), lines ("gehun 10 kilo 25,
  chawal 5 kilo 30"), bag weights ("wheat bags 23, 24.5, 22 at 25"), "rate 26", the payment ("cash 500",
  "online 300", "baaki udhaar", "pura cash"), labour ("labour 60", "labour band"), "note …" and, for the
  owner, the day ("kal"). A **check sheet** shows everything understood, marks what is unclear, lets each
  part be changed or unticked, and **Hold to add more** adds to it. Only **Fill bill** puts it on the page,
  as typing would; voice never saves. A party is picked only when exactly one known party fits; otherwise
  the sheet asks. The small 🎤 in the Customer field (Purchase and Retail sale) (beside the contact button) listens for a
  name and lists the closest parties (any script: "रमेश" ~ "Ramesh Bhai") and "Use … as said". A heard
  line can be corrected in the sheet (**Correct**: item, kg, rate); what was heard stays in a line under
  🎤; **Undo voice** (or saying "undo") takes back the last voice change; Settings can add a short beep
  after listening. In the Android app the first press asks for the microphone. See
  [voice-billing.md](../voice-billing.md).
- **Photo of weights** (PW-1; Purchase only; hidden until the owner switches it on in
  Settings › Billing tools › Photo of weights): tap the camera button beside the weight box
  and photograph the handwritten weight sheet. The app reads the weights and shows them
  for checking: the photo with a numbered box on each weight, then the weights in the
  same order. Yellow ones were not clear; crossed-out ones are listed apart and left out.
  Each weight can be changed or removed and more can be added; the bag count and total
  are shown, and checked against a total or bag count written on the sheet. A bag over
  100 kg is asked as when typed (BF-BAGCHECK). **Add N weights** only puts them into the
  bag weights of the line: pick the item and rate, tap Add to bill and save as usual.
  Nothing is saved by the photo and the photo is not kept. Offline, or when the day's
  free photo reading is used up, the app says so: type the weights. See
  [photo-weights.md](../photo-weights.md).
