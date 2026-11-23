/**
 * tests/shoot.mjs: CDP screenshot helper for visual UX review.
 * Usage: node tests/shoot.mjs <url> <outPng> [setupJsExpr] [waitMs]
 * Optionally evaluates setupJsExpr (e.g. to open a panel) before capturing.
 */
import {launchChrome} from './lib/chrome.mjs';
import {writeFileSync} from 'node:fs';

const [url, out, setup, waitArg] = process.argv.slice(2);
if (!url || !out) { console.error('usage: node tests/shoot.mjs <url> <outPng> [setupExpr] [waitMs]'); process.exit(2); }
const waitMs = Number(waitArg || 1200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchChrome(url, {extraArgs: ['--hide-scrollbars', '--window-size=1400,900']});
const PORT = browser.port;
const done = (c) => { browser.killSync(); process.exit(c); };

try {
    let wsUrl;
    for (let i = 0; i < 60 && !wsUrl; i++) {
        try {
            const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
            const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (p) wsUrl = p.webSocketDebuggerUrl;
        } catch (_e) {}
        if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('no devtools target');
    const ws = new WebSocket(wsUrl);
    let id = 1; const pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise((res) => { const _id = id++; pending.set(_id, res); ws.send(JSON.stringify({id: _id, method, params})); });
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    await send('Runtime.enable');
    await sleep(1500); // let the app boot
    if (setup) { await send('Runtime.evaluate', {expression: setup, awaitPromise: true}); await sleep(waitMs); }
    const {data} = await send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(out, Buffer.from(data, 'base64'));
    console.log('saved', out);
    done(0);
} catch (e) { console.error('shoot error:', e.message); done(1); }
