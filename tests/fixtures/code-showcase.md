# Code showcase

One realistic sample per language, to check the syntax colours in the PDF
templates (tests/code-languages.test.mjs also checks every scope has a colour).

## CSS

```css
/* Card component */
:root {
  --brand: #f47b20;
  --radius: 6px;
}

.card > .title,
#sidebar a:hover::after {
  display: flex;
  margin: 0 auto 1.5rem;
  color: var(--brand);
  border-radius: calc(var(--radius) * 2);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12) !important;
}

@media (max-width: 600px) {
  .card[data-size="small"] { padding: 12px; }
}
```

## HTML

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>PrintMD &amp; Example Co</title>
  <link rel="stylesheet" href="/css/app.css">
</head>
<body class="theme-dark">
  <!-- Main navigation -->
  <nav id="main-nav" aria-label="Primary">
    <a href="/articles?page=2" class="active">Articles</a>
  </nav>
  <button type="button" disabled>Publish</button>
  <script src="/js/app.js" defer></script>
</body>
</html>
```

## PHP

```php
<?php
declare(strict_types=1);
namespace App\Service;
use App\Entity\Article;

/** Publishes articles on schedule. */
final class Publisher extends BaseService implements PublisherInterface
{
    private const MAX_RETRIES = 3;

    public function __construct(private readonly Clock $clock) {}

    public function publish(Article $article, ?string $note = null): bool
    {
        $when = $this->clock->now()->format('Y-m-d H:i');
        return $article->setPublished(true, $when)->save() === self::MAX_RETRIES - 2;
    }
}
```

## JavaScript

```javascript
import {renderMarkdown} from './markdown.js';
// Debounced preview update
export class Preview extends EventTarget {
  #timer = null;

  constructor(element, delay = 250) {
    super();
    this.element = element;
    this.delay = delay;
  }

  update(source) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(async () => {
      const html = await renderMarkdown(source ?? '');
      this.element.innerHTML = html;
      this.dispatchEvent(new CustomEvent('rendered', {detail: {length: html.length}}));
    }, this.delay);
  }
}
```

## TypeScript

```typescript
type Status = 'draft' | 'published' | 'archived';
interface Article {
  readonly id: number;
  title: string;
  status: Status;
  tags?: string[];
}

export abstract class Repository<T extends {id: number}> {
  protected items = new Map<number, T>();
  abstract validate(item: T): boolean;
  save(item: T): T {
    if (!this.validate(item)) throw new Error(`Invalid item ${item.id}`);
    this.items.set(item.id, item);
    return item;
  }
}

export const isPublished = (a: Article): boolean => a.status === 'published';
```

## Python

```python
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Article:
    """A news article."""
    id: int
    title: str
    tags: list[str] = field(default_factory=list)
    score: Optional[float] = None

    def slug(self, max_len: int = 60) -> str:
        # Lower case, hyphens for spaces
        text = self.title.lower().replace(" ", "-")
        return text[:max_len] if len(text) > max_len else text


articles = [Article(i, f"Story {i}") for i in range(3)]
print(sorted(a.slug() for a in articles if a.score is None))
```

## Rust

```rust
use std::collections::HashMap;
/// A word counter.
#[derive(Debug, Default)]
pub struct Counter {
    counts: HashMap<String, usize>,
}

impl Counter {
    pub fn add(&mut self, text: &str) -> usize {
        for word in text.split_whitespace() {
            *self.counts.entry(word.to_lowercase()).or_insert(0) += 1;
        }
        self.counts.len()
    }
}

fn main() {
    let mut c = Counter::default();
    println!("{} unique words", c.add("the quick brown fox jumps over the lazy dog"));
}
```

## Go

```go
package main

import ("fmt"; "net/http"; "time")
// Health reports the service status.
type Health struct {
	Status  string        `json:"status"`
	Uptime  time.Duration `json:"uptime"`
}

func handler(start time.Time) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := Health{Status: "ok", Uptime: time.Since(start)}
		fmt.Fprintf(w, "%s after %v\n", h.Status, h.Uptime)
	}
}

func main() {
	http.ListenAndServe(":8080", handler(time.Now()))
}
```

## Java

```java
package com.example.docs;
import java.util.List;
import java.util.Optional;
/** Finds articles by tag. */
public final class ArticleFinder {
    private static final int LIMIT = 20;
    private final List<Article> articles;

    public ArticleFinder(List<Article> articles) {
        this.articles = List.copyOf(articles);
    }

    @Override
    public String toString() {
        return "ArticleFinder[" + articles.size() + "]";
    }
    public Optional<Article> first(String tag) {
        return articles.stream().filter(a -> a.hasTag(tag)).limit(LIMIT).findFirst();
    }
}
```

## C#

```csharp
using System;
using System.Linq;
namespace ExampleCo.Docs
{
    /// <summary>Exports documents.</summary>
    public sealed class Exporter : IExporter
    {
        private readonly ILogger _log;
        public int Pages { get; private set; } = 0;

        public Exporter(ILogger log) => _log = log;
        [Obsolete("Use ExportAsync")]
        public bool Export(string[] files, bool landscape = false)
        {
            Pages = files.Count(f => f.EndsWith(".md"));
            _log.Info($"Exported {Pages} pages, landscape: {landscape}");
            return Pages > 0;
        }
    }
}
```

## SQL

```sql
-- Most active authors in the last 90 days
SELECT u.id,
       u.name,
       COUNT(a.id)        AS articles,
       MAX(a.created_at)  AS last_article
FROM users AS u
LEFT JOIN articles a ON a.author_id = u.id
WHERE a.status = 'published'
  AND a.created_at >= NOW() - INTERVAL '90 days'
GROUP BY u.id, u.name
HAVING COUNT(a.id) > 5
ORDER BY articles DESC
LIMIT 20;

CREATE INDEX IF NOT EXISTS idx_articles_author ON articles (author_id, created_at);
```

## Bash

```bash
#!/usr/bin/env bash
set -euo pipefail

# Convert every Markdown file to a branded PDF
TEMPLATE="${1:-flow}"
OUT_DIR="./pdf"
mkdir -p "$OUT_DIR"

for file in docs/*.md; do
  name=$(basename "$file" .md)
  if [[ -s "$file" ]]; then
    curl -sf -X POST "http://127.0.0.1:8787/api/v1/render?template=$TEMPLATE" \
      --data-binary @"$file" -o "$OUT_DIR/$name.pdf"
    echo "Wrote $OUT_DIR/$name.pdf"
  fi
done
exit 0
```

## YAML

```yaml
# CI pipeline
name: tests
on:
  push:
    branches: [main, "feat/*"]
env:
  NODE_VERSION: 22
  RETRIES: 3
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - name: Run the suite
        run: node tests/run-all.mjs
        continue-on-error: false
```

## JSON

```json
{
  "name": "printmd-server",
  "version": "1.4.0",
  "private": true,
  "scripts": {
    "start": "node src/main.mjs",
    "test": "node --test test/*.test.mjs"
  },
  "engines": {"node": ">=22"},
  "limits": {"maxBytes": 2097152, "timeoutMs": 30000, "retry": null},
  "templates": ["example-co", "other-co", "plain", "unbranded"],
  "dependencies": {
    "jose": "6.2.12",
    "playwright": "1.50.0"
  }
}
```

## Dockerfile

```dockerfile
# Test image for the CI pipeline
FROM node:22-bookworm-slim AS base

ARG CHROME_VERSION=131
ENV NODE_ENV=test \
    CHROME_BIN=/usr/bin/chromium

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work
COPY package*.json ./
RUN npm ci --omit=dev
EXPOSE 8787
USER node
CMD ["node", "tests/run-all.mjs"]
```

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name docs.example.com;

    root /var/www/printmd;
    index index.html;

    # Never serve dotfiles
    location ~ /\. {
        deny all;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_read_timeout 60s;
        client_max_body_size 2m;
    }
}
```

## Terraform

```terraform
variable "environment" {
  type    = string
  default = "dev"
}

resource "aws_s3_bucket" "docs" {
  bucket = "printmd-${var.environment}"
  tags = {
    Team    = "platform"
    Managed = true
  }
}

output "bucket_arn" {
  value       = aws_s3_bucket.docs.arn
  description = "ARN of the docs bucket"
  sensitive   = false
}
```

## Diff

```diff
diff --git a/js/markdown.js b/js/markdown.js
index c398823..747d79e 100644
--- a/js/markdown.js
+++ b/js/markdown.js
@@ -219,17 +223,8 @@ export function configureMarked() {
             text = tokenOrCode || '';
             lang = langOrNothing || '';
         }
-        const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
-        try {
-            const highlighted = hljs.highlight(text, {language}).value;
-            return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
-        } catch {
+        // Language, label and highlighting: js/code-languages.js.
+        return codeBlockHtml(text, lang, hljs);
     };
```

## Markdown

```markdown
# Introduction

Revenue grew **12%** this quarter, led by *subscriptions*.

## Highlights

- Launched the [new editor](https://example.com/editor)
- Moved the API to `v2`
  1. Faster renders
  2. Fewer errors

> Quality over speed.
```
