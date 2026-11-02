---
title: Why I built PrintMD
description: Notes that look designed, without opening a word processor.
---

# Why I built PrintMD

I write in Markdown. Notes, plans, short reports, the odd longer document. Plain text is quick, it diffs well and it
never gets in my way. The trouble starts when someone else has to read it.

Most of the time that means a PDF, and getting from Markdown to a PDF that does not look like a text file with
a margin is more work than it sounds. Pasting into a word processor loses the structure. A browser's print dialog
gets you most of the way and then breaks a table across two pages or leaves a heading alone at the foot of a page.
The command line tools are powerful and need a small pile of packages and a LaTeX installation.

I wanted one thing: write Markdown, see the page, press a button, get a PDF I would not be embarrassed to send.

## What it is

PrintMD is a Markdown editor with a live preview and a handful of templates. The preview is the page, in the
template's type and spacing, so what you see is what the PDF will be. Export gives you a PDF, a Word file or a
PowerPoint file from the same text.

It is plain HTML, CSS and JavaScript modules. There is no build step and no framework, so if you can serve a folder,
you can run it. I made that choice early and I have not regretted it. It means the whole thing can be read, and
changed, by one person.

## Where it grew

The first version was an editor and one template. Then I wanted the PDFs to be right rather than nearly right, and
that turned into most of the work:

- Fonts are bundled and embedded, so a PDF looks the same on every machine.
- Page breaks follow a few simple rules: a heading never ends a page, a table row is never split, a table that runs
  on repeats its header.
- Page size is a choice per document, including a custom size, and so is a single long page for things that are not
  really pages.
- A small service on my own computer turns a Markdown file into a PDF with one command, which is how I use it
  from scripts and from other tools.

Each of those gets its own post in this series.

## Why local

PrintMD is happiest on your own machine, and I want to be plain about that. Your documents stay in your browser. The PDF
service uses your own copy of Chrome and listens only on your own computer. If you put the editor on a web server it
still works, and it tells you that running locally is better. The PDF service will not run hosted at all. The last post
in the series explains why.

## What next

It is a tool I use, so it grows when I hit a wall. If you try it and something is awkward, the issue tracker is the
place to say so.
