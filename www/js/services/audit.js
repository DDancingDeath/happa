// Audit Logging Service
import { AppState } from '../utils/state.js';
import { addAuditLog, recentAuditLogs, auditLogsSince, deleteAuditLogsBefore } from '../firebase/repos/audit-logs.js';

export class AuditService {
    // Retention period in days
    static RETENTION_DAYS = 90;
    
    static ACTIONS = {
        // Bills
        CREATE_BILL: 'CREATE_BILL',
        DELETE_BILL: 'DELETE_BILL',
        EDIT_BILL: 'EDIT_BILL',
        // A bill kept but left out of every figure (#75); details.billType says which
        VOID_BILL: 'VOID_BILL',
        
        // Sales
        CREATE_SALE: 'CREATE_SALE',
        DELETE_SALE: 'DELETE_SALE',
        EDIT_SALE: 'EDIT_SALE',
        
        // Items
        CREATE_ITEM: 'CREATE_ITEM',
        DELETE_ITEM: 'DELETE_ITEM',
        EDIT_ITEM: 'EDIT_ITEM',
        
        // Payments
        RECORD_PAYMENT: 'RECORD_PAYMENT',
        UPDATE_PAYMENT: 'UPDATE_PAYMENT',
        CLEAR_DUE: 'CLEAR_DUE',
        
        // Stock
        ADJUST_STOCK: 'ADJUST_STOCK',
        // Owner/manager saved a bill past a blocking check (#37 / #188)
        OVERRIDE_CHECK: 'OVERRIDE_CHECK',
        
        // Finance
        RECORD_WITHDRAWAL: 'RECORD_WITHDRAWAL',
        RECORD_EXPENSE: 'RECORD_EXPENSE',
        // Cash day opened / counted and closed (#85)
        CASH_OPEN: 'CASH_OPEN',
        CASH_CLOSE: 'CASH_CLOSE',
        // Shared settings (Settings › Aadhat) with before → after (#85)
        SETTINGS_CHANGE: 'SETTINGS_CHANGE',
        // Owner hid error reports in Diagnostics (#116; kept in Firestore)
        HIDE_ERRORS: 'HIDE_ERRORS',
        
        // Data Management
        CLEAR_DATA: 'CLEAR_DATA',
        // Owner changed Roles & access (#84)
        CHANGE_ROLE_ACCESS: 'CHANGE_ROLE_ACCESS',
        // Owner actions on accounts (#85, #84)
        APPROVE_USER: 'APPROVE_USER',
        REJECT_USER: 'REJECT_USER',
        CHANGE_USER_ROLE: 'CHANGE_USER_ROLE',
        REMOVE_USER: 'REMOVE_USER',
        RESTORE_USER: 'RESTORE_USER',
        
        // Auth
        LOGIN: 'LOGIN',
        LOGOUT: 'LOGOUT'
    };

    static async log(action, details = {}) {
        try {
            const user = firebase.auth().currentUser;
            
            const auditEntry = {
                action,
                userId: user?.uid || 'unknown',
                userName: String(AppState.userName || 'Unknown User').slice(0, 200),
                userRole: String(AppState.userRole || 'unknown').slice(0, 32),
                details: typeof details === 'string' ? { message: details } : details,
                timestamp: Date.now(),
                date: new Date().toISOString()
            };
            
            // Fire-and-forget: the entry is queued locally (offline persistence)
            // and synced in the background, so callers never wait on the network.
            // The repository adds serverTime (trusted time of the write, #55);
            // `timestamp` stays for ordering.
            addAuditLog(auditEntry)
                .catch(error => console.error('[AUDIT ERROR]', error));
            
        } catch (error) {
            // Don't let audit failures break the app
            console.error('[AUDIT ERROR]', error);
        }
    }

    /** Fire-and-forget log for an action that already succeeded; never throws or blocks. */
    static note(action, details = {}) {
        this.log(action, details).catch(e => console.warn('Audit entry not written:', e?.code || e));
    }

    static async getRecentLogs(limit = 50) {
        try {
            return await recentAuditLogs({ limit });
        } catch (error) {
            console.error('Error fetching audit logs:', error);
            return [];
        }
    }

    /** Entries since from (ms), newest first; throws on a failed read (the caller says so). */
    static getLogsSince(from, limit = 300) {
        return auditLogsSince(from, limit);
    }

    static async getLogsByUser(userId, limit = 50) {
        try {
            return await recentAuditLogs({ userId, limit });
        } catch (error) {
            console.error('Error fetching user audit logs:', error);
            return [];
        }
    }

    static async getLogsByAction(action, limit = 50) {
        try {
            return await recentAuditLogs({ action, limit });
        } catch (error) {
            console.error('Error fetching action audit logs:', error);
            return [];
        }
    }

    /**
     * Clean up old audit logs beyond retention period
     * Called automatically when app loads (for owners only)
     */
    static async cleanupOldLogs() {
        try {
            // Only owners can delete logs
            if (AppState.userRole !== 'owner') {
                return { deleted: 0, skipped: true };
            }
            
            // Run at most once per day per device: each run costs up to 100 reads.
            const CLEANUP_KEY = 'auditCleanupLastRun';
            const lastRun = Number(localStorage.getItem(CLEANUP_KEY)) || 0;
            if (Date.now() - lastRun < 24 * 60 * 60 * 1000) {
                return { deleted: 0, skipped: true };
            }
            localStorage.setItem(CLEANUP_KEY, String(Date.now()));
            
            // One spare day so a phone clock running ahead never asks for a
            // log the rules still protect (they allow deleting > 90 days).
            const cutoffDate = Date.now() - ((this.RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
            
            // Logs older than the retention period, at most 100 per run (one batch)
            const deleted = await deleteAuditLogsBefore(cutoffDate, 100);
            return { deleted };
            
        } catch (error) {
            console.error('[AUDIT] Cleanup error:', error);
            return { deleted: 0, error: error.message };
        }
    }
}
