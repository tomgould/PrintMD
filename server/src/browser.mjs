/**
 * One long-lived Chromium for all renders (each render gets its own context).
 *
 * The browser is started on first use and again after it crashes or
 * disconnects. After maxRenders renders it is retired: new renders go to a
 * fresh browser and the old one closes once its last render finishes, so a
 * slow leak in Chromium never builds up and one bad request cannot leave the
 * service without a browser.
 */
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';

/**
 * Chromium flags. The resolver rule and the dead proxy are the second network
 * layer: anything that got past request interception has no name to resolve
 * and no route out.
 */
export const LAUNCH_ARGS = Object.freeze([
    '--host-resolver-rules=MAP * ~NOTFOUND',
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-pings',
    '--disable-dev-shm-usage',
]);

/** How long a browser may take to close politely before its process group is killed. */
const CLOSE_GRACE_MS = 3_000;

export class BrowserNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BrowserNotFoundError';
    }
}

/**
 * The Chromium binary: PRINTMD_CHROME when set, else Playwright's own Chromium.
 * @param {string} [configured]  PRINTMD_CHROME
 * @returns {string}
 */
export function findChrome(configured = '') {
    const fixes = 'Either set PRINTMD_CHROME to a Chrome or Chromium binary (for example PRINTMD_CHROME=/usr/bin/google-chrome), '
        + 'or install Playwright\'s Chromium with: npx --prefix server playwright install chromium';
    if (configured) {
        if (!existsSync(configured)) throw new BrowserNotFoundError(`PRINTMD_CHROME points to a file that does not exist. ${fixes}`);
        return configured;
    }
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
    throw new BrowserNotFoundError(`No Chromium found. ${fixes}`);
}

/** No sandbox only as root or on CI, where Chromium cannot start one. */
export function needsNoSandbox(env = process.env) {
    return (typeof process.getuid === 'function' && process.getuid() === 0) || Boolean(env.CI);
}

export class BrowserPool {
    /**
     * @param {{executablePath: string, maxRenders?: number, sandbox?: boolean, idleCloseMs?: number}} opts
     *        idleCloseMs: close the browser this long after its last render ends (0: keep it open);
     *        the next acquire starts a fresh one, so an idle service holds no browser memory or CPU
     */
    constructor({executablePath, maxRenders = 200, sandbox = !needsNoSandbox(), launchTimeoutMs = 30_000, idleCloseMs = 0}) {
        this.executablePath = executablePath;
        this.idleCloseMs = idleCloseMs;
        this.maxRenders = maxRenders;
        this.sandbox = sandbox;
        this.launchTimeoutMs = launchTimeoutMs;
        this.current = null;     // {server, browser, renders, active, retiring, closing}
        this.gens = new Set();   // every browser still running, current or retiring
        this.launching = null;
        this.epoch = 0;          // bumped by forceRestart and close: a launch from an older epoch is killed
        this.launches = 0;
        this.crashes = 0;
        this.forcedRestarts = 0;
        this.totalRenders = 0;
        this.degraded = false;
        this.closed = false;
    }

    // Launched as a browser server, so the process can be killed outright when
    // it stops answering (Browser.close() would wait on the wedged browser).
    async #launch(epoch) {
        const server = await chromium.launchServer({
            executablePath: this.executablePath,
            headless: true,
            chromiumSandbox: this.sandbox,
            args: [...LAUNCH_ARGS],
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            timeout: this.launchTimeoutMs,
        });
        let browser;
        try {
            browser = await chromium.connect(server.wsEndpoint(), {timeout: this.launchTimeoutMs});
        } catch (err) {
            await server.kill().catch(() => {});
            throw err;
        }
        const gen = {server, browser, renders: 0, active: 0, retiring: false, closing: false};
        this.launches++;
        if (epoch !== this.epoch || this.closed) {
            // forceRestart or close came while this one was starting.
            this.#kill(gen);
            return null;
        }
        this.gens.add(gen);
        browser.on('disconnected', () => {
            if (!gen.closing) this.crashes++;
            // The connection can drop while Chromium keeps running (an oversized
            // message, a protocol error): kill the process before forgetting it.
            this.#kill(gen);
        });
        return gen;
    }

    async #ensure() {
        for (;;) {
            if (this.closed) throw new Error('pool closed');
            if (this.current && !this.current.retiring && this.current.browser.isConnected()) return this.current;
            if (!this.launching) {
                this.launching = this.#launch(this.epoch)
                    .then((gen) => {
                        if (gen) this.current = gen;
                        return gen;
                    })
                    .finally(() => { this.launching = null; });
            }
            const gen = await this.launching;
            if (gen) return gen;
        }
    }

    /** Close a browser politely, then kill whatever is left (also when the close stalls). */
    async #closeGen(gen) {
        gen.closing = true;
        clearTimeout(gen.idleTimer);
        this.gens.delete(gen);
        if (this.current === gen) this.current = null;
        let timer;
        await Promise.race([
            gen.server.close().catch(() => {}),
            new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_GRACE_MS); }),
        ]);
        clearTimeout(timer);
        await this.#killProcess(gen);
    }

    /** Kill a browser process outright; it is replaced on the next acquire. */
    #kill(gen) {
        gen.closing = true;
        clearTimeout(gen.idleTimer);
        this.gens.delete(gen);
        if (this.current === gen) this.current = null;
        this.#killProcess(gen);
    }

    /**
     * SIGKILL the browser's whole process group: Playwright starts Chromium as
     * a group leader, so its zygote, GPU and renderer children go too, even
     * when the main process is already gone. Safe to repeat.
     */
    async #killProcess(gen) {
        const proc = gen.server.process();
        if (proc && proc.pid) {
            try {
                process.kill(-proc.pid, 'SIGKILL');
            } catch { /* group already gone */ }
        }
        await gen.server.kill().catch(() => {});
    }

    /**
     * Close a browser that has had no render for idleCloseMs. A render that starts first cancels it
     * (acquire clears the timer); the timer never keeps the process alive.
     */
    #closeWhenIdle(gen) {
        clearTimeout(gen.idleTimer);
        gen.idleTimer = setTimeout(() => {
            if (gen.active === 0 && !gen.closing) this.#closeGen(gen);
        }, this.idleCloseMs);
        gen.idleTimer.unref();
    }

    /**
     * A browser for one render. Call release() when the render is over, or
     * kill() first when the browser stopped answering.
     * @returns {Promise<{browser: import('playwright').Browser, release: () => void, kill: () => void}>}
     */
    async acquire() {
        const gen = await this.#ensure();
        clearTimeout(gen.idleTimer);
        gen.active++;
        gen.renders++;
        this.totalRenders++;
        if (gen.renders >= this.maxRenders) {
            gen.retiring = true;
            if (this.current === gen) this.current = null;
        }
        let released = false;
        return {
            browser: gen.browser,
            release: () => {
                if (released) return;
                released = true;
                gen.active--;
                if (gen.retiring && gen.active === 0 && !gen.closing) this.#closeGen(gen);
                else if (gen.active === 0 && !gen.closing && this.idleCloseMs > 0) this.#closeWhenIdle(gen);
            },
            kill: () => {
                this.degraded = true;
                this.forcedRestarts++;
                if (!gen.closing) this.#kill(gen);
            },
        };
    }

    /**
     * The browser stopped answering (a launch or a hand-out that never finished):
     * kill every browser process, including one still starting, and start afresh
     * on the next acquire. Health reports "degraded" until a render succeeds.
     */
    forceRestart() {
        this.degraded = true;
        this.forcedRestarts++;
        this.epoch++;
        for (const gen of [...this.gens]) this.#kill(gen);
        this.current = null;
    }

    /** A render finished: the browser is answering again. */
    renderSucceeded() {
        this.degraded = false;
    }

    /** The current browser's process id (tests), or 0. */
    browserPid() {
        const proc = this.current && this.current.server.process();
        return proc ? proc.pid : 0;
    }

    /** For GET /health: no paths, no versions, no secrets. */
    status() {
        const up = this.current && this.current.browser.isConnected();
        const state = this.degraded ? 'degraded' : (up ? 'up' : (this.launching ? 'starting' : 'idle'));
        return {
            state,
            rendersOnThisBrowser: this.current ? this.current.renders : 0,
            renders: this.totalRenders,
            launches: this.launches,
            crashes: this.crashes,
            forcedRestarts: this.forcedRestarts,
            maxRendersPerBrowser: this.maxRenders,
        };
    }

    async close() {
        this.closed = true;
        this.epoch++;
        if (this.launching) await this.launching.catch(() => null);
        this.current = null;
        await Promise.all([...this.gens].map((gen) => this.#closeGen(gen)));
    }
}
