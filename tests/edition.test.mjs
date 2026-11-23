/**
 * tests/edition.test.mjs
 *
 * js/edition.js: the edition switch (EDITION) and the rule that decides when
 * the "run it locally" notice shows (hostedNoticeVisible).
 * Run: node --test tests/edition.test.mjs
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {EDITION, hostedNoticeVisible} from '../js/edition.js';

// The private repository (the one with deploy/public-edition.json) ships the switch off; the public build turns it on.
const PRIVATE_REPO = existsSync(new URL('../deploy/public-edition.json', import.meta.url));

test('edition: the notice flag is off in the private repository, on in the public build, and EDITION is frozen', () => {
    assert.equal(EDITION.hostedNotice, !PRIVATE_REPO);
    assert.ok(Object.isFrozen(EDITION));
});

test('edition: the flag off hides the notice for any host, protocol and dismissal', () => {
    for (const [hostname, protocol, dismissed] of [
        ['example.com', 'https:', false],
        ['example.com', 'http:', true],
        ['docs.example.org', 'file:', false],
        ['localhost', 'https:', false],
        ['127.0.0.1', 'http:', false],
        ['', 'https:', false],
        [undefined, undefined, undefined],
    ]) {
        assert.equal(hostedNoticeVisible({hostedNotice: false, hostname, protocol, dismissed}), false,
            `${hostname} over ${protocol}`);
    }
});

test('edition: the flag on, a real host over https and http shows the notice', () => {
    for (const protocol of ['https:', 'http:']) {
        assert.equal(hostedNoticeVisible({hostedNotice: true, hostname: 'example.com', protocol, dismissed: false}), true,
            protocol);
    }
    assert.equal(hostedNoticeVisible({hostedNotice: true, hostname: 'docs.example.org', protocol: 'https:', dismissed: false}), true);
});

test('edition: the flag on, local hosts never show the notice', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]', '::1', 'foo.localhost', 'my.app.localhost']) {
        assert.equal(hostedNoticeVisible({hostedNotice: true, hostname, protocol: 'https:', dismissed: false}), false,
            hostname);
    }
});

test('edition: the flag on, anything but http or https never shows the notice', () => {
    for (const protocol of ['file:', 'about:', 'ftp:', '']) {
        assert.equal(hostedNoticeVisible({hostedNotice: true, hostname: 'example.com', protocol, dismissed: false}), false,
            `${protocol || '(empty)'}`);
    }
});

test('edition: a dismissal, and unexpected or missing arguments, hide the notice', () => {
    assert.equal(hostedNoticeVisible({hostedNotice: true, hostname: 'example.com', protocol: 'https:', dismissed: true}), false);
    assert.equal(hostedNoticeVisible({hostedNotice: true, hostname: 'example.com', protocol: 'https:'}), false,
        'no dismissed argument');
    assert.equal(hostedNoticeVisible({hostedNotice: true}), false, 'no hostname or protocol');
    assert.equal(hostedNoticeVisible({}), false);
    assert.equal(hostedNoticeVisible(), false);
    assert.equal(hostedNoticeVisible({hostedNotice: true, hostname: '', protocol: 'https:', dismissed: false}), false,
        'empty hostname');
    assert.equal(hostedNoticeVisible({hostedNotice: true, hostname: undefined, protocol: 'https:', dismissed: false}), false,
        'undefined hostname');
    assert.equal(hostedNoticeVisible({hostedNotice: true, hostname: 'example.com', protocol: undefined, dismissed: false}), false,
        'undefined protocol');
});
