# Modular Code Structure

## Overview
The application uses ES6 modules with a clean separation of concerns for maintainability and scalability.

## Directory Structure

```
www/js/
├── utils/
│   ├── constants.js          # App constants (time delays, ESC/POS commands)
│   ├── state.js              # Global application state (AppState)
│   ├── helpers.js            # Utility functions (escapeHtml, debounce, formatDate, etc.)
│   ├── dates.js / money.js   # Bill-date parsing (IST-safe), payment/rounding helpers
│   ├── stock-*.js, history-*.js  # Pure stock replay / history-window logic
│   ├── keyboard-shortcuts.js # Desktop shortcuts (>= 1024px)
│   ├── release-info.js       # Pure logic for the update banner / What's new
│   └── template-loader.js    # Dynamic HTML template loading
├── ui/
│   ├── ui-manager.js         # UI utilities (loading, toast, modal, haptic)
│   ├── infinite-scroll.js    # Paged history lists
│   └── navigation.js         # Tab navigation and menu management
├── auth/
│   └── authentication.js     # Login, register, logout, role management
├── firebase/
│   └── firestore-service.js  # Firestore CRUD operations
├── modules/
│   ├── admin.js              # Owner admin panel: configure, users, data
│   ├── app-updates.js        # Update banner + What's new sheet
│   ├── billing.js            # Core billing coordinator (mode switching, drafts, auto-save)
│   ├── purchase.js           # Purchase bill creation (weights, rates, labor)
│   ├── retail-sale.js        # Retail sale creation (weights, rates, payment)
│   ├── wholesale-sales.js    # Wholesale sales (sales tab)
│   ├── cash-management.js    # Session-based cash tracking
│   ├── day.js                # Today page
│   ├── diagnostics.js        # Owner view of telemetry errors + audit logs
│   ├── insights.js           # Insights page: to do, items, parties, seasons
│   ├── money.js              # Money page: profit, cash, spending, worth
│   ├── history.js            # Bill history and editing
│   ├── items.js              # Items and rates management
│   ├── miscellaneous.js      # Expenses and withdrawals
│   ├── outstanding.js        # Outstanding payments tracking
│   ├── rate-trends.js        # Trends / Product traffic (mounted in Insights › Seasons)
│   ├── settings.js           # App settings, audit logs, storage stats
│   ├── statements.js         # Statements: day book, month, ledgers, CSV
│   ├── stock.js              # Stock tracking and adjustments
│   └── users.js              # User management and roles
├── services/
│   ├── audit.js              # Audit logging (90-day retention)
│   ├── install-prompt.js     # PWA install card
│   ├── telemetry.js          # Error capture/grouping -> telemetry collection
│   └── printer.js            # Bluetooth thermal printer (ESC/POS)
└── main.js                   # Application initialization
```

## Module Descriptions

### Utils

| Module | Description |
|--------|-------------|
| `constants.js` | Time constants, ESC/POS printer commands |
| `state.js` | Central AppState object for all global data |
| `helpers.js` | `escapeHtml()`, `debounce()`, `formatDate()`, `formatCurrency()`, `generateId()`, `pickContact()` |
| `template-loader.js` | Dynamically loads HTML templates |

### UI

| Module | Description |
|--------|-------------|
| `ui-manager.js` | `showLoading()`, `showToast()`, `showModal()`, haptic feedback |
| `navigation.js` | Tab switching, side menu, navigation state |

### Services

| Module | Description |
|--------|-------------|
| `audit.js` | `AuditService.log()`, `cleanupOldLogs()`, `getRecentLogs()` - 90-day retention |
| `printer.js` | Bluetooth printer connection, ESC/POS bill formatting |

### Business Modules

| Module | Description |
|--------|-------------|
| `billing.js` | Core billing coordinator - mode switching, item dropdowns, drafts, auto-save, edit bill |
| `purchase.js` | Purchase operations - weights, bill items, totals, payment, save to Firebase `purchases` collection |
| `retail-sale.js` | Retail sale operations - weights, sale items, totals, payment, save to Firebase `retailSales` collection |
| `wholesale-sales.js` | Wholesale sales (sales tab) with stock deduction, saves to Firebase `wholesaleSales` collection |
| `items.js` | Item CRUD, purchase/sale/wholesale rates |
| `stock.js` | Stock levels, adjustments, history |
| `history.js` | Bill history, view/edit/delete bills |
| `cash-management.js` | Cash session sign-in/out, balance tracking |
| `outstanding.js` | Customer/supplier outstanding amounts |
| `money.js` | Money page: profit, cash, spending, net worth (figures from `utils/business-metrics.js`) |
| `insights.js` | Insights page: to do, items, parties, seasons |
| `statements.js` | Statements: day book, month statement, ledgers, CSV / PDF / WhatsApp |
| `miscellaneous.js` | Expenses, withdrawals |
| `settings.js` | App settings, audit log viewer, storage stats |
| `users.js` | User approval, role management (owner only) |

## Global Exports

All modules export to `window.app` namespace for HTML onclick handlers:

```javascript
window.app = {
    items: ItemsManager,
    billing: BillingManager,
    sales: SalesManager,
    stock: StockManager,
    // ... etc
};
```

## Loading

Modules are loaded via ES6 imports in `main.js`. The app initializes on `DOMContentLoaded`.
