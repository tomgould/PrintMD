/**
 * js/page-options-dialog.js
 *
 * The Page options dialog (README, Export: Page options): a custom page size
 * (width, height, unit), the layout (pages or one continuous page), fit to size
 * and a margin override, for the open document. Built like the app's other
 * dialogs (js/password-dialog.js): Tab stays inside, Escape and Cancel change
 * nothing, focus returns where it was. Save checks every value through
 * js/export-options.js, the same rules storage and the PDF API use: a value
 * outside them is named in the dialog (role alert) and nothing is saved.
 */

import {openModal} from './dialog-a11y.js';
import {
    FITS, LAYOUTS, MARGIN_UNITS, PAGE_LIMITS, PAGE_UNITS, formatCustomSize, parseCustomSize, validMargin,
} from './export-options.js';

/** A number as typed: digits with up to three decimals, nothing else (no sign, exponent or unit). */
const NUMBER_RE = /^\s*(\d{1,5}(?:\.\d{1,3})?|\.\d{1,3})\s*$/;

/** "100x150mm" as width, height and unit for the form; empty fields for none. */
function sizeFields(customSize) {
    const s = parseCustomSize(customSize);
    return s ? {width: String(s.width), height: String(s.height), unit: s.unit} : {width: '', height: '', unit: 'mm'};
}

/** "12.5mm" as number and unit for the form; empty for none. */
function marginFields(margin) {
    const m = /^(\d+(?:\.\d+)?)(mm|cm|in|pt)$/.exec(validMargin(margin) || '');
    return m ? {value: m[1], unit: m[2]} : {value: '', unit: 'mm'};
}

/**
 * @param {HTMLElement} root  the #page-options-modal element (index.html)
 * @returns {(state: {useCustom: boolean, customSize?: string, layout: string, fit: string, margin?: string,
 *            templateMargin: string, frontMatterKeys?: string[], check?: (result: object) => string|null})
 *            => Promise<{useCustom: boolean, customSize?: string, layout: string, fit: string, margin?: string}|null>}
 *          state: what the document has now (margin: its override, if any); templateMargin: shown as the
 *          margin used when none is typed; frontMatterKeys: the options its front matter sets (named in a note);
 *          check: the caller's last word on the result (a margin too large for the page), a sentence or null.
 *          Resolves with the clean choice, or null when cancelled.
 */
export function createPageOptionsDialog(root) {
    const $ = (id) => root.querySelector(`#${id}`);
    const custom = $('po-custom');
    const width = $('po-width');
    const height = $('po-height');
    const unit = $('po-unit');
    const fit = $('po-fit');
    const margin = $('po-margin');
    const marginUnit = $('po-margin-unit');
    const note = $('po-note');
    const error = $('po-error');
    const layouts = Array.from(root.querySelectorAll('input[name="po-layout"]'));
    const backdrop = root.querySelector('[data-role="backdrop"]');
    let finish = null;
    let check = null;

    const layoutValue = () => (layouts.find((r) => r.checked) || {value: 'paged'}).value;
    /** The size fields only count, and only take focus, when the custom size is ticked; widest only on one page. */
    function sync() {
        for (const el of [width, height, unit]) el.disabled = !custom.checked;
        const widest = fit.querySelector('option[value="widest"]');
        widest.disabled = layoutValue() !== 'continuous';
        if (widest.disabled && fit.value === 'widest') fit.value = 'width';
    }
    custom.addEventListener('change', sync);
    for (const r of layouts) r.addEventListener('change', sync);

    /** Clear the marks a refused value left on its field. */
    function clearInvalid() {
        for (const el of [width, height, margin]) {
            el.removeAttribute('aria-invalid');
            el.removeAttribute('aria-errormessage');
        }
    }

    function fail(message, field) {
        error.textContent = message;
        clearInvalid();
        if (field) {
            // The field points at the message (role alert, read out at once) and takes the focus.
            field.setAttribute('aria-invalid', 'true');
            field.setAttribute('aria-errormessage', error.id);
            field.focus();
        }
        return null;
    }

    /** The form as clean values, or null after naming what is wrong. */
    function read() {
        const out = {useCustom: custom.checked, layout: layoutValue(), fit: fit.value};
        if (!LAYOUTS.includes(out.layout) || !FITS.includes(out.fit)) return fail('Choose a layout and a fit.');
        if (out.fit === 'widest' && out.layout !== 'continuous') out.fit = 'width';
        const {minSideMm, maxSideMm, maxAreaMm2} = PAGE_LIMITS;
        const sizeRule = `Width and height are numbers from ${minSideMm} to ${maxSideMm} mm a side (in ${PAGE_UNITS.join(', ')}), `
            + `at most ${maxAreaMm2 / 1e6} square metres.`;
        // The remembered size is kept when the custom size is not ticked; typed values are checked only when it is.
        if (custom.checked) {
            if (!NUMBER_RE.test(width.value)) return fail(sizeRule, width);
            if (!NUMBER_RE.test(height.value)) return fail(sizeRule, height);
            const size = formatCustomSize({width: Number(width.value), height: Number(height.value), unit: unit.value});
            if (!size) return fail(sizeRule, width);
            out.customSize = size;
        } else if (NUMBER_RE.test(width.value) && NUMBER_RE.test(height.value)) {
            const size = formatCustomSize({width: Number(width.value), height: Number(height.value), unit: unit.value});
            if (size) out.customSize = size;
        }
        if (margin.value.trim() !== '') {
            const value = NUMBER_RE.exec(margin.value);
            const m = value && MARGIN_UNITS.includes(marginUnit.value) ? validMargin(`${Number(value[1])}${marginUnit.value}`) : null;
            if (!m) return fail(`The margin is a number in ${MARGIN_UNITS.join(', ')}, from 0 to about 100 mm; leave it empty for the template's.`, margin);
            out.margin = m;
        }
        const problem = check ? check(out) : null;
        if (problem) return fail(problem, out.margin ? margin : (custom.checked ? width : null));
        return out;
    }

    function fillForm(state) {
        custom.checked = Boolean(state.useCustom);
        const s = sizeFields(state.customSize);
        width.value = s.width;
        height.value = s.height;
        unit.value = s.unit;
        for (const r of layouts) r.checked = r.value === (LAYOUTS.includes(state.layout) ? state.layout : 'paged');
        fit.value = FITS.includes(state.fit) ? state.fit : 'off';
        const m = marginFields(state.margin);
        margin.value = m.value;
        marginUnit.value = m.unit;
        margin.placeholder = `Template (${state.templateMargin})`;
        error.textContent = '';
        clearInvalid();
        sync();
    }

    root.querySelector('[data-choice="save"]').addEventListener('click', () => {
        if (!finish) return;
        const result = read();
        if (result) finish(result);
    });
    root.querySelector('[data-choice="cancel"]').addEventListener('click', () => { if (finish) finish(null); });
    root.querySelector('[data-choice="reset"]').addEventListener('click', () => {
        for (const r of layouts) r.checked = r.value === 'paged';
        fit.value = 'off';
        margin.value = '';
        custom.checked = false;
        error.textContent = '';
        sync();
    });
    root.addEventListener('keydown', (e) => {
        // Enter in a field saves, as in the app's other dialogs.
        if (!finish || e.key !== 'Enter' || !(e.target instanceof HTMLInputElement) || e.target.type === 'checkbox'
            || e.target.type === 'radio') return;
        e.preventDefault();
        root.querySelector('[data-choice="save"]').click();
    });
    if (backdrop) backdrop.addEventListener('click', () => { if (finish) (custom.checked ? width : custom).focus(); });

    return function openPageOptions(state) {
        if (finish) finish(null);   // never stack two
        check = typeof state.check === 'function' ? state.check : null;
        fillForm(state);
        const keys = Array.isArray(state.frontMatterKeys) ? state.frontMatterKeys : [];
        note.textContent = keys.length
            ? `This document's front matter sets ${keys.join(', ')}; what you save here wins.`
            : 'Each document keeps its own page options.';
        return new Promise((resolve) => {
            let modal = null;
            finish = (value) => {
                finish = null;
                root.hidden = true;
                if (modal) modal.close();
                resolve(value);
            };
            root.hidden = false;
            modal = openModal(root, {initialFocus: custom.checked ? width : custom, onEscape: () => { if (finish) finish(null); }});
        });
    };
}
