# Voice billing (#81, #131)

Status: in the app, **off by default**: one or several bill lines per sentence,
the customer's name and a spoken readback (#81 A1–A3). The web header (#266) and
the Android recogniser (#267) are in, so it can run in Chrome and in the Android
app; it still needs a test on a real phone (see "What is still needed").

## What it does

Settings › **Voice billing** (per device, off until switched on). When on and the
device has a speech engine, Billing shows a 🎤 button on the purchase and the
retail sale form. One tap:

1. listens once (the language follows the app: Hindi `hi-IN`, English `en-IN`);
2. reads the customer's name and each line's item, weight and rate from what was
   heard (`www/js/utils/voice-parse.js`, spec VB-1 in [calculations.md](calculations.md));
3. shows a check dialog: what was heard, the customer, and the item / weight (kg) /
   rate (₹) found for each line, or "not heard", and reads it back aloud;
4. only after **OK**: one line goes in the form's Item, Rate and Weight boxes;
   several lines are added to the bill, each ticked line through the form's own
   Add to Bill (with its bag-weight and rate checks), in spoken order; the
   customer's name, if ticked, goes in the Customer box.

Voice never saves. One line: the user checks it, taps Add to Bill, then Save, as
when typing. Several lines: the user unticks any wrong line in the dialog (a line
missing its weight or rate can't be ticked), then checks the bill and saves. If a
check stops a line (the user taps Fix), that line stays in the form, the later
lines are not added, and the message says how many were. Voice refuses to switch
the item while weights for another item are already entered (they would move to
the spoken item), and adds no lines while a weight is typed or entered but not
added. Nothing heard is stored, logged or sent anywhere by the app (a phrase not\nunderstood is counted on the phone by a hash only, see tier B below).

**Several lines (A2).** "गेहूं 50 kg 25 रुपये, सरसों 30 kg 55 रुपये": lines are split
at "aur" / "और" / "and" / "phir" / "फिर", a comma, a full stop or "।", or between two
items said with nothing between them (cut where both sides read best as a line,
"10 kg aloo 30 rupees 5 kg pyaaz 25"). A part that names no item stays with the
line before it, so "one hundred and fifty kg" and "aloo 10 kilo aur 30 rupaye" stay
one line.

**Customer (A3).** "customer" / "ग्राहक" / "naam" / "नाम" / "party" / "kisan" and then
up to three words ("ग्राहक का नाम रमेश", "customer name is Mohan Lal"), ending at a
number, an item, a unit or a line break. A name already in the form's customer
list is used with its spelling. The dialog says which typed name it would replace;
untick it to keep that one. Said alone ("customer Suresh"), only the name is filled.

**Readback (A1).** The dialog reads back what was understood with the browser's
`speechSynthesis` in `hi-IN` or `en-IN` ("Customer Ramesh. Wheat, 50 kg, 25 rupees
per kg"; in Hindi with the Hindi item name), and stops when the dialog closes, so
the next 🎤 doesn't hear it. Its **Read aloud** switch mutes it on this device
(`aadhat.voiceReadback`; on by default). It uses only a voice on the device
(`localService`), never a network voice such as Chrome's "Google …" voices, which
would send the text (names, items, amounts) to a server. With no such voice for the
language, or no `speechSynthesis` at all (the Android System WebView often has none
or lists no voices), nothing is read aloud, the switch is hidden and the dialog works
the same.

Understood: digits (also Devanagari ०–९), Hindi number words 1–99, सौ / hundred,
हज़ार / thousand, आधा / half (½), पाव / quarter (¼), डेढ़ (1½), ढाई (2½), साढ़े (+½), सवा (+¼),
पौने (−¼; "sava kilo" = 1.25 kg), English number words; a final "do" / "दो" ("give") is not 2;
weight words kg / kilo (also in Devanagari), and grams as kg (500 gram = 0.5 kg,
1 kilo 500 gram = 1.5 kg); rupee words and "का" / "ka" after a rate, "at" / "₹" /
"rate" / "भाव" before it. Numbers without such a word are weight first, then rate.
"per kilo" / "प्रति kg" and "kilo ka 30" make a rate. Items match by English or Hindi name
(archived items never). A number with another unit (quintal, bori, bag, packet…)
or said as a total ("for 300", "10 kilo ke 300") is never used, and then the
line's unmarked numbers and a rupee-only rate are not guessed either: the dialog
warns and the user types them (also "300 rupaye ke 10 kilo", "10 kilo 300 mein",
"60 rupaye mein 2 kilo"; and
"100 rupaye ka chawal" with no weight, an amount to buy). More
numbers than a weight and a rate are flagged too, and so is a rate more than 3×
above or below every rate kept for that item (likely a total).

## Tier B (#131): correct, transcript, undo, beep, missed phrases

All on the phone: no new service, permission or Firestore read.

- **Correct a line.** Each line in the check dialog has a **Correct** button (keyboard
  reachable, `aria-expanded`) that opens boxes for its item, weight (kg) and rate,
  filled with what was heard. A change shows in the row at once; a line that was
  missing its weight or rate becomes tickable once both are typed. OK uses the
  corrected values (still through the form's own checks).
- **Transcript.** Under 🎤 a line (`role="status"`, `aria-live="polite"`) shows
  "Listening…", then what was heard and what came of it (check it, cancelled, filled,
  lines added, not understood, undone). It stays until the next listen; it is shown
  only while voice billing is on and is never stored.
- **Undo.** Each voice change on a form (lines added, the customer, item, rate and
  weight boxes) is kept on that form, the last 10 (`utils/voice-undo.js`).
  **Undo voice** under 🎤, or saying only "undo" / "wapas" / "pichla hatao" /
  "वापस" / "पिछला हटाओ" / "ग़लत" (`isUndoCommand`), takes back the last one: it
  removes the lines it added and puts the boxes back, but only what is still as voice
  left it. A line removed or edited since, or a box typed over, is kept, and the
  message says so. It waits (and says so) while the bill is saving, and puts the
  item and rate back only when no weights are entered and no bill line is being
  edited (those weights would be billed as the old item). Saving or clearing the
  bill ends its voice changes, so Undo is never offered across bills. A voice
  result is not applied while the bill is saving either.
- **Beep.** Settings › Voice billing › **Beep after listening** (per device,
  `aadhat.voiceBeep`, off by default): a short high tone when something was
  understood, a low one when not (Web Audio, made on the phone).
- **Missed phrases (C13).** A sentence in which nothing was understood counts
  `voice.miss` and `voice.miss.<8 hex>` in the local usage counters of #136
  (Settings › Usage on this phone; 90 days, never sent). The 8 hex digits are the
  start of an HMAC-SHA-256 (Web Crypto) of the lower-cased words, keyed with a random
  salt made once on this phone (`happa.voicePhraseSalt`, never exported or sent), so a
  phrase that keeps failing shows as one repeated code on this phone, and the code
  can't be turned back into the words; the words themselves are never kept (Q75). `voice.undo` and
  `voice.edit` count undos and corrected lines.

## Findings (validated 1 Nov 2026)

**Where the "staging" code is.** In the archived private repo
`DDancingDeath/AadhatManagementApp-staging` (read only), `main` branch:
`www/js/modules/voice-billing.js` (802 lines), `docs/VOICE_BILLING_V2.md`, tests
`www/js/__tests__/voice-billing.test.js` and `voice-settings.test.js`, mic buttons
in `www/templates/billing.html`. Commits: V1 `56e230f`, V2 Tier A `d827e1c` (A5
settings), `ca19a4f` (A1 spoken readback), `25ed551` (A2 several items), `3462d6f`
(A3 customer name). Nothing of it was ever in the production repos: in happa (all
143 branches) and the old `AadhatManagementApp` (all 49 branches)
`git log --all -S SpeechRecognition` and `-S RECORD_AUDIO` find nothing.

**How it worked.** The browser Web Speech API (`webkitSpeechRecognition`, `hi-IN`)
plus `speechSynthesis` for the readback; a regex parser. It filled the form **and
auto-added** (weight chip, and in a several-item sentence each line to the bill),
with "add to bill" / "जोड़ दो" voice commands. A4 (Hindi 11–99) and A6 (confirm
before commit) were planned, not built.

**It never worked in the Android app.** The Android System WebView (what Capacitor
runs in) has no working Web Speech API: `webkitSpeechRecognition` is missing or
does nothing there (Chromium issue 41172064; it works only in the Chrome browser).
Staging's manifest also never had `RECORD_AUDIO` (its C12 item was open). So the
app needs a native recogniser: `@capacitor-community/speech-recognition` (MIT,
v7 for Capacitor 7) wraps Android's `SpeechRecognizer`; its own manifest adds
`RECORD_AUDIO` and the `android.speech.RecognitionService` `<queries>` entry, and
it asks for the microphone at runtime.

**Hindi.** Yes: both Chrome (`hi-IN`) and Android's recogniser (Google) handle
Hindi and mixed Hindi-English well; Google usually writes numbers as digits.

**Offline.** Chrome's Web Speech API sends the audio to Google's servers: online
only. Android's recogniser works offline only if the phone has Google's offline
speech pack for that language (Settings › Google › Voice › Offline speech
recognition); otherwise it needs the internet too. The app shows "Voice needs the
internet here" when the engine says so; typing always works.

**Privacy.** The audio goes to the phone's or browser's speech service (usually
Google), as with the keyboard's mic. The app keeps no audio and no text; the
setting's hint says so.

**Security header.** #198 (#89) first sent `Permissions-Policy: microphone=()` on
the web, which blocked the microphone for the site. #266 changed it to
`microphone=(self)` on the app site only (`firebase.json`; frames, other sites and
the redirect-only sites still get none), and [security.md](security.md) says why.
The app still reads the policy (`document.featurePolicy`, `www/js/ui/voice-mic.js`):
where a policy blocks the microphone, voice counts as not available (the setting is
greyed out with "Not available on this device"). The header does not reach the
Android app (it serves `www/` from the APK).

## What is still needed

| Change | Why | State |
|---|---|---|
| `Permissions-Policy: microphone=(self)` on the app site, `docs/security.md` updated | The web / PWA (Chrome) can use the mic for voice | Done (#266, 1 Nov) |
| `@capacitor-community/speech-recognition` 7 + `RECORD_AUDIO` in the Android manifest | The Android app gets a recogniser (the WebView has none) | Done (#267, 1 Nov); in APKs built since |
| A test on a real phone in the Android app: Hindi and English, a noisy shop, with and without internet, the microphone prompt, several lines in one sentence, a customer's name, whether the readback speaks | #81's "works in the Android WebView with the mic prompt" item; nothing above was tried on a phone | Owner, open |

Both changes are safe while the setting is off: no page asks for the microphone
unless the user switches voice on and taps 🎤.

## Not built yet (from #81 and #131)

- #81: the wake word (A0, needs a Picovoice key), Hindi number words above 99
  except hundreds; a native text-to-speech plugin if the Android app turns out to
  have no voice for the readback.
- #131: continuous dictation, editing a row by voice ("line 2 rate 30"), and the
  Android App Actions shortcut ("Bill banao", a native `shortcuts.xml` change). Undo,
  correcting a line in the dialog, the transcript strip, the beep and counting missed
  phrases are in (above).
- Quintal (100 kg) as a weight word; rates per quintal.

Recommendation: test on a real phone with the shop's own items (Hindi and English,
noisy shop, with and without internet, one and several lines, the readback) before
anyone relies on it. Keep the check-before-fill step: voice fills or adds only
after OK, and a person saves.
