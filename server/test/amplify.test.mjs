/**
 * Amplification: one image, referenced many times, must not build a print
 * document many times its size. The expanded size (every reference to a data
 * URI counted at the URI's full size) is checked against a ceiling before the
 * placeholders are expanded, and a request over it gets 413 too_large.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApi, render, chromiumDescendants, PNG_DATA_URI} from './helpers.mjs';
import {loadConfig} from '../src/config.mjs';

let api;

before(async () => {
    api = await startTestApi();
});

after(async () => {
    await api.close();
});

/** A reference-style image of payloadBytes, used refs times (amplify.sh's shape). */
function amplified(payloadBytes, refs) {
    const png = PNG_DATA_URI.split(',')[1];
    return `# amp\n\n[x]: data:image/png;base64,${png}${'A'.repeat(payloadBytes)}\n\n${'![a][x] '.repeat(refs)}\n`;
}

test('an image referenced 100 times (about 100 MB expanded) is refused with 413 before it is expanded', async () => {
    assert.equal((await render(api.url, '# Warm up')).status, 200);
    const browsersBefore = chromiumDescendants().sort();
    const rssBefore = process.memoryUsage().rss;
    let peak = rssBefore;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
    const t0 = Date.now();
    let r;
    try {
        r = await render(api.url, amplified(1024 * 1024, 100));
    } finally {
        clearInterval(sampler);
    }
    const ms = Date.now() - t0;
    assert.equal(r.status, 413, r.body.toString().slice(0, 200));
    assert.equal(r.json.error.code, 'too_large');
    // Refused before expanding is shown by memory, not by a duration a slower CPU could fail.
    const grewMb = (peak - rssBefore) / 1048576;
    assert.ok(grewMb < 250, `Node grew by ${grewMb.toFixed(0)} MB (answered in ${ms} ms)`);
    assert.deepEqual(chromiumDescendants().sort().filter((p) => !browsersBefore.includes(p)), [], 'no new Chromium processes');
    assert.equal((await render(api.url, '# After\n\nfine')).status, 200, 'the next render works');
});

test('a small image referenced 300 times is fine', async () => {
    const r = await render(api.url, amplified(2048, 300));
    assert.equal(r.status, 200, r.body.toString().slice(0, 200));
});

test('PRINTMD_MAX_EXPANDED_BYTES sets the ceiling', async () => {
    assert.equal(loadConfig({env: {}, argv: []}).maxExpandedBytes, 40 * 1024 * 1024);
    assert.equal(loadConfig({env: {PRINTMD_MAX_EXPANDED_BYTES: '1000000'}, argv: []}).maxExpandedBytes, 1000000);
    assert.throws(() => loadConfig({env: {PRINTMD_MAX_EXPANDED_BYTES: 'lots'}, argv: []}), /PRINTMD_MAX_EXPANDED_BYTES/);
    const small = await startTestApi({env: {PRINTMD_MAX_EXPANDED_BYTES: '200000'}});
    try {
        const r = await render(small.url, amplified(2048, 300));
        assert.equal(r.status, 413);
        assert.equal(r.json.error.code, 'too_large');
        assert.equal((await render(small.url, '# Small\n\nfine')).status, 200);
    } finally {
        await small.close();
    }
});
