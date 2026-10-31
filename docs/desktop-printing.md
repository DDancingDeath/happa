# Desktop printing spike (#133)

**Question:** can the web app on a Windows computer (Chrome or Edge, PWA or a
tab) print to the shop's Bluetooth receipt printer, and what's the fallback?
The answer decides whether a desktop shell such as Electron is needed (#144).

**Status:** the code and a test page are ready. The real-printer result is
still needed from the owner (checklist below). Nothing in the app uses this yet.

## What the browser offers (desk research, Nov 2026)

| Way | Browsers | Notes |
|---|---|---|
| **Web Serial** to a Bluetooth printer (SPP / RFCOMM) | Chrome and Edge 117+ on Windows, macOS, Linux and ChromeOS | Chrome lists paired Serial Port Profile devices itself, with no COM port mapping needed, and also lists the Windows "outgoing" COM port. Chrome 130+ adds `connected` and connect/disconnect events. Not in Firefox or Safari. |
| Web Serial on Android | Chrome 138+ (SPP) | Not needed: the APK prints through the Cordova plugin (docs/printing.md). |
| Web Bluetooth | Chrome, Edge | BLE only. Most cheap 58/80 mm printers are Bluetooth Classic, so it isn't usable. |
| **Windows print dialog** (`window.print()`) | every browser | Needs the printer installed in Windows with a driver. Many of these printers ship a "POS-58/80" driver that prints to the Bluetooth COM port. Paper size and margins must be set once. |

Sources: Chrome for Developers, "Serial over Bluetooth on the web" (Chrome 117)
and "Bluetooth RFCOMM updates in Web Serial" (Chrome 130).

## Finding: our own headers block Web Serial

`firebase.json` sends `Permissions-Policy: … serial=() …` on every path
(#89 / PR #198). With that header, `navigator.serial.requestPort()` is refused
on myhappa.web.app however the browser behaves. This PR relaxes it to
`serial=(self)` **only for `/spike/**`**, so the test page can run. A test in
`tests/ci/security-headers.test.js` checks that it's the only exception.
Shipping Web Serial printing in the app itself needs `serial=(self)` on the app's
pages: a security-header decision for the owner/reviewer.

## What's built

- **`www/js/services/web-serial-transport.js`:** a transport with the same
  shape as `cordovaTransport()` (`available`, `canCheck`, `connect(id, onDrop)`,
  `disconnect`, `isConnected`, `write`, `list`), plus `request()` for the browser
  picker, which needs a click. `PrinterLink` uses it as is, so the timeouts, the
  one-at-a-time queue and the "may have printed" handling are the same as on the
  phone. It's a lazy asset: the app never loads it.
- **`/spike/serial.html`:** a test page that isn't linked anywhere, needs no login
  and saves nothing. It draws the app's own test bill (the same renderer and the
  same `GS v 0` raster bytes as the phone) and offers:
  1. **Choose printer**, then **Print test slip** over Web Serial;
  2. **Print with Windows**: the slip as a 58 mm image in the print dialog;
  3. a log (browser, port info, bytes, time, outcome) to paste into the issue.
- Checked in headless Chromium with a fake serial port. I can't test a real printer.

## Decision tree for #144 (after the owner's test)

- **Web Serial prints:** no Electron needed.
  1. Next PR: in `PrinterService`, pick `webSerialTransport()` when there's no
     Cordova plugin and `'serial' in navigator`.
  2. Settings › Printer gets **Choose printer** (the picker). The port is
     remembered by Chrome (`getPorts()`), so later prints don't prompt.
  3. Set `serial=(self)` for the app.
  4. Remove `/spike/`.
- **Only the Windows dialog works:** add a **Print** button to the bill preview on
  desktop (`window.print()` of the slip image). It's slower (a dialog each time),
  but needs no new permission.
- **Neither works:** an Electron shell (node-serialport) would be needed. It costs
  code signing and an installer. Otherwise desktop keeps the image preview and
  phones do the printing.

## Things to expect

- A printer that's off: on Windows, opening the outgoing COM port can take several
  seconds to fail. `PrinterLink` gives up after its connect timeout (8 s per
  try in Test Print mode) and nothing is sent.
- `write()` resolves when Windows has taken the bytes, not when the paper is
  out. A link that drops mid-print is "may have printed", as on the phone.
- Chrome asks once per site to use the port.

## Owner checklist (Windows PC, about 10 minutes)

1. Windows Settings › Bluetooth & devices: pair the shop printer (PIN usually
   0000 or 1234).
2. In **Chrome or Edge**, open https://myhappa.web.app/spike/serial.html. Step 1
   should say the browser can talk to the printer directly.
3. Click **Choose printer**. Pick the printer: it may be listed by name or as
   "Standard Serial over Bluetooth link (COMx)". Then click **Print test slip**.
   Does a test bill come out? Is it sharp, is Hindi readable, and is it the full
   width?
4. Click **Print test slip** again: it should print once, quickly.
5. Switch the printer off and click **Print test slip**: the log shows a failure
   within about 10 to 25 s, and nothing prints later.
6. Only if step 3 failed: install the printer's Windows driver and click
   **Print with Windows**. Choose the printer, paper 58 mm, margins none.
7. Copy the log at the bottom into issue #133, with what came out of the printer
   and the Windows and Chrome versions.
