/**
 * Which server/test/*.test.mjs files tests/run-all.mjs runs.
 *
 * On CI (CI=1, the CI container at about half a CPU) only the print
 * quality gate runs: the whole server suite takes over 17 minutes there and its
 * timing tests (queue, slow clients, render timeout) do not hold. Everywhere
 * else every file runs. SERVER_TESTS=all runs every file; SERVER_TESTS=a,b the
 * files whose names contain a or b.
 */

/**
 * The print-quality gate CI runs: the QA on every template and its bad-PDF checks, one
 * guard per print rule in few renders (print-gate; the fuller print-checks runs elsewhere),
 * the tidy's decisions, and the template platform (running head and foot, Slide, fonts)
 * on the test-only fixture template, and page control (a custom size, the continuous page and its split,
 * fit width and its lower bound, the margin override, the page options refused).
 */
export const CI_SERVER_TESTS = Object.freeze(['print-quality.test', 'print-gate.test', 'tidy.test', 'template-platform.test',
    'page-control.test']);

/**
 * @param {string[]} all  the server test file names (sorted)
 * @param {{CI?: string, SERVER_TESTS?: string}} [env]
 * @returns {{files: string[], pick: string}}  files: the chosen names; pick: the selection as SERVER_TESTS spells it
 */
export function serverTestFiles(all, env = process.env) {
    const pick = env.SERVER_TESTS || (env.CI ? CI_SERVER_TESTS.join(',') : 'all');
    const words = pick.split(',').map((w) => w.trim()).filter(Boolean);
    const files = pick === 'all' ? [...all] : all.filter((f) => words.some((w) => f.includes(w)));
    return {files, pick};
}
