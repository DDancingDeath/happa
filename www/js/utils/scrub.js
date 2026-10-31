/**
 * @fileoverview Removes personal data and secrets from error text before it is
 * stored (#116): error reports (telemetry) are read by the owner in Diagnostics,
 * so they must not carry emails, phone numbers, rupee amounts or tokens.
 * Pure: no Firestore, AppState or DOM.
 * @module utils/scrub
 */

const RULES = [
    // JSON Web Tokens (Firebase ID tokens) and Google API keys
    [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '<token>'],
    [/\bAIza[0-9A-Za-z_-]{20,}/g, '<key>'],
    // secrets in query strings or "key: value" text
    [/\b(access_token|id_token|refresh_token|token|apiKey|api_key|key|oobCode|password|auth|sig|signature)(=|:\s*)[^&\s"',;)]+/gi, '$1$2<redacted>'],
    [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <token>'],
    // emails (the lookbehind keeps a long run without "@" linear)
    [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
    // UPI ids (name@bank, no dot after the @)
    [/(?<![\w.-])[\w.-]{2,}@[a-z]{2,}\b/gi, '<upi>'],
    // Indian mobile numbers: +91 / 91 / 0 or nothing before, 98765 43210 or 987 654 3210 grouping.
    // Digits inside a longer run (13-digit times) or inside ids (letters and digits) never match.
    [/(?:\+91[\s-]?|\b91(?=[6-9]\d{9}\b)|\b0|\b)(?:[6-9]\d{4}[\s-]?\d{5}|[6-9]\d{2}[\s-]\d{3}[\s-]\d{4})\b/g, '<phone>'],
    // rupee amounts
    [/(₹|\bRs\.?|\bINR)\s?-?[\d,]+(?:\.\d+)?/gi, '₹<amount>'],
    // long opaque strings (tokens, keys); file paths and ordinary ids are shorter or contain "/".
    // A Firestore "create index" link describes the index, not a secret: kept.
    [/(?<!create_composite=)\b[A-Za-z0-9_-]{32,}\b/g, '<token>']
];

/** Longest text scrubbed (callers keep at most 4,000 characters anyway). */
const MAX_SCRUB = 8000;

/**
 * The text with personal data and secrets replaced by placeholders.
 * @param {*} value
 * @returns {*} strings scrubbed (and cut to MAX_SCRUB first); other values unchanged
 */
export function scrubText(value) {
    if (typeof value !== 'string' || !value) return value;
    return RULES.reduce((s, [re, to]) => s.replace(re, to), value.slice(0, MAX_SCRUB));
}

/** A page address without its query string (where tokens and codes travel); the #route is kept. */
export function scrubUrl(value) {
    if (typeof value !== 'string' || !value) return value;
    const [beforeHash, ...hash] = value.split('#');
    const path = beforeHash.split('?')[0];
    return scrubText(hash.length ? `${path}#${hash.join('#').split('?')[0]}` : path);
}

/**
 * A console.error argument as safe text: an Error's message, a string, a number;
 * for any other object only its `code` (data objects hold names and amounts).
 * @param {*} arg
 * @returns {string}
 */
export function describeLogArg(arg) {
    if (arg instanceof Error) return scrubText(arg.message);
    if (arg === null || arg === undefined) return String(arg);
    if (typeof arg === 'object') {
        const code = typeof arg.code === 'string' ? arg.code : '';
        return code ? `[object ${code}]` : '[object]';
    }
    return scrubText(String(arg));
}
