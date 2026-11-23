/**
 * js/builtins-restore.js  (classic script, loaded just after vendor/pptxgenjs)
 *
 * Puts back the browser's own trim family and parseInt/parseFloat that
 * js/builtins-save.js kept before pptxgen's core-js replaced them with
 * quadratic regex versions. The browser's functions follow the current
 * standard, so pptxgen works the same with them.
 */
(function () {
    'use strict';
    var KEY = Symbol.for('printmd.native-builtins');
    var saved = window[KEY];
    if (!Array.isArray(saved)) return;
    saved.forEach(function (entry) {
        var now = Object.getOwnPropertyDescriptor(entry.owner, entry.name);
        if (!now || now.value !== entry.desc.value) Object.defineProperty(entry.owner, entry.name, entry.desc);
    });
    delete window[KEY];
}());
