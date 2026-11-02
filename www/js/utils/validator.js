/**
 * Validation Utility Module
 * Provides client-side form validation before Firebase calls
 */

import { formatKg } from './money.js';

/**
 * Validation result object
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether validation passed
 * @property {string[]} errors - Array of error messages
 */

export const Validator = {
    /**
     * Validate that a value is not empty
     * @param {*} value - Value to check
     * @param {string} fieldName - Name of field for error message
     * @returns {ValidationResult}
     */
    required(value, fieldName) {
        const valid = value !== null && value !== undefined && String(value).trim() !== '';
        return {
            valid,
            errors: valid ? [] : [`${fieldName} is required`]
        };
    },

    /**
     * Validate that a number is positive
     * @param {number} value - Number to validate
     * @param {string} fieldName - Name of field for error message
     * @returns {ValidationResult}
     */
    positiveNumber(value, fieldName) {
        const num = Number(value);
        const valid = !isNaN(num) && num > 0;
        return {
            valid,
            errors: valid ? [] : [`${fieldName} must be a positive number`]
        };
    },

    /**
     * Validate that a number is non-negative (zero or positive)
     * @param {number} value - Number to validate
     * @param {string} fieldName - Name of field for error message
     * @returns {ValidationResult}
     */
    nonNegativeNumber(value, fieldName) {
        const num = Number(value);
        const valid = !isNaN(num) && num >= 0;
        return {
            valid,
            errors: valid ? [] : [`${fieldName} must be zero or positive`]
        };
    },

    /**
     * Validate email format
     * @param {string} email - Email to validate
     * @returns {ValidationResult}
     */
    email(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const valid = emailRegex.test(email);
        return {
            valid,
            errors: valid ? [] : ['Please enter a valid email address']
        };
    },

    /**
     * Validate password strength
     * @param {string} password - Password to validate
     * @param {number} minLength - Minimum length (default 6)
     * @returns {ValidationResult}
     */
    password(password, minLength = 6) {
        const errors = [];
        if (!password || password.length < minLength) {
            errors.push(`Password must be at least ${minLength} characters`);
        }
        return {
            valid: errors.length === 0,
            errors
        };
    },

    /**
     * Validate that quantity doesn't exceed available stock
     * @param {number} quantity - Requested quantity
     * @param {number} available - Available stock
     * @param {string} itemName - Item name for error message
     * @returns {ValidationResult}
     */
    stockAvailable(quantity, available, itemName) {
        const valid = quantity <= available;
        return {
            valid,
            errors: valid ? [] : [`Insufficient stock for ${itemName}. Available: ${formatKg(available)}kg`]
        };
    },

    /**
     * Validate phone number format (Indian)
     * @param {string} phone - Phone number to validate
     * @returns {ValidationResult}
     */
    phoneNumber(phone) {
        if (!phone) return { valid: true, errors: [] }; // Optional field
        const phoneRegex = /^[6-9]\d{9}$/;
        const valid = phoneRegex.test(phone.replace(/\D/g, ''));
        return {
            valid,
            errors: valid ? [] : ['Please enter a valid 10-digit phone number']
        };
    },

    /**
     * Validate array of rates
     * @param {number[]} rates - Array of rates
     * @param {string} fieldName - Name of field for error message
     * @returns {ValidationResult}
     */
    ratesArray(rates, fieldName) {
        if (!Array.isArray(rates) || rates.length === 0) {
            return {
                valid: false,
                errors: [`At least one ${fieldName} is required`]
            };
        }
        const hasValidRate = rates.some(rate => rate && rate > 0);
        return {
            valid: hasValidRate,
            errors: hasValidRate ? [] : [`At least one valid ${fieldName} is required`]
        };
    },

    /**
     * Combine multiple validation results
     * @param {...ValidationResult} results - Validation results to combine
     * @returns {ValidationResult}
     */
    combine(...results) {
        const allErrors = results.flatMap(r => r.errors);
        return {
            valid: allErrors.length === 0,
            errors: allErrors
        };
    },

    /**
     * Validate bill data before saving
     * @param {Object} billData - Bill data object
     * @returns {ValidationResult}
     */
    validateBill(billData) {
        const checks = [];
        
        checks.push(this.required(billData.sellerName, 'Seller name'));
        
        if (!billData.items || billData.items.length === 0) {
            checks.push({ valid: false, errors: ['Please add at least one item to the bill'] });
        } else {
            billData.items.forEach((item, index) => {
                checks.push(this.required(item.name, `Item ${index + 1} name`));
                checks.push(this.positiveNumber(item.rate, `Item ${index + 1} rate`));
                checks.push(this.positiveNumber(item.weight || item.quantity, `Item ${index + 1} weight`));
            });
        }
        
        return this.combine(...checks);
    },

    /**
     * Validate sale data before saving
     * @param {Object} saleData - Sale data object
     * @returns {ValidationResult}
     */
    validateSale(saleData) {
        const checks = [];
        
        if (!saleData.items || saleData.items.length === 0) {
            checks.push({ valid: false, errors: ['Please add at least one item to the sale'] });
        } else {
            saleData.items.forEach((item, index) => {
                checks.push(this.required(item.name, `Item ${index + 1} name`));
                checks.push(this.positiveNumber(item.rate, `Item ${index + 1} rate`));
                checks.push(this.positiveNumber(item.qty || item.quantity, `Item ${index + 1} quantity`));
            });
        }
        
        return this.combine(...checks);
    },

    /**
     * Validate expense data before saving
     * @param {Object} expenseData - Expense data object
     * @returns {ValidationResult}
     */
    validateExpense(expenseData) {
        return this.combine(
            this.required(expenseData.type, 'Expense type'),
            this.positiveNumber(expenseData.amount, 'Amount')
        );
    },

    /**
     * Validate item data before saving
     * @param {Object} itemData - Item data object
     * @returns {ValidationResult}
     */
    validateItem(itemData) {
        return this.combine(
            this.required(itemData.name, 'Item name'),
            this.ratesArray(itemData.rates, 'purchase rate')
        );
    },

    /**
     * Validate stock adjustment data
     * @param {Object} adjustmentData - Adjustment data object
     * @returns {ValidationResult}
     */
    validateStockAdjustment(adjustmentData) {
        return this.combine(
            this.required(adjustmentData.itemName, 'Item'),
            this.positiveNumber(adjustmentData.quantity, 'Quantity'),
            this.positiveNumber(adjustmentData.rate, 'Rate')
        );
    },

    /**
     * Validate payment data
     * @param {Object} paymentData - Payment data object
     * @returns {ValidationResult}
     */
    validatePayment(paymentData) {
        return this.combine(
            this.positiveNumber(paymentData.amount, 'Payment amount')
        );
    },

    /**
     * Validate withdrawal data
     * @param {Object} withdrawalData - Withdrawal data object
     * @returns {ValidationResult}
     */
    validateWithdrawal(withdrawalData) {
        return this.combine(
            this.required(withdrawalData.personName, 'Person name'),
            this.positiveNumber(withdrawalData.amount, 'Amount')
        );
    }
};
