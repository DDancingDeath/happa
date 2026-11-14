# Design system ("Bahi")

How the app's look is built: design tokens in layers, the component classes that read them, the
icons, the themes and how to add one, and the rules every UI change follows. The reasoning behind
it is the redesign direction (§3 design system, §4 themes); this page is what the code does now.

| What | Where |
|---|---|
| Tokens (Modern Minimal, the default theme) | `www/css/variables.css` |
| Other themes (tokens only) | `www/css/themes/<id>.css` |
| Theme registry, Appearance | `www/js/ui/themes.js`, `www/js/ui/theme.js` (ThemeManager) |
| Pre-paint theme boot | the inline `#themeBoot` script in `www/index.html` (its hash is in the CSP, `docs/security.md`) |
| Controls (buttons, fields, select, switch, segmented control, tabs, chips, tags) and the global element rules (touch, focus ring, iOS field size) | `www/css/forms.css` |
| Surfaces and feedback (panel, rows, metrics, hero, meter, notice, empty, skeleton, table, scrim, dialog, sheet, toast, tones) | `www/css/surfaces.css` |
| The app dialog and page dialogs (`.app-scrim > .app-dialog`, `.dialog-*`); the saving spinner | `www/css/charts.css`; `www/css/loading.css` |
| Icons | sprite at the top of `www/templates/navigation.html`, CSS in `www/css/icons.css` |
| Cascade order | `www/styles.css` (joined into `www/css/app.css` by `npm run build:css`): tokens and themes, then the component sheets (`icons`, `tables`, `tabs`, `toast`, then `forms`, `surfaces` and `loading` over them), then the app shell (`auth`, `hamburger`, `navigation`), then the pages, and `desktop.css` (≥1024 px layout) last. A page overrides a component in its own context; each component class is styled in one component sheet, not again in a page sheet |

## 1. Token layers

Components read only layers 1 and 2. A theme sets layer 1 and, where it is different, a few
layer-2 tokens. Nothing else changes per theme.

| Layer | What | Tokens | Set by |
|---|---|---|---|
| **1. Semantic** | Colours by meaning, elevation, focus | `--bg`, `--surface`, `--surface-2`, `--surface-3`, `--line`, `--line-strong`, `--ink`, `--ink-2`, `--ink-3`, `--ink-placeholder`, `--scrim`; `--accent`, `--accent-hover`, `--accent-strong`, `--accent-text`, `--accent-soft`, `--accent-line`; `--mode-sale`, `--mode-wholesale`, `--mode-rentals` (+ `-soft`); `--positive`, `--negative`, `--warning`, `--info` (+ `-soft`, `-line`), `--negative-fill`, `--warning-dot`, `--caution-soft`; the **inks** `--on-accent`, `--on-accent-strong`, `--on-mode-sale`, `--on-mode-wholesale`, `--on-caution-soft`; `--e1`…`--e3`, `--highlight`, `--focus`, `--state-hover` | every theme (a light block, and a dark block unless it is always dark) |
| **2. Component** | Shape and type roles (declared beside layer 1, on `:root, [data-theme]`); materials and button inks derived from layer 1 (on `:root, [data-theme], [data-mode]`) | `--r-2xs`, `--r-xs`, `--r-sm`, `--r-control`, `--r-md` (control + 2px), `--r-panel`, `--r-lg` (panel + 2px), `--r-chip`, `--r-sheet`, `--r-full`, `--r-round` (50%), `--rule-style`; `--font-ui`, `--font-display`, `--font-num`, `--font-hero`, `--w-regular`, `--w-strong`, `--w-display`, `--tracking-display`, `--title-style`, `--hero-nums`; `--page-bg`, `--panel-bg`, `--panel-border`, `--panel-shadow`, `--input-bg`, `--input-border`, `--bar-bg`, `--bar-border`, `--seg-track`, `--seg-on`, `--table-rule`, `--btn-primary-bg`, `--btn-primary-ink`, `--btn-primary-shadow`, `--btn-sale-bg`, `--btn-sale-ink`, `--btn-danger-bg`, `--btn-danger-ink`, `--toast-bg`, `--toast-ink`, `--toast-pos/-neg/-warn/-info`, `--preview-apply-line`, `--mode-purchase` | defaults in `variables.css`; a theme overrides only what makes it different |
| **3. Components** | `.btn`, `.field`, `.seg`, `.panel`, `.row`, `.notice` … (§3) | read tokens, never raw colours | base CSS only |

**Not per theme** (on `:root`): the type scale `--fs-caption|sm|body|lead|title|display|hero` (plus `--fs-input`, a fixed 16px for text fields so iOS does not zoom on focus),
`--lh-body`, `--w-label`, spacing `--sp-1…10`, `--gutter`,
`--section-gap`, `--row-h`, `--control-h(-sm)`, motion `--ease`, `--dur-1…3`, layers `--z-*` (below), edge stripes `--stripe` / `--stripe-sm` (`box-shadow: var(--stripe) <colour>`) and the validation rings `--ring-danger` / `--ring-warning`. Layouts are therefore
identical in every theme. Desktop (≥1024 px, `desktop.css`) sets `--control-h` 36, `--row-h` 44 and the desktop type scale (body 14, lead 16,
title 18, display 26, hero 30). Hindi (`html[lang="hi"]`) raises `--fs-sm` / `--fs-body` and `--lh-body`,
makes `--w-label` 400, and turns off a theme's italic titles and display tracking (`--title-style`, `--tracking-display`); the Android app (`html.platform-android`) uses weight 500.

**Layers (`--z-*`), low to high.** Use a token; a step inside a band is a `calc()` offset of the band's token, so
the stacking order stays exact. `ds-guard` counts any numeric `z-index`.

| Token | Value | Used by |
|---|---|---|
| `--z-base` | 1 | Billing's Fill tick box over its label |
| `--z-raised` | 2 | desktop Billing summary's sticky totals and actions |
| `--z-sticky` (`--z-menu`) | 5 | sticky page heads (Insights), the bill-check notice, a page's pop-up menu |
| `--z-popover` | 30 | the party name suggestions |
| `--z-nav` | 900 | desktop sidebar; the phone's canvas band under the app bar |
| `--z-appbar` | 950 | app bar (desktop), bottom tab bar; −10 Billing's action bar, +10 pull-to-refresh, +40 the phone app bar |
| `--z-drawer` (`--z-bell`) | 1000 | the old `.modal`, the bell; −1 the menu scrim (`.overlay`), +1 the phone side menu and the sync pill, +2 / +3 the notifications scrim / sheet |
| `--z-sheet` | 9000 | floating notices (printer permission, theme preview bar); −1 the update banner, +1 the clock notice |
| `--z-dialog` (`--z-auth`) | 10000 | page dialogs (`.app-scrim.page-sheet`, + `--sheet-layer`, the stack depth), the sign-in screen, Rentals sheets |
| `--z-busy` | 15000 | the saving spinner: above any stack of page dialogs, below the confirms |
| `--z-modal` | 20000 | confirms and alerts (`.app-scrim`, + `--sheet-layer`) over any of the above |
| `--z-toast` | 100000 | toasts; −2 the storage-full banner (`quota-guard.js`) |
| `--z-max` | 2147483647 | reserved: nothing may sit above it |

**One name per token.** The old aliases (`--primary-color`, `--card-bg`, `--text-secondary`, `--border-color`,
`--shadow-md`, `--radius`, `--space-*`, `--transition*`, …) are gone: every stylesheet and script uses the
names above (`--accent-text`, `--panel-bg`, `--ink-2`, `--line`, `--e2`, `--r-control`, `--sp-*`,
`var(--dur-2) var(--ease)`). Don't bring an old name back.

**Why the third selector.** The materials and inks derived with `var()` from layer-1 colours sit in a block on
`:root, [data-theme], [data-mode]`, so they are recomputed on each themed element. That is what lets a
gallery card (`<span data-theme="nature" data-mode="dark">`) render another theme in place. A new
derived colour token goes in that block too.

### Modes and themes

- `<html>` carries `data-theme` (the theme id), `data-appearance` (the choice: light, dark or
  system) and `data-mode` (the effective light or dark, which CSS keys on). There is no
  `body.dark-mode` class and no `[style*=…]` bridge: inline colours don't follow the mode, so use a class or token.
- The dark values live in `@media screen { [data-mode="dark"] { … } }`. **All theme colours are
  screen-only**, so printing from any theme or mode gives Modern light: black on white. Receipts
  are drawn on a canvas with their own colours and never read tokens.
- A theme of `kind: 'dark'` (Dark, Midnight, Cyberpunk) is always dark, whatever the Appearance choice.
- **Type roles.** Page, section and sheet titles read `--font-display` (section titles also `--title-style`);
  Billing's total and the action-bar figure read `--font-hero` and `--w-display` (figures keep lining digits; only Vintage's hero total takes old-style, `--hero-nums`); bill-table rows, list rows
  and payment rows read `--rule-style`; table headers `--table-rule`. Vintage, Classic and Premium set a serif
  `--font-display` (Vintage italic section titles and dashed rules, Classic navy header rules, Premium a light
  400 weight). Material sets a Roboto-first `--font-ui`, Fluent a Segoe UI Variable Display `--font-display` and
  Cyberpunk mono figures (`--font-num`, `--font-hero`). All these stacks keep `"Nirmala UI", "Noto Sans Devanagari"` before the generic `serif`, so Hindi
  text stays Devanagari sans; only Latin text and digits take the serif.
- The choice is per device (`happa.theme`, `happa.appearance`, `happa.themeKind`,
  `happa.bar.light|dark` in localStorage). No Firestore reads or writes. A saved theme this version doesn't know (after a rollback) is shown as Modern but kept, with its kind and bar colours; `happa.themeFallback` names it, so the boot script uses the Appearance choice instead of that stale kind.
- The browser bar (`theme-color`) takes the theme's `--bg`, so `--bg` must be a `#rrggbb` hex.

### Ink on fills

Text on a coloured fill uses that fill's ink token, never white. The dark themes have **light**
fills (a pale accent, a light green sale fill), so white text there is unreadable.

| Fill | Text |
|---|---|
| `--btn-primary-bg` / `--accent` | `--btn-primary-ink` (`--on-accent`) |
| `--btn-sale-bg` / `--mode-sale` | `--btn-sale-ink` (`--on-mode-sale`) |
| `--mode-wholesale` | `--on-mode-wholesale` |
| `--btn-danger-bg` / `--negative-fill` | `--btn-danger-ink` |
| `--accent-strong` (hero cards, menu header, sign-in header) | `--on-accent-strong` |
| `--caution-soft` | `--on-caution-soft` |
| `--toast-bg` | `--toast-ink` |

## 2. Contrast

Every text token keeps WCAG AA (4.5:1) on the surfaces it is used on, in every theme and mode:
`--ink` on `--bg` / `--surface`, `--ink-2` / `--ink-3` and accent text also on `--surface-2`, the
placeholder on `--input-bg`, each ink on its fill, status colours on surfaces and on their `-soft`
fills, the toast.

- `tests/ci/theme-contrast.test.js` checks those pairs from the CSS (resolving `var()` chains and
  compositing translucent fills) for every theme × mode. A theme can't merge with a failing pair.
- `tests/e2e/themes.spec.js` runs axe `color-contrast` on Billing, Today, Outstanding, Money, Insights and Statements for every
  theme × mode, and `tests/e2e/a11y-contrast.spec.js` covers the main pages in Modern, en and hi, phone and desktop.

## 3. Components

Class names and states are in the first lines of `forms.css` and `surfaces.css`. The legacy
component classes are gone (K2): a hook that JS or a test needs is a `data-*` attribute (`[data-history-item]`, `[data-bill-row]`, `[data-stock-item]`, …),
and page layout uses page-scoped classes (`.bill-form-field`, `.pay-line`, …).

- **Buttons** `.btn` + `-primary` / `-tonal` / `-ghost` / `-danger` / `-danger-outline` / `-success`, `-sm`, `-icon`,
  `-block` (`-danger-outline`: a risky choice that is not the main action, e.g. Discard the line, Save anyway at a rate check). One primary button per screen. Hover is a veil over the button's own colour; a busy
  save sets `aria-busy` (the `runExclusive` lock). Every button, `-sm` too, and the payment actions
  (`[data-record-payment]`, `[data-mark-cleared]`) are at least 44 px tall. No page has a button class with its own
  look (C2): Billing and Wholesale use Save `-primary`, Print and Share (`-icon`) the default, Add to bill and
  Rest → due `-tonal`, the draft toolbar and the contact picker `-ghost`; inside `.bill-sale` (Retail sale) and
  `.ws-entry` (Wholesale) the primary and tonal buttons take the mode's colour. `[data-add-line]` and
  `[data-add-weight]` are the E2E hooks. Bill details' footer: Close (ghost, left), Void and
  Delete permanently (danger), Reprint and Share (tonal), Edit (the one primary, right). Small × and + inside a row
  (weight chips, bill lines, rate chips) are `-ghost -icon` / `-tonal -icon` with the sprite icon; period steppers are `-icon`.
  Inline text links inside a sentence (`.due-bill-link`, `.bill-edits__view`) stay links.
- **Fields** `.field > label + .input`, label above, `₹` / `kg` in `.adorn`; native `<select>`
  styled as an input; checkbox and switch; `.kbd` hints (desktop). **Search** `.search-field > .i + .input`: the
  sprite search icon inside the field (decorative, `aria-hidden`), the input keeps its own `aria-label`. A field
  error is `showFieldError(inputId, text)` (`ui/bill-highlight.js`): a `.bill-check-msg` line under the field
  (`role="alert"`), `aria-invalid` and `aria-describedby` on the input, cleared on its next edit (Billing and
  Wholesale's "Please enter a valid rate"). A required field has no `*`: it takes `aria-required="true"`, and optional
  fields say "(optional)".
- **One rule for switches (C3)**: page sections are **Tabs** `.tabs` (underline; `role="tablist"`, each
  button `role="tab"` with `aria-selected`); filters and modes are a **Segmented control** `.seg`
  (`role="group"`, each button `aria-pressed`; a `.mode-dot` span for purchase / sale); on / off is a **chip**
  `.chip` (`aria-pressed`) or a `.switch`. **Tags** `.tag` (`.pos/.neg/.warn/.info`). The old `.filter-buttons`,
  `.filter-btn`, `.sub-tabs`, `.sub-tab` and the bespoke `*-toggle-chip`s are gone (action buttons that used
  `.filter-btn` are `.btn .btn-sm`).
- **Tab keyboard** (`www/js/ui/seg.js`, installed once on the document): every `role="tablist"` has a roving
  tabindex (only the selected tab is a Tab stop) and Left / Right / Home / End select a tab through its own
  click handler, also for tablists drawn later.
- **Mode dot** `.mode-dot` (`.sale`, `.wholesale`): 8 px identity dot beside a purchase / sale / wholesale label, never a status.
- **Panel and rows** `.panel`, `.row` (`.row-main`, `.row-title`, `.row-meta`, `.row-trail`,
  `.row-amt`, `.lead-icon`). **Metrics** `.metrics > .metric`, `.hero-num`, `.display-num`, `.meter`.
  `.panel-tap` is a panel that opens something (hover and focus ring).
- **Hero figure** `.hero` (C1): the page's one big figure, plain on the page with no fill: a caption
  `.hero-cap` (or `.metric-label`) above a `.hero-num` (or a `.display-num` `.hero-fig`), then its
  in / out or compare line. Money, Statements and Today use it; `ins-hero`, `today-hero` and the
  bespoke card classes of the legacy registry are gone (theme tiles keep their previews in a panel frame).
- **Money figure** `.money` with the sign in `<span class="cur">₹</span>` (smaller, `--fs-cur`, and muted
  `ink-3`; plain in print): `<strong class="money"><span class="cur">₹</span><span id="…">0</span></strong>`.
  Billing's totals and action bar use it; the digits keep their own id. Scripts write a figure with
  `moneyHtml(amount, opts)` (`www/js/ui/components.js`, on the `check:html-escape` allow list): `<span class="money">`,
  the true minus outside `.cur` (−₹500), `—` when missing; its text is exactly `moneyText(amount, opts)`. `opts` is a
  named preset (`MONEY_PRESETS` in `utils/money.js`: `exact`, `rate`, `signed`, …), and plain screen text uses
  `moneyText(amount, preset)`; no page defines its own money formatter (F0). Billing's totals are grouped (₹6,28,782).
- **Page head** `<header class="page-head"><h2>…</h2></header>` (optionally with `<div class="page-head-actions">` for the page's mode and actions): the page's title, in every page template, with the app bar's key (`pageTitleKey()` in `ui/bottom-nav.js`, or the page's own `title` key) and no emoji. It is the only page-title pattern. Below 1024 px it is not drawn (the app bar is the title); on desktop (4.2) the h2 is for screen readers, since the header bar shows the same title, and the row shows only when it has actions (an h2-only head takes no space). It is not a second banner landmark. `.sr-only` hides any other text that only screen readers need (Money keeps
  its ⚠ / ✓ status words that way beside the sprite icon).
- **Money, Insights, Statements (5.7)**: plain hero figures (`.hero-num`), section titles above panels of `.row`s,
  Cash in / out as `.metrics`, `.tabs` for the sections and `.seg` for sub-views, `.notice` caveats and checks,
  `.empty`, `.table`; `.ins-line` is the hook (oracle, number audit, statement print).
- **Billing (3.5)**: the totals are a plain panel (the payable is the big ink figure, Total paid a plain row);
  each payment row's "Fill" (`.pay-fill`) is its tick box (`#cashCheckbox` …) drawn as a text button, so ticking
  still puts the whole bill there; ticked it reads "Filled ✓" on the primary (sale: sale) fill, its name is the visible word plus a hidden hint; the bill lines are a row list in a panel below 1024 px (the same `#billTable`
  cells; desktop keeps the table); Notes and Date sit side by side.
- **Outstanding (5.3)**: the owed total is the hero figure, with a `.meter` and its legend (the age groups,
  still buttons that filter). Age colours: up to 30 days `--ink-3`, 31–60 `--warning-dot`, 61–90
  `--on-caution-soft`, 90+ `--negative`; dues themselves stay in ink, and ages are `.tag` (`.warn` after 30
  days, `.neg` after 90). The rule is `dueTone(days, amount)` in `utils/aging.js` (History's Due tag and Workers' dues use it too): ₹0 is never coloured, so an empty age group shows a muted dot and amount. Party rows are `.row`s in a panel with an initials avatar drawn from
  `data-initials` (CSS, so the row's text is unchanged); bills are panels.
- **Today › Cash (5.2a)**: Available cash is the hero figure, the day's other figures a `.metrics` panel (each figure draws its
  own hairlines, so the grid holds whichever ones show); Open, Record and Close are panels of `.field`s with ₹ as an `.adorn-pre`,
  one primary button each (Record is tonal while Close shows); the Difference figure takes a tone class. The script's markup
  (5.2b): the count check is a `.notice` with an icon per line; each history day is a `.row` with its figures in two columns and
  a `.tag` status; "not counted" and duplicate days are notices; a day's details are `.metrics`, in / out sums and entry lines.
  Every figure is `moneyHtml()`.
- **Wholesale (5.5)**: Billing's components (customer field, line panel, row-list bill lines, totals panel with "Fill", Notes |
  Date, the phone action bar) on the page's `.bill-page` class: Billing's `#billing` rules read `:is(#billing, .bill-page)`,
  and its tones read `--bill-tone-text / -soft / -fill / -ink`, which `.bill-page` sets to the wholesale mode (violet fills and
  soft, ink text). Sales | History | Outstanding is a `.seg`; stock and average rate are `.metrics`; Outstanding bills are
  Outstanding's `.due-bill` panels; a bill opened from a list is panels of `.row`s and a `.table`.
  `moneyInText(text, amounts, opts)` (`components.js`) draws the figure (or an array of figures, found in order) inside a
  translated sentence with `moneyHtml` (`opts` as `formatRupees`, e.g. the preset `'rate'`; a missing amount
  leaves its text as it is).
- **Rates and Stock (5.6)**: Rates is a `.table` in a panel (purchase / retail / wholesale headers carry their `.mode-dot`,
  rates in ink), Export / Import / Add item as buttons (Add item primary), a `.search-field`, archived items a `.tag`.
  Stock: Current | Adjustment | Not selling is a `.seg`; the summary is `.metrics`; items and dead stock are `.row`s
  in a panel (`[data-stock-item]` is the hook; an unmatched bucket takes a tone on its note and kg); the low-stock list is a
  `.notice`; the adjustment form is a panel of `.field`s with kg and ₹ … /kg as `.adorn`, current stock and average
  rate as `.metrics`; adjustments are panels (`[data-history-item]` hook). Sections switch with `hidden`.
- **History (5.4a, C4)**: a bill is a `.row` (`[data-history-item][data-bill-row]` is the hook, also on Wholesale › History); consecutive rows join into one panel with hairlines. The bill number has its `.mode-dot` (no side stripe), number and amount in ink; online / cash / due are `.tag`s (the Due tag ages with `dueTone`). Table View and the other desktop lists (Day labour, Rate trends, Recurring bills, Workers) are `.table`s.
- **Expenses (5.4b)**: Business | Personal is a `.seg`; each form is a `.panel` of `.field`s (₹ as an `.adorn`) with a primary
  Save and a tonal Print; a section's list is a `.panel` of `.row`s (amount in `.row-trail`, voided rows `.is-voided` with a
  `.tag`), "Show voided" is a `.switch` and the quick-fill templates are `.chip`s. Expense details: the amount as a
  `.display-num`, then a `.panel` of label | value `.row`s with sprite icons and the remarks as a `.notice`.
- **Settings, App health and Anomalies (5.8a)**: each Settings card is a `.panel` (`.set-panel`: its title, `.field`s,
  `.set-toggle` lines with a `.switch` on the right, `.set-kv` label | value lines and `.set-actions` button rows stacked
  with one gap); Language, Appearance (Light / Dark / System with the sun, moon and auto icons) and the Usage range are
  `.seg`s; the theme gallery's tiles show the preview flush on top and a check on the chosen theme ("Always dark" is a
  `.tag`). Units are `.adorn`s (labour kg and ₹, the Rentals electricity rate). `.settings-card` and `.danger-btn` are
  deleted (Admin no longer uses them). The card hooks `#notifSettingsCard`, `#installAppCard`, `#roleAccessCard`, the printer buttons and the
  native share button start `hidden`; their scripts set `hidden` with `style.display`. App health: sections are panels,
  tables `.table`, pass rates tinted cells, and Today's below-target banner a `.notice.neg`. Anomalies: filters are
  `.field`s in a panel with a `.search-field`, List | Patterns are `.tabs`, rows (also on Today's Day report) are `.row`s
  with a severity dot (no stripe), `.tag` status and `.btn-sm` review buttons, amounts `moneyHtml()`; the heat map and the
  by-hour bars draw from `--a` / `--h` custom properties and the trend chart's axis text from the theme's muted ink.
- **Admin (5.8b)**: Users | Data are `.tabs` (Aadhat settings is a ghost button beside them); each list of people is a `.panel`
  of `.row`s (name, email, a `.tag` for the role or status) with small `.btn`s below; the activity range is a `.seg` and the
  report a `.table` (bill total via `moneyHtml`); storage is `.metrics` and a row list; Data sections are panels with tonal
  actions and one danger button; the backup check answers in a `.notice`; Clear data's dialogs use `admin-clear*` classes.
- **Diagnostics (5.8b)**: Errors | Audit logs | Status | Number checks are `.tabs`; error counts are `.metrics`; errors, audit
  entries, number checks and the error-report test are panels (`.diag-card`) whose type / result is a `.tag` (audit actions a
  tinted `.lead-icon`), not a coloured stripe; timings, reads, status and differences are `.table`s (differences via `moneyHtml`);
  controls are `.btn`s (refresh an icon button). Copied / shared status text and the error report are unchanged plain text.
- **Sign-in, notifications, /download (5.10)**: Login | Register is a `.tabs` (`data-auth-tab` is the hook, `.on` and
  `aria-selected` mark the open card); each card is `.field`s with `.input`s, one `.btn-primary` (Forgot password and Not now are
  `.btn-ghost`), the show-password eye a `.btn-icon`, and "Continue with Google" a `.btn.btn-google` in Google's own colours. The
  result above the button (also "pending approval") is a `.notice`: `showMessage` adds `.neg` / `.pos` / `.info` beside its
  `error` / `success` / `info` hook. The bell's inbox is a `.sheet` over a `.scrim` with `.row`s (`.notif-item`, a sprite
  `.lead-icon` per type, unread rows tinted `--info-soft` with an `--info` edge) and an `.empty`; its close button has
  `data-dismiss`. `/download` is standalone (`variables.css` pins `html` / `body` for the app shell), so its `<style>` copies the
  tokens it uses; `tests/ci/download-tokens.test.js` keeps them equal to `variables.css` and its rules free of raw colours.
- **Rentals (5.9a)**: Simple | Advanced is a `.seg` beside the page title (`.rent-head`, on the right on desktop); This month |
  Tenants | Properties | Reports are `.tabs`, Rentals settings and Roles & access ghost buttons. Lists are `.panel`s of `.row`s:
  a row with several lines (a tenant, unit or property) is a `.row.rent-entry` (title and figure on top, then details, `.tag`
  statuses with `data-rent-status`, and small `.btn`s); totals are `.metrics`; the yearly-increase note a `.notice.info`; the ⋯
  menu, Back, Add, Receipts, Deposit, Meter reading and the phone number use sprite icons (the ⚡ electricity tags stay text,
  as the characterisation snapshot pins them). Hooks for tests: `data-lease`, `data-unit`, `data-tenant`, `data-property`,
  `.rent-entry`. `rentals.css` loads after `app.css`, so its desktop rules in `desktop.css` are one step more specific
  (`.tab .rent-head`).
- **Rentals dialogs (5.9b)**: the form dialog is a `.sheet` (`#rentDialog`, with a grabber) over a `.scrim`
  (`#rentDialogScrim`), a centred dialog on desktop; Cancel (`#rentDialogCancel`, ghost, `data-dismiss`) on the left and
  Save (`#rentDialogSave`, primary) on the right. Esc and Back close it like any modal `.sheet[aria-modal="true"]`
  (`closeTopDialog`), Tab stays inside, and focus returns to the opener. Deposit, expense, yearly report, meter, link,
  unit and receipt-list dialogs use `.metrics`, `.table`, `.field`s, `.btn`s, `.tag` and `.notice`, with `moneyHtml()`
  figures; the receipt itself, its title and its share text are unchanged. The tenant's `/r/<token>` page is standalone
  like `/download`: `www/r/rent-history.css` copies the tokens it uses into `:root` (same test).
- **Notices and empty states (C4b)**: the old banners are notices: unsaved bill `.autosave-notice` (warn), live bill checks `.bill-check-notice` (neg / warn, solid, sticky), wrong clock `.clock-notice` and printer permission `.printer-perm-notice` (float), the Android update `.app-update` (info, solid, above the tab bar), a voided bill `.bill-voided-notice`, the bill being edited `#billEditNotice` (info, "Editing #P12" on Billing until it is saved) and History's older-bills line `.history-range-note` (info, warn on error). Every page's empty list is an `emptyState()`.
- **Feedback** `.notice` (`.pos/.neg/.warn/.info`; `.solid` puts the tint on an opaque surface for a notice that sticks or floats, `.float` pins it to the top of the screen, `.notice-actions` holds its buttons; `[hidden]` always hides it), `.empty` (write it with `emptyState({ icon, title, text, action, tone })` from `ui/components.js`: the icon tile, a title, an optional line and an optional button; loading and error lines stay a plain `<p class="empty">`), `.skel`, `.toast` (near-black; light in the
  Dark theme), `.dialog` / `.sheet` / `.scrim` (old `.modal-overlay > .modal-box`), `.spinner` (blocking
  saves only). Dialog buttons: Cancel (ghost) on the left, one primary on the right, labelled with a verb; a destructive
  confirm (Void bill) passes `{ confirmLabel, danger: true }` to `UIManager.showModal` / `showModalWithHtml` (`.btn-danger` instead of `.btn-primary`; Cancel is `.btn-ghost`).
  **The app dialog (C5a)**: `showModal`, `showModalWithHtml` and `showCustomModal` share one controller (`ui/ui-manager.js`)
  and one template (`#modalOverlay.scrim.app-scrim > #modalBox.app-dialog` with `.dialog-title`, `.dialog-body` and `.dialog-actions`): a `.dialog` from 600 px, a bottom `.sheet` with a grabber
  below. It takes focus, keeps Tab inside (`trapFocus`, shared with the More and Rentals sheets) and gives focus back; Esc,
  Back and a scrim tap answer it as Cancel (`closeTopDialog`; an alert as OK, a custom modal through its `[data-dismiss]`).
  A dialog replaced before it was answered resolves as dismissed. The ids and the `AppState.modalResolve` promise are kept.
  **Other dialogs (C5b)** use the same controller and markup: `buildSheet()` makes it in JS, `openSheet(overlay, { focus })` opens it (focus, Tab trap, 350 ms touch guard) and
  `closeSheet(overlay)` gives focus back. Esc (at any width: the controller's own listener, which keyboard-shortcuts.js then skips), Back and a scrim tap press the top dialog's `[data-dismiss]`; dialogs stack in
  the order they open (`--z-modal` + `--sheet-layer`). The bill-save questions (unadded line, extreme rate, heavy bag) are
  built this way with their ids, `data-choice` and the focused default (Add, Fix) unchanged; the reason and voice-check
  dialogs are app dialogs with `.field` content. The page dialogs are `.app-scrim.page-sheet` (a band under the confirms
  they open, `--z-dialog`): bill details (`#billDetailsOverlay`, History and Wholesale), drafts (`#draftsOverlay`), the
  Item dialog (`#itemEditOverlay`), expense details (`#expenseDetailsOverlay`), the Money breakdown
  (`#financeBreakdownSheet`, a wide dialog on desktop, no longer a side panel) and What's new (`#whatsNewSheet`); the
  desktop keyboard help (`#kbdHelpOverlay`) is a dialog. `.dialog-head` is a title row with its own Back / Close
  buttons, `.dialog-wide` a 560 px (desktop 680 px) dialog.
- **App shell (phone and tablet, <1024 px)**: `header.app-bar` (`hamburger.css`) holds the open page's title (`#appBarTitle`, the menu name `t('ui.nav.*')` set by `ui/bottom-nav.js` on `aadhat:tabshown`), the sync pill (`#syncStatus`) and the bell; pages scroll under it (`--appbar-h`, `--tab-top`). The menu button shows only in Rentals (no tab bar). **More** opens `#sideNav` as a modal bottom sheet (`navigation.css`): the business switch and the pages not on the tab bar (`data-bar` links are hidden there) in groups (`.nav-group`); it takes focus, keeps Tab inside, closes on Esc, Back or a swipe down and gives focus back. The open page is the `main` landmark (`role="main"`, set by `showTab`).
- **Desktop shell (≥1024 px, 4.2, `desktop.css`)**: the same `header.app-bar` becomes the 60 px page header beside the sidebar (`--desktop-header-h`): the page title (the same `#appBarTitle`), the sync pill and the bell; pages scroll under it. The sidebar is the same `#sideNav` on `--surface-2`: the business (`.nav-mark`, name and role, the business switch), the same `.nav-group`s as the More sheet (a group shows only when the role may open one of its pages; links a role may not open carry `hidden`), Alt+1…9 hints (`.nav-kbd`, from `TAB_SHORTCUTS` in `keyboard-shortcuts.js`, which also sets `aria-keyshortcuts`), Settings and Shortcuts. At 1024–1279 px it is a 64 px icon rail (names stay for screen readers and show as tooltips). Density: `--control-h` 36, `--row-h` 44. Tab order: header, sidebar, page.
- **Tones** for text written by scripts: `.tone-pos`, `.tone-neg`, `.tone-warn`, `.tone-info`,
  `.tone-muted`, instead of inline colours.

Money and weight figures use `tabular-nums`. New CSS adds no uppercase and no letter-spacing that
can reach Hindi text (a few older table headers still do; they go with their screens).

## 4. Icons

Line icons on a 24 grid, 1.75 stroke, `currentColor`, from the sprite at the top of
`templates/navigation.html` (no extra request):

```html
<svg class="i" aria-hidden="true" focusable="false"><use href="#i-receipt"/></svg>
```

Sizes: `.i-sm` 16, `.i` 20, `.i-lg` 24. An icon next to text is `aria-hidden`; an icon-only
button has an `aria-label` (through `data-i18n-aria-label`). A new icon is a new `<symbol id="i-…">`
in the sprite. `tests/ci/icon-sprite.test.js` checks that every `href="#i-…"` (double quotes) in `index.html`,
templates, scripts and CSS (not `__tests__`) has a symbol, and that the sprite stays small.

Scripts that draw an icon call `icon(name, size)` from `www/js/ui/icons.js` (Today, the Day report),
which returns that markup; `icon` is on the `check:html-escape` allow list. Pass a constant name, never
one built from data: `icon-sprite.test.js` checks every name passed to `icon()`.

Emoji stay only where they are content: WhatsApp share text, receipts and print, and text people
type.

## 5. Adding a theme

1. **Tokens.** Create `www/css/themes/<id>.css` with only custom properties (and `color-scheme`):
   - a block `[data-theme="<id>"]` for what is the same in both modes (shape, faces, materials);
   - for `kind: 'both'`, `[data-theme="<id>"]:not([data-mode="dark"])` (light) and
     `[data-theme="<id>"][data-mode="dark"]` (dark); for `kind: 'dark'`, one block;
   - every colour, face and rule style inside `@media screen { … }`, so print stays black on white in the Modern type;
   - set the layer-1 colours, and every ink whose fill turns light (`--on-accent`,
     `--on-mode-sale`, `--on-mode-wholesale`); keep `--accent-strong` deep enough for white text;
   - `--bg` as a `#rrggbb` hex (it becomes the browser bar colour).
2. **Wire it.** Add `@import url('css/themes/<id>.css');` to `www/styles.css` after `variables.css`,
   then `npm run build:css`. Add `{ id: '<id>', kind: 'both' | 'dark' }` to `THEMES` in
   `www/js/ui/themes.js` (the order is the gallery order).
3. **Words.** Add `ui.settings.theme_<id>` and `ui.settings.theme_<id>_desc` to `www/js/i18n/en.js` and
   `www/js/i18n/hi.js`.
4. **Test.** In `tests/e2e/themes.spec.js`, add the theme × mode rows to `COMBOS`, add the id to
   `DARK_KIND` if it is always dark, and raise the gallery's card count (`toHaveCount`). The Jest tests pick
   the theme up from the registry: `tests/ci/themes.test.js` (file ↔ registry ↔ styles.css ↔ i18n,
   tokens only, screen-only colours, **≤1.5 KB gzip**) and `tests/ci/theme-contrast.test.js` (every
   pair at 4.5:1).
5. Bump the cache (`?v=`, `BUILD_ID`, `CACHE_NAME`) and take screenshots of Billing, Today,
   Outstanding and Settings › Appearance in each mode, phone and desktop.

No screen, component, ThemeManager or `#themeBoot` change is needed (the boot script is data-only,
so its CSP hash never changes for a new theme). A theme ships no images or fonts: the CSP has no
font origin, and stacks must keep `"Nirmala UI", "Noto Sans Devanagari"` before the generic family
so Hindi stays a legible sans.

A theme file sets only custom properties and `color-scheme` (`themes.test.js` fails on anything else).
If one component needs a different value in one theme, scope a token to it in the theme file
(`[data-theme="<id>"] .input { --input-border: … }`); it must not change any box size or layout, and it
counts toward the 1.5 KB. A look that tokens can't express needs a new token in `variables.css` first.

## 6. Do and don't

| Do | Don't |
|---|---|
| Use tokens for every colour, size, weight, radius and shadow | Write a hex, `rgb()` or colour name in `www/css`, a template `style=` / `<style>` or `www/js` (`colour-guard`) |
| Put text on a fill in that fill's ink token | Put `color: white` / `#fff` on an accent, sale or wholesale fill (`themes.test.js` fails); only the danger fill and `--accent-strong` take white, through their ink tokens |
| Keep theme differences in `css/themes/<id>.css` | Add `[data-theme=…]`, `[data-mode=…]` or `.dark-mode` selectors in page CSS: a token already switches with the mode |
| Use a new token in `variables.css` when nothing fits, with a value for light and dark | Add a page-local custom property holding a colour |
| Use the type scale `--fs-*` and `--w-*` | Write a raw `font-size` / `font-weight` (`type-guard`), use 500, uppercase or letter-spacing on Hindi |
| Use the component classes (§3) and keep the old classes and every id as hooks | Rename or drop a class or id that JS or E2E uses |
| Mark state with tone classes (`.tone-neg`, `.tag.warn`) from scripts | Write inline colours from JS (`el.style.color = …`) |
| Use sprite icons (§4) | Use emoji in navigation, titles or buttons |
| Put desktop-only rules in `desktop.css` | Put `@media (min-width: 1024px)` rules in page CSS |
| Move things with `transform` and `opacity` only (colour and shadow transitions on hover are fine); respect reduced motion | Use `backdrop-filter` on phone layouts |
| Leave print and receipts alone | Let a theme colour reach `@media print`, `printer.js`, `receipt-drawing.js` or `rent-receipt.css` |

## 7. Guards

| Test | Fails on |
|---|---|
| `tests/ci/colour-guard.test.js` | a hard-coded colour outside the allowlist (see "Strict guards" below) |
| `tests/ci/type-guard.test.js` | a raw `font-size` / `font-weight` outside the allowlist |
| `tests/ci/ds-guard.test.js` | raw spacing, radius, shadow or z-index, `!important`, an `#id` or `.dark-mode` / `[data-theme]` selector, an inline style, an emoji, a Title Case label or a legacy component class outside the allowlist; an allowlist entry without a known list or a reason |
| `tests/ci/themes.test.js` | a theme missing from the registry, `styles.css` or i18n; a non-token rule or a colour outside `@media screen` in a theme file; a theme over 1.5 KB gzip; a rule in `www/css` or a template `<style>` that sets an accent, sale, wholesale, positive or negative fill and white text together |
| `tests/ci/theme-contrast.test.js` | a text / background pair under 4.5:1 in any theme × mode |
| `tests/ci/icon-sprite.test.js` | a missing `#i-*` symbol, or the sprite growing too large |
| `www/js/__tests__/theme-manager.test.js`, `theme-boot.test.js` | Appearance, System, preview and the pre-paint boot |
| `tests/e2e/themes.spec.js` | axe contrast on Billing, Today, Outstanding, Cash, Money, Insights, Statements and the open More sheet per theme × mode; the gallery preview, Cancel, Apply |
| `tests/e2e/app-shell.spec.js` | the phone app bar title (en, hi), one `main`, the More sheet's focus, Tab, Esc and Back; the desktop page header title per page (en, hi), one banner / nav / main, the grouped sidebar per role, Tab order, Alt+1…9 and the 1024 px rail |
| `tests/e2e/a11y-contrast.spec.js`, `billing-fold.spec.js` | contrast on the main pages (en, hi); Save / Print above the fold |

### Strict guards

Why: the app looked inconsistent because every screen grew its own spacing, radii, shadows, inline styles, emoji icons, Title Case labels and
component classes. The guards started as ratchets (counts could only fall); since K4 (Nov 2026) they are strict: every metric is 0 in every
file, except for the entries in `tests/ds-allowlist.json`. CI fails when:

* a file has a count but no entry, or more than its entry (use the token, class or icon the message names);
* a file's count is **below** its entry. Lower the entry in the same PR, so the fix can't be spent on new drift later;
* an entry names an unknown metric or list, has no reason, or is listed twice;
* the allowlist is looser than on the PR base (`git show origin/<base>:tests/ds-allowlist.json`, or `ARCH_BASE_REF`): an entry's
  count rises, a metric's total rises, or a new entry appears. Skipped with a message when the base ref isn't available
  (local runs), unless `ARCH_REQUIRE_BASE=1` (CI on pull requests).

| Guard (metric) | Allowlist | Counts, per file |
|---|---|---|
| `colour-guard` (`colour`) | `tests/ds-allowlist.json` | hex / `rgb()` / `hsl()` / colour names |
| `type-guard` (`type`) | 〃 | raw `font-size` / `font-weight` |
| `ds-guard` `spacing` | 〃 | `margin` / `padding` / `gap` with a non-zero px / rem / em (use `--sp-*`) |
| `ds-guard` `radius`, `shadow`, `zIndex` | 〃 | raw `border-radius` (`--r-*`), `box-shadow` / `text-shadow` (`--e1`…`--e3`), numeric `z-index` |
| `ds-guard` `important`, `idSelector`, `themeSelector` | 〃 | `!important`; selectors with `#id`; `.dark-mode` / `[data-theme]` / `[data-mode]` outside `variables.css` and `themes/` |
| `ds-guard` `inlineStyle` | 〃 | template `style="…"`, `style="…"` in JS strings, `.style.x =` writes other than `display`, `setAttribute('style')`. A style holding only custom properties (`style="--w:42%"`) is allowed |
| `ds-guard` `emoji` | 〃 | emoji in templates; `ui.*` keys with an emoji in `en.js` / `hi.js`, one row per area (`www/js/i18n/en.js#ui.cash`) |
| `ds-guard` `titleCase` | 〃 | Title Case `ui.*` labels (2–7 words) in `en.js`, one row per area |
| `ds-guard` `legacyClass` | 〃 + `tests/ds-legacy-classes.json` | uses of a legacy component class (registry: old class → its replacement) in `class="…"`, `className` and `classList.add/toggle` |

Scope: `www/css` (not `app.css`, `variables.css` or `themes/`), `www/index.html`, `www/templates`, `www/js`. `@media print` and the receipt files
(`rent-receipt.css`, `printer.js`, `receipt-drawing.js`, `rent-receipt.js`) stay out.

The lists (`"lists"` in the file) say which kinds of exception are legitimate:

| List | For |
|---|---|
| `print` | thermal-printer and printable-image canvases (black on white), like `@media print` and the receipt files the guards skip |
| `canvas` | chart colours drawn on `<canvas>` and the legend swatches that key them |
| `share-text` | text that leaves the app (WhatsApp day report, due reminders) where an emoji is part of the message |
| `standalone` | output that can't load `app.css` tokens: the exported HTML file, DevTools console styles, the self-styled quota banner |
| `js-state` | a template's initial `style="display:…"` that JS and tests read through `element.style` (the remaining test hooks) |
| `proper-noun` | Title Case that names a page or a theme |
| `off-scale` | a raw value with no exact token: a nearer token would change the look, so it waits for the page PR that owns the screen |
| `cascade` | an `!important` or `#id` selector that decides which rule wins today (the `#billing` layer); removing it needs its own cascade-checked PR |
| `visible-fix` | drift whose fix is a visible change (an emoji to swap for a sprite icon), left for the page PR |

Adding an entry is the exception, not the fix: first use the token, class or icon. Drift in a file that already exists on the base can't be
allowlisted at all: an existing entry may only go down, and a new entry for an existing file fails. Only a file that is **new in the PR**
(a new theme file, a new canvas chart) may get an entry, and it must say when it was added:

```
{"metric":"colour","file":"www/js/ui/new-chart.js","count":4,"list":"canvas","reason":"series colours drawn on the canvas","added":"#490"}
```

* `metric` is a ds-guard metric, `colour` or `type`; `file` is the path the failure message prints (i18n rows are `www/js/i18n/en.js#ui.<area>`,
  so a new i18n row is never new-file);
* `count` is the file's exact count, from the failure message;
* `list` is one of the lists above. A new kind of exception adds a list with a description, in the same reviewed PR;
* `reason` (20+ characters) says why this file needs it: which values, which output, why no token fits;
* `added` is the PR number (`#490`) or the date (`2026-11-14`). A justified new entry doesn't count towards its metric's total.

Reviewers treat a new entry like new drift that needs a justification. After you remove drift, lower the entries (an entry at 0 is dropped):

```
DS_ALLOWLIST=lower npx jest -i ds-guard colour-guard type-guard
```

Commit the lowered JSON in the same PR. Moving rules from an existing stylesheet into another existing one raises the destination's entry,
which the base check refuses: fix the moved drift in the same PR instead.
