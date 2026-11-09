# Settings, Admin, App health

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [settings.hi.md](settings.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

- **Settings › Common**: language, appearance (Light, Dark or System, which follows the device; saved on this device) and the
  **theme**: Modern Minimal (the default), Vintage, Classic, Nordic, Nature, Premium, Dark or Midnight. Vintage, Classic
  and Premium use serif titles and figures for English; Hindi stays in the usual Devanagari letters. Tapping a theme previews it across the app;
  **Apply** saves it on this device and **Cancel** (or leaving Settings) goes back. Dark and Midnight are always dark.
  **Reset to default** goes back to Modern Minimal and System. Printed bills look the same in every theme. Then account (Change password), notifications,
  Bluetooth Printer (Test Print), install the app; in the Android app, **Crash reports** (off
  unless this phone's user turns it on: crashes and freezes then go to the shop's Firebase with the
  phone's details; the app adds no names or amounts, but an error message can hold text; docs/error-reporting.md says exactly what is sent); the owner's **Roles & access** (what each role may see, edit
  window in days). **Printed bill**: the bottom line, the bill's QR code, the bill language, print darkness
  and logo are the same on every phone; the owner, or a manager allowed in Roles & access, changes them.
  The printer and paper width stay on each phone.
- **Settings › Aadhat**: business name and UPI ID, labour rate and package
  weight, bill checks, bill numbers, opening stock.
- **Admin › Users**: approve, change role, Reset Password (emails the person a
  link), Delete (removes access; Restore brings them back as a pending
  registration).
- **Admin › Data › Bill dues: stored in one place** (owner): **Check bills** reads every bill once
  and says how many older bills keep their due in an old place; **Store the due** writes it in the one
  place the app uses. No amount on any screen changes (BILL-PAY); check that a recent backup is good first.
- **Anomalies**: bills that look wrong (a possible duplicate bill, a rate far off,
  a big cash gap…) and each mismatch the daily number checks found ("Number check: …", on
  its bill, item or cash day); tap "Mark OK" or "Mark fixed" on each.
- **Diagnostics › Number checks**: the always-true checks run on this phone's data
  (bill split, payments, dates, dues, drawer, stock).
- **Diagnostics › Audit logs**: CSV (in English) or Print / PDF of the entries listed;
  **Errors**: Export report (the errors with names, numbers and secrets removed, plus this
  phone's status) to send to whoever fixes the app. Both are written in the audit log.
- **Diagnostics › Status › Test error reports** (owner only): **Send a test error** records a test error
  through the app's error reports; it shows under Diagnostics › Errors. In the Android app with crash reports
  switched on it also goes to Crashlytics (an error that did not close the app), and **Send a test crash**
  closes the app on purpose after a confirm. With crash reports off, or not set up in that version of the app,
  it says so and offers no test crash (docs/error-reporting.md, "Check that reports arrive").
