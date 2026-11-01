# Voice billing (#81, #131)

Status: a minimal, safe first version is in the app, **off by default**. It needs
two more changes before it works anywhere (see "What is still needed").

## What it does

Settings › **Voice billing** (per device, off until switched on). When on and the
device has a speech engine, Billing shows a 🎤 button on the purchase and the
retail sale form. One tap:

1. listens once (the language follows the app: Hindi `hi-IN`, English `en-IN`);
2. reads the item, weight and rate from what was heard (`www/js/utils/voice-parse.js`,
   spec VB-1 in [calculations.md](calculations.md));
3. shows a check dialog: what was heard, and the item / weight (kg) / rate (₹) it
   found, or "not heard";
4. only after **OK** puts them in the form's Item, Rate and Weight boxes.

Voice never taps Add to Bill and never saves: the user checks the line, taps Add
to Bill, then Save, as when typing. It refuses to switch the item while weights
for another item are already entered (they would move to the spoken item). Nothing
heard is stored, logged or sent anywhere by the app.

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
warns and the user types them. More numbers than a weight and a rate are flagged too.

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

**Security header.** #198 (#89) sends `Permissions-Policy: microphone=()` on the
web, which blocks the microphone for the site, and [security.md](security.md)
said the app has no voice billing. A header can't depend on the setting. Until it
allows `microphone=(self)`, the web app sees the policy (`document.featurePolicy`)
and treats voice as not available (the setting is greyed out with "Not available
on this device"). The header does not reach the Android app (it serves `www/`
from the APK).

## What is still needed

| Change | Why | State |
|---|---|---|
| `Permissions-Policy: microphone=(self)` on the app site, `docs/security.md` updated | The web / PWA (Chrome) can use the mic for voice | separate PR, security review |
| `@capacitor-community/speech-recognition` 7 + `RECORD_AUDIO` in the Android manifest | The Android app gets a recogniser (the WebView has none) | separate PR, review; then a new APK |

Both are safe while the setting is off: no page asks for the microphone unless the
user switches voice on and taps 🎤.

## Not built yet (from #81 and #131)

- #81: spoken readback (A1), several items in one sentence (A2), customer-name
  dictation (A3), the wake word (A0, needs a Picovoice key), Hindi number words
  above 99 except hundreds.
- #131: continuous dictation, "undo", edit a row by voice, a transcript strip, a
  beep, counting missed phrases (C13, through the local usage counters of #136),
  and the Android App Actions shortcut ("Bill banao").
- Quintal (100 kg) as a weight word; rates per quintal.

Recommendation: ship the two pending changes, test on a real phone with the shop's
own items (Hindi and English, noisy shop, with and without internet), and only then
add readback and several items per sentence. Keep the check-before-fill step: voice
fills, a person adds and saves.
