# Vendored third-party files

Served from our own origin so the service worker can precache them and the app
(PWA and Capacitor APK) can start with no network (issue #28). Do not edit these
files — replace them with a new versioned folder instead.

## Firebase JS SDK 10.7.1 (compat builds)

| File | Source | SHA-256 |
|---|---|---|
| `firebase/10.7.1/firebase-app-compat.js` | `https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js` | `af2a25c7827b5ac0eecc4e293b2644958037a4cc085ed5f5038aada31f3a4cf0` |
| `firebase/10.7.1/firebase-auth-compat.js` | `https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js` | `4e599f83d2eb9a581815a274178bf002aa517c305b85bf2489aeb5f42d26bcfb` |
| `firebase/10.7.1/firebase-firestore-compat.js` | `https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js` | `84b2e0c9480de124ed53b7206ae1a93fd5c62399e525a14bcfafc23930eaaac9` |

- Byte-identical to the gstatic CDN copies and to the same files in the
  `firebase@10.7.1` npm package (checked via jsDelivr).
- License: Apache License 2.0, Copyright Google LLC
  (https://github.com/firebase/firebase-js-sdk/blob/master/LICENSE). The
  minified builds carry no license header of their own.
- `index.html` loads them with `integrity="sha384-…"`; `load-perf.test.js`
  checks those hashes against the files on disk.

### Upgrading

1. Download the three `*-compat.js` files for the new version into
   `vendor/firebase/<version>/` and verify them against the npm package.
2. Update the `<script>` tags (src + integrity) in `index.html` and the
   `STATIC_ASSETS` entries in `service-worker.js`; delete the old folder.
3. Run `npm run check:sw` and `npm test`.

## SheetJS Community Edition 0.20.1 (`xlsx.mini.min.js`)

| File | Source | SHA-256 |
|---|---|---|
| `sheetjs/0.20.1/xlsx.mini.min.js` | `https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.mini.min.js` | `c2721014c290bbfee3b7fcf9998da38372d4d568c0706428d881323d8af0d1c9` |

- The small build (XLSX / CSV only) of the same release Items loads in full from
  the CDN (`XLSX_URL` in `js/utils/lazy-scripts.js`, whose SRI hash matched the
  downloaded full build). Excel files saved through `Exporter.saveWorkbook`
  (Ask item reports) use this copy, so they work offline (#415).
- In `LAZY_ASSETS` of `service-worker.js` (not precached; install caches it,
  best effort). `lazy-scripts.js` loads it with `integrity="sha384-…"`
  (`XLSX_WRITER_INTEGRITY`); `load-perf.test.js` checks it against the file.
- License: Apache License 2.0, Copyright SheetJS LLC
  (https://git.sheetjs.com/sheetjs/sheetjs/src/branch/master/LICENSE).
