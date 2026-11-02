# Manual Test Checklist

These checks need a real browser, real files or native dialogs, so `node tests/run-all.mjs` cannot cover them. Checks
D1 to D5 use the File System Access API, which only exists in secure contexts (https or localhost) and needs real user
gestures.

**Never run by a person yet:** real Microsoft Word and PowerPoint (O1, O2), Firefox and Safari (S3 step 4, S9 step 2,
A2), screen readers (A1 NVDA, A2 VoiceOver), Google Drive with real credentials (S1, S2), the templates in the
browser's print (T1 to T3), the Claude Code skill (P3) and the service across a real login (P4). Until someone runs them,
those areas are untested. Write the date, browser and result next to a check when you run it.

| Check | What it covers |
|-------|----------------|
| **Files on disk and storage** | |
| [D1](#d1-open-from-disk-and-auto-reload) | Open from disk and auto-reload |
| [D2](#d2-dirty-conflict-dialog) | Conflict dialog when the file changes under unsaved edits |
| [D3](#d3-a-hidden-tab-pauses-polling) | A hidden tab pauses polling |
| [D4](#d4-reload-the-page-then-grant-permission-again-from-the-sidebar) | Permission again after a page reload |
| [D5](#d5-save-to-disk-real-file-picker) | Save to disk with the real file picker |
| [D6](#d6-delete-a-document-native-confirm) | Delete a document |
| [D7](#d7-drop-a-file-onto-the-window) | Drop a file onto the window |
| [D8](#d8-leave-the-page-with-unsaved-text) | Leave the page with unsaved text; storage blocked |
| [D9](#d9-sidebar-paging-and-search-on-a-real-library) | Sidebar paging and search on a real library; the keys for the 1st to 9th document |
| [D10](#d10-copy-html-over-plain-http) | Copy HTML over plain http, with a real clipboard |
| [D11](#d11-a-tab-on-an-older-version-blocks-the-upgrade) | A tab on an older version blocks the database upgrade |
| [D12](#d12-each-document-keeps-its-settings) | Each document keeps its template, size, orientation and format through a reload and a new browser session |
| [D13](#d13-the-split-theme-view-and-sidebar-are-remembered) | The split, theme, view and sidebar are remembered through a reload and a new browser session |
| **Security under the Content-Security-Policy** | |
| [S1](#s1-google-drive-import-with-real-credentials) | Google Drive import with real credentials |
| [S2](#s2-google-docs-sheets-and-other-drive-types-real-google) | Google Docs, Sheets and other Drive types |
| [S3](#s3-pdf-imports-that-need-real-files) | PDF imports that need real files (scans, 300+ pages, passwords, Safari) |
| [S4](#s4-an-embed-from-an-allow-listed-host-plays) | An allow-listed embed plays |
| [S5](#s5-pdf-export-through-the-print-window) | PDF export through the print window |
| [S6](#s6-images-over-plain-http-do-not-load) | Images over plain http do not load |
| [S7](#s7-preflight-warnings-come-before-the-print-window) | Preflight warnings before the print window |
| [S8](#s8-print-preview-fidelity) | Print preview fidelity: fonts and cover |
| [S9](#s9-print-quality-of-the-editors-pdf-in-chrome-firefox-and-safari) | Print quality of the editor's PDF in Chrome, Firefox and Safari |
| [S10](#s10-code-blocks-in-the-print-dialogs-pdf) | Code blocks in the print dialog's PDF: language label and colours |
| **Front matter** | |
| [F1](#f1-front-matter-in-the-editor-and-every-export) | Front matter in the editor and every export |
| **Templates** | |
| [T1](#t1-the-template-picker-and-each-templates-page) | The template picker, its groups, and each template's page sizes and starting page |
| [T2](#t2-a-running-head-and-foot-in-the-editors-pdf) | A running head and foot, and the Slide size, in the editor's PDF |
| [T3](#t3-the-cover-in-the-preview) | The cover in the preview, in both orientations and Slide |
| **Page options** | |
| [L1](#l1-a-custom-size) | A custom size in the print dialog's PDF, and values the dialog refuses |
| [L2](#l2-one-continuous-page) | One continuous page: three templates, bookmarks and links, a manual break ignored |
| [L3](#l3-fit-to-size) | Fit width, its 40% limit, and widest |
| [L4](#l4-the-margin) | Margins of 0 and 30 mm, and the running head under 18 mm |
| [L5](#l5-each-document-keeps-its-page-options) | Each document keeps its page options through a reload and a restart; a new one starts plain |
| **Word and PowerPoint in Microsoft Office** | |
| [O1](#o1-the-word-file-opens-cleanly) | The Word file opens cleanly |
| [O2](#o2-the-powerpoint-file-opens-cleanly) | The PowerPoint file opens cleanly |
| **The PDF API** | |
| [P1](#p1-a-colleagues-first-run-of-the-pdf-api) | A colleague's first run of the PDF API |
| [P2](#p2-web-pages-cannot-reach-the-local-pdf-api) | Web pages cannot reach the local PDF API |
| [P3](#p3-a-colleagues-first-pdf-through-the-claude-code-skill) | A colleague's first PDF through the Claude Code skill |
| [P4](#p4-the-pdf-api-as-a-service-linux) | The PDF API as a systemd user service: install, login, idle, stop |
| **Accessibility** | |
| [A1](#a1-nvda-with-chrome-or-firefox-windows) | NVDA with Chrome or Firefox (Windows) |
| [A2](#a2-voiceover-with-safari-macos) | VoiceOver with Safari (macOS) |
| [A3](#a3-windows-high-contrast-forced-colours) | Windows High Contrast (forced colours) |
| [A4](#a4-touch-screen-phone-or-tablet) | Touch screen (phone or tablet) |

## Prerequisites

- Serve the app over http on localhost, for example `python3 -m http.server 8080`, and open `http://localhost:8080`.
  Opening `index.html` from disk (`file://`) does not work.
- Use a Chromium-based browser (Chrome or Edge) with the File System Access API, except where a check names another
  browser.
- `markdown-showcase.md` links three photos from picsum.photos that print at about 96 to 120 ppi (worked out from
  their pixel widths), so exporting it should open the *"Check before exporting"* dialog listing them: click **Export
  anyway** to go on.
- Have a `.md` file available on disk to open.

## Files on disk and storage

### D1. Open from disk and auto-reload

1. Click **Open** in the toolbar or **Open…** in the sidebar.
2. Pick a `.md` file from disk.
3. Edit that file in another app (e.g. VS Code, Notepad) and save.
4. **Expected:** within ~2 seconds the editor auto-reloads with the new content and a toast says *"Reloaded from disk"*.

### D2. Dirty conflict dialog

1. Open a disk-backed file as above.
2. Make a local edit in the editor (the doc is now dirty).
3. Edit the file on disk in another app and save.
4. **Expected:** an in-app dialog titled *"File changed on disk"* appears with **Keep mine** (focused) and **Load disk version**.
5. Click **Load disk version**: the disk version loads and the doc is clean again.
6. Repeat, but press **Escape** or click **Keep mine**: your local edits are kept, the doc stays dirty, and the dialog does not reappear for the same disk version.
7. Save the file in the other app again. **Expected:** the dialog appears again for the newer disk version.

### D3. A hidden tab pauses polling

1. Open a disk-backed file.
2. Switch to another browser tab or minimise the window.
3. Edit the file on disk and save.
4. Switch back to the app tab.
5. **Expected:** the file is checked as soon as the window regains focus, and no later than the next poll (about 1.5 seconds). The editor reloads with the new content. Polling is stopped while the tab is hidden.

### D4. Reload the page, then grant permission again from the sidebar

1. Open a disk-backed file.
2. Reload the browser page.
3. The sidebar still shows the disk-backed document.
4. Click that document in the sidebar.
5. **Expected:** the stored file handle may need its permission granted again after a reload, so the click (a user gesture) calls `requestPermission({ mode: 'read' })`, which either succeeds silently or shows the browser's permission prompt. After that the doc loads and the watcher starts.

### D5. Save to disk (real file picker)

1. Open a disk-backed file, edit it, press **Ctrl+S**. **Expected:** the file on disk has your text, the toast says *"Saved to <filename>"*, the doc is clean.
2. On a new local doc (**Alt+N**, or **Ctrl+Option+N** on macOS), type text and press **Ctrl+S**. Pick a new file in the save dialog. **Expected:** the file is written and the doc becomes disk-backed; editing it in another app now triggers D1.
3. Open a disk-backed file, edit it in another app and save, then press **Ctrl+S** in PrintMD without waiting. **Expected:** a dialog warns the file changed on disk, with **Cancel** focused, before anything is overwritten. The other choices are **Load disk version** and **Overwrite disk with mine**.
4. Press **Ctrl+S**, then immediately click another doc in the sidebar. Come back to the first doc after a few seconds. **Expected:** no false "File changed on disk" dialog for your own save.

### D6. Delete a document (native confirm)

1. In the sidebar, hover a doc and click the **×**. **Expected:** a confirm asks before deleting; **Cancel** keeps it.
2. Delete the only remaining doc. **Expected:** one blank doc is left, and the deleted doc does not reappear after a reload.

### D7. Drop a file onto the window

1. Drag a `.md` file from your file manager onto the app. **Expected:** it opens as a new doc and the browser does not navigate away.
2. Drag a `.pdf`, `.docx`, `.html` or `.epub` file. **Expected:** it is imported as a new doc, and the doc you were on is unchanged.

### D8. Leave the page with unsaved text

1. Type some text, then immediately close the tab or reload. **Expected:** after reopening, the text is there.
2. Make the browser refuse site data (cookies, `localStorage` and IndexedDB) for the app's origin, for example by blocking `http://localhost:8080` under `chrome://settings/content/cookies`, then reload the app. **Expected:** a banner says *"Storage unavailable, changes won't be kept"*, and the app still works: you can type and switch docs until you close the tab. The banner stays until you click its **×**.

### D9. Sidebar paging and search on a real library

The automated tests use generated documents and a stubbed screen reader; this checks the feel with your own.

1. With more than 50 documents stored (import or create them), scroll to the end of the sidebar. **Expected:** a
   **Show more** button under the list; clicking it adds the next 50 and moves focus to the first new one. On the last
   page the button goes.
2. Type part of an old document's title in the search box (*"Search titles…  (Esc to clear)"*). **Expected:** after a
   short pause the list shows the matches, including documents that were not listed; typing stays smooth while it
   searches, and a slow search shows *"Searching…"* in place of the list. A word that matches nothing shows *"No files
   match"*. `Esc` clears the search and returns to the editor.
3. With a screen reader on, search for a word with fewer than 50 matches. **Expected:** the count is read once
   ("11 documents match"), and there is no **Show more**. Clear the search, then press **Show more**. **Expected:**
   "Showing 100 documents" is read ("Showing all N documents" on the last page). A search with more than 50 matches
   reads "50 documents shown, more match", and its **Show more** reads the new count.
4. With four documents, the cursor in the editor: on Windows or Linux press **Alt+3**; on a Mac press **Ctrl+Option+3**,
   then **Option+3** on its own. **Expected:** Alt+3 or Ctrl+Option+3 opens the third document in the sidebar;
   Option+3 types its character (`#` on a UK layout) and switches nothing. On a French layout, **Alt** plus the `3`
   key without Shift also opens the third document.

### D10. Copy HTML over plain http

`navigator.clipboard` exists only on https and localhost. The automated test stubs the copy command; this uses a real
clipboard.

1. Serve the app on your network address (`python3 -m http.server 8080 --bind 0.0.0.0`) and open
   `http://<your-ip>:8080` from another machine or by IP (not `localhost`).
2. Choose **⋯ > Copy HTML** and paste into a text editor. **Expected:** the toast says *"HTML copied to clipboard"* and
   the preview's HTML pastes.
3. If your browser blocks the fallback copy too, **Expected:** a message starting *"Could not copy the HTML"* says to
   use https or localhost, or to select the preview and press Ctrl+C. It never claims a copy that did not happen.

### D11. A tab on an older version blocks the upgrade

The automated tests play the old tab in code (`tests/lib/old-tab.js`); this checks the note and the banner in a real
browser. Use a port this browser has never opened the app on, so its database does not exist yet.

1. Serve the repo on a new port and open `http://localhost:<port>/README.md` (any page of the same origin). In its
   DevTools console, hold a version 1 database open as an old tab would:
   `r = indexedDB.open('printmd', 1); r.onupgradeneeded = () => r.result.createObjectStore('docs', {keyPath: 'id'}); r.onsuccess = () => { held = r.result; }`
2. Open the app (`http://localhost:<port>/`) in a second tab. **Expected:** a note at the bottom right, *"Waiting for
   another PrintMD tab to close… It runs an older version of the app. Close it to carry on."*, with the seconds
   left, and the editor read-only. A screen reader reads the note once, without the seconds.
3. Within 5 seconds, run `held.close()` in the first tab. **Expected:** the note goes and the documents load.
4. Repeat with a new port and do not close it. **Expected:** after 5 seconds an alert banner says
   *"Another PrintMD tab is still open on an older version, so your documents could not be opened. Changes here
   are kept in memory only: close the other tab, then reload this one."*, and the footer reads **Kept in memory only**.

### D12. Each document keeps its settings

`tests/doc-settings-app.test.html` covers this in one browser session; this checks a real restart.

1. Start Chrome with a fresh profile, for example `google-chrome --user-data-dir="$(mktemp -d)"`, and note the folder.
   Open the app. **Expected:** the welcome document, the first template, A4, Portrait, PDF.
2. In the welcome document pick a second template, then **A3**, **Landscape**, **Word**. Press **Alt+N**
   (**Ctrl+Option+N** on macOS) and type a heading. **Expected:** the new document starts with that template, A3,
   Landscape, Word.
3. In the new document pick a template that starts on its own page (one that offers **Slide 16:9**). **Expected:**
   Size becomes **Slide 16:9** with Page locked to Landscape. Set As to **PowerPoint**. Where no template offers Slide,
   pick any other template, **Letter**, **Portrait** and **PowerPoint**.
4. Click the welcome document in the sidebar, then the new one, a few times. **Expected:** each shows its own template,
   Size, Page and As, and the preview page changes shape to match (wide for A3 landscape, wider still for Slide). The
   order of the sidebar does not change.
5. Reload the page and repeat step 4. **Expected:** the same.
6. Quit Chrome completely, start it again with the same `--user-data-dir`, and repeat step 4. **Expected:** the same.
7. In the Slide document pick **Letter** and **Portrait**, switch away and back, and reload. **Expected:** Letter,
   Portrait: opening a document never puts it back on its template's starting page; only picking the template in the
   template menu does.

### D13. The split, theme, view and sidebar are remembered

1. In a fresh profile (as in D12), drag the divider so the editor takes about two thirds, switch to the dark theme and
   close the sidebar with **☰**. Reload. **Expected:** the same split, dark theme, sidebar closed.
2. Choose **View > Preview only**, quit the browser and start it again with the same profile. **Expected:** Preview
   only, dark, sidebar closed. Choose **View > Split**: the split is the one from step 1.
3. Focus the divider (`Tab` past the editor), press `End` and reload. **Expected:** the editor takes 80%.
4. Make the window narrow, about 900 px, and reload. **Expected:** both panes are still visible.
5. In the DevTools console run `localStorage.setItem('printmd-split', 'oops')` and reload. **Expected:** a 50/50
   split and no error.

## Security checks under the Content-Security-Policy

These need a visible browser, the network or real Google credentials. Keep DevTools open on the **Console** tab: a
blocked resource shows as a red "violates the following Content Security Policy directive" message.

### S1. Google Drive import with real credentials

1. Open **Import ▾ > Google Drive… > Credentials**, enter a real OAuth Client ID and API key for the serving origin, and
   click **Save**.
2. On **Browse Drive**, click **Open Drive Picker**, sign in and pick a Google Doc. **Expected:** the Google sign-in
   popup and the Picker open, the consent screen asks only for access to files you pick, the doc imports as a new
   document, and the Console shows no CSP violations.
3. On **Paste URL**, paste the link of a private doc you own and click **Import**. **Expected:** it imports after sign-in,
   with no CSP violations.
4. Start an import, then close the Google sign-in popup. **Expected:** the import fails with "Google sign-in was closed
   before it finished." and no document is created.
5. On **Credentials**, click **Clear saved Google credentials**. **Expected:** both fields empty, and after a reload they
   stay empty.

### S2. Google Docs, Sheets and other Drive types (real Google)

The automated tests stub `fetch`, so these are the only checks against Google itself.

1. Make a Google Doc with a heading, a bulleted list, a numbered list, a link and a small table, and share it as
   "Anyone with the link". Paste its link with no Client ID saved. **Expected:** it imports without sign-in, with the
   headings, both lists, the link (pointing at the real address, not `google.com/url?q=`) and the table.
2. Paste the same link in its account form (`https://docs.google.com/document/u/1/d/…/edit`). **Expected:** the same
   result.
3. Make a Google Sheet with a header row, a cell containing a comma and a cell containing `|`, share it the same way and
   paste its link. **Expected:** a Markdown table of the first tab, the comma kept inside its cell and the pipe escaped.
4. Turn link sharing off for the Doc and paste its link with no Client ID saved. **Expected:** a message that it could
   not be read without signing in, naming the Credentials tab, and no CSP violation other than the blocked request to
   `accounts.google.com`. Save a Client ID and paste it again. **Expected:** sign-in, then the import.
5. Paste the link of a Google Slides file you can open (with a Client ID saved). **Expected:** after sign-in, the message
   "PrintMD cannot import Google Slides from Google Drive", and no document.
6. Upload a password-protected PDF and a `.docx` to Drive and import each through **Browse Drive**. **Expected:** the
   PDF asks for its password in the app; the Word file imports with its images.

### S3. PDF imports that need real files

1. Import a scanned PDF (pages that are pictures, with no OCR text layer). **Expected:** the import fails with
   "No text layer (scanned PDF?)…" and no document is created.
2. Import a PDF of more than 300 pages. **Expected:** a dialog asks before reading it, with **Cancel** focused;
   **Cancel** creates no document, **Import anyway** imports it.
3. Import a password-protected PDF, enter a wrong password, then the right one. **Expected:** the dialog asks again
   saying the password did not open the PDF, then the document imports. Pressing **Escape** in the dialog cancels the
   import with no message and no document.
4. In Safari (16.3 or older if available, and a current version), load the app and import any PDF. **Expected:** the
   app starts (no regex lookbehind left to stop it parsing). PDF import needs Safari 17.4 or later (README, Browser
   support): there the PDF imports; on an older Safari the import fails with a message and creates no document.

### S4. An embed from an allow-listed host plays

1. Add `<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" width="560" height="315" allowfullscreen></iframe>`
   to a document. **Expected:** the video appears in the preview and plays, and full screen works.
2. Change the host to `https://example.com/`. **Expected:** the iframe is removed from the preview.

### S5. PDF export through the print window

1. With a document that has an image and a code block, choose **PDF** and click **Export**. **Expected:** a new window
   opens with the cover and pages, the print dialog appears once the window has loaded, fonts and images are shown,
   and the window closes after printing or cancelling.
2. Check the Console of both windows. **Expected:** no CSP violations.
3. Repeat with a document that links a remote image you have not opened before, for example
   `![photo](https://picsum.photos/seed/printmd-new/800/300)`. **Expected:** the print dialog appears only after the
   image has loaded, the image shows in the saved PDF, and neither Console shows a CSP violation.
4. Use a slow connection (DevTools > Network > Slow 4G) and export again. **Expected:** the print dialog waits for the
   images and fonts (up to about 15 seconds) instead of opening on a half-loaded page.

### S6. Images over plain http do not load

1. Add `![http image](http://example.com/image.png)` to a document. **Expected:** the image does not load in the preview
   or the PDF, and the Console shows a CSP `img-src` message. This is intended: only `https:`, same-origin, `data:` and
   `blob:` images load.

### S7. Preflight warnings come before the print window

1. Remove the `#` title line from a document, choose **PDF** and click **Export** (pop-ups allowed as usual, no
   exception for the site). **Expected:** an in-app dialog *"Check before exporting"* lists *"No document title found"*,
   with **Cancel** focused; no print window has opened yet.
2. Click the dialog's message text, then press **Escape**. **Expected:** the dialog closes, focus returns to
   **Export**, and no window opens.
3. Export again and click **Export anyway**. **Expected:** the print window opens (the browser does not report a
   blocked pop-up) and the print dialog appears.
4. Block pop-ups for the site and export a document with a title. **Expected:** a toast says the print window could not
   open and asks to allow pop-ups; no alert box.

### S8. Print preview fidelity

1. Open `markdown-showcase.md` from the repo with **Open** and export it as PDF with each template.
   **Expected:** the print preview shows each template's own body font (the first family in its `fontStack`, such as
   Montserrat, or Source Serif Pro with Inter headings for Unbranded), not Arial or Times. Saving as PDF and running `pdffonts` on the file lists those
   families as embedded. Add a line `Dvořák in Łódź, Māori, Ștefan`: its accented letters use the same font as the
   text around them, and `pdffonts` lists no extra font.
2. Choose **Letter** and **Landscape** and export again. **Expected:** the cover fills exactly page 1 (logo at the top,
   footer bar at the bottom) and the document starts on page 2, with no blank or half-filled cover page.
3. Choose **A4** and **Portrait**. **Expected:** the cover fills page 1 and the body pages keep the template's margin.

### S9. Print quality of the editor's PDF in Chrome, Firefox and Safari

The automated checks cover the API's PDF; the editor's PDF comes from each browser's own print dialog.

1. In Chrome, export `markdown-showcase.md` and save as PDF (untick **Headers and footers** in the print dialog).
   Run `node server/qa/pdf-qa.mjs file.pdf --cover` (it needs poppler-utils). **Expected:** `fonts-embedded`,
   `no-type3`, `vendored-fonts`, `title`, `language` and `page-size` pass. `image-ppi` fails on the showcase's
   photos and `forbidden` on its `http://localhost:3000` line; both are the document, not the print. If the dialog's
   **More settings** offers a document outline option, tick it and save again.
2. Check tags and bookmarks: `pdfinfo file.pdf` prints `Tagged: yes` for a tagged PDF, `pdfinfo -struct file.pdf`
   lists the headings in the structure tree, and the PDF viewer's bookmarks pane lists the headings. `pdf-qa`'s
   `outline` check passes with "no headings" on an untagged file, so read its detail text: it must name the
   bookmarks. Record the results for Chrome.
3. Repeat steps 1 and 2 in Firefox and Safari. **Expected:** the PDF prints in the vendored fonts with the same
   layout. Record which of tags and bookmarks each browser writes.
4. Add `<img src="..." width="576" alt="small">` with an image about 200 px wide (576 CSS px is 6 in), then export.
   **Expected:** the preflight dialog lists *"Image 1 is about 33 ppi at the size it prints; 150 or more prints
   sharply."* before the print window opens (N counts every raster image in the preview).
5. Rename `vendor/fonts/montserrat/montserrat-latin-400-normal.woff2` on a local copy, reload with the cache off
   (DevTools > Network > Disable cache), and export a document with a template whose body font is Montserrat.
   **Expected:** the print window's own confirm asks *"Font Montserrat 400 did not load…, so the PDF would print it in
   a fallback font."* and *"Print anyway?"*; **Cancel** closes it without printing, **OK** prints in a fallback font. Put the
   file back.
6. Add `print-links: true` to the front matter and export. **Expected:** each external link prints its address after
   the text, in brackets and smaller type, in the PDF only (not the preview); an autolink (`<https://...>`), a
   `#anchor` and a `mailto:` link print no address.

### S10. Code blocks in the print dialog's PDF

The automated checks raster the API's PDF (`server/test/code-blocks.test.mjs`); this checks the browser's own print.

1. Export `tests/fixtures/code-showcase.md` as PDF with a template that has a dark code background and with
   Unbranded (a light one), and save each as PDF, leaving **Background graphics** unticked.
2. **Expected:** each fenced block with a language (```` ```php ````, ```` ```bash ````) has a small upper-case label
   in its top-right corner with a coloured dot before it, and its code is coloured (keywords, strings, comments,
   functions in different colours) on the template's code background. The colours print without **Background
   graphics** ticked.
3. **Expected:** a block whose fence word is not a known language shows the word as its label with a grey dot and
   plain text; a fence with no language has no label. A long line wraps inside the block.

## Front matter

### F1. Front matter in the editor and every export

1. Start a document with:

   ```markdown
   ---
   title: Front Matter Check
   author: Jo Bloggs
   date: 2026-03-01
   ---
   # Body heading

   Text.
   ```

   **Expected:** the preview shows no `---` rules or `key: value` lines; the cover reads *Front Matter Check*, the
   author (*Prepared by Jo Bloggs* on the branded templates, *Jo Bloggs* on Unbranded) and *1 March 2026*; the sidebar
   lists the document as *Front Matter Check*.
2. Export it as PDF, Word and PowerPoint. **Expected:** each has the same cover title, author and date, and none shows
   the front matter lines. The automated tests cover the Word and PowerPoint files from `prepareExport` on
   (`docx-export.test.html`, `pptx-export.test.html`); this step checks the **Export** button path and the download.

## Templates

`template-platform.test.html` covers the picker, the sizes and the default page with a test-only template, and the
server's print-quality tests check every template's PDF from the API. These checks look at the deployment's real
templates in the editor and in the browser's own print. The README's [Templates](../README.md#templates) table says
which template has a running head and foot, which offers Slide, which offers fewer paper sizes, and which has a page
colour.

### T1. The template picker and each template's page

1. Open the template picker. **Expected:** with groups in the manifests, one heading per group, A to Z (a template
   with no group under *Other*, last), and the templates under each heading A to Z by name; the first manifest entry
   is chosen on a first visit. `Ctrl+K` and typing `template` lists the same templates in the same order, each with
   its group ("Template: *name* (*group*)").
2. Choose the template that offers Slide and starts on it. **Expected:** **Size** changes to *Slide* and offers only
   that template's sizes; **Page** shows *Landscape* and cannot be changed while Slide is chosen. Choose **A4**:
   **Page** can be changed again.
3. Choose a template that lists fewer paper sizes. **Expected:** **Size** offers only those. Choose one with no
   `page.sizes`: A4, A3, A5, Letter and Legal, no Slide.
4. Click **ℹ** on a template whose manifest entry has a `description`. **Expected:** the popover shows that
   description.

### T2. A running head and foot in the editor's PDF

1. Choose a template with a running head and foot, add front matter with `title`, `author` and `subject`, write
   enough text for three pages, and export as PDF (untick **Headers and footers** in the print dialog).
   **Expected:** the preview shows no running head or foot; the PDF shows them on every body page and never on the
   cover, with page numbers that count the cover (the first body page is page 2), the text clear of the paper edge.
2. Do the same with the other templates that have one, in A4 portrait and landscape. **Expected:** as step 1, and the
   head and foot line up with the text column's left and right edges.
3. Choose the template that starts on Slide and export. **Expected:** 16:9 pages (`pdfinfo` gives about 720 x 405
   pts), the cover filling page 1.
4. Choose a template with a page colour and export with **Background graphics** ticked. **Expected:** the body pages
   take the colour to the paper edge, margins included; the cover is as it is without it.

### T3. The cover in the preview

1. With each template whose cover fills the page, look at the preview in A4 portrait, then A4 landscape.
   **Expected:** the cover card is exactly one page tall in both (no strip of white under a full-page cover, nothing
   cut off at its foot) and looks like page 1 of the exported PDF.
2. Choose the template that starts on Slide. **Expected:** the cover card has the 16:9 shape of a slide.
3. Narrow the preview pane with the divider. **Expected:** the cover card keeps its page shape as it shrinks.

## Page options

`tests/page-options-app.test.html` drives the dialog and the memory in one session, `tests/page-layout.test.html`
the measuring step and `server/test/page-control.test.mjs` the API's PDFs; these check the browser's own print
dialog, which no test can drive. In each, keep **Margins: Default** and **Scale: 100** in the print dialog.

### L1. A custom size

1. Choose **Custom size…** in the Size menu. **Expected:** the Page options dialog opens with Custom size ticked and
   the cursor in Width; Page is locked once saved. Type 100 x 150 mm and **Save**. **Expected:** the preview's page
   card is narrow and 2:3; the ⚙ button shows a dot and its tooltip names the size.
2. Export as PDF with any template. **Expected:** the print preview shows 100 x 150 mm pages; `pdfinfo` gives about
   283 x 425 pts on every page, cover included.
3. Repeat with 1200 x 800 px. **Expected:** about 900 x 600 pts. Try a width of 10 mm, `100;}` and 300 x 300 in.
   **Expected:** the dialog names the rule and stays open; nothing changes.

### L2. One continuous page

1. Open the demo document (`~/Downloads/printmd-demo-source/printmd-demo.md`, with its two images), choose
   **⚙ > One continuous page** and export as PDF with three templates, the deck and a dark one among them.
   **Expected:** a single page in the print preview, as wide as the chosen size and as tall as the document, the cover
   at the top at its own height (the deck's at the slide's), no page numbers, the last line close to the bottom edge.
2. Open the saved PDF. **Expected:** one page (`pdfinfo`), bookmarks in the sidebar that jump to their headings,
   links that open.
3. Add a manual page break (`<div style="page-break-after: always"></div>`) and export again. **Expected:** still one
   page, no gap where the break was.

### L3. Fit to size

1. Paste a table of ten columns of long words and export on A4 portrait with Fit **Off**. **Expected:** the table runs
   past the right margin.
2. Choose **Fit width** and export. **Expected:** the table fits the text column, smaller; after the print dialog
   opens, a message says "Table 1 is scaled to N% to fit the page width."
3. Make the table forty columns wide. **Expected:** "Print anyway?" names the table as needing under 40%; Cancel
   closes the print window.
4. With **One continuous page** and **Widest block**, export the ten-column table. **Expected:** the page is wider
   than A4 and the table prints at full size.

### L4. The margin

1. Set the margin to 0 and export. **Expected:** the text runs to the paper edge (the print dialog's own headers off).
2. Set it to 30 mm. **Expected:** a wide white border on every side.
3. With a template that has a running head and foot, set 12 mm and export. **Expected:** the list before the print
   window says the running head and foot are left out; the PDF has none. Set 18 mm. **Expected:** they print, closer
   to the text.

### L5. Each document keeps its page options

1. In a fresh profile (as in D12), give one document a custom size, one continuous page, Fit width and a 10 mm margin;
   leave a second document as it is. Switch between them, reload, then quit and restart the browser with the same
   profile. **Expected:** each document shows its own options every time (Size, the ⚙ dot, the dialog's fields, the
   preview); the order of the sidebar does not change.
2. Press **Alt+N**. **Expected:** the new document takes the last size, but starts on pages, Fit off and the template
   margin.
3. In the first document choose A4 in the Size menu, then **Custom size…** again. **Expected:** the dialog shows the
   custom size from step 1.

## Word and PowerPoint in Microsoft Office

The export tests open both files in LibreOffice only. Microsoft Word is stricter about the file format, so check these in
real Word and PowerPoint (Windows or macOS, a current Microsoft 365 build) after a change to `js/docx-export.js`,
`js/pptx-export.js` or `js/slides.js`. Make the files with `node tests/office-convert.mjs --keep /tmp/office`
(`fixture.docx` and `fixture.pptx`; it needs `soffice`, `pdftotext`, `pdfinfo` and, for the page images,
`pdftoppm`), or export `markdown-showcase.md` from the app (as Word, a dialog first lists the images the file leaves
out: click **Export anyway**).

### O1. The Word file opens cleanly

1. Open `fixture.docx` in Word. **Expected:** no "Word found unreadable content" or repair prompt.
2. **Expected:** the three numbered lists read 1, 2 / 1, 2 / 5, 6; the nested list under *Outer bullet* reads 1, 2
   indented under it; the task items show ☐ and ☑ where a bullet would be.
3. Ctrl+click *the site*: **Expected:** `https://example.com/a?b=1&c=2` opens. Ctrl+click *the heading*:
   **Expected:** Word jumps to *Fixture heading*. *a script* is plain text.
4. **Expected:** the table's first row is one merged cell across both columns, *Tall cell* spans two rows, and the
   last row holds a small table inside its right-hand cell.
5. File > Info (Properties). **Expected:** Title *Fixture Report*, Author *Jo Bloggs*, Created 1 March 2026.

### O2. The PowerPoint file opens cleanly

1. Open `fixture.pptx` in PowerPoint. **Expected:** no repair prompt ("PowerPoint found a problem with content"), the
   cover first, and every slide in the thumbnail pane. Slides with mixed formatting in one paragraph (a bold word, a
   link, inline code) are the ones a repair prompt would come from.
2. **Expected:** on *Opening* the two paragraphs are on separate lines and the second shows `&lt;` and a bold word;
   *Code* shows the code in a grey box in a monospace font, the second line indented.
3. **Expected:** *Table* is a real table (click a cell to edit it) with the header row in the template colour;
   *Image* shows the red and blue picture.
4. **Expected:** *Long section* ends at line 18 and *Long section (cont.)* starts at 19, numbered 19 (not 1), and no text
   runs past the footer on either slide.
5. **Expected:** on *Nested*, *Inner item* is indented one level under *Outer item*, and the numbered items read 1, 2.

## The PDF API

### P1. A colleague's first run of the PDF API

On a machine that has never run it (macOS too, if anyone uses one), follow the README's
[Run it on your machine](../README.md#run-it-on-your-machine) steps word for word.

1. **Expected:** `npm --prefix server ci` and the browser step finish without errors, and `start:local` prints the
   `listening` line.
2. Run the README's showcase `curl` command, then open `showcase.pdf`. **Expected:** the cover of the template the command
   names, then the body in that template's font, the same as **Export** with **PDF** under **As** in the editor.
3. Stop the server with Ctrl+C. **Expected:** it exits, and `curl -s http://127.0.0.1:8787/api/v1/health` fails to
   connect.

### P2. Web pages cannot reach the local PDF API

1. Start the API with `npm --prefix server run start:local`, open any public web site in Chrome, open DevTools >
   Console and run `fetch('http://127.0.0.1:8787/api/v1/whoami').then(r => r.status, e => 'blocked: ' + e)`.
   **Expected:** the request is refused, either by the browser (blocked from reaching the local network, or a CORS
   error) or with a 403. The server log shows `"status":403` with `"error":"forbidden_origin"` for any request that
   reached it.
2. In the same console, run
   `fetch('http://127.0.0.1:8787/api/v1/render', {method: 'POST', mode: 'no-cors', headers: {'Content-Type': 'text/plain'}, body: '# x'})`.
   **Expected:** no `"route":"render"` line with `"status":200` appears in the server log.

### P3. A colleague's first PDF through the Claude Code skill

On a machine with Claude Code, the skill that calls this API installed (the README's
[Make PDFs from Claude Code](../README.md#make-pdfs-from-claude-code-or-from-a-script) says how), and the API running as in P1 or P4:

1. Ask Claude Code, in a local session, for a PDF of a short Markdown file with a relative image. **Expected:** the
   skill checks the API, lists the templates (every one `GET /api/v1/templates` lists, the default marked, each with
   its sizes), asks which template if you named none, and reports the PDF's path, template and page count. The image
   is in the PDF.
2. Stop the API (Ctrl+C, or `systemctl --user stop printmd-api` for the service) and ask again. **Expected:** the
   skill shows the start commands word for word (for the service, `systemctl --user start printmd-api` first) and
   renders nothing.
3. Ask for the same file in the template that starts on Slide. **Expected:** a 16:9 landscape PDF, without asking
   for a size.

### P4. The PDF API as a service (Linux)

`server/test/service.test.mjs` checks the unit the script writes without installing it; this installs it for real.
On a Linux desktop with systemd, from a checkout with `npm --prefix server ci` done:

1. Run `server/service/install-service.sh`. **Expected:** it prints `Wrote ~/.config/systemd/user/printmd-api.service`,
   then that the API runs on `http://127.0.0.1:8787` and a test render worked, and names the browser it uses.
2. Log out and in again (or reboot). **Expected:** `systemctl --user is-active printmd-api` prints `active` and
   `curl -s http://127.0.0.1:8787/api/v1/health` answers `"status":"ok"` with `"browser":{"state":"idle"`.
3. Render one PDF, then wait 70 seconds. **Expected:** right after the render `systemctl --user status printmd-api`
   lists Chrome processes under the service; after the wait only the `node` process is left, and health shows the
   browser `idle`. The next render works and starts the browser again.
4. `systemctl --user stop printmd-api`. **Expected:** no Chrome process from the service is left (`pgrep -a chrome`
   shows none with `--headless`), and the health `curl` fails to connect.
5. `server/service/install-service.sh --uninstall`. **Expected:** "Removed printmd-api.service.", the unit file is
   gone, and the service does not start at the next login.

## Accessibility checks

`tests/a11y-keys.mjs` covers the keyboard walkthrough in headless Chrome and `tests/a11y.test.html` the roles, names,
contrast and live regions. These checks need a real screen reader, forced colours or a touch screen.

### A1. NVDA with Chrome or Firefox (Windows)

1. Start NVDA, open the app and press **Tab** once. **Expected:** NVDA reads "Skip to editor, link". **Enter** puts the cursor in the editor ("Markdown editor, edit, multi line").
2. Press **D** (next landmark) repeatedly in browse mode. **Expected:** banner, navigation "Recent files", main, complementary "Live preview", content info.
3. Tab to the sidebar list. **Expected:** "*title*, *time*, button, current" for the open document. **↓** reads the next document; **Tab** reads "Delete *title*, button".
4. Press **Ctrl+K**. **Expected:** "Command palette, dialog", then "Command, combo box, expanded", then the first command. **↓** reads each command as it is highlighted ("*label*, *n* of *m*"). Type `pdf` and pause: "*n* commands" is read once. **Esc** closes it and NVDA is back in the editor.
5. Open **Import ▾ → Google Drive…**. **Expected:** "Import from Google Drive, dialog", then the URL field. **Tab** never reaches the toolbar behind it; **Esc** closes it and focus is back on **Import**.
6. Type in the editor for 10 seconds. **Expected:** nothing about saving is read while you type.
7. In a document without a heading, choose **Export** with PDF. **Expected:** "Check before exporting, alert dialog" and the warning text, with focus on **Cancel**.

### A2. VoiceOver with Safari (macOS)

1. Turn on VoiceOver (**Cmd+F5**) and open the app. Open the rotor (**VO+U**) and pick Landmarks. **Expected:** the same five landmarks as in A1.
2. Repeat A1 steps 3 to 5 with **Cmd+K** for the palette. **Expected:** the same names and roles, and focus returns where it was on **Esc**.
3. Make a save fail (fill the disk quota, or block site data after the app has loaded and type). **Expected:** "Changes not saved: …" is read once, not on every keystroke, and "Saved" is read once after a later save succeeds.

### A3. Windows High Contrast (forced colours)

1. Turn on a contrast theme (Settings, Accessibility, Contrast themes) and open the app in Chrome or Edge.
2. Tab through the toolbar, the sidebar, the editor (**Esc**, **Tab**) and the divider. **Expected:** every focused control shows a visible outline in the theme's colours; the open document in the sidebar is distinguishable from the others.
3. Open the palette and a dialog. **Expected:** the panel edges and the highlighted command are visible.

### A4. Touch screen (phone or tablet)

1. Open the app on a phone or tablet. **Expected:** every document in the sidebar shows its **×** without hovering, and the time sits to the left of it, not under it.
2. Tap a document's **×**. **Expected:** the confirm asks before deleting, and tapping the row itself opens the document.

## Notes

- The fallback `<input type="file">` path is used automatically when `showOpenFilePicker` is missing: in browsers without the File System Access API, and on a non-secure origin such as a LAN IP over http. **Open** then reads the file into a new doc without watching it, and **Save** downloads a copy.
- Documents are stored in IndexedDB. The editor text is also written to `localStorage` (`printmd-crash`) when the page is hidden or closing, and restored at the next start if it is newer than the stored doc.
