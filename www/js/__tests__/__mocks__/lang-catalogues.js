// Jest stand-in for www/js/i18n/lang-catalogues.js (jest.config.js moduleNameMapper): both
// catalogues are loaded up front, so t() works in every language straight after import.
import en from '../../i18n/en.js';
import hi from '../../i18n/hi.js';

export const PRELOADED = { en, hi };

export function importCatalogue(lang) {
    return Promise.resolve({ default: lang === 'hi' ? hi : en });
}
