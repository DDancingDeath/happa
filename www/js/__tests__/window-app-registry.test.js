/**
 * Every inline handler (`onclick="window.app.x.y(...)"` and other `on*=`
 * attributes) in templates, index.html and HTML rendered from JS must name a
 * method that `main.js` (or a lazily loaded section) registers on `window.app`.
 * AadhatManagementApp#74: Admin → Users "Reset password" / "Delete" threw because
 * the facade did not expose them.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const WWW = path.resolve(__dirname, '..', '..');

function listFiles(dir, ext, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'lib' || entry.name === 'vendor') continue;
            listFiles(full, ext, out);
        } else if (entry.name.endsWith(ext)) {
            out.push(full);
        }
    }
    return out;
}

function parse(src) {
    const opts = { ecmaVersion: 'latest', allowHashBang: true, allowAwaitOutsideFunction: true };
    try {
        return acorn.parse(src, { ...opts, sourceType: 'module' });
    } catch {
        return acorn.parse(src, { ...opts, sourceType: 'script' });
    }
}

function keyName(prop) {
    if (prop.computed) return null;
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    return null;
}

function memberPath(node) {
    const parts = [];
    while (node && node.type === 'MemberExpression' && !node.computed) {
        parts.unshift(node.property.name);
        node = node.object;
    }
    if (!node || node.type !== 'Identifier') return null;
    parts.unshift(node.name);
    return parts;
}

// `...Object.fromEntries(['a', 'b'].map(name => [name, fn]))` (lazy-loaded sections in main.js)
function spreadNames(spread) {
    const call = spread.argument;
    if (call?.type !== 'CallExpression' || memberPath(call.callee)?.join('.') !== 'Object.fromEntries') return [];
    const mapped = call.arguments[0];
    const list = mapped?.type === 'CallExpression' && mapped.callee.type === 'MemberExpression' ? mapped.callee.object : null;
    if (list?.type !== 'ArrayExpression') return [];
    return list.elements.filter((e) => e?.type === 'Literal' && typeof e.value === 'string').map((e) => e.value);
}

function addObject(defined, prefix, obj) {
    for (const prop of obj.properties) {
        if (prop.type === 'SpreadElement') {
            spreadNames(prop).forEach((name) => defined.add(prefix ? `${prefix}.${name}` : name));
            continue;
        }
        if (prop.type !== 'Property') continue;
        const name = keyName(prop);
        if (!name) continue;
        const p = prefix ? `${prefix}.${name}` : name;
        defined.add(p);
        if (prop.value.type === 'ObjectExpression') addObject(defined, p, prop.value);
    }
}

function collectRegistry() {
    const jsFiles = listFiles(path.join(WWW, 'js'), '.js');
    const asts = jsFiles.map((f) => ({ file: f, ast: parse(fs.readFileSync(f, 'utf8')) }));
    const objectsByName = new Map();
    for (const { ast } of asts) {
        walk.simple(ast, {
            VariableDeclarator(node) {
                if (node.id.type === 'Identifier' && node.init?.type === 'ObjectExpression') {
                    objectsByName.set(node.id.name, node.init);
                }
            }
        });
    }
    const resolveObject = (expr) => {
        if (expr.type === 'ObjectExpression') return expr;
        const parts = memberPath(expr);
        if (!parts) return null;
        for (let i = 0; i < parts.length; i++) {
            let obj = objectsByName.get(parts[i]);
            if (!obj) continue;
            for (const key of parts.slice(i + 1)) {
                const prop = obj.properties.find((p) => p.type === 'Property' && keyName(p) === key);
                obj = prop && prop.value.type === 'ObjectExpression' ? prop.value : null;
                if (!obj) break;
            }
            if (obj) return obj;
        }
        return null;
    };

    const defined = new Set();
    for (const { ast } of asts) {
        walk.simple(ast, {
            AssignmentExpression(node) {
                const target = memberPath(node.left);
                if (!target || target[0] !== 'window' || target[1] !== 'app') return;
                const prefix = target.slice(2).join('.');
                if (prefix) defined.add(prefix);
                if (node.right.type === 'ObjectExpression') addObject(defined, prefix, node.right);
            },
            CallExpression(node) {
                const callee = memberPath(node.callee);
                if (!callee || callee.join('.') !== 'Object.assign' || node.arguments.length < 2) return;
                const target = memberPath(node.arguments[0]);
                if (!target || target[0] !== 'window' || target[1] !== 'app') return;
                const prefix = target.slice(2).join('.');
                for (const src of node.arguments.slice(1)) {
                    const obj = resolveObject(src);
                    if (obj) addObject(defined, prefix, obj);
                }
            }
        });
    }
    return defined;
}

const HANDLER_ATTR = /\bon[a-z]+\s*=\s*(["'])([\s\S]*?)\1/g;
const APP_CALL = /window\.app\.([\w$]+(?:\.[\w$]+)*)\s*\(/g;

function collectHandlerCalls() {
    const files = [
        ...listFiles(path.join(WWW, 'templates'), '.html'),
        path.join(WWW, 'index.html'),
        ...listFiles(path.join(WWW, 'js'), '.js')
    ];
    const calls = [];
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        for (const attr of src.matchAll(HANDLER_ATTR)) {
            for (const call of attr[2].matchAll(APP_CALL)) {
                const line = src.slice(0, attr.index).split('\n').length;
                calls.push({ where: `${path.relative(WWW, file)}:${line}`, path: call[1] });
            }
        }
    }
    return calls;
}

describe('window.app registry (AadhatManagementApp#74)', () => {
    const defined = collectRegistry();
    const calls = collectHandlerCalls();

    test('finds the facade and the inline handlers', () => {
        expect(defined.has('admin.init')).toBe(true);
        expect(calls.length).toBeGreaterThan(100);
    });

    test('every inline window.app handler exists on the facade', () => {
        const missing = calls.filter((c) => !defined.has(c.path)).map((c) => `${c.where} window.app.${c.path}`);
        expect(missing).toEqual([]);
    });

    test('Admin → Users reset password and delete are registered', () => {
        expect(defined.has('admin.resetUserPassword')).toBe(true);
        expect(defined.has('admin.deleteUser')).toBe(true);
    });
});
