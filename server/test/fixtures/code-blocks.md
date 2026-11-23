# Code blocks

PHP:

```php
<?php
// Load the article and publish it.
function publish(int $id): bool {
    $article = Article::load($id);
    return $article->setPublished(true)->save() === 1;
}
```

JSON with comments:

```jsonc
{
  // Feature flags for the dev sites.
  "flags": {"newEditor": true, "retries": 3},
  "owner": null
}
```

Bash:

```bash
#!/usr/bin/env bash
set -euo pipefail
for f in *.md; do echo "Converting $f"; done
```

Terraform:

```terraform
resource "aws_s3_bucket" "docs" {
  bucket = "printmd-${var.env}" # one per environment
  tags   = { Team = "platform" }
}
```

Plain text:

```text
Nothing to colour here.
```

No language:

```
an unlabelled block
```

A long line wraps instead of running off the page:

```js
const url = 'https://example.com/a/very/long/path/that/keeps/going/and/going/until/it/is/far/wider/than/the/page/itself?with=query&and=more&values=1234567890';
```
