# Hostile fixture

Every element below tries to make the renderer fetch something. CANARY is
replaced by the test's canary server origin (http://127.0.0.1:port). None of
these requests may arrive.

![markdown image](CANARY/md-image.png "title")

<img src="CANARY/img.png" alt="img">
<img src="http://169.254.169.254/latest/meta-data/iam/security-credentials/" alt="metadata">
<img src="file:///etc/passwd" alt="file">
<img src="https://render.invalid/../../etc/passwd" alt="traversal">
<img src="https://render.invalid/js/%2e%2e/%2e%2e/etc/passwd" alt="encoded traversal">
<img srcset="CANARY/srcset-1x.png 1x, CANARY/srcset-2x.png 2x" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="srcset">

<picture><source srcset="CANARY/picture-source.png"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="picture"></picture>

<iframe src="CANARY/iframe.html"></iframe>
<iframe src="https://www.youtube.com/embed/abc"></iframe>
<link rel="stylesheet" href="CANARY/link.css">
<link rel="prefetch" href="CANARY/prefetch">
<object data="CANARY/object.swf"></object>
<embed src="CANARY/embed.swf">
<meta http-equiv="refresh" content="0; url=CANARY/meta-refresh">
<video src="CANARY/video.mp4" poster="CANARY/poster.png"></video>
<audio src="CANARY/audio.mp3"></audio>

<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <image href="CANARY/svg-image.png" width="10" height="10"/>
  <image xlink:href="CANARY/svg-xlink-image.png" width="10" height="10"/>
  <use href="CANARY/svg-use.svg#x"/>
  <feImage href="CANARY/fe-image.png"/>
</svg>

<div style="background-image: url(CANARY/css-url.png)">CSS url()</div>
<div style="background-image: url('http://169.254.169.254/css-metadata')">CSS url() to metadata</div>

<style>
@import "CANARY/import.css";
@import url(CANARY/import-url.css);
@font-face { font-family: Evil; src: url(CANARY/font.woff2) format("woff2"); }
body { background: url(CANARY/style-bg.png); font-family: Evil; }
</style>

<a href="CANARY/plain-link">A plain link is fine: it is never fetched.</a>

<form action="CANARY/form"><button formaction="CANARY/formaction">x</button></form>

<script src="CANARY/script.js"></script>
<base href="CANARY/base/">

Done.
