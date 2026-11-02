/**
 * tests/audit.mjs: drive the app through real user interactions via CDP and
 * report every console error / uncaught exception, plus a screenshot at the end
 * (AUDIT_SHOTS=1: one after every step, named after it).
 * Usage: node tests/audit.mjs <url> [outDir]
 *
 * Browser-generated messages (CSP violations, failed loads) arrive through the
 * Log domain, so they are captured as well as console.error/warn. Workers are
 * auto-attached. The PDF print window is opened with print() stubbed, checked
 * (opened, printed once, no scripts) and its log is audited too.
 * AUDIT_IMPORT_FILES=a.pdf,b.html imports each file through the matching
 * hidden file input, exercising the lazy-loaded importers.
 */
import {launchChrome} from './lib/chrome.mjs';
import {writeFileSync, mkdirSync} from 'node:fs';

const url = process.argv[2] || 'http://localhost:8765/index.html';
const outDir = process.argv[3] || '/tmp/shots';
mkdirSync(outDir, {recursive: true});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchChrome(url, {extraArgs: ['--hide-scrollbars', '--window-size=1400,900']});
const PORT = browser.port;
const done = (c) => { browser.killSync(); process.exit(c); };

const logs = [];
let step = 'boot';

try {
    let wsUrl;
    for (let i = 0; i < 60 && !wsUrl; i++) {
        try { const list = await (await fetch(`http://localhost:${PORT}/json`)).json(); const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /index\.html|localhost/.test(t.url) && t.url !== 'about:blank'); if (p) wsUrl = p.webSocketDebuggerUrl; } catch (_e) {}
        if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('no devtools target');
    const ws = new WebSocket(wsUrl);
    let id = 1; const pending = new Map();
    ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
        const where = m.sessionId ? `worker:${step}` : step;
        if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            logs.push({step: where, type: 'EXCEPTION', text: (d.exception && (d.exception.description || d.exception.value)) || d.text});
        } else if (m.method === 'Runtime.consoleAPICalled') {
            if (['error', 'warning'].includes(m.params.type)) {
                logs.push({step: where, type: m.params.type.toUpperCase(), text: m.params.args.map(a => a.value || a.description || a.type).join(' ')});
            }
        } else if (m.method === 'Log.entryAdded') {
            const e = m.params.entry;
            // A /favicon.ico 404 counts too: index.html links assets/favicon.svg, so none is expected.
            if (['error', 'warning'].includes(e.level)) logs.push({step: where, type: `LOG_${e.level.toUpperCase()}(${e.source})`, text: e.text + (e.url ? ` [${e.url}]` : '')});
        } else if (m.method === 'Target.attachedToTarget') {
            const sid = m.params.sessionId;
            workers.push(m.params.targetInfo);
            for (const method of ['Runtime.enable', 'Log.enable', 'Runtime.runIfWaitingForDebugger']) send(method, {}, sid);
        }
    });
    const workers = [];
    const send = (method, params = {}, sessionId) => new Promise((res) => { const _id = id++; pending.set(_id, res); ws.send(JSON.stringify({id: _id, method, params, ...(sessionId ? {sessionId} : {})})); });
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Log.enable');
    await send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
    await sleep(1800);

    // userGesture: popups (PDF print window) need user activation.
    const evalp = (expr) => send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true, userGesture: true});
    // The print window is its own page target: connect to it and replay its log
    // (Log.enable sends entries collected before we attached).
    let printWindows = 0;
    async function auditPrintWindow() {
        const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
        const popup = list.find((t) => t.type === 'page' && t.url === 'about:blank' && t.webSocketDebuggerUrl);
        if (!popup) { logs.push({step, type: 'AUDIT', text: 'print window target not found'}); return; }
        printWindows++;
        const pws = new WebSocket(popup.webSocketDebuggerUrl);
        await new Promise((res, rej) => { pws.addEventListener('open', res); pws.addEventListener('error', rej); });
        pws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data);
            if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
                logs.push({step: 'print-window', type: `LOG_${m.params.entry.level.toUpperCase()}(${m.params.entry.source})`, text: m.params.entry.text});
            } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
                logs.push({step: 'print-window', type: m.params.type.toUpperCase(), text: m.params.args.map(a => a.value || a.description).join(' ')});
            }
        });
        let pid = 1;
        for (const method of ['Runtime.enable', 'Log.enable']) pws.send(JSON.stringify({id: pid++, method}));
        await sleep(600);
        pws.close();
    }
    // bringToFront: with the print window open the app page is in the background, and a
    // background page in headless Chrome may never produce the frame a screenshot waits for.
    const shot = async (name) => { await send('Page.bringToFront'); const {data} = await send('Page.captureScreenshot', {format: 'png'}); writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, 'base64')); };

    // Journey: each [label, expression]
    const steps = [
        ['type-editor', "(()=>{const e=document.getElementById('editor');e.focus();e.value='# Hello World\\n\\nSome **bold** text and a list:\\n\\n- one\\n- two\\n';e.dispatchEvent(new Event('input',{bubbles:true}));return 'typed';})()"],
        ['fmt-bold', "document.querySelector('[data-fmt=\\'bold\\']').click()"],
        ['fmt-h2', "document.querySelector('[data-fmt=\\'h2\\']').click()"],
        ['fmt-table', "document.querySelector('[data-fmt=\\'table\\']').click()"],
        ['fmt-link', "document.querySelector('[data-fmt=\\'link\\']').click()"],
        ['open-import-menu', "document.getElementById('menu-import-trigger').click()"],
        ['close-import-menu', "document.body.click()"],
        ['sidebar-new', "document.getElementById('sidebar-new').click()"],
        ['new-doc2', "window.__bd.docManager.newDoc('# Second Doc').then(()=>window.__bd.renderSidebar())"],
        ['switch-doc0', "(()=>{const t=document.querySelector('#doc-list .doc-item');t&&t.click();return 'sw';})()"],
        ['switch-doc1', "(()=>{const items=document.querySelectorAll('#doc-list .doc-item');items[1]&&items[1].click();return 'sw2';})()"],
        ['view-editor', "document.querySelector('#menu-view-list [data-view=\\'editor\\']').click()"],
        ['view-preview', "document.querySelector('#menu-view-list [data-view=\\'preview\\']').click()"],
        ['view-split', "document.querySelector('#menu-view-list [data-view=\\'split\\']').click()"],
        ['theme-toggle', "document.getElementById('btn-theme').click()"],
        ['theme-toggle2', "document.getElementById('btn-theme').click()"],
        ['template-info', "document.getElementById('btn-template-info').click()"],
        ['close-info', "document.body.click()"],
        ['switch-template', "(()=>{const s=document.getElementById('template-select');s.value=s.options[s.options.length-1].value;s.dispatchEvent(new Event('change',{bubbles:true}));return s.value;})()"],
        ['export-docx', "(()=>{const f=document.getElementById('export-format');f.value='docx';f.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('btn-export').click();return 'exp';})()"],
        ['export-pptx', "(()=>{const f=document.getElementById('export-format');f.value='pptx';f.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('btn-export').click();return 'exp';})()"],
        ['sample-doc', "(()=>{window.confirm=()=>true;document.getElementById('btn-reset').click();return 'sample';})()"],
        // print() is stubbed on the popup so the window stays open to be audited.
        ['export-pdf', "(()=>{const ro=window.open;window.open=(...a)=>{const w=ro.apply(window,a);window.open=ro;window.__auditPopup=w;window.__auditPrinted=0;if(w)w.print=()=>{window.__auditPrinted++;};return w;};const f=document.getElementById('export-format');f.value='pdf';f.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('btn-export').click();return 'exp';})()"],
        ['wait-print-window', "new Promise(r=>setTimeout(()=>r('waited'),2500))"],
        ['check-print-window', "(()=>{const w=window.__auditPopup;const r={opened:!!w,printed:window.__auditPrinted,scripts:w?w.document.querySelectorAll('script').length:-1,body:w?w.document.body.innerText.length:0};if(!r.opened||r.printed!==1||r.scripts!==0||r.body<20)console.error('print window check failed '+JSON.stringify(r));return r;})()"],
        ['drive-open', "document.getElementById('btn-import-drive').click()"],
        ['drive-tab-picker', "document.querySelector('#drive-modal .drive-tab[data-tab=\\'picker\\']').click()"],
        ['drive-tab-settings', "document.querySelector('#drive-modal .drive-tab[data-tab=\\'settings\\']').click()"],
        ['drive-close', "document.getElementById('drive-modal-close').click()"],
        ['open-more-menu', "document.getElementById('menu-more-trigger').click()"],
        ['close-more-menu', "document.body.click()"],
        ['copy-html', "document.getElementById('btn-copy-html').click()"],
        // The command palette (js/palette.js) through its shortcut, then Escape.
        ['palette-open', "(document.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', ctrlKey: true, bubbles: true})), 'open')"],
        ['palette-close', "(document.getElementById('cmdk-input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})), document.getElementById('cmdk').hidden)"],
        ['delete-doc', "(()=>{window.confirm=()=>true;const d=document.querySelectorAll('#doc-list .doc-del');d[d.length-1].click();return d.length;})()"],
        // Sidebar paging and title search (js/sidebar.js) with 120 more documents.
        ['seed-120', "(async()=>{const dm=window.__bd.docManager;for(let i=1;i<=120;i++)await dm.newDoc('# Example Co seeded doc '+i);await window.__bd.renderSidebar();return document.querySelectorAll('#doc-list .doc-item').length;})()"],
        ['show-more', "(document.querySelector('#sidebar .doc-more').click(), 'more')"],
        ['show-more-2', "new Promise(r=>setTimeout(()=>{document.querySelector('#sidebar .doc-more').click();r(document.querySelectorAll('#doc-list .doc-item').length);},300))"],
        ['search', "(()=>{const f=document.getElementById('doc-filter');f.focus();f.value='seeded doc 7';f.dispatchEvent(new Event('input',{bubbles:true}));return 'q';})()"],
        ['search-settled', "new Promise(r=>setTimeout(()=>r([...document.querySelectorAll('#doc-list .doc-title')].map(t=>t.textContent).join('|')),600))"],
        ['search-clear', "(document.getElementById('doc-filter').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})), 'clear')"],
    ];

    for (const [label, expr] of steps) {
        step = label;
        const r = await evalp(expr);
        if (r && r.exceptionDetails) logs.push({step, type: 'EVAL_ERROR', text: r.exceptionDetails.exception?.description || r.exceptionDetails.text});
        else if (process.env.AUDIT_SHOTS) console.log(`[${label}] ${JSON.stringify(r && r.result && r.result.value)}`);
        if (label === 'check-print-window') await auditPrintWindow();
        await sleep(350);
        if (process.env.AUDIT_SHOTS) await shot(label);
    }
    // Imports through the real file inputs (lazy-loaded vendor scripts, pdf.js worker).
    const importFiles = (process.env.AUDIT_IMPORT_FILES || '').split(',').filter(Boolean);
    const inputFor = {pdf: '#pdf-input', docx: '#docx-input', html: '#html-input', htm: '#html-input', epub: '#epub-input'};
    for (const file of importFiles) {
        step = `import:${file.split('/').pop()}`;
        const sel = inputFor[file.split('.').pop().toLowerCase()];
        if (!sel) { logs.push({step, type: 'AUDIT', text: 'no importer for ' + file}); continue; }
        const {root} = await send('DOM.getDocument', {depth: 1});
        const {nodeId} = await send('DOM.querySelector', {nodeId: root.nodeId, selector: sel});
        await send('DOM.setFileInputFiles', {nodeId, files: [file]});
        await sleep(3000);
        const r = await evalp("document.getElementById('autosave-status').textContent");
        console.log(`[${step}] status: ${r && r.result && r.result.value}`);
    }
    step = 'final';
    await sleep(600);
    await shot('audit-final');

    console.log(`print windows audited: ${printWindows}, workers attached: ${workers.length}`);
    console.log('=== CONSOLE ERRORS / EXCEPTIONS ===');
    if (!logs.length) console.log('(none)');
    for (const l of logs) console.log(`[${l.step}] ${l.type}: ${l.text}`);
    console.log('=== total issues:', logs.length, '===');
    done(logs.length ? 1 : 0);
} catch (e) { console.error('audit error:', e.message); done(2); }
