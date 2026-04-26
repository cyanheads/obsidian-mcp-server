# Formatting Utilities (`utils/formatting`)

```ts
import { markdown, MarkdownBuilder, diffFormatter, tableFormatter, treeFormatter } from '@cyanheads/mcp-ts-core/utils';
```

---

## `markdown()` / `MarkdownBuilder`

`markdown()` is a factory shorthand for `new MarkdownBuilder()`. Fluent builder — all methods return `this` except `build()`.

### Methods

| Method | Signature | Notes |
|:-------|:----------|:------|
| `h1` | `(text, emoji?) -> this` | `# [emoji ]text` |
| `h2` | `(text, emoji?) -> this` | `## [emoji ]text` |
| `h3` | `(text, emoji?) -> this` | `### [emoji ]text` |
| `h4` | `(text, emoji?) -> this` | `#### [emoji ]text` |
| `keyValue` | `(key, value) -> this` | `**key:** value` |
| `keyValuePlain` | `(key, value) -> this` | `key: value` (no bold) |
| `list` | `(items, ordered?) -> this` | `ordered` defaults to `false`; empty arrays silently ignored |
| `codeBlock` | `(content, language?) -> this` | Fenced block; `language` defaults to `''` |
| `inlineCode` | `(code) -> this` | Backtick-wrapped; no trailing newline |
| `paragraph` | `(text) -> this` | Text + `\n\n` |
| `blockquote` | `(text) -> this` | Each line prefixed with `>` + space |
| `hr` | `() -> this` | `---` |
| `link` | `(text, url) -> this` | `[text](url)`; no trailing newline |
| `table` | `(headers, rows) -> this` | GFM table; no-ops if headers or rows empty |
| `section` | `(title, content) -> this` | H2 heading + callback |
| `section` | `(title, level, content) -> this` | Heading at level 2/3/4 + callback |
| `details` | `(summary, details) -> this` | HTML `<details>`/`<summary>` collapsible block |
| `alert` | `(type, content) -> this` | GFM `[!TYPE]` alert blockquote |
| `taskList` | `(items) -> this` | GFM checkbox list; `items: Array<{ checked: boolean; text: string }>` |
| `image` | `(altText, url, title?) -> this` | `![alt](url "title")` |
| `strikethrough` | `(text) -> this` | `~~text~~`; no trailing newline |
| `diff` | `(changes) -> this` | ` ```diff ` block; `changes: { additions?: string[]; deletions?: string[]; context?: string[] }` |
| `badge` | `(label, message, color?) -> this` | shields.io badge image; `color` defaults to `'blue'` |
| `bold` | `(text) -> this` | `**text**`; no trailing newline |
| `italic` | `(text) -> this` | `*text*`; no trailing newline |
| `boldItalic` | `(text) -> this` | `***text***`; no trailing newline |
| `raw` | `(markdown) -> this` | Appends verbatim |
| `blankLine` | `() -> this` | Single `\n` |
| `text` | `(text) -> this` | Plain text, no formatting, no implicit newlines |
| `when` | `(condition, content) -> this` | Conditional append; `content: () => void` |
| `reset` | `() -> this` | Clears buffer |
| `build` | `() -> string` | Returns trimmed joined buffer; does NOT reset |

### Usage

```ts
const md = markdown()
  .h1('Report', '📊')
  .paragraph('Generated automatically.')
  .section('Results', 3, () => {
    md.table(['Name', 'Score'], [['Alice', '95'], ['Bob', '87']]);
  })
  .when(hasWarnings, () => {
    md.alert('warning', 'Some items need attention.');
  })
  .build();
```

Inline methods (`bold`, `italic`, `inlineCode`, `link`, `strikethrough`) do not append newlines — combine them with `text()` or `paragraph()` for inline composition.

---

## `diffFormatter`

**Tier 3 peer:** `diff` (`bun add diff`). All methods are **async**.

### Types

```ts
type DiffFormat = 'unified' | 'patch' | 'inline';

interface DiffFormatterOptions {
  context?: number;           // unchanged lines around changes; default 3
  format?: DiffFormat;        // default 'unified'
  includeHeaders?: boolean;   // ---/+++ headers (patch only); default true
  oldPath?: string;           // file path for old version (headers)
  newPath?: string;           // file path for new version (headers)
  showLineNumbers?: boolean;  // default true
}
```

### Methods

| Method | Signature | Returns |
|:-------|:----------|:--------|
| `diff` | `(oldText, newText, options?, context?) -> Promise<string>` | Formatted diff string |
| `diffLines` | `(oldLines, newLines, options?, context?) -> Promise<string>` | Same as `diff` but accepts pre-split `string[]` arrays |
| `diffWords` | `(oldText, newText, context?) -> Promise<string>` | Word-level inline diff: `[+added+]` / `[-removed-]` |
| `getStats` | `(oldText, newText, context?) -> Promise<{ additions, deletions, changes }>` | Line-count stats; `changes = additions + deletions` |

### Format behavior

| Format | Output |
|:-------|:-------|
| `'unified'` | Hunk headers (`@@`) only — strips `---`/`+++` file headers. Default. |
| `'patch'` | Full patch with file headers. `includeHeaders: false` strips them. |
| `'inline'` | No headers or hunk markers. Additions as `[+text+]`, removals as `[-text-]`. |

### Usage

```ts
const diff = await diffFormatter.diff(oldCode, newCode, {
  format: 'unified',
  context: 5,
  showLineNumbers: true,
});

const stats = await diffFormatter.getStats(oldCode, newCode);
// { additions: 12, deletions: 3, changes: 15 }
```

---

## `tableFormatter`

Synchronous — no peer dependency.

### Types

```ts
type TableStyle = 'markdown' | 'ascii' | 'grid' | 'compact';
type Alignment = 'left' | 'center' | 'right';

interface TableFormatterOptions {
  style?: TableStyle;                    // default 'markdown'
  alignment?: Record<string, Alignment>; // key = column name or numeric index string
  maxWidth?: number;                     // truncates at this width; default 50
  minWidth?: number;                     // default 3
  truncate?: boolean;                    // truncate with '...' when exceeding maxWidth; default true
  headerStyle?: 'bold' | 'uppercase' | 'none';
  padding?: number;                      // spaces around cell content; default 1
}
```

### Methods

| Method | Signature | Notes |
|:-------|:----------|:------|
| `format` | `<T extends Record<string, unknown>>(data, options?, context?) -> string` | Extracts headers from first object's keys; stringifies values. Returns `''` if empty. |
| `formatRaw` | `(headers, rows, options?, context?) -> string` | Pre-serialized `string[][]`; every row must match `headers.length`. Returns `''` if empty. |

### Styles

| Style | Description |
|:------|:------------|
| `markdown` | GFM pipes with alignment indicators in separator row |
| `ascii` | `+`/`-`/`\|` box drawing |
| `grid` | Unicode box drawing (`┌─┬─┐` / `│` / `├─┼─┤` / `└─┴─┘`) |
| `compact` | Space-separated, no borders |

### Usage

```ts
// From objects — headers auto-extracted from keys
const table = tableFormatter.format(
  [{ name: 'Alice', score: 95 }, { name: 'Bob', score: 87 }],
  { style: 'grid', alignment: { score: 'right' } },
);

// From raw arrays
const raw = tableFormatter.formatRaw(
  ['Name', 'Score'],
  [['Alice', '95'], ['Bob', '87']],
  { style: 'markdown', headerStyle: 'bold' },
);
```

---

## `treeFormatter`

Synchronous — no peer dependency.

### Types

```ts
type TreeStyle = 'unicode' | 'ascii' | 'compact';

interface TreeNode {
  name: string;                           // required, must be non-empty
  children?: TreeNode[];                  // presence determines folder vs leaf icon
  metadata?: Record<string, unknown>;     // rendered as key=value when showMetadata enabled
}

interface TreeFormatterOptions {
  style?: TreeStyle;        // default 'unicode'
  maxDepth?: number;        // 0-based cutoff; undefined = no limit
  showMetadata?: boolean;   // append metadata after node name; default false
  icons?: boolean;          // prefix nodes with icons; default false
  indent?: string;          // per-level indent; default '  ' (two spaces)
  folderIcon?: string;      // icon for branch nodes; default folder emoji
  fileIcon?: string;        // icon for leaf nodes; default page emoji
}
```

### Methods

| Method | Signature | Notes |
|:-------|:----------|:------|
| `format` | `(root, options?, context?) -> string` | Single tree. Detects and marks circular references as `[Circular Reference]`. |
| `formatMultiple` | `(roots, options?, context?) -> string` | Forest of trees joined by `\n\n`. `roots` must be non-empty. |

### Styles

| Style | Connectors |
|:------|:-----------|
| `unicode` | `├──` / `└──` / `│` |
| `ascii` | `+--` / `\--` / `\|` |
| `compact` | Indented list, no connectors |

### Usage

```ts
const tree: TreeNode = {
  name: 'src',
  children: [
    { name: 'index.ts' },
    {
      name: 'utils',
      children: [{ name: 'helpers.ts', metadata: { lines: 42 } }],
    },
  ],
};

const output = treeFormatter.format(tree, {
  style: 'unicode',
  icons: true,
  showMetadata: true,
  maxDepth: 3,
});
```
