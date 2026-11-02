/**
 * js/builtins-save.js  (classic script, loaded just before vendor/pptxgenjs)
 *
 * pptxgen.bundle.js carries core-js 2, which decides the browser's own
 * String.prototype.trim is non-compliant (Unicode no longer counts U+180E as
 * white space) and replaces the trim family, and Number.parseInt/parseFloat,
 * with regex versions. Those are quadratic on text with a long run of white
 * space: trimming "fn a" + 1 MB of spaces + "x" took minutes, and every
 * importer, Turndown and marked call trim on untrusted text.
 *
 * This saves the browser's functions; js/builtins-restore.js, loaded just
 * after the bundle, puts them back. The key is a registered symbol, so no
 * element id can stand in for it.
 */
(function () {
    'use strict';
    var KEY = Symbol.for('printmd.native-builtins');
    var saved = [];
    function keep(owner, name) {
        var desc = Object.getOwnPropertyDescriptor(owner, name);
        if (desc) saved.push({owner: owner, name: name, desc: desc});
    }
    ['trim', 'trimStart', 'trimEnd', 'trimLeft', 'trimRight'].forEach(function (name) { keep(String.prototype, name); });
    keep(Number, 'parseInt');
    keep(Number, 'parseFloat');
    keep(window, 'parseInt');
    keep(window, 'parseFloat');
    Object.defineProperty(window, KEY, {value: saved, configurable: true});
}());
