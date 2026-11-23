/**
 * Shared by tests/template-layers.test.html and tests/template-boot.test.html: run one
 * template-registry case in tests/lib/registry-frame.html, and check the banner a
 * page shows when the core templates cannot be loaded.
 */
import {assert} from './harness.js';

/** Run one case in a fresh frame (a fresh module graph) and wait for its report. */
export function inFrame(which, {app = false} = {}) {
    return new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.title = `case ${which}`;
        const onMessage = (ev) => {
            if (ev.origin !== location.origin || !ev.data || ev.data.frame !== which) return;
            window.removeEventListener('message', onMessage);
            frame.remove();
            resolve(ev.data);
        };
        window.addEventListener('message', onMessage);
        frame.src = `lib/registry-frame.html?case=${encodeURIComponent(which)}${app ? '&app=1' : ''}`;
        document.body.appendChild(frame);
    });
}

export const FAILED = 'PrintMD could not load its templates. Reload the page; if it keeps happening, tell whoever runs this site.';

/** The one visible, non-modal alert that says what to do, read out once, focus left alone. */
export function assertFailureBanner(r, focused) {
    const mine = r.alerts.filter((a) => a.text === FAILED);
    assert(mine.length === 1, 'one banner with the message: ' + JSON.stringify(r.alerts));
    assert(r.alerts.filter((a) => a.shown).length === 1, 'no other alert speaks: ' + JSON.stringify(r.alerts));
    assert(mine[0].shown, 'the banner is shown');
    assert(mine[0].modal === null && mine[0].tabindex === null, 'not modal, not focusable: ' + JSON.stringify(mine[0]));
    assert(r.announcements === 1, 'announced once: ' + r.announcements);
    assert(r.focused === focused, `focus stays on ${focused}: ` + r.focused);
    assert(r.errors.length === 1 && r.errors[0].includes('manifest.core.json'), 'one console error naming the core manifest: ' + r.errors);
    assert(r.violations.length === 0, 'no policy violation: ' + r.violations);
}
