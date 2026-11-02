#!/usr/bin/env node
/**
 * tests/a11y-keys.mjs: the keyboard-only walkthrough and the accessibility tree,
 * driven through Chrome DevTools with real key events (Input.dispatchKeyEvent),
 * so Tab, Enter and Escape behave as they do for a person at a keyboard.
 *
 * It checks: the Tab order through the toolbars; the sidebar (filter, arrows,
 * Enter to open, the delete button by keyboard); the command palette combobox;
 * the import menu; every dialog's focus trap, Escape and focus restore; the
 * template popover; the editor's Escape-then-Tab exit; the divider's keyboard
 * resizing; roles and names from Accessibility.getPartialAXTree; the focus
 * ring; the Drive dialog inside the viewport; no /favicon.ico request;
 * prefers-reduced-motion; and the in-memory fallback's status text.
 *
 * The checks are in four groups: dialogs, page (landmarks, divider, theme,
 * motion, favicon and the in-memory fallback), sidebar (with the Tab order) and
 * palette. The groups share one Chrome; each runs in its own browser context
 * (separate storage, a fresh page and app load), so they stay independent.
 *
 * Usage: node tests/a11y-keys.mjs [group...] [--shots <dir>]
 *   group          dialogs, page, sidebar or palette (default: all four)
 *   --shots <dir>  also save screenshots (light and dark focus rings, palette,
 *                  dialogs) there
 * tests/run-all.mjs runs each group as its own suite (a11y-keys-dialogs,
 * a11y-keys-page, a11y-keys-sidebar, a11y-keys-palette). Exit code 0 when every check passes.
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {launchChrome, sleep} from './lib/chrome.mjs';
import {startStaticServer} from './lib/static-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The browser-level DevTools socket URL of the Chrome on `port`, once it is up. */
async function browserSocketUrl(port) {
    for (let i = 0; i < 400; i++) {
        try {
            const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
            if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
        } catch (_e) { /* not up yet */ }
        await sleep(25);
    }
    throw new Error('no DevTools browser target');
}

/** A small DevTools client on one socket (browser or page) with events and a deadline on every call. */
async function openSession(wsUrl, {callTimeoutMs = 10000} = {}) {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
            else p.res(m.result);
        } else if (m.method) {
            for (const fn of listeners.get(m.method) || []) fn(m.params);
        }
    });
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, {once: true});
        ws.addEventListener('error', () => rej(new Error('DevTools socket error')), {once: true});
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
        const _id = id++;
        const timer = setTimeout(() => {
            pending.delete(_id);
            rej(new Error(`DevTools ${method} got no answer within ${callTimeoutMs} ms`));
        }, callTimeoutMs);
        pending.set(_id, {res, rej, timer, method});
        ws.send(JSON.stringify({id: _id, method, params}));
    });
    const on = (method, fn) => {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(fn);
    };
    const evalExpr = async (expression) => {
        const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
        if (r.exceptionDetails) {
            throw new Error('page threw: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
        }
        return r.result.value;
    };
    // A generous deadline: it only matters when a check fails, and slow CI CPUs must not.
    const waitFor = async (expr, what, timeoutMs = 10000) => {
        const end = Date.now() + timeoutMs;
        for (;;) {
            const v = await evalExpr(`(() => { try { return (${expr}) === true; } catch (e) { return false; } })()`);
            if (v === true) return;
            if (Date.now() > end) throw new Error('timed out waiting for ' + (what || expr));
            await sleep(25);
        }
    };
    return {send, on, evalExpr, waitFor, close: () => { try { ws.close(); } catch (_e) { /* closed */ } }};
}

// Key definitions for Input.dispatchKeyEvent (keyDown with text types a character).
const KEYS = {
    Tab: {code: 'Tab', keyCode: 9},
    Enter: {code: 'Enter', keyCode: 13, text: '\r'},
    Escape: {code: 'Escape', keyCode: 27},
    ' ': {code: 'Space', keyCode: 32, text: ' '},
    ArrowLeft: {code: 'ArrowLeft', keyCode: 37},
    ArrowUp: {code: 'ArrowUp', keyCode: 38},
    ArrowRight: {code: 'ArrowRight', keyCode: 39},
    ArrowDown: {code: 'ArrowDown', keyCode: 40},
    Home: {code: 'Home', keyCode: 36},
    End: {code: 'End', keyCode: 35},
    Delete: {code: 'Delete', keyCode: 46},
    k: {code: 'KeyK', keyCode: 75, text: 'k'},
};

/** Press and release one key, as a keyboard does. */
async function press(s, key, {shift = false, ctrl = false, alt = false} = {}) {
    const d = KEYS[key];
    if (!d) throw new Error('unknown key ' + key);
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const text = ctrl || alt ? undefined : d.text;
    const base = {key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, modifiers};
    await s.send('Input.dispatchKeyEvent', {type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? {text, unmodifiedText: text} : {})});
    await s.send('Input.dispatchKeyEvent', {type: 'keyUp', ...base});
}

/** What has focus, as a short readable name. */
const FOCUS = `(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    if (el.id) return el.id;
    if (el.classList.contains('skip-link')) return 'skip-link';
    if (el.dataset && el.dataset.fmt) return 'fmt:' + el.dataset.fmt;
    const item = el.closest('.doc-item');
    if (item) return (el.classList.contains('doc-del') ? 'doc-del:' : 'doc-open:') + item.querySelector('.doc-title').textContent;
    return el.tagName.toLowerCase() + '.' + el.className;
})()`;

/**
 * A document whose raw HTML ids copy every id pattern the palette options have
 * used (`cmdkOption<n>`, `cmdk-opt-<n>`) plus any `extra` ids, e.g. the option
 * ids of an earlier page load. Put in the editor so the preview renders it.
 */
const hostileDoc = (extra = []) => '# Hostile ids\n\n' + [
    ...[0, 1, 2, 3, 4].flatMap((n) => [`cmdkOption${n}`, `cmdk-opt-${n}`, `cmdk-option-${n}`, `bd-0000000000000000-cmdk-option-${n}`]),
    ...extra,
].map((id) => `<p id="${id}">decoy ${id}</p>`).join('\n') + '\n';

/** Put `text` in the editor and wait until the preview shows the first decoy. */
async function openHostileDoc(s, text) {
    await s.evalExpr(`(() => { const e = document.getElementById('editor'); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', {bubbles: true})); return true; })()`);
    await s.waitFor("!!document.querySelector('#preview p[id]')", 'decoys rendered');
}

/**
 * The palette's active option as Chrome reports it (the combobox's activedescendant
 * relation) and as the DOM resolves it: both must be an option inside #cmdk-list.
 */
async function activeOption(s) {
    const ax = await axOf(s, '#cmdk-input');
    const dom = await s.evalExpr(`(() => {
        const id = document.getElementById('cmdk-input').getAttribute('aria-activedescendant');
        const el = id && document.getElementById(id);
        return {id, inList: !!(el && el.closest('#cmdk-list') && el.getAttribute('role') === 'option'), text: el ? el.textContent : null};
    })()`);
    return {axIds: ax.props.activedescendant || [], ...dom};
}

/**
 * In the page: window.__glyphContrast(el), the WCAG contrast of el's text as
 * painted (its colour, alpha and opacity, and its ancestors' opacity) against the
 * background layers behind it.
 */
const GLYPH_CONTRAST = `(() => {
    const parse = (s) => { const p = /rgba?\\(([^)]+)\\)/.exec(s)[1].split(/[ ,/]+/).filter(Boolean).map(Number); return {r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1}; };
    const blend = (f, b, a) => ({r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a)});
    const lum = ({r, g, b}) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    window.__glyphContrast = (el) => {
        const layers = [];
        for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0) { layers.push(c); if (c.a === 1) break; } }
        let bg = {r: 255, g: 255, b: 255};
        for (const c of layers.reverse()) bg = blend(c, bg, c.a);
        const fg = parse(getComputedStyle(el).color);
        let alpha = fg.a;
        for (let n = el; n; n = n.parentElement) alpha *= Number(getComputedStyle(n).opacity);
        const [a, b] = [lum(blend(fg, bg, alpha)), lum(bg)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
    };
    return true;
})()`;

/** Move the real mouse pointer over the middle of the element matching `selector`. */
async function hover(s, selector) {
    const r = await s.evalExpr(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2}; })()`);
    await s.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x, y: r.y});
}

/** True while the palette, a dialog, a menu or the template popover is open. */
const OVERLAY_OPEN = `(() => {
    const shown = (el) => el && getComputedStyle(el).display !== 'none' && !el.hidden;
    return shown(document.getElementById('cmdk')) || shown(document.getElementById('drive-modal'))
        || [...document.querySelectorAll('.app-modal, .menu-list')].some(shown)
        || shown(document.getElementById('template-info-popover'));
})()`;

/** Runs before the app's scripts: IndexedDB cannot be opened, so the app falls back to memory. */
const BLOCK_INDEXEDDB = "Object.defineProperty(window, 'indexedDB', {configurable: true, get() { return {open() { throw new Error('IndexedDB blocked for this test'); }, deleteDatabase() { return {}; }}; }});";

/** Runs before the app's scripts: logs every crypto.getRandomValues result (as hex) in window.__randomOut. */
const RECORD_RANDOM = `(() => {
    const real = crypto.getRandomValues.bind(crypto);
    window.__randomOut = [];
    crypto.getRandomValues = (a) => {
        const r = real(a);
        window.__randomOut.push(Array.from(r, (b) => b.toString(16).padStart(2, '0')).join(''));
        return r;
    };
})();`;

/** The state RESET_APP produces. */
const RESET_DONE = "!document.querySelector('[inert]') && document.querySelector('#main').classList.contains('view-split') && document.documentElement.dataset.theme === 'light'";

/** Back to a known state: no filter, split view, light theme, no stubs, focus on <body>. True once there. */
const RESET_APP = `(async () => {
    const f = document.getElementById('doc-filter');
    if (f.value) { f.value = ''; f.dispatchEvent(new Event('input', {bubbles: true})); await window.__bd.renderSidebar(); }
    if (!document.getElementById('main').classList.contains('view-split')) document.querySelector('#menu-view-list [data-view=split]').click();
    if (document.documentElement.dataset.theme !== 'light') document.getElementById('btn-theme').click();
    // Checks stub window.open and confirm: put the browser's own back (saved on the first reset).
    if (!window.__orig) window.__orig = {open: window.open, confirm: window.confirm};
    window.open = window.__orig.open;
    window.confirm = window.__orig.confirm;
    if (document.activeElement) document.activeElement.blur();
    return ${RESET_DONE};
})()`;

/** The accessibility node of the element matching `selector` (role, name, properties). */
async function axOf(s, selector) {
    const {root: doc} = await s.send('DOM.getDocument', {depth: 0});
    const {nodeId} = await s.send('DOM.querySelector', {nodeId: doc.nodeId, selector});
    if (!nodeId) throw new Error('no element ' + selector);
    const {nodes} = await s.send('Accessibility.getPartialAXTree', {nodeId, fetchRelatives: false});
    const n = nodes[0];
    const props = {};
    // Relations (activedescendant, controls) carry their target ids in relatedNodes.
    for (const p of n.properties || []) {
        props[p.name] = p.value && (p.value.relatedNodes ? p.value.relatedNodes.map((r) => r.idref) : p.value.value);
    }
    return {role: n.role && n.role.value, name: n.name && n.name.value, value: n.value && n.value.value, ignored: !!n.ignored, props};
}

/** Every unignored node of the full accessibility tree, as {role, name}. */
async function axTree(s) {
    const {nodes} = await s.send('Accessibility.getFullAXTree', {});
    return nodes.filter((n) => !n.ignored).map((n) => ({role: n.role && n.role.value, name: n.name && n.name.value}));
}

/**
 * The checks come in groups by concern, which tests/run-all.mjs runs and times
 * as separate suites (a11y-keys-sidebar, ...). Each group gets its own browser
 * context: separate storage, a fresh page and a fresh app load.
 */
// The lightest group comes first in run-all: the first group run also starts Chrome.
export const A11Y_KEY_GROUPS = Object.freeze(['dialogs', 'page', 'sidebar', 'palette']);

// One Chrome for every group: starting Chrome and its first page load take
// seconds on a slow CI CPU. The groups stay independent through their contexts.
let shared = null;

async function sharedBrowser() {
    if (!shared) {
        const browser = await launchChrome('about:blank', {extraArgs: ['--hide-scrollbars', '--window-size=1400,900']});
        try {
            shared = {browser, session: await openSession(await browserSocketUrl(browser.port))};
        } catch (e) {
            await browser.stop();
            throw e;
        }
    }
    return shared;
}

/** Stop the Chrome the groups share (runA11yKeys does this itself unless keepBrowser is set). */
export async function closeA11yKeysBrowser() {
    if (!shared) return;
    const {browser, session} = shared;
    shared = null;
    session.close();
    await browser.stop();
}

/**
 * @param {{log?: Function, shotsDir?: string|null, groups?: string[], keepBrowser?: boolean}} [opts]
 *        groups: which of A11Y_KEY_GROUPS to run (default all); keepBrowser: leave
 *        Chrome running for the next call (then call closeA11yKeysBrowser at the end)
 * @returns {Promise<boolean>} true when every check passed
 */
export async function runA11yKeys({log = console.log, shotsDir = null, groups = A11Y_KEY_GROUPS, keepBrowser = false} = {}) {
    const unknown = groups.filter((g) => !A11Y_KEY_GROUPS.includes(g));
    if (unknown.length) throw new Error('unknown a11y-keys group: ' + unknown.join(', '));
    const server = await startStaticServer(root);
    const results = [];
    let current = null;   // the open app session; reset() puts it back in a known state
    let firstLoadOptionIds = [];   // palette option ids of the first page load
    // Every check starts from a known state: each session is reset before its first
    // check, and every check is followed by a reset that runs even when it throws,
    // so one failure cannot cascade into the next check.
    const check = async (name, fn) => {
        const started = Date.now();
        try {
            await fn();
            results.push({name, ok: true});
            log(`PASS  ${name}  (${Date.now() - started} ms)`);
        } catch (e) {
            results.push({name, ok: false});
            log(`FAIL  ${name}: ${(e && e.message) || e}`);
        } finally {
            if (current) {
                try {
                    await current.reset();
                } catch (e) {
                    log(`      (reset failed: ${(e && e.message) || e})`);
                }
            }
        }
    };
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
    if (shotsDir) mkdirSync(shotsDir, {recursive: true});

    async function withApp(fn, {beforeLoad = null} = {}) {
        const t0 = Date.now();
        const b = await sharedBrowser();
        const {browserContextId} = await b.session.send('Target.createBrowserContext', {});
        let s;
        let tChecks = 0;
        try {
            const {targetId} = await b.session.send('Target.createTarget', {url: 'about:blank', browserContextId});
            s = await openSession(`ws://127.0.0.1:${b.browser.port}/devtools/page/${targetId}`);
            const tChrome = Date.now();
            const requests = [];
            s.on('Network.responseReceived', (p) => requests.push({url: p.response.url, status: p.response.status}));
            for (const m of ['Page.enable', 'Network.enable', 'Runtime.enable', 'DOM.enable', 'Accessibility.enable']) await s.send(m);
            await s.send('Emulation.setDeviceMetricsOverride', {width: 1400, height: 900, deviceScaleFactor: 1, mobile: false});
            const BOOTED = '!!(window.__bd && window.__bd.docManager && window.__bd.docManager.currentId != null)';
            /** Load the app (again), optionally with a script that runs before the page's own. */
            s.load = async (preScript = null) => {
                if (preScript) await s.send('Page.addScriptToEvaluateOnNewDocument', {source: preScript});
                await s.send('Page.navigate', {url: `${server.origin}/index.html`});
                await s.waitFor(BOOTED, 'app boot', 20000);
                if (s.reset) await s.reset();
            };
            await s.load(beforeLoad);
            s.requests = requests;
            s.reset = async () => {
                // Close whatever is open (palette, dialogs, menus, popover) the way a user would.
                if (await s.evalExpr(OVERLAY_OPEN)) {
                    for (let i = 0; i < 5 && await s.evalExpr(OVERLAY_OPEN); i++) await press(s, 'Escape');
                    if (await s.evalExpr(OVERLAY_OPEN)) {
                        // Escape did not close it (a broken dialog): start again from a fresh load.
                        await s.send('Page.reload', {ignoreCache: true});
                        await s.waitFor(BOOTED, 'app reboot', 20000);
                    }
                }
                await s.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: 1, y: 899});
                if (!await s.evalExpr(RESET_APP)) await s.waitFor(RESET_DONE, 'reset state');
            };
            current = s;
            await s.reset();
            s.shot = async (name) => {
                if (!shotsDir) return;
                const {data} = await s.send('Page.captureScreenshot', {format: 'png'});
                writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
            };
            s.focus = () => s.evalExpr(FOCUS);
            tChecks = Date.now();
            log(`      (page ready in ${tChrome - t0} ms, app loaded in ${tChecks - tChrome} ms)`);
            await fn(s);
        } finally {
            current = null;
            const tStop = Date.now();
            if (s) s.close();
            await b.session.send('Target.disposeBrowserContext', {browserContextId}).catch(() => {});
            if (tChecks) log(`      (checks ${tStop - tChecks} ms, context closed in ${Date.now() - tStop} ms)`);
        }
    }

    /** Run one group's checks in a fresh Chrome, if that group was asked for. */
    const group = async (name, body, opts) => {
        if (groups.includes(name)) await withApp(body, opts);
    };

    try {
        await group('sidebar', async (s) => {
            // Three documents, so the sidebar has something to move through.
            await s.evalExpr(`(async () => {
                const dm = window.__bd.docManager;
                await dm.newDoc('# Alpha\\n\\nfirst');
                await dm.newDoc('# Beta notes\\n\\nsecond');
                await dm.newDoc('# Gamma\\n\\nthird');
                await window.__bd.renderSidebar();
                return true;
            })()`);
            await s.waitFor("document.querySelectorAll('#doc-list .doc-item').length === 4", 'four docs listed');

            await check('Tab order: skip link, nav toolbar, format bar, sidebar, editor', async () => {
                // Start where a fresh page starts: focus a throwaway, unfocusable-by-Tab
                // element at the top of <body>, so the next Tab finds the first stop.
                await s.evalExpr("(() => { const t = document.createElement('span'); t.tabIndex = -1; t.className = 'tab-start'; document.body.prepend(t); t.focus(); return true; })()");
                const order = [];
                for (let i = 0; i < 40; i++) {
                    await press(s, 'Tab');
                    const f = await s.focus();
                    order.push(f);
                    if (f === 'editor') break;
                }
                await s.evalExpr("document.querySelector('body > .tab-start').remove(), true");
                const nav = ['skip-link', 'btn-new', 'btn-open', 'btn-save', 'menu-import-trigger', 'menu-more-trigger',
                    'template-select', 'btn-template-info', 'menu-view-trigger', 'export-paper-size', 'export-orientation',
                    'btn-page-options', 'export-format', 'btn-export', 'btn-theme'];
                assert(JSON.stringify(order.slice(0, nav.length)) === JSON.stringify(nav), 'nav order ' + JSON.stringify(order));
                const fmtCount = await s.evalExpr("document.querySelectorAll('#toolbar-format button').length");
                const fmt = order.slice(nav.length, nav.length + fmtCount);
                assert(fmtCount === 17 && fmt.every((f) => f.startsWith('fmt:') || /^btn-(bold|italic)$/.test(f)), 'format bar next: ' + JSON.stringify(fmt));
                const rest = order.slice(nav.length + fmtCount);
                const want = ['sidebar-toggle', 'sidebar-new', 'sidebar-open', 'doc-filter', 'doc-open:Gamma', 'doc-del:Gamma', 'editor'];
                assert(JSON.stringify(rest) === JSON.stringify(want), 'sidebar then editor (one stop per list): ' + JSON.stringify(rest));
            });

            await check('focus ring: keyboard focus shows a 2px outline on toolbar, sidebar and editor', async () => {
                const ring = (sel) => s.evalExpr(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); const cs = getComputedStyle(el); return {style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor}; })()`);
                for (const sel of ['#btn-new', '#template-select', '[data-fmt="bold"]', '#doc-filter', '#doc-list .doc-item.active .doc-open', '#editor', '#divider', '#preview-pane']) {
                    const r = await ring(sel);
                    assert(r.style !== 'none' && r.width >= 2, `${sel} ring: ${JSON.stringify(r)}`);
                }
                await s.evalExpr("document.getElementById('editor').focus(), true");
                await s.shot('focus-editor-light');
            });

            await check('editor: Tab indents, Escape then Tab leaves the editor', async () => {
                await s.evalExpr("(() => { const e = document.getElementById('editor'); e.focus(); e.setSelectionRange(0, 0); return true; })()");
                const before = await s.evalExpr("document.getElementById('editor').value.length");
                await press(s, 'Tab');
                assert(await s.focus() === 'editor', 'Tab stays in the editor to indent');
                assert(await s.evalExpr("document.getElementById('editor').value.length") === before + 2, 'Tab inserted two spaces');
                await press(s, 'Escape');
                await press(s, 'Tab');
                assert(await s.focus() === 'divider', 'Escape, Tab moves on to the divider, got ' + await s.focus());
                await s.evalExpr("document.getElementById('editor').focus(), true");
                await press(s, 'Escape');
                await press(s, 'Tab', {shift: true});
                assert(/^doc-del:/.test(await s.focus()), 'Escape, Shift+Tab moves back to the sidebar, got ' + await s.focus());
            });

            await check('sidebar: roles and names in the accessibility tree', async () => {
                const list = await axOf(s, '#doc-list');
                assert(list.role === 'list' && list.name === 'Recent files', 'list: ' + JSON.stringify(list));
                const title = await s.evalExpr("document.querySelector('#doc-list .doc-item.active .doc-title').textContent");
                const open = await axOf(s, '#doc-list .doc-item.active .doc-open');
                // Chrome puts a space between the title and the hidden comma (flex items): "Gamma , just now".
                assert(open.role === 'button' && open.name.replace(/\s+,/, ',').startsWith(title + ', '), 'open button: ' + JSON.stringify(open));
                assert(await s.evalExpr("document.querySelector('#doc-list .doc-item.active .doc-open').getAttribute('aria-current')") === 'true', 'aria-current on the open document');
                assert(await s.evalExpr("document.querySelectorAll('#doc-list [aria-current]').length") === 1, 'only the open document is current');
                const del = await axOf(s, '#doc-list .doc-item.active .doc-del');
                assert(del.role === 'button' && del.name === 'Delete ' + title, 'delete button: ' + JSON.stringify(del));
                const filter = await axOf(s, '#doc-filter');
                assert(filter.role === 'textbox' && filter.name === 'Search documents by title', 'filter: ' + JSON.stringify(filter));
                // Four documents fit on one page: no Show more button in the Tab order or the tree.
                assert(await s.evalExpr("document.querySelector('#sidebar .doc-more').hidden"), 'Show more hidden with four documents');
                const nav = await axOf(s, '#sidebar');
                assert(nav.role === 'navigation' && nav.name === 'Recent files', 'sidebar landmark: ' + JSON.stringify(nav));
            });

            await check('sidebar: filter, ArrowDown, Enter opens the document and keeps focus on it', async () => {
                await s.evalExpr("document.getElementById('doc-filter').focus(), true");
                await s.send('Input.insertText', {text: 'beta'});
                await s.waitFor("document.querySelectorAll('#doc-list .doc-item').length === 1", 'filtered to one');
                await press(s, 'ArrowDown');
                assert(await s.focus() === 'doc-open:Beta notes', 'ArrowDown to the match, got ' + await s.focus());
                await press(s, 'Enter');
                await s.waitFor("window.__bd.docManager.currentFileName === null && document.getElementById('editor').value.startsWith('# Beta notes')", 'Beta opened');
                await s.waitFor("document.querySelector('#doc-list .doc-item.active .doc-title') && document.querySelector('#doc-list .doc-item.active .doc-title').textContent === 'Beta notes'", 'Beta marked active');
                assert(await s.focus() === 'doc-open:Beta notes', 'focus stays on the opened item, got ' + await s.focus());
                await s.evalExpr("document.getElementById('doc-filter').focus(), true");
                await press(s, 'Escape');
                await s.waitFor("document.querySelectorAll('#doc-list .doc-item').length === 4", 'filter cleared');
                assert(await s.focus() === 'editor', 'Escape in the filter clears it and returns to the editor');
            });

            await check('sidebar: arrows, Home and End move between documents', async () => {
                const titles = await s.evalExpr("[...document.querySelectorAll('#doc-list .doc-title')].map(t => t.textContent)");
                assert(titles.length >= 3, 'three or more documents: ' + JSON.stringify(titles));
                await s.evalExpr("document.querySelectorAll('#doc-list .doc-open')[1].focus(), true");
                await press(s, 'ArrowDown');
                assert(await s.focus() === 'doc-open:' + titles[2], 'ArrowDown: ' + await s.focus());
                await press(s, 'ArrowUp');
                assert(await s.focus() === 'doc-open:' + titles[1], 'ArrowUp: ' + await s.focus());
                await press(s, 'End');
                assert(await s.focus() === 'doc-open:' + titles[titles.length - 1], 'End: ' + await s.focus());
                await press(s, 'Home');
                assert(await s.focus() === 'doc-open:' + titles[0], 'Home: ' + await s.focus());
                await press(s, 'ArrowUp');
                assert(await s.focus() === 'doc-filter', 'ArrowUp from the first item returns to the filter: ' + await s.focus());
            });

            await check('sidebar: Tab to the delete button, Enter deletes after confirm and does not open it', async () => {
                await s.evalExpr("window.__confirmed = []; window.confirm = (m) => { window.__confirmed.push(m); return true; }; true");
                const openBefore = await s.evalExpr('window.__bd.docManager.currentId');
                const alphaIsOpen = await s.evalExpr("document.querySelector('#doc-list .doc-item.active .doc-title').textContent === 'Alpha'");
                assert(!alphaIsOpen, 'Alpha is not the open document (the check deletes another one)');
                await s.evalExpr("[...document.querySelectorAll('#doc-list .doc-open')].find(b => b.textContent.startsWith('Alpha')).focus(), true");
                await press(s, 'Tab');
                assert(await s.focus() === 'doc-del:Alpha', 'Tab reaches Alpha\'s delete button, got ' + await s.focus());
                const del = await s.evalExpr("getComputedStyle(document.activeElement).opacity");
                assert(Number(del) >= 0.5, 'the focused delete button is visible, opacity ' + del);
                await press(s, 'Enter');
                await s.waitFor("![...document.querySelectorAll('#doc-list .doc-title')].some(t => t.textContent === 'Alpha')", 'Alpha deleted');
                const confirmed = await s.evalExpr('window.__confirmed');
                assert(confirmed.length === 1 && /Alpha/.test(confirmed[0]), 'one confirm about Alpha: ' + JSON.stringify(confirmed));
                assert(await s.evalExpr('window.__bd.docManager.currentId') === openBefore, 'the open document did not change');
                const f = await s.focus();
                assert(/^doc-open:|^doc-filter$/.test(f), 'focus stays in the sidebar after the delete, got ' + f);
            });

            await check('sidebar: the × shown on hover reaches 4.5:1 in the open row and the others, light and dark', async () => {
                await s.evalExpr(GLYPH_CONTRAST);
                const failures = [];
                for (const theme of ['light', 'dark']) {
                    if (theme === 'dark') await s.evalExpr("document.getElementById('btn-theme').click(), true");
                    for (const row of ['.doc-item.active', '.doc-item:not(.active)']) {
                        await hover(s, `#doc-list ${row} .doc-title`);
                        // Wait for the hover state and the end of any transition (state, not time).
                        await s.waitFor(`document.querySelector('#doc-list ${row}').matches(':hover') && document.getAnimations().length === 0`, 'hover settled');
                        const r = await s.evalExpr(`window.__glyphContrast(document.querySelector('#doc-list ${row} .doc-del'))`);
                        if (r < 4.5) failures.push(`${theme} ${row}: ${r.toFixed(2)}:1`);
                    }
                }
                assert(failures.length === 0, failures.join('; '));
            });

            // Last in the group: it adds 50 documents.
            await check('sidebar: Show more is a button after the list; Enter loads the next page, focuses its first item and announces it', async () => {
                await s.evalExpr(`(async () => {
                    const dm = window.__bd.docManager;
                    for (let i = 1; i <= 50; i++) await dm.newDoc('# Example Co page doc ' + i);
                    await window.__bd.renderSidebar();
                    return true;
                })()`);
                await s.waitFor("document.querySelectorAll('#doc-list .doc-item').length === 50 && !document.querySelector('#sidebar .doc-more').hidden", 'first page and Show more');
                const btn = await axOf(s, '#sidebar .doc-more');
                assert(btn.role === 'button' && btn.name === 'Show more', 'Show more button: ' + JSON.stringify(btn));
                await s.evalExpr("document.querySelector('#doc-list .doc-item .doc-del').focus(), true");
                await press(s, 'Tab');
                assert(await s.evalExpr("document.activeElement === document.querySelector('#sidebar .doc-more')"), 'Tab from the list reaches Show more, got ' + await s.focus());
                await press(s, 'Enter');
                await s.waitFor("document.querySelectorAll('#doc-list .doc-item').length === 53", 'next page listed');
                await s.waitFor("document.querySelector('#sidebar .doc-more').hidden", 'Show more hidden on the last page');
                const f = await s.focus();
                const third = await s.evalExpr("'doc-open:' + document.querySelectorAll('#doc-list .doc-title')[50].textContent");
                assert(f === third, 'focus on the first new item: ' + f + ' (wanted ' + third + ')');
                await s.waitFor("document.querySelector('body > .sr-status').textContent === 'Showing all 53 documents'", 'announced politely');
            });
        });

        await group('palette', async (s) => {
            await check('palette: combobox with listbox options, arrows move the active option, Escape restores focus', async () => {
                await s.evalExpr("document.getElementById('editor').focus(), true");
                await press(s, 'k', {ctrl: true});
                await s.waitFor("!document.getElementById('cmdk').hidden && document.activeElement.id === 'cmdk-input'", 'palette open');
                const input = await axOf(s, '#cmdk-input');
                assert(input.role === 'combobox' && input.props.expanded === true, 'combobox expanded: ' + JSON.stringify(input));
                assert(input.name === 'Command', 'combobox name: ' + input.name);
                const listbox = await axOf(s, '#cmdk-list');
                assert(listbox.role === 'listbox', 'listbox: ' + JSON.stringify(listbox));
                const active = () => s.evalExpr("(() => { const i = document.getElementById('cmdk-input'); const id = i.getAttribute('aria-activedescendant'); const o = id && document.getElementById(id); return o ? {id, label: o.textContent, selected: o.getAttribute('aria-selected'), role: o.getAttribute('role'), others: document.querySelectorAll('#cmdk-list [aria-selected=\"true\"]').length} : null; })()");
                const first = await active();
                assert(first && first.role === 'option' && first.selected === 'true' && first.others === 1, 'first option active: ' + JSON.stringify(first));
                await press(s, 'ArrowDown');
                const second = await active();
                assert(second && second.id !== first.id && second.selected === 'true' && second.others === 1, 'ArrowDown moves: ' + JSON.stringify(second));
                await s.shot('palette');
                await s.send('Input.insertText', {text: 'preview only'});
                // The count updates once typing pauses: wait for the text that matches the options shown.
                const COUNT_MATCHES = "(() => { const n = document.querySelectorAll('#cmdk-list [role=option]').length; return n >= 1 && document.querySelector('#cmdk .cmdk-status').textContent === n + (n === 1 ? ' command' : ' commands'); })()";
                await s.waitFor(COUNT_MATCHES, 'the count for the filtered list');
                const st = await axOf(s, '#cmdk .cmdk-status');
                assert(st.role === 'status', 'count is a status region: ' + st.role);
                await press(s, 'Escape');
                await s.waitFor("document.getElementById('cmdk').hidden", 'palette closed');
                assert(await s.focus() === 'editor', 'focus back on the editor: ' + await s.focus());
                assert(await s.evalExpr("document.getElementById('cmdk-input').getAttribute('aria-expanded')") === 'false', 'collapsed after close');
            });

            await check('palette: Enter runs the command and returns focus', async () => {
                await s.evalExpr("document.getElementById('editor').focus(), true");
                await press(s, 'k', {ctrl: true});
                await s.waitFor("document.activeElement.id === 'cmdk-input'", 'palette open');
                await s.send('Input.insertText', {text: 'editor only'});
                await s.waitFor("document.querySelectorAll('#cmdk-list [role=option]').length >= 1", 'filtered');
                await press(s, 'Enter');
                await s.waitFor("document.getElementById('cmdk').hidden && document.getElementById('main').classList.contains('view-editor')", 'command ran');
                assert(await s.focus() === 'editor', 'focus back on the editor: ' + await s.focus());
            });

            await check('palette: each View command leaves focus on a visible control, from the editor and from the preview', async () => {
                const failures = [];
                // Each view from each starting point, and each from the other views (Preview only, then Editor only, ...).
                // Every View command once, including the two that hide the focused pane.
                const plan = [
                    ['editor', 'View: Preview only'], ['preview-pane', 'View: Split'],
                    ['preview-pane', 'View: Editor only'], ['editor', 'View: Split'],
                ];
                for (const [from, label] of plan) {
                    // Start from `from` when it is visible in the current view, else from whatever is.
                    await s.evalExpr(`(() => { const el = document.getElementById('${from}'); (el.getClientRects().length ? el : document.querySelector('#editor-pane, #preview-pane')).focus(); return true; })()`);
                    const start = await s.focus();
                    await press(s, 'k', {ctrl: true});
                    await s.waitFor("document.activeElement.id === 'cmdk-input'", 'palette open');
                    await s.send('Input.insertText', {text: label});
                    await s.waitFor(`(document.querySelector('#cmdk-list .cmdk-item.sel') || {}).textContent === ${JSON.stringify(label + 'View')}`, label + ' highlighted');
                    await press(s, 'Enter');
                    await s.waitFor("document.getElementById('cmdk').hidden", 'palette closed');
                    const after = await s.evalExpr("(() => { const el = document.activeElement; return {id: el && el.id, body: !el || el === document.body, visible: !!(el && el.getClientRects().length)}; })()");
                    if (after.body || !after.visible) failures.push(`${label} from ${start}: focus on ${after.body ? 'body' : after.id + ' (hidden)'}`);
                }
                assert(failures.length === 0, failures.join('; '));
                const name = await axOf(s, '#preview-pane');
                assert(name.name === 'Live preview', 'the preview has a name for when it takes focus: ' + name.name);
            });

            await check('palette: a document with copies of the option ids cannot take over the active option', async () => {
                await openHostileDoc(s, hostileDoc());
                await s.evalExpr("document.getElementById('editor').focus(), true");
                await press(s, 'k', {ctrl: true});
                await s.waitFor("document.activeElement.id === 'cmdk-input' && document.querySelectorAll('#cmdk-list [role=option]').length > 2", 'palette open');
                for (let step = 0; step < 3; step++) {
                    const a = await activeOption(s);
                    assert(a.inList && a.axIds.length === 1 && a.axIds[0] === a.id, `step ${step}: active option ${JSON.stringify(a)}`);
                    assert(!/decoy/.test(a.text), 'a decoy is active: ' + a.text);
                    await press(s, 'ArrowDown');
                }
                firstLoadOptionIds = await s.evalExpr("[...document.querySelectorAll('#cmdk-list [role=option]')].slice(0, 5).map(o => o.id)");
                assert(firstLoadOptionIds.every((id) => /[0-9a-f]{16}/.test(id)), 'option ids carry a random token: ' + JSON.stringify(firstLoadOptionIds));
            });

            await check('palette: option ids carry 64 random bits drawn at this page load', async () => {
                assert(firstLoadOptionIds.length === 5, 'the option ids were recorded');
                // RECORD_RANDOM (run before the app) logged every crypto.getRandomValues result
                // of this load: the id prefix must be one of them, 8 bytes (16 hex digits) long.
                const drawn = await s.evalExpr('window.__randomOut');
                const prefix = /^bd-([0-9a-f]+)-/.exec(firstLoadOptionIds[0]);
                assert(prefix && prefix[1].length === 16 && drawn.includes(prefix[1]), `prefix ${prefix && prefix[1]} among ${JSON.stringify(drawn)}`);
                assert(firstLoadOptionIds.every((id) => id.startsWith(prefix[0])), 'every option shares the prefix');
            });
        }, {beforeLoad: RECORD_RANDOM});

        await group('dialogs', async (s) => {
            await check('import menu: Enter opens it on the first item, arrows wrap, Escape returns to the trigger', async () => {
                await s.evalExpr("document.getElementById('menu-import-trigger').focus(), true");
                await press(s, 'Enter');
                await s.waitFor("!document.getElementById('menu-import-list').hidden", 'menu open');
                assert(await s.focus() === 'btn-import-pdf', 'first item focused: ' + await s.focus());
                await press(s, 'ArrowUp');
                assert(await s.focus() === 'btn-import-drive', 'ArrowUp wraps to the last item: ' + await s.focus());
                await press(s, 'ArrowDown');
                assert(await s.focus() === 'btn-import-pdf', 'ArrowDown wraps to the first: ' + await s.focus());
                await press(s, 'Escape');
                assert(await s.evalExpr("document.getElementById('menu-import-list').hidden"), 'menu closed');
                assert(await s.focus() === 'menu-import-trigger', 'focus back on the trigger: ' + await s.focus());
            });

            await check('Drive dialog: opened by keyboard, named, background inert, Tab trapped, Escape restores focus', async () => {
                await s.evalExpr("document.getElementById('menu-import-trigger').focus(), true");
                await press(s, 'ArrowDown');   // a closed menu opens on ArrowDown too
                await s.waitFor("!document.getElementById('menu-import-list').hidden", 'menu open');
                await press(s, 'ArrowUp');
                await press(s, 'Enter');
                await s.waitFor("getComputedStyle(document.getElementById('drive-modal')).display !== 'none' && document.activeElement.id === 'drive-url-input'", 'drive dialog open with focus in the URL field');
                const dlg = await axOf(s, '#drive-modal');
                assert(dlg.role === 'dialog' && dlg.name === 'Import from Google Drive' && dlg.props.modal === true, 'dialog: ' + JSON.stringify(dlg));
                assert(await s.evalExpr("!!document.getElementById('toolbar-nav').closest('[inert]') && !!document.getElementById('main').closest('[inert]')"), 'background is inert');
                const tree = await axTree(s);
                assert(!tree.some((n) => n.name === 'Export'), 'the toolbar is out of the accessibility tree while the dialog is open');
                const seen = new Set();
                for (let i = 0; i < 14; i++) {
                    await press(s, 'Tab', {shift: i >= 7});
                    assert(await s.evalExpr("document.getElementById('drive-modal').contains(document.activeElement)"), 'Tab left the dialog at step ' + i + ': ' + await s.focus());
                    seen.add(await s.focus());
                }
                assert(seen.size >= 4, 'Tab visits the dialog controls: ' + JSON.stringify([...seen]));
                const rect = await s.evalExpr("(() => { const r = document.getElementById('drive-modal-panel').getBoundingClientRect(); return {top: r.top, left: r.left, bottom: r.bottom, right: r.right, w: innerWidth, h: innerHeight}; })()");
                assert(rect.top >= 0 && rect.left >= 0 && rect.bottom <= rect.h && rect.right <= rect.w, 'panel inside the viewport: ' + JSON.stringify(rect));
                const cx = (rect.left + rect.right) / 2;
                const cy = (rect.top + rect.bottom) / 2;
                assert(Math.abs(cx - rect.w / 2) <= 2 && Math.abs(cy - rect.h / 2) <= 2, 'panel centred: ' + JSON.stringify(rect));
                await s.shot('drive-dialog');
                await press(s, 'Escape');
                await s.waitFor("getComputedStyle(document.getElementById('drive-modal')).display === 'none'", 'drive dialog closed');
                assert(await s.focus() === 'menu-import-trigger', 'focus restored to the Import menu: ' + await s.focus());
                assert(await s.evalExpr("!document.querySelector('[inert]')"), 'nothing left inert');
            });

            await check('Drive dialog: the tabs are a tablist with arrow keys', async () => {
                await s.evalExpr("document.getElementById('btn-import-drive').click(), true");
                await s.waitFor("document.activeElement.id === 'drive-url-input'", 'open');
                await s.evalExpr("document.querySelector('#drive-tab-bar [data-tab=url]').focus(), true");
                const tab = await axOf(s, '#drive-tab-bar [data-tab=url]');
                assert(tab.role === 'tab' && tab.props.selected === true, 'tab: ' + JSON.stringify(tab));
                await press(s, 'ArrowRight');
                assert(await s.evalExpr("document.activeElement.dataset.tab === 'picker' && document.activeElement.getAttribute('aria-selected') === 'true' && getComputedStyle(document.getElementById('drive-tab-picker')).display !== 'none'"), 'ArrowRight selects Browse Drive');
                await press(s, 'ArrowLeft');   // back to Paste URL for the next opening
            });

            await check('template popover: Enter opens it with focus inside, Escape closes and restores', async () => {
                await s.evalExpr("document.getElementById('btn-template-info').focus(), true");
                await press(s, 'Enter');
                await s.waitFor("!document.getElementById('template-info-popover').hidden", 'popover open');
                assert(await s.focus() === 'template-info-close', 'focus on its close button: ' + await s.focus());
                await press(s, 'Escape');
                assert(await s.evalExpr("document.getElementById('template-info-popover').hidden"), 'closed');
                assert(await s.focus() === 'btn-template-info', 'focus back on the info button: ' + await s.focus());
            });

            await check('preflight dialog: alertdialog, Cancel first, Tab trapped, Escape cancels and restores focus', async () => {
                await s.evalExpr(`(() => {
                    window.__opened = 0; window.open = () => { window.__opened++; return null; };
                    const e = document.getElementById('editor'); e.value = 'No heading, so the template warns.';
                    e.dispatchEvent(new Event('input', {bubbles: true}));
                    const f = document.getElementById('export-format'); f.value = 'pdf'; f.dispatchEvent(new Event('change', {bubbles: true}));
                    document.getElementById('btn-export').focus();
                    return true;
                })()`);
                await press(s, 'Enter');
                await s.waitFor("!document.getElementById('preflight-modal').hidden", 'preflight open');
                assert(await s.evalExpr("document.activeElement.dataset.choice") === 'cancel', 'Cancel has focus');
                const dlg = await axOf(s, '#preflight-modal');
                assert(dlg.role === 'alertdialog' && dlg.name === 'Check before exporting' && dlg.props.modal === true, 'alertdialog: ' + JSON.stringify(dlg));
                const described = await s.evalExpr("document.getElementById(document.getElementById('preflight-modal').getAttribute('aria-describedby')).textContent");
                assert(/check this first/.test(described), 'described by the message: ' + described);
                for (let i = 0; i < 4; i++) {
                    await press(s, 'Tab');
                    assert(await s.evalExpr("document.getElementById('preflight-modal').contains(document.activeElement)"), 'Tab left the preflight dialog');
                }
                await s.shot('preflight-dialog');
                await press(s, 'Escape');
                await s.waitFor("document.getElementById('preflight-modal').hidden", 'closed');
                assert(await s.focus() === 'btn-export', 'focus back on Export: ' + await s.focus());
                assert(await s.evalExpr('window.__opened') === 0, 'Escape opened no print window');
            });
        });

        // Page-wide checks run with IndexedDB blocked from the first load, so the same
        // page also covers the in-memory fallback (none of the page-wide checks use storage).
        await group('page', async (s) => {
            await check('divider: a focusable separator with a value, arrows, Shift, Home and End resize', async () => {
                await s.evalExpr("document.getElementById('divider').focus(), true");
                const ax = await axOf(s, '#divider');
                // Chrome reports aria-valuenow as the node's value.
                assert(['separator', 'splitter'].includes(ax.role) && ax.props.focusable === true && Number(ax.value) === 50
                    && ax.props.valuemin === 20 && ax.props.valuemax === 80 && ax.props.orientation === 'vertical',
                    'divider: ' + JSON.stringify(ax));
                assert(ax.name === 'Resize editor and preview', 'name: ' + ax.name);
                const now = () => s.evalExpr("Number(document.getElementById('divider').getAttribute('aria-valuenow'))");
                const width = () => s.evalExpr("Math.round(document.getElementById('editor-pane').style.width ? parseFloat(document.getElementById('editor-pane').style.width) : 50)");
                await press(s, 'ArrowRight');
                assert(await now() === 52 && await width() === 52, 'ArrowRight +2: ' + await now());
                await press(s, 'ArrowLeft', {shift: true});
                assert(await now() === 42 && await width() === 42, 'Shift+ArrowLeft -10: ' + await now());
                await press(s, 'Home');
                assert(await now() === 20, 'Home: ' + await now());
                await press(s, 'ArrowLeft');
                assert(await now() === 20, 'clamped at the minimum');
                await press(s, 'End');
                assert(await now() === 80 && await width() === 80, 'End: ' + await now());
                await press(s, 'ArrowLeft', {shift: true});
                await press(s, 'ArrowLeft', {shift: true});
                await press(s, 'ArrowLeft', {shift: true});
                assert(await now() === 50, 'back to 50: ' + await now());
            });

            await check('landmarks and title: one main, banner, navigation, complementary, contentinfo, lang', async () => {
                const tree = await axTree(s);
                const roles = (r) => tree.filter((n) => n.role === r).length;
                assert(roles('main') === 1, 'one main: ' + roles('main'));
                assert(roles('banner') === 1 && roles('contentinfo') === 1, 'banner and contentinfo');
                assert(roles('navigation') >= 1 && roles('complementary') >= 1, 'navigation and complementary');
                assert(await s.evalExpr("document.documentElement.lang") === 'en', 'lang');
                assert(/PrintMD$/.test(await s.evalExpr('document.title')), 'title: ' + await s.evalExpr('document.title'));
            });

            await check('theme button: a toggle named "Dark theme", pressed only in the dark theme', async () => {
                const pressed = (ax) => String(ax.props.pressed);
                const light = await axOf(s, '#btn-theme');
                assert(['button', 'togglebutton'].includes(String(light.role).toLowerCase()) && light.name === 'Dark theme' && pressed(light) === 'false',
                    'light: ' + JSON.stringify(light));
                await s.evalExpr("document.getElementById('btn-theme').focus(), true");
                await press(s, 'Enter');
                await s.waitFor("document.documentElement.dataset.theme === 'dark'", 'dark theme');
                const dark = await axOf(s, '#btn-theme');
                assert(dark.name === 'Dark theme' && pressed(dark) === 'true', 'dark: ' + JSON.stringify(dark));
                await press(s, 'Enter');
                await s.waitFor("document.documentElement.dataset.theme === 'light'", 'light again');
                assert(pressed(await axOf(s, '#btn-theme')) === 'false', 'not pressed in the light theme again');
            });

            await check('dark theme: the focus ring still shows', async () => {
                await s.evalExpr("document.getElementById('btn-theme').click(), document.getElementById('btn-export').focus(), true");
                const r = await s.evalExpr("(() => { const cs = getComputedStyle(document.getElementById('btn-export')); return {style: cs.outlineStyle, width: parseFloat(cs.outlineWidth)}; })()");
                assert(r.style !== 'none' && r.width >= 2, 'dark ring: ' + JSON.stringify(r));
                if (shotsDir) await s.waitFor('document.getAnimations().length === 0', 'theme transition done');
                await s.shot('focus-export-dark');
            });

            await check('prefers-reduced-motion: transitions and animations are switched off', async () => {
                await s.send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
                try {
                    const d = await s.evalExpr("['btn-new', 'divider', 'sidebar', 'editor'].map(id => getComputedStyle(document.getElementById(id)).transitionDuration)");
                    assert(d.every((v) => v.split(',').every((x) => parseFloat(x) <= 0.01)), 'durations: ' + JSON.stringify(d));
                } finally {
                    await s.send('Emulation.setEmulatedMedia', {features: []});
                }
            });

            await check('favicon: assets/favicon.svg loads, no /favicon.ico request', async () => {
                // The icon is fetched after load; wait for its response (the state), then look for the .ico.
                for (const end = Date.now() + 10000; !s.requests.some((r) => /\/assets\/favicon\.svg$/.test(r.url)) && Date.now() < end;) await sleep(25);
                const ico = s.requests.filter((r) => /\/favicon\.ico$/.test(r.url));
                assert(ico.length === 0, 'favicon.ico requested: ' + JSON.stringify(ico));
                const svg = s.requests.filter((r) => /\/assets\/favicon\.svg$/.test(r.url));
                assert(svg.length >= 1 && svg.every((r) => r.status === 200), 'favicon.svg: ' + JSON.stringify(svg));
            });

            await check('memory fallback: banner is an alert and the status bar says "Kept in memory only"', async () => {
                await s.waitFor("!document.getElementById('storage-banner').hidden", 'banner shown');
                const banner = await axOf(s, '#storage-banner');
                assert(banner.role === 'alert', 'banner role: ' + banner.role);
                // Record every text the footer shows from here on, then type and wait for the save itself.
                await s.evalExpr(`(() => {
                    const el = document.getElementById('autosave-status');
                    window.__seen = [el.textContent];
                    new MutationObserver(() => window.__seen.push(el.textContent)).observe(el, {childList: true, characterData: true, subtree: true});
                    document.getElementById('editor').focus();
                    return true;
                })()`);
                await s.send('Input.insertText', {text: 'typed while in memory '});
                await s.evalExpr('window.__bd.docManager.saveCurrent().then(() => true)');
                const seen = await s.evalExpr('window.__seen');
                assert(seen.every((t) => !/Autosaved/.test(t)), 'never says Autosaved: ' + JSON.stringify(seen));
                assert(seen[seen.length - 1] === 'Kept in memory only', 'says Kept in memory only: ' + JSON.stringify(seen));
            });

            await check('memory fallback: the banner is inert behind an open dialog, and live again after', async () => {
                await s.waitFor("!document.getElementById('storage-banner').hidden", 'banner shown');
                await s.evalExpr("document.getElementById('btn-import-drive').click(), true");
                await s.waitFor("document.activeElement.id === 'drive-url-input'", 'drive dialog open');
                assert(await s.evalExpr("document.getElementById('storage-banner').inert"), 'banner inert while the dialog is open');
                const tree = await axTree(s);
                assert(!tree.some((n) => n.role === 'button' && n.name === 'Dismiss'), 'its Dismiss button is out of the accessibility tree');
                for (let i = 0; i < 8; i++) {
                    await press(s, 'Tab');
                    assert(await s.evalExpr("document.getElementById('drive-modal').contains(document.activeElement)"), 'Tab left the dialog: ' + await s.focus());
                }
                await press(s, 'Escape');
                await s.waitFor("getComputedStyle(document.getElementById('drive-modal')).display === 'none'", 'closed');
                assert(await s.evalExpr("!document.getElementById('storage-banner').inert"), 'banner live again');
            });
        }, {beforeLoad: BLOCK_INDEXEDDB});
    } finally {
        await server.close();
        if (!keepBrowser) await closeA11yKeysBrowser();
    }
    const failed = results.filter((r) => !r.ok).length;
    log(`${results.length - failed} passed · ${failed} failed · ${results.length} total`);
    return failed === 0 && results.length > 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const i = process.argv.indexOf('--shots');
    const shotsDir = i > -1 ? resolve(process.argv[i + 1]) : null;
    const named = process.argv.slice(2).filter((a, n, all) => !a.startsWith('--') && all[n - 1] !== '--shots');
    const started = Date.now();
    const ok = await runA11yKeys({shotsDir, groups: named.length ? named : A11Y_KEY_GROUPS});
    console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
    process.exit(ok ? 0 : 1);
}
