/**
 * js/editor-format.js
 *
 * Markdown formatting in the editor: the formatting toolbar's actions, Bold and
 * Italic for the shortcuts, image snippets, and the editor's own keys (Tab
 * indents, Enter continues a list, Escape then Tab leaves the editor).
 *
 * Every edit goes through js/text-insert.js, so the browser's native undo stack
 * keeps working where it can.
 */
import {replaceRange as replaceTextRange} from './text-insert.js';

/**
 * @param {{editor: HTMLTextAreaElement, onChange: Function, pickImage: Function}} deps
 *   onChange   after a toolbar edit: render the preview now and schedule the autosave
 *   pickImage  open the image file picker (the toolbar's Image button)
 */
export function createEditorFormat({editor, onChange, pickImage}) {
    /**
     * Replace editor text between [start, end) with `text`, preserving the browser's
     * native undo/redo stack via execCommand when it can, and setting the value
     * directly (plus an input event) when it cannot, e.g. in Preview-only view.
     * Always use this instead of editor.value = … for user-initiated edits.
     */
    function replaceRange(start, end, text) {
        replaceTextRange(editor, start, end, text);
    }

    /**
     * Replace the entire editor content in a single undoable step.
     * Used by reset to sample, so the user can Ctrl+Z the whole action.
     */
    function setContent(text) {
        replaceTextRange(editor, 0, editor.value.length, text);
    }

    /**
     * Wrap the current selection with before/after strings.
     * Restores the selection after wrapping.
     */
    function wrapSelection(before, after) {
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const selected = editor.value.substring(start, end);
        replaceRange(start, end, before + selected + after);
        // Restore selection inside the wrappers
        editor.setSelectionRange(start + before.length, start + before.length + selected.length);
        onChange();
    }

    /**
     * Insert/replace a heading at the level of the current line.
     * Calling the same level twice cycles it off (removes the heading).
     */
    function insertHeading(level) {
        editor.focus();
        const prefix = '#'.repeat(level) + ' ';
        const text = editor.value;
        const pos = editor.selectionStart;
        const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
        const lineEnd = text.indexOf('\n', pos);
        const end = lineEnd === -1 ? text.length : lineEnd;
        const line = text.substring(lineStart, end);
        const match = line.match(/^(#{1,6})\s/);
        // Toggle off if same level; otherwise replace/add
        const stripped = line.replace(/^#{1,6}\s/, '');
        const newLine = (match && match[1].length === level) ? stripped : prefix + stripped;
        replaceRange(lineStart, end, newLine);
        editor.setSelectionRange(lineStart + newLine.length, lineStart + newLine.length);
        onChange();
    }

    /**
     * Prefix every line that intersects the current selection.
     * @param {string} prefix  e.g. '- ', '> ', '- [ ] '
     */
    function prefixLines(prefix) {
        editor.focus();
        const text = editor.value;
        const selStart = editor.selectionStart;
        const selEnd = editor.selectionEnd;
        const lineStart = text.lastIndexOf('\n', selStart - 1) + 1;
        const afterEnd = selEnd === 0 ? 0 : selEnd - 1;
        const rawLineEnd = text.indexOf('\n', afterEnd);
        const lineEnd = rawLineEnd === -1 ? text.length : rawLineEnd;
        const block = text.substring(lineStart, lineEnd);
        const prefixed = block.split('\n').map(l => prefix + l).join('\n');
        replaceRange(lineStart, lineEnd, prefixed);
        editor.setSelectionRange(lineStart, lineStart + prefixed.length);
        onChange();
    }

    /** Prefix selected lines as a numbered list. */
    function insertOrderedList() {
        editor.focus();
        const text = editor.value;
        const selStart = editor.selectionStart;
        const selEnd = editor.selectionEnd;
        const lineStart = text.lastIndexOf('\n', selStart - 1) + 1;
        const rawLineEnd = text.indexOf('\n', selEnd === 0 ? 0 : selEnd - 1);
        const lineEnd = rawLineEnd === -1 ? text.length : rawLineEnd;
        const block = text.substring(lineStart, lineEnd);
        const numbered = block.split('\n').map((l, i) => `${i + 1}. ${l}`).join('\n');
        replaceRange(lineStart, lineEnd, numbered);
        editor.setSelectionRange(lineStart, lineStart + numbered.length);
        onChange();
    }

    /** Wrap selection (or placeholder) in a fenced code block. */
    function insertCodeBlock() {
        editor.focus();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const selected = editor.value.substring(start, end);
        const body = selected || 'your code here';
        const block = `\`\`\`\n${body}\n\`\`\``;
        replaceRange(start, end, block);
        // Select the body so the user can immediately type their code
        editor.setSelectionRange(start + 4, start + 4 + body.length);
        onChange();
    }

    /** Insert a 3-column table template at the cursor. */
    function insertTable() {
        editor.focus();
        const start = editor.selectionStart;
        const snippet = `\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |\n`;
        replaceRange(start, start, snippet);
        editor.setSelectionRange(start + 2, start + 10); // inside first cell header
        onChange();
    }

    /** Insert a markdown link, using selection as the link text. */
    function insertLink() {
        editor.focus();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const selected = editor.value.substring(start, end);
        const linkText = selected || 'link text';
        const snippet = `[${linkText}](https://)`;
        replaceRange(start, end, snippet);
        // Select the URL placeholder so the user can type immediately
        const urlStart = start + linkText.length + 3;
        editor.setSelectionRange(urlStart, urlStart + 8); // 'https://'
        onChange();
    }

    /** Insert a horizontal rule on its own lines at the cursor. */
    function insertRule() {
        editor.focus();
        const pos = editor.selectionStart;
        const snippet = '\n\n---\n\n';
        replaceRange(pos, pos, snippet);
        editor.setSelectionRange(pos + snippet.length, pos + snippet.length);
        onChange();
    }

    /** Insert an image markdown snippet from a data URL. */
    function insertImageSnippet(dataUrl, filename) {
        editor.focus();
        const alt = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
        const snippet = `![${alt}](${dataUrl})`;
        const start = editor.selectionStart;
        replaceRange(start, start, snippet);
        editor.setSelectionRange(start + snippet.length, start + snippet.length);
        onChange();
    }

    /**
     * Dispatch a formatting action by name.
     * Called by the formatting toolbar via data-fmt attributes.
     */
    function dispatchFormat(action) {
        switch (action) {
            case 'h1': insertHeading(1); break;
            case 'h2': insertHeading(2); break;
            case 'h3': insertHeading(3); break;
            case 'h4': insertHeading(4); break;
            case 'bold': wrapSelection('**', '**'); break;
            case 'italic': wrapSelection('_', '_'); break;
            case 'strike': wrapSelection('~~', '~~'); break;
            case 'code-inline': wrapSelection('`', '`'); break;
            case 'code-block': insertCodeBlock(); break;
            case 'blockquote': prefixLines('> '); break;
            case 'hr': insertRule(); break;
            case 'ul': prefixLines('- '); break;
            case 'ol': insertOrderedList(); break;
            case 'task': prefixLines('- [ ] '); break;
            case 'link': insertLink(); break;
            case 'image': pickImage(); break;
            case 'table': insertTable(); break;
        }
    }

    /** The editor's own keys: Tab / Shift+Tab indent, Enter continues a list. */
    function attachEditorKeys() {
        // Tab indents, so on its own it cannot leave the editor. Escape, then Tab
        // (or Shift+Tab), moves focus on as usual: no keyboard trap.
        let tabLeaves = false;
        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') tabLeaves = true;
            else if (e.key !== 'Tab' && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) tabLeaves = false;
        });
        editor.addEventListener('blur', () => { tabLeaves = false; });

        // Tab / Shift+Tab indentation
        editor.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (tabLeaves) {
                tabLeaves = false;
                return;              // the browser moves focus
            }

            e.preventDefault();

            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const hasMultiLine = start !== end && editor.value.slice(start, end).includes('\n');

            if (hasMultiLine || e.shiftKey) {
                const firstLineStart = editor.value.lastIndexOf('\n', start - 1) + 1;
                const lastLineEndRaw = editor.value.indexOf('\n', end === 0 ? 0 : end - 1);
                const lastLineEnd = lastLineEndRaw === -1 ? editor.value.length : lastLineEndRaw;
                const block = editor.value.substring(firstLineStart, lastLineEnd);
                const lines = block.split('\n');
                const modified = lines.map((line) => {
                    if (e.shiftKey) {
                        return line.replace(/^ {1,2}/, '');
                    }
                    return '  ' + line;
                }).join('\n');
                replaceRange(firstLineStart, lastLineEnd, modified);
                editor.setSelectionRange(firstLineStart, firstLineStart + modified.length);
                editor.dispatchEvent(new Event('input', {bubbles: true}));
            } else {
                replaceRange(start, end, '  ');
            }
        });

        // Smart list continuation on Enter
        editor.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            if (e.shiftKey || e.ctrlKey || e.metaKey) return;

            const pos = editor.selectionStart;
            const lineStart = editor.value.lastIndexOf('\n', pos - 1) + 1;
            const line = editor.value.substring(lineStart, pos);
            const match = line.match(/^(\s*)([-*+]|(\d+)\.)\s+(.*)$/);

            if (!match) return;

            e.preventDefault();

            const [, indent, unorderedMarker, orderedNum, content] = match;

            if (content === '') {
                // Empty bullet: remove the entire line prefix
                replaceRange(lineStart, pos, '');
                editor.setSelectionRange(lineStart, lineStart);
                editor.dispatchEvent(new Event('input', {bubbles: true}));
            } else {
                const prefix = indent + (orderedNum ? (parseInt(orderedNum, 10) + 1) + '. ' : unorderedMarker + ' ');
                replaceRange(pos, editor.selectionEnd, '\n' + prefix);
                // Ensure preview updates in case the browser didn't fire input
                editor.dispatchEvent(new Event('input', {bubbles: true}));
            }
        });
    }

    return {dispatchFormat, wrapSelection, insertImageSnippet, setContent, attachEditorKeys};
}
