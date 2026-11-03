// @ts-check
// -------------------- CONSTANTS --------------------

// ESC/POS Commands
export const ESC = '\x1B';
export const GS = '\x1D';

// Default Settings
export const DEFAULT_SETTINGS = {
    heavyWeightThreshold: 30,
    laborRate: 6,
    autoLaborEnabled: true,
    showHindi: false
};

// Transaction Modes
export const TRANSACTION_MODES = {
    PURCHASE: 'purchase',
    SALE: 'sale'
};

// Filter Types
export const FILTER_TYPES = {
    TODAY: 'today',
    WEEK: 'week',
    MONTH: 'month',
    CUSTOM: 'custom',
    ALL: 'all'
};

// User Roles
export const USER_ROLES = {
    OWNER: 'owner',
    MANAGER: 'manager',
    STAFF: 'staff'
};

// Analytics Periods
export const ANALYTICS_PERIODS = {
    SEVEN_DAYS: '7days',
    THIRTY_DAYS: '30days',
    NINETY_DAYS: '90days',
    ALL_TIME: 'all'
};

// Time Constants (in milliseconds)
export const TIME_MS = {
    SECOND: 1000,
    MINUTE: 60 * 1000,
    HOUR: 60 * 60 * 1000,
    DAY: 24 * 60 * 60 * 1000,
    WEEK: 7 * 24 * 60 * 60 * 1000,
    THIRTY_DAYS: 30 * 24 * 60 * 60 * 1000
};

// Auto-save delay (milliseconds)
export const AUTO_SAVE_DELAY = 2000;

// App Configuration
export const APP_CONFIG = {
    // Set to true in development, false in production
    DEBUG_MODE: false,
    // Firebase collections
    COLLECTIONS: {
        ITEMS: 'items',
        PURCHASES: 'purchases',
        RETAIL_SALES: 'retailSales',
        WHOLESALE_SALES: 'wholesaleSales',
        EXPENSES: 'expenses',
        STOCK_ADJUSTMENTS: 'stockAdjustments',
        WITHDRAWALS: 'withdrawals',
        USERS: 'users',
        ITEM_FREQUENCY: 'itemFrequency',
        CASH_MANAGEMENT: 'cashManagement',
        NOTIFICATIONS: 'notifications'
    }
};
