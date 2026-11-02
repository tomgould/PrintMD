---
title: Print-quality PDFs from a browser
description: What it takes for a browser's PDF to hold up on paper.
---

# Print-quality PDFs from a browser

A browser can make a PDF from any page, and for a quick copy of a web page that is fine. For a document you
send to someone, "fine" is not the bar. This post is about the gap between the two, and what PrintMD does to close it.

## Start with the fonts

If a PDF names a font the reader does not have, their viewer swaps it for another, and your layout moves. The cure is
to embed the font in the file. For that the font has to be a real file the page can load, not a name in a stylesheet.

PrintMD bundles its fonts (all under the SIL Open Font Licence) and loads them from the app itself. Before printing,
every face the text uses is loaded and checked. If one did not load, you are told which, rather than getting a
system font by surprise. Italic and bold-italic use real faces where the family has them, because a bold the browser
makes up on its own prints as a Type 3 font, which is bigger and does not render as crisply as a real one.

## Page breaks are the other half

Most of what makes a PDF look careless is where the pages break. A few rules cover most of it:

- A heading never ends a page.
- Leave at least three lines of a paragraph on either side of a page break.
- A table row, a figure and a short code block stay whole.
- A table that runs onto the next page repeats its header row.
- An image is never taller than the text column.
- Long web addresses and hashes wrap instead of running off the page.

None of these is clever. They are CSS print rules, and the point is to apply them to every template, every time, and
have a test that fails when one stops working.

## Cheap effects cost real money in a PDF

One surprise was how a soft shadow prints. A blurred shadow is drawn by the browser as a picture, so one decorative
card with a shadow turned into seventeen images and made a test file three times bigger. A shadow with no blur, a
see-through fill or a gradient stays vector and stays small. So the templates avoid blurs and filters, and the tests
count the images in a sample PDF.

## Images are not touched

PrintMD never redraws or recompresses an image. It does check the resolution each one will print at, and lists any that
fall under 150 pixels per inch, because that is the point where print starts to look soft. SVG is vector, so it is not
checked.

## Checking it

The tests print a sample document with every template and look at the result with the usual poppler tools: page size,
fonts embedded, the text in reading order. That catches the regressions that a glance at the preview would not.

If you want to see it for yourself, run the editor, open the sample document, and choose Export.
