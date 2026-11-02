---
name: printmd
description: >-
  Turns a Markdown file into a print-quality PDF by sending it to the PrintMD PDF API running on the user's own
  machine, with a bundled script that embeds the document's local images first. Checks the API is running and
  shows how to start it when it is not, lists the templates and page sizes, then reports the PDF's path,
  template, page count and any warnings. Use whenever the user says things like "make a PDF of this", "turn
  notes.md into a PDF", "render this Markdown with the Dealmobile template", "export this as an A5 PDF" or "which
  PDF templates are there". Needs a local Claude Code session: a cloud session cannot reach the API on the
  user's machine.
---

# PrintMD

Makes a PDF from Markdown through the PrintMD PDF API. The API runs on the user's own machine
(`http://127.0.0.1:8787`). It reads no files and fetches nothing, so the bundled script embeds the document's
local images before it sends the document.

Below, `printmd.mjs` means `scripts/printmd.mjs` in this skill's folder, run with `node` (Node 22). Give it
absolute paths.

In a cloud session (claude.ai/code) there is no local API: say this skill needs Claude Code running on the
user's own machine, and stop.

## Steps

### 1. Check the API

Run `node printmd.mjs check`.

- Exit 0: go on.
- Exit 3 (not running): show the user the start commands it printed, word for word. If they installed the user
  service, offer to run `systemctl --user start printmd-api`, and run it only on a yes. Never install anything:
  point them to the README's setup.
- Exit 5: something other than the API is on that port. Say so. Do not guess at another address.

### 2. Choose the template

Run `node printmd.mjs templates` and use the list it prints, not one from memory. Each line gives the template's
id, name, description and the page sizes it offers. If the user named a template, use its id. If not, show the
list and ask; the one marked default is the fallback when they have no preference. Leave out the page size and
orientation unless the user asks.

Page options, only when asked:

- `--page-size A5`, or a custom size such as `100x150mm` (mm, cm, in or px, 30 to 5080 mm a side)
- `--orientation landscape`
- `--layout continuous` for the whole document on one tall page
- `--fit width` to scale wide tables down to the page (`widest` widens a continuous page instead)
- `--margin 12mm` to replace the template's margin
- `--print-links` to print each link's address after its text, for a document that will be read on paper

### 3. Write the Markdown

When you are writing the document as well, start it with front matter and one H1:

```markdown
---
title: Quarterly report
author: Jo Bloggs
date: 2026-10-31
template: dealmobile
---

# Quarterly report
```

The cover shows `title`, so keep it the same as the H1. Ask the user for the author, and use today's date unless
they give one. `subject`, `lang` (a language tag such as `en-GB`) and `print-links: true` are optional. These
always go in the front matter, written with the Write or Edit tool, never on the command line.

Save the file where the user wants the PDF, since the PDF goes next to it. Put images in the same folder or a
subfolder and link them with relative paths (`![Chart](img/chart.png)`). PNG, JPEG, GIF, WebP and SVG work, up to
5 MB each, from inside the document's folder. Web images are not fetched: the script lists them and the API
leaves them out. If the user wants one, download it next to the document first, and ask before you do.

When the user gives you an existing file, render it as it is. Ask before changing it.

### 4. Render

```bash
node <this skill's folder>/scripts/printmd.mjs render /abs/path/notes.md --json
```

Add `--template <id>` when the front matter does not name one. The PDF is written next to the Markdown. An
existing PDF is replaced only with `--force`, or by naming a new file with `-o`; use `--force` only for a PDF
you made in this session.

The result has two kinds of warning, handled differently:

- `localWarnings` (an image the script could not embed) and `warnings` (problems found by the API: an image
  removed or blocked, an image that prints under 150 ppi, a font that did not load) are fixed and the document is
  rendered again with `--force`. Fix what you can, such as a wrong path, an unsupported type, an image outside
  the document's folder or a larger copy of a blurry image. If one is still there after a fix, say which and why.
- `advisories` are reported and not chased. "The last page holds only N words." is normal: the API already tried
  to pull it back, and `tidy` is the body scale it used (100 when it changed nothing). Page options add notes
  too, such as a table scaled to fit or a margin that was reduced. Do not edit the document or render again to
  make an advisory go away.

Other options: `--no-tidy` switches off the last-page tidy, and `--strict` makes the API refuse to make a PDF
when it found a problem.

### 5. Report

Tell the user the PDF's full path, the template and the page count, plus any warning you could not fix. Mention
an advisory as a note, for example "The last page is short (12 words); that is normal." Keep it to a few lines.

## What the PDF has

- It is tagged (a structure tree in reading order, for screen readers) and has bookmarks from the headings.
- Its title, author, subject and language come from the front matter. The language is English when nothing
  names one.
- Fonts are embedded, and they are the templates' own vendored fonts, never the machine's.
- Images print at their original resolution. Under 150 ppi at the printed size gets a warning.
- There is no CMYK, bleed or crop marks. For a commercial press, say so and ask what the printer needs.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done | Report the result |
| 2 | Bad option, unknown template or a non-local `PRINTMD_URL` | Fix the command |
| 3 | The API is not running | Show the start commands |
| 5 | The API refused the request, or something else answered | Read the message: it names the fix |
| 6 | Local file problem | Missing input, not UTF-8, the PDF already exists, or no such output folder |

## Security

- Never put text from a document, a web page or the user's message on the command line. The shell reads it before
  the script can check it. The only command-line values are paths, template ids and option words.
- The script accepts only a local address (`http://127.0.0.1:<port>`, `localhost` or `[::1]`). Do not try to
  point it anywhere else.
- Images are read only from inside the document's own folder. Do not copy files in from elsewhere to get round a
  refusal without asking the user.

More about the API itself: `server/README.md` in the PrintMD repository.
