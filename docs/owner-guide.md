# happa: owner guide

A short guide for the owner: what each page shows, how its numbers are worked
out, and what to do when something goes wrong. Plain words only; the exact
definitions are in [calculations.md](calculations.md) (the codes in brackets,
like T1 or C7, are its spec IDs). Hindi version: [owner-guide.hi.md](owner-guide.hi.md).

Any change to what a page shows or does updates that page's file in `docs/pages/`
(English `<page>.md` and Hindi `<page>.hi.md`) in the same pull request, as the
checklist in AGENTS.md asks.

---

## 1. Words used everywhere

- **Bill total** (BILL-TOTAL): what a bill is worth. A purchase is worth its
  total **after labour** is taken off; a sale is worth its sale total.
- **Lines total**: what the lines of a bill come to before
  labour. It is the "Total" on the printed slip and in the WhatsApp text; the
  payable comes after it.
- **Paid at save** (BILL-AT-SAVE): the cash and online typed when the bill was
  saved. Money paid later is a **due payment** (DUE-PAY) and counts on the day it
  is paid, not on the bill's day.
- **Due** (BILL-DUE): what is still owed on a bill. Never below 0; 0 when the
  bill is cleared, written off or voided.
- **Voided bill** (VOID): a bill cancelled with a reason. It stays in History,
  marked Voided, and counts nowhere: not in stock, dues, cash or any report.
- **Old-app due** (OPENING): a due carried over from the old app. It counts in
  dues only, never in a day's or month's sales or purchases.
- **Business or personal expense** (EXP-KIND): an expense is personal only when
  it is tagged personal. Untagged ones are business.
- **Cash or online expense** (EXP-MODE): picked when the expense is entered. Only
  cash expenses leave the drawer. Old expenses with no mode count as cash.
- **Average cost** (AVG-COST): the cost per kg of an item, averaged over what was
  bought (weighted by kg). A sale takes stock out at the average cost of that
  moment; this is the **cost of goods sold** (COGS).
- **Rounding** (MONEY-ROUND): rates keep paise; every money amount the app saves
  is a whole rupee (₹12.50 becomes ₹13). Cash counted in the drawer keeps paise.
- **A day** (DAY) is the Indian calendar day, midnight to midnight. A **month**
  starts on the 1st, a **year** on 1 January.

---

## 2. Page by page

Each page has its own short file in `docs/pages/` (English and Hindi): what it shows and how each number is worked out.

- [Today](pages/today.md)
- [Billing (purchase, retail sale) and Wholesale](pages/billing.md)
- [History](pages/history.md)
- [Outstanding (and Wholesale › Outstanding)](pages/outstanding.md)
- [Stocks](pages/stock.md)
- [Cash (the drawer)](pages/cash.md)
- [Expenses](pages/expenses.md)
- [Money (Profit, Cash, Spending, Worth)](pages/money.md)
- [Insights (To do, Items, Parties, Seasons)](pages/insights.md)
- [Statements](pages/statements.md)
- [Rates](pages/rates.md)
- [Rentals](pages/rentals.md)
- [Settings, Admin, App health](pages/settings.md)

---

## 3. Runbook: what to do when

### Every day

1. Open cash in the morning (Cash › Open cash). It needs internet.
2. Before closing, look at **Today**: the "All anomalies · N pending" line and
   the labour card.
3. Count the drawer and close the day (Cash › Close cash & end day). If it is
   more than ₹1 off, check the day's cash bills and expenses before saving.
4. The header pill should say **Synced** on every phone.

### Every week

- **Outstanding**: call parties who owe for more than 30 days (Insights › To do).
- **Anomalies**: clear the pending ones.
- **Diagnostics › Number checks**: all should pass.
- Days left "Not counted" on Cash: count them if the cash is still known.

### The printer is not printing

1. Settings › Common › **Bluetooth Printer**: is the printer turned on, paired in
   Android Bluetooth settings, "Enable Bluetooth Printer" ticked and the printer
   picked and connected? Tap **Test Print** (it shows once the printer is
   connected).
2. "May have printed": the printer did not confirm. **Check the paper before
   printing again**, so the bill is not printed twice.
3. Still nothing: turn the printer off and on, then connect it again from
   Settings › Common › Bluetooth Printer.
4. Android stops apps in the background to save battery. Open Android Settings ›
   Apps › happa › Battery and choose **Unrestricted** (or "Don't optimise"), so the
   printer link is not cut.
5. The bill is saved even when printing fails: its picture opens with **Print**,
   to try again once the printer is on (3 tries in all), or reprint later from History.
6. "Bluetooth permission needed" banner (Android 12 and newer): tap **Allow**, or
   allow **Nearby devices** in Android Settings › Apps › happa › Permissions.

### The phone's clock is wrong

Once a day, at start, the app compares the phone's clock with the server's. When
it is off by 9 minutes or more a red banner says by how much: set the date and time
to automatic in Android settings, then tap **Check again**. Until then bills get the
phone's wrong time and payments are refused. Bill details show both times: **Entered
on the phone** and **Saved on the server** (far apart: a wrong clock, or a bill saved
offline and sent later).

### Changes are not syncing

- The header pill shows **Offline** or "N changes waiting to sync". Saved bills are
  kept on the phone and sent when the internet is back. Do not enter them again.
  Offline, it also says how old the figures are ("data as of 2:05 pm").
- In History and Expenses a row this phone has not sent yet shows **Waiting to sync**,
  and **Saved** once it reached the server.
- Close cash asks first while this phone still has changes waiting: other phones
  don't see them yet.
- "Saving… not confirmed on this phone yet": look in History before typing the
  bill again.
- "Save failed — storage full": free space on the phone; until then nothing new
  is saved.
- "Daily free data limit reached": the free plan's reads or writes for the day are
  used up. Bills saved now stay on the phone and sync after the limit resets (about
  12:30–13:30 IST). Tell the developer if it happens often.
- If one phone stays stuck for hours, close and reopen the app with internet on;
  the waiting changes are sent first. Don't clear the app's data while changes are
  waiting: they would be lost.

### The cash does not match

1. Cash › the day's details: compare cash sales, cash purchases, cash expenses and
   due payments with the bills.
2. Common causes: a bill saved as cash that was paid online (edit the bill with a
   reason), an expense saved as cash that was online, a due payment recorded on the
   wrong day, a "No bill — old udhaar" entry missing.
3. Close with the real count anyway: the difference is saved and shown as short or
   extra.

### A bill was entered twice

1. **Anomalies** flags a "possible duplicate bill" only when the same party, lines
   and total are saved again within 2 minutes (the window is in Settings › Aadhat ›
   bill checks).
2. Otherwise look in History: filter by the party and compare the totals and
   times.
3. Open the extra bill and **Void** it with a reason ("entered twice"). A bill
   that already has later payments can't be voided: ask the developer.

### A phone was lost, or someone left

1. Someone else: **Admin › Users › Delete** them. They can't sign in or register
   again (Restore brings them back as a pending registration). Their saved bills
   stay.
2. Your own phone: change your password at once on another phone (Settings ›
   Common › Account › **Change password**, then open the emailed link).
3. Anyone else who was signed in on that phone: Admin › Users › **Reset Password**
   emails them a link; the password changes only when they use it.

### Backups and restore

- Backups run by themselves once a day in the early afternoon (about 13:45 IST,
  sometimes hours later) and a full one every Sunday; they are kept for 60 days and
  checked automatically, and a monthly test restores one into a test database. Two failed days in a row open an alert for the developer
  ([tools/backup/README.md](../tools/backup/README.md)).
- A restore into the live app is done by the developer from the latest good
  backup. Tell them the date and time the data was last right. Whatever was entered
  after that backup is lost and has to be entered again.
- **Admin › Data › Check a backup**: pick a backup file on the phone (the developer
  can give you the unlocked nightly file) and the app checks it is complete and how
  old it is, without changing anything. Do it at least once a month: Today reminds you
  (REM-3) when no check was recorded on this phone for 30 days. The card also lists
  the restore steps; the app itself never restores.
- Admin › Data "Clear All Data" works only on the website. It first saves a backup
  file and deletes nothing unless that file was saved.
