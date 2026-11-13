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
| Controls (buttons, fields, select, switch, segmented control, tabs, chips, tags) | `www/css/forms.css` |
| Surfaces and feedback (panel, rows, metrics, hero, meter, notice, empty, skeleton, table, dialog, sheet, toast, loading, tones) | `www/css/surfaces.css` |
| Icons | sprite at the top of `www/templates/navigation.html`, CSS in `www/css/icons.css` |
| Cascade order | `www/styles.css` (joined into `www/css/app.css` by `npm run build:css`) |

## 1. Token layers

Components read only layers 1 and 2. A theme sets layer 1 and, where it is different, a few
layer-2 tokens. Nothing else changes per theme.

| Layer | What | Tokens | Set by |
|---|---|---|---|
| **1. Semantic** | Colours by meaning, elevation, focus | `--bg`, `--surface`, `--surface-2`, `--surface-3`, `--line`, `--line-strong`, `--ink`, `--ink-2`, `--ink-3`, `--ink-placeholder`, `--scrim`; `--accent`, `--accent-hover`, `--accent-strong`, `--accent-text`, `--accent-soft`, `--accent-line`; `--mode-sale`, `--mode-wholesale`, `--mode-rentals` (+ `-soft`); `--positive`, `--negative`, `--warning`, `--info` (+ `-soft`, `-line`), `--negative-fill`, `--warning-dot`, `--caution-soft`; the **inks** `--on-accent`, `--on-accent-strong`, `--on-mode-sale`, `--on-mode-wholesale`, `--on-caution-soft`; `--e1`…`--e3`, `--highlight`, `--focus`, `--state-hover` | every theme (a light block, and a dark block unless it is always dark) |
| **2. Component** | Shape and type roles (declared beside layer 1, on `:root, [data-theme]`); materials and button inks derived from layer 1 (on `:root, [data-theme], [data-mode]`) | `--r-xs`, `--r-sm`, `--r-control`, `--r-panel`, `--r-chip`, `--r-sheet`, `--r-full`, `--rule-style`; `--font-ui`, `--font-display`, `--font-num`, `--font-hero`, `--w-regular`, `--w-strong`, `--w-display`, `--tracking-display`, `--title-style`, `--hero-nums`; `--page-bg`, `--panel-bg`, `--panel-border`, `--panel-shadow`, `--input-bg`, `--input-border`, `--bar-bg`, `--bar-border`, `--seg-track`, `--seg-on`, `--table-rule`, `--btn-primary-bg`, `--btn-primary-ink`, `--btn-primary-shadow`, `--btn-sale-bg`, `--btn-sale-ink`, `--btn-danger-bg`, `--btn-danger-ink`, `--toast-bg`, `--toast-ink`, `--toast-pos/-neg/-warn/-info`, `--preview-apply-line`, `--mode-purchase` | defaults in `variables.css`; a theme overrides only what makes it different |
| **3. Components** | `.btn`, `.field`, `.seg`, `.panel`, `.row`, `.notice` … (§3) | read tokens, never raw colours | base CSS only |

**Not per theme** (on `:root`): the type scale `--fs-caption|sm|body|lead|title|display|hero`,
`--lh-body`, `--w-label`, spacing `--sp-1…10`, `--gutter`,
`--section-gap`, `--row-h`, `--control-h(-sm)`, motion `--ease`, `--dur-1…3`. Layouts are therefore
identical in every theme. Hindi (`html[lang="hi"]`) raises `--fs-sm` / `--fs-body` and `--lh-body`,
makes `--w-label` 400, and turns off a theme's italic titles and display tracking (`--title-style`, `--tracking-display`); the Android app (`html.platform-android`) uses weight 500.

**Old names** (`--primary-color`, `--card-bg`, `--white`, `--success-color`, `--btn-primary`,
`--shadow-md`, `--radius`, …) are aliases of the tokens above, so older stylesheets follow every
theme. New code uses the new names.

**Why the third selector.** The materials and inks derived with `var()` from layer-1 colours sit in a block on
`:root, [data-theme], [data-mode]`, so they are recomputed on each themed element. That is what lets a
gallery card (`<span data-theme="nature" data-mode="dark">`) render another theme in place. A new
derived colour token goes in that block too. (The old `--radius*`, `--space-*` and `--transition*`
aliases are on `:root` only, so a scoped preview keeps the page's values for them; new code uses `--r-*`.)

### Modes and themes

- `<html>` carries `data-theme` (the theme id), `data-appearance` (the choice: light, dark or
  system) and `data-mode` (the effective light or dark, which CSS keys on). `body.dark-mode`
  mirrors `data-mode="dark"` for older selectors until they are converted.
- The dark values live in `@media screen { [data-mode="dark"] { … } }`. **All theme colours are
  screen-only**, so printing from any theme or mode gives Modern light: black on white. Receipts
  are drawn on a canvas with their own colours and never read tokens.
- A theme of `kind: 'dark'` (Dark, Midnight) is always dark, whatever the Appearance choice.
- **Type roles.** Page, section and sheet titles read `--font-display` (section titles also `--title-style`);
  Billing's total and the action-bar figure read `--font-hero` and `--w-display` (figures keep lining digits; only Vintage's hero total takes old-style, `--hero-nums`); bill-table rows, list rows
  and payment rows read `--rule-style`; table headers `--table-rule`. Vintage, Classic and Premium set a serif
  `--font-display` (Vintage italic section titles and dashed rules, Classic navy header rules, Premium a light
  400 weight). Their stacks keep `"Nirmala UI", "Noto Sans Devanagari"` before the generic `serif`, so Hindi
  text stays Devanagari sans; only Latin text and digits take the serif.
- The choice is per device (`happa.theme`, `happa.appearance`, `happa.themeKind`,
  `happa.bar.light|dark` in localStorage). No Firestore reads or writes.
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
| `--accent-strong` (hero cards, menu header, login button) | `--on-accent-strong` |
| `--caution-soft` | `--on-caution-soft` |
| `--toast-bg` | `--toast-ink` |

## 2. Contrast

Every text token keeps WCAG AA (4.5:1) on the surfaces it is used on, in every theme and mode:
`--ink` on `--bg` / `--surface`, `--ink-2` / `--ink-3` and accent text also on `--surface-2`, the
placeholder on `--input-bg`, each ink on its fill, status colours on surfaces and on their `-soft`
fills, the toast.

- `tests/ci/theme-contrast.test.js` checks those pairs from the CSS (resolving `var()` chains and
  compositing translucent fills) for every theme × mode. A theme can't merge with a failing pair.
- `tests/e2e/themes.spec.js` runs axe `color-contrast` on Billing, Today and Outstanding for every
  theme × mode, and `tests/e2e/a11y-contrast.spec.js` covers the main pages in Modern, en and hi, phone and desktop.

## 3. Components

Class names and states are in the first lines of `forms.css` and `surfaces.css`. Older classes are
kept as hooks (JS and E2E use them) and share the new look; they are listed beside the new one.

- **Buttons** `.btn` + `-primary` / `-tonal` / `-ghost` / `-danger` / `-success`, `-sm`, `-icon`,
  `-block`. One primary button per screen. Hover is a veil over the button's own colour; a busy
  save sets `aria-busy` (the `runExclusive` lock). Old: `.save-btn`, `.print-btn`, `.draft-btn`,
  `.add-to-bill-btn`, `.quick-add-btn-inline`, `.split-rest-btn`.
- **Fields** `.field > label + .input`, label above, `₹` / `kg` in `.adorn`; native `<select>`
  styled as an input; checkbox and switch; `.kbd` hints (desktop).
- **Segmented control** `.seg` (old `.filter-buttons > .filter-btn`), with a mode dot for
  purchase / sale. **Tabs** `.tabs` (old `.sub-tabs > .sub-tab`). **Chips** `.chip`, **tags** `.tag`
  (`.pos/.neg/.warn/.info`).
- **Mode dot** `.mode-dot` (`.sale`, `.wholesale`): 8 px identity dot beside a purchase / sale / wholesale label, never a status.
- **Panel and rows** `.panel`, `.row` (`.row-main`, `.row-title`, `.row-meta`, `.row-trail`,
  `.row-amt`, `.lead-icon`). **Metrics** `.metrics > .metric`, `.hero-num`, `.display-num`, `.meter`.
- **Money figure** `.money` with the sign in `<span class="cur">₹</span>` (smaller, `--fs-cur`, and muted
  `ink-3`; plain in print): `<strong class="money"><span class="cur">₹</span><span id="…">0</span></strong>`.
  Billing's totals and action bar use it; the digits keep their own id.
- **Billing (3.5)**: the totals are a plain panel (the payable is the big ink figure, Total paid a plain row);
  each payment row's "Fill" (`.pay-fill`) is its tick box (`#cashCheckbox` …) drawn as a text button, so ticking
  still puts the whole bill there; ticked it reads "Filled ✓" on the primary (sale: sale) fill, its name is the visible word plus a hidden hint; the bill lines are a row list in a panel below 1024 px (the same `#billTable`
  cells; desktop keeps the table); Notes and Date sit side by side.
- **Feedback** `.notice` (`.pos/.neg/.warn/.info`), `.empty`, `.skel`, `.toast` (near-black; light in the
  Dark theme), `.dialog` / `.sheet` / `.scrim` (old `.modal-overlay > .modal-box`), `.spinner` (blocking
  saves only).
- **App shell (phone and tablet, <1024 px)**: `header.app-bar` (`hamburger.css`) holds the open page's title (`#appBarTitle`, the menu name `t('ui.nav.*')` set by `ui/bottom-nav.js` on `aadhat:tabshown`), the sync pill (`#syncStatus`) and the bell; pages scroll under it (`--appbar-h`, `--tab-top`). The menu button shows only in Rentals (no tab bar). **More** opens `#sideNav` as a modal bottom sheet (`navigation.css`): the business switch and the pages not on the tab bar (`data-bar` links are hidden there) in groups (`.nav-group`); it takes focus, keeps Tab inside, closes on Esc, Back or a swipe down and gives focus back. Desktop keeps the sidebar; the bar draws nothing there (`display: contents`). The open page is the `main` landmark (`role="main"`, set by `showTab`).
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
| Keep theme differences in `css/themes/<id>.css` | Add `[data-theme=…]`, `[data-mode=…]` or `.dark-mode` selectors in page CSS: a token already switches with the mode (the older `.dark-mode` rules are removed screen by screen) |
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
| `tests/ci/colour-guard.test.js` | a file gaining a hard-coded colour (baseline `tests/colour-baseline.json`, may only go down: `COLOUR_BASELINE=lower`) |
| `tests/ci/type-guard.test.js` | a raw `font-size` / `font-weight` (baseline `tests/type-baseline.json`, `TYPE_BASELINE=lower`) |
| `tests/ci/themes.test.js` | a theme missing from the registry, `styles.css` or i18n; a non-token rule or a colour outside `@media screen` in a theme file; a theme over 1.5 KB gzip; a rule in `www/css` or a template `<style>` that sets an accent, sale, wholesale, positive or negative fill and white text together |
| `tests/ci/theme-contrast.test.js` | a text / background pair under 4.5:1 in any theme × mode |
| `tests/ci/icon-sprite.test.js` | a missing `#i-*` symbol, or the sprite growing too large |
| `www/js/__tests__/theme-manager.test.js`, `theme-boot.test.js` | Appearance, System, preview and the pre-paint boot |
| `tests/e2e/themes.spec.js` | axe contrast on Billing, Today, Outstanding and the open More sheet per theme × mode; the gallery preview, Cancel, Apply |
| `tests/e2e/app-shell.spec.js` | the phone app bar title (en, hi), one `main`, the More sheet's focus, Tab, Esc and Back; the desktop sidebar |
| `tests/e2e/a11y-contrast.spec.js`, `billing-fold.spec.js` | contrast on the main pages (en, hi); Save / Print above the fold |
