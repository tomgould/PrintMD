---
title: Custom sizes, one long page and fit to width
description: The page options in PrintMD and the edge cases behind them.
---

# Custom sizes, one long page and fit to width

Not every PDF is an A4 page. A one-page menu, a slide, a social image, a long receipt: each wants a different shape.
PrintMD has four page options for them, kept per document so that the settings travel with the text.

## Custom size

Open the page options and choose a custom size. Type a width and height in millimetres, centimetres, inches or
pixels, so `100x150mm`, `8.5x11in` and `1200x800px` all work. A pixel is the CSS pixel, a 96th of an inch, so
1200 by 800 pixels is about 317 by 212 millimetres.

There are limits, and they are there for a reason. Each side runs from 30 mm to 5080 mm, which is the longest side the
browser can print, and the page area is capped at four square metres. A tiny page with a long document could
otherwise produce thousands of pages.

## One continuous page

Some documents are not made of pages at all. Choose the continuous layout and the whole document goes onto a single
page of the width you chose, exactly as tall as the content. There are no page breaks and no running head or foot.

The height has to be measured after the fonts and images have loaded, so the page is laid out first, measured, and then
printed at that height. If the result is taller than one PDF page can be, it is split into the fewest tall pages that
hold it, and a note says so. A heading stays with what follows it across the split. A block that cannot break, such as
a table row, moves whole to the next piece, which can leave a gap. I would rather you know that than have it hidden.

## Fit to width

A wide table or image will run past the margin. Fit width scales a block down to fit the column instead, and tells you
what it did: "Table 1 is scaled to 72% to fit the page width." If a block would need to shrink below 40%, it is left
alone with a warning, because text that small cannot be read.

For the continuous layout there is a third choice, widest block, which makes the page as wide as the widest block and
scales only what is still too wide.

## Margin

Leave the margin empty to use the template's. Otherwise give a number in millimetres, centimetres, inches or points. A
margin that leaves less than 20 mm for the text is refused. The running head and foot need a margin of 18 mm or more,
so under that they are left out and you are told.

## In front matter

All of it can be set from the top of the document, so a file carries its own page:

```markdown
---
title: Lunch menu
page-size: 100x210mm
layout: continuous
fit: width
margin: 8mm
---
```

The editor's own settings win once a document has any. The PDF service reads the front matter too, and a value in the
request wins over both.
