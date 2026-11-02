/**
 * tests/lib/chrome.mjs
 *
 * Helpers for launching a throwaway headless Chrome: a random free
 * remote-debugging port and a fresh mkdtemp profile, so parallel or repeated
 * runs never collide and nothing is left behind in /tmp.
 */
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a free TCP port. */
export function freePort() {
    return new Promise((ok, fail) => {
        const s = createServer();
        s.once('error', fail);
        s.listen(0, '127.0.0.1', () => {
            const {port} = s.address();
            s.close(() => ok(port));
        });
    });
}

/**
 * Launch headless Chrome on `url`.
 * @param {string} url
 * @param {{extraArgs?: string[], bin?: string}} [opts]
 * @returns {Promise<{port: number, profileDir: string, stop: () => Promise<void>}>}
 */
export async function launchChrome(url, {extraArgs = [], bin = process.env.CHROME_BIN || 'google-chrome'} = {}) {
    const port = await freePort();
    const profileDir = mkdtempSync(join(tmpdir(), 'bd-cdp-'));
    const child = spawn(bin, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        ...extraArgs,
        url,
    ], {stdio: 'ignore', detached: true});

    let exited = false;
    const exitPromise = new Promise((ok) => child.once('exit', () => { exited = true; ok(); }));
    child.once('error', () => { exited = true; });

    // Chrome forks zygote/GPU/renderer helpers. Running it as its own process
    // group lets us signal all of them at once, so none outlive the profile dir.
    const signalGroup = (sig) => {
        try { process.kill(-child.pid, sig); } catch (_e) {
            try { child.kill(sig); } catch (_e2) { /* already gone */ }
        }
    };

    async function stop() {
        // SIGTERM first so Chrome flushes localStorage/IndexedDB; SIGKILL as a backstop.
        if (!exited) {
            signalGroup('SIGTERM');
            await Promise.race([exitPromise, sleep(2000)]);
        }
        signalGroup('SIGKILL'); // sweep any helper that outlived the main process
        if (!exited) await Promise.race([exitPromise, sleep(1000)]);
        // Chrome's helper processes can still be flushing after the main process
        // exits, so give them a moment and retry the delete.
        await sleep(200);
        try { rmSync(profileDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 150}); } catch (_e) { /* best effort */ }
    }

    /** Synchronous hard stop for scripts that call process.exit() straight after. */
    function killSync() {
        signalGroup('SIGKILL');
        try { rmSync(profileDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); } catch (_e) { /* best effort */ }
    }

    return {port, profileDir, stop, killSync};
}
