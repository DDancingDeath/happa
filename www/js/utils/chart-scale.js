/**
 * @fileoverview Y-axis top for small bar charts (Anomalies, Product traffic).
 * @module utils/chart-scale
 */

/** Largest value, or 1 when every value is 0 (bars never divide by zero). */
export function chartScaleMax(values) {
    const max = Math.max(0, ...values.map(v => Number(v) || 0));
    return max > 0 ? max : 1;
}