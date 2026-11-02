# PrintMD PDF service

A small local service that turns Markdown into a PDF with your own copy of Chrome. It runs on your computer and
listens only on `127.0.0.1`. **It is not available when hosted:** it refuses to start with a token, a login provider
or any address other than loopback. Run it where you work.

## Run it

```bash
npm --prefix server ci
npx --prefix server playwright install chromium     # or: export PRINTMD_CHROME=/usr/bin/google-chrome
npm --prefix server run start:local                  # plain `npm start` does the same in this edition
```

It listens on `http://127.0.0.1:8787` by default. On Linux, `server/service/install-service.sh` installs it as a user
service that starts at login and closes the browser a minute after the last render, so it idles at the memory of a
small Node process.

## Use it

```bash
curl -s http://127.0.0.1:8787/api/v1/health
curl -s http://127.0.0.1:8787/api/v1/templates
curl -s -X POST 'http://127.0.0.1:8787/api/v1/render?template=dealmobile&pageSize=A4' \
  -H 'Content-Type: text/markdown' --data-binary @notes.md -o notes.pdf
```

`POST /api/v1/render` takes `text/markdown`, with the options in the query, or `application/json` with the
Markdown and the same options as fields. The answer is `application/pdf`.

| Option | Values |
|---|---|
| `template` | An id from `GET /api/v1/templates`. Default: the first one listed. |
| `pageSize` | A named size (`A4`, `A3`, `A5`, `Letter`, `Legal`) or a custom one: `100x150mm`, `8.5x11in`, `1200x800px`. |
| `orientation` | `portrait` or `landscape`. |
| `layout` | `paged` (default) or `continuous`, one page as tall as the document. |
| `fit` | `off` (default), `width` or `widest`: scale a block that is too wide down to fit. |
| `margin` | `12mm`, `0.5in`, `0`. Empty keeps the template's. |
| `title`, `author`, `date`, `subject` | The cover and the PDF's details. In a JSON body they go under `meta`. |
| `lang` | The PDF's language tag, such as `en-GB`. |
| `printLinks` | `true` prints each link's address after its text. |
| `tidy` | `false` turns off the small scale-down that rescues a nearly empty last page. |
| `strict` | `true` answers 422 instead of a PDF when the render found a problem. |

Front matter at the top of the Markdown can set the same things (`title`, `author`, `date`, `template`,
`page-size`, `layout`, `fit`, `margin`, `subject`, `lang`, `print-links`); a value in the request wins.

Response headers say what happened: `X-PrintMD-Pages`, `X-PrintMD-Warnings` and `X-PrintMD-Advisories` (URL-encoded
JSON), `X-PrintMD-Tidy` and `X-PrintMD-Version`. Errors are JSON, `{"error": {"code": "...", "message": "..."}}`, with a
status that fits: 400 for a bad option, 413 for too big, 415 for the wrong content type, 422 under `strict`, 429
when it is busy, 504 when a render ran out of time.

## Limits and safety

- Markdown up to 2 MB (images embedded as `data:` URIs are not counted against it), a request body up to 15 MB, 20
  seconds per render, two renders at once and a short queue; past that the answer is 429 with `Retry-After`.
- The render page can load only the app's own files. A request for anything else is blocked and listed in the
  warnings, so a document cannot make the service fetch an address.
- The print page carries a content security policy with scripts, frames and connections switched off.
- Custom sizes are capped at 30 to 5080 mm a side and four square metres a page, and a document that would print more
  than 5,000 pages is refused.
- Logs hold the request id, template, sizes, page count, duration and status. Never the Markdown, a title or a file name.

## Settings

All settings are environment variables, read once by `src/config.mjs` (its header lists them):

| Variable | Default |
|---|---|
| `PRINTMD_HOST` | `127.0.0.1`. Anything but a loopback address is refused. |
| `PRINTMD_PORT` | `8787` |
| `PRINTMD_CHROME` | Path to Chrome or Chromium. Default: the browser Playwright downloaded. |
| `PRINTMD_BROWSER_IDLE_S` | `0` keeps the browser open. A number of seconds closes it after that long without a render. |
| `PRINTMD_MAX_EXPANDED_BYTES` | A ceiling for a document's size once every data URI is counted in full. |
| `PRINTMD_VERSION` | Reported in `X-PrintMD-Version`. Default: the git short sha. |

The process exits with 2 on an invalid or refused setting and with 3 when no browser is found.

## Tests

```bash
node --test server/test/*.test.mjs                 # the whole server suite (renders real PDFs, needs Chrome)
node tests/run-all.mjs server                      # the same, through the project's runner
```

The render tests check the PDFs with `pdfinfo`, `pdftotext` and `pdffonts` from poppler.
