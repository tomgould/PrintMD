#!/usr/bin/env node
/**
 * PrintMD PDF API.
 *
 *   npm run start:local    local mode: 127.0.0.1 only, no sign-in, API on
 *   npm start              deployed mode: the access login (PRINTMD_AUTH=access,
 *                          or token for a shared API token), API off unless
 *                          PRINTMD_API_ENABLED=1
 *
 * Settings: see src/config.mjs and server/README.md.
 */
import {loadConfig, ConfigError} from './config.mjs';
import {EDITION} from './edition.mjs';
import {BrowserNotFoundError} from './browser.mjs';
import {TemplateRegistryError} from '../../js/template-registry.js';

// The runtime loads the template registry as it is imported. A broken layer is only a
// warning there; a broken core manifest is fatal, and gets a one-line message, not a stack.
let runtime;
try {
    runtime = await import('./runtime.mjs');
} catch (err) {
    if (err instanceof TemplateRegistryError) {
        process.stderr.write(`printmd-pdf-api: the templates cannot be loaded: ${err.message}\n`);
        process.exit(2);
    }
    throw err;
}
const {startApi, jsonLineLogger} = runtime;
const log = jsonLineLogger(process.stdout);

let config;
try {
    config = loadConfig({edition: EDITION});
} catch (err) {
    if (err instanceof ConfigError) {
        process.stderr.write(`printmd-pdf-api: ${err.message}\n`);
        process.exit(2);
    }
    throw err;
}
// The configuration keeps only the token's digest; the browser this process
// starts inherits the environment, so the token leaves it here.
delete process.env.PRINTMD_API_TOKEN;

let api;
try {
    api = await startApi(config, {log});
} catch (err) {
    if (err instanceof ConfigError) {
        process.stderr.write(`printmd-pdf-api: ${err.message}\n`);
        process.exit(2);
    }
    if (err instanceof BrowserNotFoundError) {
        process.stderr.write(`printmd-pdf-api: ${err.message}\n`);
        process.exit(3);
    }
    process.stderr.write(`printmd-pdf-api: could not start (${err.code || err.name}).\n`);
    process.exit(1);
}

log({event: 'listening', url: api.url, mode: config.mode, apiEnabled: config.apiEnabled, version: api.version});
if (!config.apiEnabled) {
    process.stderr.write('printmd-pdf-api: the API is switched off (PRINTMD_API_ENABLED is not set); /api/v1 answers 503.\n');
}

// Never print a rejection's message: it can carry Chromium text that quotes a document.
process.on('unhandledRejection', (err) => log({event: 'unhandled_rejection', name: err && err.name}));

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        if (stopping) return;
        stopping = true;
        log({event: 'stopping', signal});
        await api.close();
        process.exit(0);
    });
}
