/**
 * The server test selection (tests/lib/server-tests.mjs): CI runs exactly the
 * print-quality gate, everywhere else runs every file, SERVER_TESTS overrides.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {serverTestFiles} from './lib/server-tests.mjs';

const ALL = readdirSync(new URL('../server/test/', import.meta.url)).filter((f) => f.endsWith('.test.mjs')).sort();

test('server tests on CI: exactly the print-quality gate, every file of it present', () => {
    const {files} = serverTestFiles(ALL, {CI: '1'});
    assert.deepEqual(files, ['page-control.test.mjs', 'print-gate.test.mjs', 'print-quality.test.mjs', 'template-platform.test.mjs',
        'tidy.test.mjs']);
    assert.ok(!files.includes('tidy-load.test.mjs'), 'the heavy tidy load test stays out');
    assert.ok(!files.includes('print-checks.test.mjs'), 'the fuller print checks run outside CI');
});

test('server tests elsewhere: every file; SERVER_TESTS=all or a list overrides CI', () => {
    assert.deepEqual(serverTestFiles(ALL, {}).files, ALL);
    assert.deepEqual(serverTestFiles(ALL, {CI: '1', SERVER_TESTS: 'all'}).files, ALL);
    assert.deepEqual(serverTestFiles(ALL, {CI: '1', SERVER_TESTS: 'units, fonts'}).files, ['fonts.test.mjs', 'units.test.mjs']);
    assert.deepEqual(serverTestFiles(ALL, {SERVER_TESTS: 'no-such-file'}).files, []);
});
