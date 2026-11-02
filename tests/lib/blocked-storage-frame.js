/**
 * The whole editor with localStorage blocked, run in tests/lib/blocked-storage-frame.html
 * by tests/ui-prefs.test.html. Touching `localStorage` throws SecurityError here, as it does
 * when the browser refuses site data. IndexedDB still works, so documents load. What the
 * running editor shows goes to the parent with postMessage.
 */
Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('The user denied access to storage (test)', 'SecurityError'); },
});

const errors = [];
const realError = console.error.bind(console);
console.error = (...args) => { errors.push(args.map(String).join(' ')); realError(...args); };
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));

const send = (result) => parent.postMessage({frame: 'blocked-storage', errors, ...result}, location.origin);

async function loadScripts(srcs) {
    for (const src of srcs) {
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error('could not load ' + src));
            document.head.appendChild(s);
        });
    }
}

try {
    const indexUrl = new URL('../../index.html', location.href);
    const page = new DOMParser().parseFromString(await (await fetch(indexUrl)).text(), 'text/html');
    for (const link of page.head.querySelectorAll('link[rel="stylesheet"]')) {
        const el = document.createElement('link');
        el.rel = 'stylesheet';
        el.href = new URL(link.getAttribute('href'), indexUrl).href;
        document.head.appendChild(el);
    }
    for (const el of [...page.body.children]) if (el.tagName !== 'SCRIPT') document.body.appendChild(document.adoptNode(el));
    await loadScripts(['../../vendor/marked/marked.min.js', '../../vendor/dompurify/purify.min.js', '../../vendor/highlightjs/highlight.min.js']);
    const app = await import('../../js/app.js');
    await app.init();
    const $ = (id) => document.getElementById(id);
    const r = {
        booted: !$('editor').readOnly && Boolean(window.__bd && window.__bd.docManager.currentId != null),
        split: $('divider').getAttribute('aria-valuenow'),
        editorWidth: $('editor-pane').style.width,
        theme: document.documentElement.getAttribute('data-theme'),
        view: ['split', 'editor', 'preview'].find((v) => $('main').classList.contains('view-' + v)) || null,
        sidebarCollapsed: $('sidebar').classList.contains('collapsed'),
    };
    // Changing each preference still works; nothing is kept, and nothing throws.
    $('divider').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true}));
    r.splitAfterKey = $('divider').getAttribute('aria-valuenow');
    $('btn-theme').click();
    r.themeAfterToggle = document.documentElement.getAttribute('data-theme');
    $('sidebar-toggle').click();
    r.sidebarAfterToggle = $('sidebar').classList.contains('collapsed');
    send(r);
} catch (e) {
    send({error: String((e && e.stack) || e)});
}
