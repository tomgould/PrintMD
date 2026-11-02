# Markdown Showcase

A comprehensive reference document covering every element Markdown supports.

---

## Table of Contents

- [Headings](#headings)
- [Paragraphs & Line Breaks](#paragraphs--line-breaks)
- [Emphasis](#emphasis)
- [Blockquotes](#blockquotes)
- [Lists](#lists)
- [Code](#code)
- [Horizontal Rules](#horizontal-rules)
- [Links](#links)
- [Images](#images)
- [Tables](#tables)
- [Task Lists](#task-lists)
- [Footnotes](#footnotes)
- [Definition Lists](#definition-lists)
- [Strikethrough & Highlight](#strikethrough--highlight)
- [Subscript & Superscript](#subscript--superscript)
- [Emoji](#emoji)
- [Escaping Characters](#escaping-characters)
- [HTML Inline](#html-inline)

---

## Headings

# Heading 1

## Heading 2

### Heading 3

#### Heading 4

##### Heading 5

###### Heading 6

Alternate H1 (Setext style)
===========================

Alternate H2 (Setext style)
----------------------------

---

## Paragraphs & Line Breaks

This is a paragraph. Paragraphs are separated by a blank line.
Adjacent lines with no blank line between them are joined into the same paragraph. They do not produce a line break.

This is a second paragraph. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut
labore et dolore magna aliqua.

To force a line break within a paragraph, end a line with two or more spaces  
then continue on the next line. That produces a `<br>`.

---

## Emphasis

**Bold** text using double asterisks.

__Bold__ text using double underscores.

*Italic* text using single asterisk.

_Italic_ text using single underscore.

***Bold and italic*** using triple asterisks.

___Bold and italic___ using triple underscores.

**Bold with _nested italic_ inside.**

*Italic with **nested bold** inside.*

---

## Blockquotes

> A simple single-line blockquote.

> A blockquote that spans
> multiple lines in the source
> but renders as one block.

> **Blockquote with formatting.**
> You can use *italic*, **bold**, and `code` inside a blockquote.

> Nested blockquotes:
>
> > This is a nested blockquote inside the first.
> >
> > > And one level deeper still.

> #### Blockquote with a heading
>
> - Lists work inside blockquotes too.
> - Item two.
>
> The blockquote ends after the blank line.

---

## Lists

### Unordered Lists

- Item one
- Item two
- Item three

* Asterisk bullet one
* Asterisk bullet two

+ Plus bullet one
+ Plus bullet two

**Nested unordered list:**

- Level one
    - Level two
        - Level three
            - Level four
    - Back to two
- Back to one

### Ordered Lists

1. First item
2. Second item
3. Third item

**Ordered list with arbitrary numbers (still renders correctly):**

1. First
1. Second
1. Third

**Ordered list starting at a different number:**

5. Fifth
6. Sixth
7. Seventh

**Nested ordered list:**

1. First item
    1. Sub-item A
    2. Sub-item B
        1. Sub-sub-item i
        2. Sub-sub-item ii
2. Second item
3. Third item

**Mixed nested lists:**

1. Ordered top level
    - Unordered nested
    - Another unordered nested
        1. Back to ordered at depth three
        2. Item two
2. Second ordered item

**Loose list** (paragraphs inside each item):

- This item has a paragraph.

  The paragraph continues here inside the same list item.

- This item is also loose.

  It also has a paragraph inside.

---

## Code

### Inline Code

Use `backticks` for inline code. For example: `const x = 42;` or `npm install`.

To include a backtick inside inline code, use double backticks: `` `backtick` ``.

### Fenced Code Blocks

```
Plain fenced block with no language specified.
```

```javascript
// JavaScript
const greet = (name) => {
    return `Hello, ${name}!`;
};

async function fetchData(url) {
    const response = await fetch(url);
    const data = await response.json();
    return data;
}

console.log(greet('PrintMD'));
```

```python
# Python
def fibonacci(n):
    if n <= 1:
        return n
    a, b = 0, 1
    for _ in range(2, n + 1):
        a, b = b, a + b
    return b

print([fibonacci(i) for i in range(10)])
```

```sql
-- SQL
SELECT u.id,
       u.name,
       COUNT(p.id)       AS post_count,
       MAX(p.created_at) AS last_post
FROM users u
         LEFT JOIN posts p ON p.user_id = u.id
WHERE u.created_at >= NOW() - INTERVAL '90 days'
GROUP BY u.id, u.name
ORDER BY post_count DESC
    LIMIT 20;
```

```bash
# Bash
#!/usr/bin/env bash
set -euo pipefail

for file in *.md; do
  echo "Processing: $file"
  pandoc "$file" -o "${file%.md}.pdf"
done
```

```css
/* CSS */
:root {
    --primary: #1e3a5f;
    --accent: #fd6f2f;
}

.card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.5rem;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
```

```json
{
  "name": "printmd",
  "version": "1.0.0",
  "scripts": {
    "start": "serve .",
    "test": "vitest"
  },
  "dependencies": {
    "marked": "^9.0.0",
    "dompurify": "^3.0.0"
  }
}
```

```typescript
// TypeScript
interface Document {
    id: string;
    title: string;
    author?: string;
    createdAt: Date;
    tags: string[];
}

function renderDoc(doc: Document): string {
    return `# ${doc.title}\n\nAuthor: ${doc.author ?? 'Unknown'}`;
}
```

```php
<?php
// PHP

declare(strict_types=1);

class ArticleRepository
{
    public function __construct(private readonly PDO $db) {}

    public function findPublished(int $limit = 20): array
    {
        $stmt = $this->db->prepare(
            'SELECT id, title, slug, published_at
             FROM articles
             WHERE status = :status
             ORDER BY published_at DESC
             LIMIT :limit'
        );
        $stmt->execute([':status' => 'published', ':limit' => $limit]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    public function findBySlug(string $slug): ?array
    {
        $stmt = $this->db->prepare(
            'SELECT * FROM articles WHERE slug = :slug LIMIT 1'
        );
        $stmt->execute([':slug' => $slug]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }
}

// Usage
$repo = new ArticleRepository($pdo);
$articles = $repo->findPublished(limit: 10);

foreach ($articles as $article) {
    echo sprintf("[%s] %s\n", $article['published_at'], $article['title']);
}
```

### Indented Code Block (4 spaces)

    This is an indented code block.
    It works with 4 leading spaces.
    No syntax highlighting.

---

## Horizontal Rules

Three or more hyphens:

---

Three or more asterisks:

***

Three or more underscores:

___

---

## Links

### Inline Links

[Basic link](https://example.com)

[Link with title](https://example.com "Visit Example")

[Relative link](./other-file.md)

### Reference-Style Links

[Reference link][ref1]

[Another reference][ref2]

[ref1]: https://example.com "Example Site"

[ref2]: https://example.org "Example Org"

### Autolinks

<https://example.com>

<hello@example.com>

### Bare URL (GFM)

https://example.com

---

## Images

### Inline Image

![A forest path with sunlight filtering through the trees](https://picsum.photos/seed/printmd/800/300 "Sample landscape photo from picsum.photos")

### Image with Reference Style

![A calm mountain lake at dawn][img1]

[img1]: https://picsum.photos/seed/lake/800/250

### Linked Image

[![A close-up of a journalist's notebook and pen](https://picsum.photos/seed/flow/400/180)](https://example.com)

---

## Tables

### Basic Table

| Column One | Column Two | Column Three |
|------------|------------|--------------|
| Row 1, A   | Row 1, B   | Row 1, C     |
| Row 2, A   | Row 2, B   | Row 2, C     |
| Row 3, A   | Row 3, B   | Row 3, C     |

### Alignment

| Left-aligned | Centre-aligned | Right-aligned |
|:-------------|:--------------:|--------------:|
| Apple        |     Banana     |        Cherry |
| One          |      Two       |         Three |
| `code`       |    **bold**    |        *ital* |

### Wide Table

| Name          | Role            | Department     | Start Date | Status   |
|---------------|-----------------|----------------|------------|----------|
| Alice Johnson | Lead Developer  | Engineering    | 2021-03-01 | Active   |
| Bob Chen      | Product Manager | Product        | 2020-07-15 | Active   |
| Carol Smith   | UX Designer     | Design         | 2022-01-10 | Active   |
| David Okafor  | Data Analyst    | Analytics      | 2021-11-22 | On Leave |
| Eve Williams  | DevOps Engineer | Infrastructure | 2019-05-30 | Active   |

---

## Task Lists

- [x] Completed task
- [x] Another completed task
- [ ] Incomplete task
- [ ] Another incomplete task
    - [x] Nested completed sub-task
    - [ ] Nested incomplete sub-task
- [x] Final completed item

---

## Footnotes

Here is a sentence with a footnote.[^1]

And another sentence with a second footnote.[^note]

[^1]: This is the first footnote text.

[^note]: This is a named footnote. Footnotes can contain **bold**, *italic*, and `code`.

---

## Definition Lists

Term One
:   The definition of term one.

Term Two
:   The first definition of term two.
:   A second definition for the same term.

Markdown
:   A lightweight markup language created by John Gruber in 2004.
:   Designed to be readable as plain text and convertible to HTML.

---

## Strikethrough & Highlight

~~Strikethrough~~ text using double tildes.

This sentence has ~~deleted words~~ in the middle of it.

==Highlighted text== using double equals (supported in some renderers).

---

## Subscript & Superscript

H~2~O (subscript, supported in some renderers)

E = mc^2^ (superscript, supported in some renderers)

---

## Emoji

:smile: :rocket: :check: :warning: :books: :computer:

(Emoji shortcodes are supported in some Markdown renderers, including GitHub.)

---

## Escaping Characters

Use a backslash `\` to escape Markdown special characters:

\*not italic\*

\*\*not bold\*\*

\# not a heading

\- not a list item

\[not a link\](https://example.com)

\`not code\`

Full list of escapable characters: \\ \` \* \_ \{ \} \[ \] \( \) \# \+ \- \. \!

---

## HTML Inline

Markdown renderers that allow HTML can render inline elements:

The <abbr title="HyperText Markup Language">HTML</abbr> abbreviation tag.

<kbd>Ctrl</kbd> + <kbd>S</kbd> to save.

<mark>Highlighted with HTML mark tag.</mark>

<small>Smaller text using the small tag.</small>

<details>
<summary>Collapsed section (click to expand)</summary>

This content is hidden until the user expands the `<details>` block. Useful for long optional content.

</details>

---

## Combining Elements

> **Note:** The following examples show elements used together.

### Blockquote with a list inside

> Here are the key points:
>
> 1. First important point
> 2. Second important point
     >

- Sub-detail A

> - Sub-detail B
> 3. Third important point

### Table with inline formatting

| Feature       | Status | Notes                  |
|:--------------|:-------|:-----------------------|
| **Bold**      | ✅ Done | Works in all renderers |
| *Italic*      | ✅ Done | Works in all renderers |
| ~~Strike~~    | ✅ Done | GFM only               |
| `Inline code` | ✅ Done | Works in all renderers |
| [Link](/)     | ✅ Done | Relative or absolute   |

### Code block inside a list

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the development server:

   ```bash
   npm run dev
   ```

3. Open `http://localhost:3000` in your browser.

---

*End of Markdown Showcase. This document covers headings, paragraphs, emphasis, blockquotes, lists (ordered, unordered,
nested, loose, mixed), code (inline and fenced with 10+ languages), horizontal rules, links (inline, reference,
autolink), images, tables (basic, aligned, wide), task lists, footnotes, definition lists, strikethrough, highlight,
subscript, superscript, emoji, character escaping, inline HTML, and combination examples.*
