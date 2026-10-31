/**
 * @fileoverview Mock Firebase/Firestore services for unit testing
 * Provides mock implementations of FirebaseService methods
 * @module __tests__/__mocks__/firebase-mock
 */

/**
 * Mock data store for testing
 */
export const mockDataStore = {
    items: [],
    purchases: [],
    retailSales: [],
    sales: [],
    expenses: [],
    stockAdjustments: [],
    withdrawals: [],
    cashSessions: [],
    users: []
};

/**
 * Reset all mock data to initial state
 */
export function resetMockData() {
    mockDataStore.items = [];
    mockDataStore.purchases = [];
    mockDataStore.retailSales = [];
    mockDataStore.sales = [];
    mockDataStore.expenses = [];
    mockDataStore.stockAdjustments = [];
    mockDataStore.withdrawals = [];
    mockDataStore.cashSessions = [];
    mockDataStore.users = [];
}

/**
 * Mock FirebaseService for testing
 * Implements the same interface as the real FirebaseService
 */
export const MockFirebaseService = {
    // Items
    async loadItems() {
        return [...mockDataStore.items];
    },

    async saveItem(item) {
        if (item.id) {
            const index = mockDataStore.items.findIndex(i => i.id === item.id);
            if (index >= 0) {
                mockDataStore.items[index] = item;
            }
        } else {
            item.id = `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            mockDataStore.items.push(item);
        }
        return item;
    },

    async deleteItem(itemId) {
        const index = mockDataStore.items.findIndex(i => i.id === itemId);
        if (index >= 0) {
            mockDataStore.items.splice(index, 1);
        }
    },

    // Purchases
    async loadPurchases() {
        return [...mockDataStore.purchases];
    },

    async savePurchase(purchase) {
        if (purchase.id) {
            const index = mockDataStore.purchases.findIndex(b => b.id === purchase.id);
            if (index >= 0) {
                mockDataStore.purchases[index] = purchase;
            }
        } else {
            purchase.id = `purchase_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            mockDataStore.purchases.push(purchase);
        }
        return purchase;
    },

    async deletePurchase(purchaseId) {
        const index = mockDataStore.purchases.findIndex(b => b.id === purchaseId);
        if (index >= 0) {
            mockDataStore.purchases.splice(index, 1);
        }
    },

    // Sales (Wholesale)
    async loadSales() {
        return [...mockDataStore.sales];
    },

    async saveWholesaleSale(sale) {
        if (sale.id) {
            const index = mockDataStore.sales.findIndex(s => s.id === sale.id);
            if (index >= 0) {
                mockDataStore.sales[index] = sale;
            }
        } else {
            sale.id = `sale_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            mockDataStore.sales.push(sale);
        }
        return sale;
    },

    async deleteSale(saleId) {
        const index = mockDataStore.sales.findIndex(s => s.id === saleId);
        if (index >= 0) {
            mockDataStore.sales.splice(index, 1);
        }
    },

    // Expenses
    async loadExpenses() {
        return [...mockDataStore.expenses];
    },

    async saveExpense(expense) {
        expense.id = `expense_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        mockDataStore.expenses.push(expense);
        return expense;
    },

    async deleteExpense(expenseId) {
        const index = mockDataStore.expenses.findIndex(e => e.id === expenseId);
        if (index >= 0) {
            mockDataStore.expenses.splice(index, 1);
        }
    },

    // Stock Adjustments
    async loadStockAdjustments() {
        return [...mockDataStore.stockAdjustments];
    },

    async saveStockAdjustment(adjustment) {
        adjustment.id = `adj_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        mockDataStore.stockAdjustments.push(adjustment);
        return adjustment;
    },

    // Withdrawals
    async loadWithdrawals() {
        return [...mockDataStore.withdrawals];
    },

    async saveWithdrawal(withdrawal) {
        withdrawal.id = `wd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        mockDataStore.withdrawals.push(withdrawal);
        return withdrawal;
    },

    // Cash Sessions
    async loadCashSessions() {
        return [...mockDataStore.cashSessions];
    },

    // Retail Sales
    async loadRetailSales() {
        return [...mockDataStore.retailSales];
    },

    async saveRetailSale(sale) {
        if (sale.id) {
            const index = mockDataStore.retailSales.findIndex(s => s.id === sale.id);
            if (index >= 0) {
                mockDataStore.retailSales[index] = sale;
            }
        } else {
            sale.id = `retail_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            mockDataStore.retailSales.push(sale);
        }
        return sale;
    },

    async deleteRetailSale(saleId) {
        const index = mockDataStore.retailSales.findIndex(s => s.id === saleId);
        if (index >= 0) {
            mockDataStore.retailSales.splice(index, 1);
        }
    },

    // Stock calculation mock
    async calculateStock() {
        const stock = {};
        
        // Add stock from purchases
        mockDataStore.purchases.forEach(purchase => {
            if (purchase.items) {
                purchase.items.forEach(item => {
                    const key = item.itemId || item.name;
                    if (!stock[key]) {
                        stock[key] = { quantity: 0, rate: 0 };
                    }
                    stock[key].quantity += parseFloat(item.weight || item.quantity || 0);
                    stock[key].rate = parseFloat(item.rate || 0);
                });
            }
        });

        // Subtract stock from wholesale sales
        mockDataStore.sales.forEach(sale => {
            if (sale.items) {
                sale.items.forEach(item => {
                    const key = item.itemId || item.name;
                    if (stock[key]) {
                        stock[key].quantity -= parseFloat(item.qty || item.quantity || 0);
                    }
                });
            }
        });

        // Subtract stock from retail sales
        mockDataStore.retailSales.forEach(sale => {
            if (sale.items) {
                sale.items.forEach(item => {
                    const key = item.itemId || item.name;
                    if (stock[key]) {
                        stock[key].quantity -= parseFloat(item.qty || item.quantity || 0);
                    }
                });
            }
        });

        return stock;
    },

    // Real-time listeners (no-op for testing)
    setupRealtimeListeners() {},
    cleanup() {}
};

/**
 * Mock AppState for testing
 */
export const MockAppState = {
    currentUser: { uid: 'test-user-123', email: 'test@example.com' },
    userName: 'Test User',
    userRole: 'owner',
    items: [],
    purchaseHistory: [],
    retailSalesHistory: [],
    salesHistory: [],
    expensesHistory: [],
    stockAdjustments: [],
    stock: {},
    settings: {
        laborRate: 5,
        defaultWeightMode: 'gross',
        showHindi: false
    },
    billItems: [],
    modalResolve: null
};

/**
 * Reset AppState to initial values
 */
export function resetMockAppState() {
    MockAppState.items = [];
    MockAppState.purchaseHistory = [];
    MockAppState.retailSalesHistory = [];
    MockAppState.salesHistory = [];
    MockAppState.expensesHistory = [];
    MockAppState.stockAdjustments = [];
    MockAppState.stock = {};
    MockAppState.billItems = [];
}
