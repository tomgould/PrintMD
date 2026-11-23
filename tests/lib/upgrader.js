/**
 * tests/lib/upgrader.js (loaded by upgrader.html in a frame)
 *
 * Plays a second tab on the current code whose own database upgrade takes a
 * long time, as it does on a big library. It runs js/store.js's real upgrade,
 * but keeps the upgrade transaction busy until the test calls
 * window.releaseUpgrade(), so the test controls how long it lasts.
 * window.upgradeStarted and window.upgradeDone report progress.
 */
import * as store from '../../js/store.js';

let released = false;
window.upgradeStarted = false;
window.upgradeDone = false;
window.releaseUpgrade = () => { released = true; };

// The store creates its indexes in the upgrade transaction: keep that
// transaction alive with a chain of small reads until released.
const realCreateIndex = IDBObjectStore.prototype.createIndex;
IDBObjectStore.prototype.createIndex = function (...args) {
    const index = realCreateIndex.apply(this, args);
    if (!window.upgradeStarted) {
        window.upgradeStarted = true;
        const objectStore = this;
        const spin = () => {
            if (released) return;
            objectStore.get('no-such-doc').onsuccess = spin;
        };
        spin();
    }
    return index;
};

store.openDB().then(() => { window.upgradeDone = true; store.closeDB(); });
