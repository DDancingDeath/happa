# Environment Separation Guide

## Overview

This app uses **collection prefixes** to separate development and production data within the **same Firebase project** (no extra project needed!):

| Environment | Collection Names | Example |
|-------------|------------------|---------|
| `production` | `items`, `purchases`, etc. | Normal collections |
| `development` | `dev_items`, `dev_purchases`, etc. | Prefixed collections |

## How It Works

### Automatic Detection

The app automatically detects the environment:

1. **URL Parameter** (highest priority): `?env=development`
2. **localStorage**: `localStorage.setItem('appEnv', 'development')`
3. **Hostname**: `localhost` → development, otherwise → production

### Visual Indicator

When running in development mode, you'll see an orange banner at the top of the screen showing "🔧 DEVELOPMENT".

## Usage

### For Development (testing locally)

```bash
# Just run locally - automatically uses dev_ prefix (localhost = development)
npx serve www
```

All data will be stored in `dev_items`, `dev_purchases`, `dev_retailSales`, etc.

### For Production (deployed app)

The deployed Happa site (`happa-bfc07.web.app`, see `happa.config.json`) automatically uses production (no prefix).

### Force Development on Production URL (for testing)

```bash
# One-time: only affects this page load
https://happa-bfc07.web.app/?env=development

# Persistent: set in browser console, persists across sessions
localStorage.setItem('appEnv', 'development');
```

### Switch Environments Manually

```javascript
// In browser console:

// Switch to development
localStorage.setItem('appEnv', 'development');
location.reload();

// Switch to production  
localStorage.setItem('appEnv', 'production');
location.reload();

// Clear override (use automatic detection)
localStorage.removeItem('appEnv');
location.reload();

// Check current environment
console.log(window.APP_ENV);  // 'development' or 'production'
console.log(window.COLLECTION_PREFIX);  // 'dev_' or ''
```

## Benefits of This Approach

✅ **No extra Firebase project needed** - Uses same project, different collections  
✅ **Free** - No additional costs  
✅ **Same auth** - Login works in both environments  
✅ **Easy cleanup** - Just delete `dev_*` collections when done testing  
✅ **Clear separation** - Production data is never touched during development  

## Viewing Dev Data in Firebase Console

In Firebase Console, you'll see both sets of collections:
- `items` (production)
- `dev_items` (development)
- `purchases` (production)
- `dev_purchases` (development)
- etc.

## Cleanup Dev Data

To delete all development data, go to Firebase Console and delete all collections starting with `dev_`.

Or use the app's "Clear All Data" feature while in development mode.

## Quick Reference

| Command | Effect |
|---------|--------|
| `?env=development` | Force dev environment |
| `?env=production` | Force prod environment |
| `localStorage.setItem('appEnv', 'development')` | Persist dev mode |
| `window.APP_ENV` | Check current environment |
| `window.COLLECTION_PREFIX` | Check current prefix (`dev_` or ``) |
| `window.getCollection('items')` | Get prefixed collection name |
