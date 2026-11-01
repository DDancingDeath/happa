# Un-awaited async calls — audit (#126)

Audit of async functions called without `await` in `www/js` (2026-10-21).
Guard: `www/js/__tests__/floating-promises.test.js` finds every call to an
async function that is not awaited, returned, assigned, passed on, or chained
with `.then` / `.catch`, and fails on anything not in its reviewed
allow-list. New code must await save/delete/money calls, or add a `.catch`
that tells the user (saves) or logs (background work).

Rule of thumb:

- **Saves / deletes / money** — `await` inside `try/catch`, and show the
  user a toast on failure. Inline `onclick` handlers can't catch, so the
  async function they call must catch everything itself.
- **Intentional fire-and-forget** (audit log, item frequency, autosave,
  rate-change notifications, cleanup) — keep it non-blocking but end the
  call with `.catch(e => console.warn(...))` so a failure is never an
  unhandled rejection.

## Fixed in this change

| Where | Call | Was | Now |
|---|---|---|---|
| `modules/items.js` addRate / deleteRate / addSaleRate / deleteSaleRate / addWholesaleRate / deleteWholesaleRate | `FirebaseService.saveItem` | Awaited but no `try`; called from inline `onclick` → rejection lost, rate list silently out of sync with the server | `_saveItemRates()`: try/catch, undo the local change, re-render, toast "Rate not saved" |
| `modules/items.js` (3 rate inputs) | `FirebaseService.notifyRateChange` | Floating inside a `try` that can't catch it | `.catch` → `console.warn` |
| `modules/miscellaneous.js` (business + personal expense save) | `printExpenseReceipt` | Floating; print failure was an unhandled rejection, user saw nothing | `.catch` → toast "Expense saved, but printing failed" |
| `modules/miscellaneous.js` (after expense save) ×2, `modules/cash-management.js` init | `calculateTodayTransactions` | Floating | `.catch` → `console.error` (no awaits inside, so ordering was already correct) |
| `modules/day.js` (after cash reset) | `cashManagement.init` | Floating in `setTimeout` | `.catch` → `console.error` |
| `modules/billing.js` edit bill / edit sale | `AuditService.log` | Floating | `.catch` → `console.warn` (stays non-blocking) |
| `modules/billing.js` mode switch + debounce | `autoSaveToCloud` | Floating | `.catch` → `console.warn` (stays non-blocking, PR #7) |
| `modules/billing.js`, `purchase.js`, `retail-sale.js` after clear/save | `deleteAutoSave` | Floating | `.catch` → `console.warn` |
| `main.js` startup | `AuditService.cleanupOldLogs` | Floating | `.catch` → `console.warn` |

## Reviewed and left floating (allow-list in the test)

| Where | Call | Why it's safe |
|---|---|---|
| `firebase/firestore-service.js` tab-shown listener | `flushPendingWork` | catches stock errors itself |
| `main.js` | `updateDraftCount` | own try/catch |
| `main.js` `editBillDetails` handler | `BillingManager.editBill` | own try/catch + toast |
| `modules/miscellaneous.js` | `editExpense` | no awaits; runs synchronously |
| `modules/purchase.js` / `retail-sale.js` | `addToBill` / `addToSalesBill` | no awaits; runs synchronously |
| `modules/settings.js` | `connectToPrinter` | own try/catch + toast |
| `modules/stock.js` | `renderStock`, `renderAdjustmentHistory` | UI refresh; own try/catch |
| `ui/infinite-scroll.js` | `trigger` | catches and shows the retry state |

## Inline-handler entry points checked for their own try/catch

Async functions called from `onclick` / `onchange` strings can't be awaited.
Checked: admin.js (approve / reject / role / reset / delete / storage /
clear data), billing.js `loadDraft` / `deleteDraft`,
outstanding.js `recordPayment` / `markAsCleared`, wholesale-sales.js
`recordPayment` / `markSaleAsCleared`, diagnostics.js `clearAll` /
`deleteError` / loaders, items.js `deleteItem` — all wrap their writes in
try/catch with a user message. items.js rate add/delete did not (fixed
above). Read-only / print-only handlers without a try
(`outstanding.showDetails`, `wholesaleSales.reprintSaleById`,
`history.viewBill`) don't write data and were left as they are.

## Not covered by the guard

- Names that are both sync and async somewhere (e.g. `init`, `showTab`,
  `renderHistory`) and `console.log` look-alikes are skipped by name; only
  `AuditService.log` is checked explicitly.
- A call inside an arrow body (`setTimeout(() => x())`) counts as consumed.
