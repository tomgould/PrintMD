# Vendored highlight.js 11.9.0

Syntax highlighting for code blocks, served by the app itself (no CDN; the CSP allows scripts from the app only).
Every file comes unchanged from the `@highlightjs/cdn-assets` npm package, version 11.9.0, BSD-3-Clause (`LICENSE`).

| File                   | What it is                                                         | Size    |
|------------------------|--------------------------------------------------------------------|---------|
| `highlight.min.js`     | The package's `highlight.min.js`: the core and 36 common languages | 122 KB  |
| `languages.min.js`     | The other 156 languages: the package's `languages/<name>.min.js` files, concatenated in name order | 913 KB (256 KB gzipped) |
| `atom-one-dark.min.css`| The package's `styles/atom-one-dark.min.css` (the template CSS overrides its colours) | 1 KB |

`languages.min.js` registers each grammar on the global `hljs`, so it loads after `highlight.min.js`: `index.html`,
`server/harness.html` and the test pages that render Markdown load both. Loading all 156 costs about 11 ms in Chrome; the
alternative, fetching a grammar when a document first uses it, would make the preview and every export wait for a fetch.
HCL and Terraform, which highlight.js does not ship, use our own grammar in `js/hljs-hcl.js`.

To rebuild `languages.min.js` from the package (sha256 `71e3af3c...1a131d40`):

```bash
npm pack @highlightjs/cdn-assets@11.9.0 && tar xzf highlightjs-cdn-assets-11.9.0.tgz
node -e 'const h=require("./package/highlight.min.js"),c=new Set(h.listLanguages()),fs=require("fs");
  fs.readdirSync("package/languages").filter(f=>f.endsWith(".min.js")).map(f=>f.slice(0,-7))
    .filter(l=>!c.has(l)).sort().forEach(l=>fs.appendFileSync("languages.min.js",fs.readFileSync(`package/languages/${l}.min.js`)))'
```
