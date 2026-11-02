---
title: A PDF service that only runs on your machine
description: Why the PDF service refuses to be hosted, and how it stays safe.
---

# A PDF service that only runs on your machine

PrintMD has a small PDF service. You send it Markdown, it sends back a PDF. I use it from scripts and from other tools,
because a single command is easier than opening an editor.

You might expect me to say you can host it for your team. You cannot, and this post is about why that is on purpose.

## What it does

The service keeps a copy of Chrome and prints with it. The request is the Markdown and a few options (template, page
size, layout, margin). The answer is the PDF, with headers that report the page count and any warnings about the
document.

```bash
curl -s -X POST 'http://127.0.0.1:8787/api/v1/render?template=dealmobile' \
  -H 'Content-Type: text/markdown' --data-binary @notes.md -o notes.pdf
```

It uses your installed Chrome or a Chromium that Playwright downloads. After a minute with nothing to print the
browser closes, so the service sits at roughly the memory of a small Node process until the next request.

## Why it will not be hosted

A service that turns arbitrary text into a rendered page, on a machine with a network, is a place where things go
wrong. Someone sends a document that asks the browser to fetch an internal address, or to burn minutes of CPU, or
to render a page the size of a billboard. Every one of those is something I would have to defend against, forever,
for a tool whose job is to make nice PDFs.

On your own machine the questions mostly go away, because the only person sending documents is you. So the public
edition of the service runs in one mode: local. It listens on 127.0.0.1 and refuses to start if you point it at
anything else, or ask it to run behind a token. That is a decision, not a missing feature.

## It is still locked down

Local does not mean careless. A Markdown file can contain images and links, and you may paste in something you did not
write. So the render page is closed off:

- The page can only load files that belong to the app. A request for anything else is blocked and shows up as a warning
  on the PDF.
- The print page carries a content security policy with no scripts allowed.
- Image data is capped in size, and so are the Markdown, the number of pages and the render time.
- The service takes a few renders at a time and says "busy" to the rest.

## The editor

The editor is a different case. It is a static page, and nothing in it sends your documents anywhere. Hosting it is fine.
It shows a notice when it is hosted, which says that running locally gives the best results and that the PDF service is
only available on your own computer. PDFs from the hosted editor go through your browser's print dialog.

## What this costs

If you wanted a shared PDF service for a team, this is the wrong tool, and I do not want to pretend otherwise. If you
want to make good PDFs from your own notes, it is a few commands and a folder.
