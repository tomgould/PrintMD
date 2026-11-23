#!/usr/bin/env node
/**
 * tests/update-snapshots.mjs: rewrite the snapshot fixtures in tests/fixtures/.
 *
 * Usage: node tests/update-snapshots.mjs
 *
 * Serves the project, opens tests/export-pipeline.test.html in headless Chrome,
 * and writes every snapshot the page recorded (window.__snapshots) to
 * tests/fixtures/<name>. Run it only after a change that is meant to alter the
 * print document, then review `git diff tests/fixtures` before committing.
 */
import {writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchChrome, sleep} from './lib/chrome.mjs';
import {startStaticServer} from './lib/static-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'tests/export-pipeline.test.html';

const server = await startStaticServer(root);
const browser = await launchChrome(`${server.origin}/${PAGE}`);
let code = 1;
try {
    let wsUrl;
    for (let i = 0; i < 80 && !wsUrl; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${browser.port}/json`)).json();
            const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) wsUrl = page.webSocketDebuggerUrl;
        } catch (_e) { /* devtools not up yet */ }
        if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('no DevTools page target');
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    });
    await new Promise((ok, fail) => { ws.addEventListener('open', ok); ws.addEventListener('error', fail); });
    const evaluate = (expression) => new Promise((ok) => {
        const n = id++;
        pending.set(n, (r) => ok(r && r.result ? r.result.value : undefined));
        ws.send(JSON.stringify({id: n, method: 'Runtime.evaluate', params: {expression, returnByValue: true}}));
    });

    let snapshots;
    for (let i = 0; i < 120 && !snapshots; i++) {
        if (await evaluate('window.__snapshotsReady === true')) snapshots = await evaluate('window.__snapshots');
        else await sleep(250);
    }
    ws.close();
    if (!snapshots || !Object.keys(snapshots).length) throw new Error(`${PAGE} recorded no snapshots`);
    for (const [name, html] of Object.entries(snapshots)) {
        const file = resolve(root, 'tests/fixtures', name);
        writeFileSync(file, html);
        console.log(`wrote tests/fixtures/${name} (${html.length} chars)`);
    }
    code = 0;
} catch (e) {
    console.error('update-snapshots:', e.message);
} finally {
    await browser.stop();
    await server.close();
}
process.exit(code);
