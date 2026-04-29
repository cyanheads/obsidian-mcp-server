# Parsing Utilities (`utils/parsing`)

```ts
import { yamlParser, xmlParser, csvParser, jsonParser, pdfParser, dateParser, frontmatterParser } from '@cyanheads/mcp-ts-core/utils';
```

All parsers are **Tier 3** — lazy-load their peer dependency on first call. All methods are **async** unless noted.

**Common behavior:**

- Singleton instances exported alongside classes
- `<think>...</think>` blocks at the start of input are automatically stripped and logged at `debug` level (except `dateParser` and `pdfParser`)
- All `context?: RequestContext` parameters are optional (synthetic context created if omitted)
- Errors throw `McpError` — never return error values

---

## `yamlParser`

**Peer dep:** `js-yaml` (`bun add js-yaml`)

| Method | Signature |
|:-------|:----------|
| `parse` | `<T = unknown>(yamlString, context?) -> Promise<T>` |

Uses `js-yaml` `DEFAULT_SCHEMA`. Throws `ConfigurationError` if dep missing, `ValidationError` on empty/malformed input.

```ts
const config = await yamlParser.parse<ServerConfig>(yamlString);
```

---

## `xmlParser`

**Peer dep:** `fast-xml-parser` (`bun add fast-xml-parser`)

| Method | Signature |
|:-------|:----------|
| `parse` | `<T = unknown>(xmlString, context?) -> Promise<T>` |

Internal `XMLParser` instance constructed once with `{ processEntities: false, htmlEntities: false }` and cached. Entity refs pass through as-is.

```ts
const data = await xmlParser.parse<FeedResponse>(xmlString);
```

---

## `csvParser`

**Peer dep:** `papaparse` (`bun add papaparse`)

| Method | Signature |
|:-------|:----------|
| `parse` | `<T = unknown>(csvString, options?, context?) -> Promise<Papa.ParseResult<T>>` |

`options` is `Papa.ParseConfig` forwarded verbatim — key options: `header`, `delimiter`, `dynamicTyping`. Returns `{ data: T[], errors: ParseError[], meta: ParseMeta }`. Throws `ValidationError` if `result.errors` is non-empty.

```ts
const result = await csvParser.parse<Row>(csvString, { header: true, dynamicTyping: true });
for (const row of result.data) { /* ... */ }
```

---

## `jsonParser`

**Peer dep:** `partial-json` (`bun add partial-json`)

| Method | Signature |
|:-------|:----------|
| `parse` | `<T = unknown>(jsonString, allowPartial?, context?) -> Promise<T>` |

`allowPartial` defaults to `Allow.ALL`. Combine `Allow` flags with bitwise OR for fine-grained control over what partial constructs to accept.

### `Allow` flags

| Flag | Value | Meaning |
|:-----|------:|:--------|
| `STR` | `0x1` | Partial strings |
| `NUM` | `0x2` | Partial numbers |
| `ARR` | `0x4` | Partial arrays |
| `OBJ` | `0x8` | Partial objects |
| `NULL` | `0x10` | Partial nulls |
| `BOOL` | `0x20` | Partial booleans |
| `NAN` | `0x40` | NaN values |
| `INFINITY` | `0x80` | Positive Infinity |
| `_INFINITY` | `0x100` | Negative Infinity |
| `INF` | `0x180` | Both Infinity variants |
| `SPECIAL` | `0x1F0` | NULL \| BOOL \| NAN \| INF |
| `ATOM` | `0x1F3` | All atomic types |
| `COLLECTION` | `0xC` | ARR \| OBJ |
| `ALL` | `0x1FF` | Everything (default) |

```ts
// Parse streaming/partial JSON from LLM output
const partial = await jsonParser.parse<ToolCall>(chunk, Allow.OBJ | Allow.STR);

// Strict parse — no partial constructs
const strict = await jsonParser.parse<Config>(jsonString, 0);
```

---

## `pdfParser`

**Peer deps:** `pdf-lib` + `unpdf` (`bun add pdf-lib unpdf`)

### Methods

| Method | Sync? | Signature |
|:-------|:------|:----------|
| `createDocument` | async | `(context?) -> Promise<PDFDocument>` |
| `loadDocument` | async | `(pdfBytes, context?) -> Promise<PDFDocument>` |
| `addPage` | **sync** | `(doc, options?) -> PDFPage` |
| `embedFont` | async | `(doc, fontName?, context?) -> Promise<PDFFont>` |
| `embedImage` | async | `(doc, options, context?) -> Promise<PDFImage>` |
| `drawText` | async | `(page, options) -> Promise<void>` |
| `drawImage` | async | `(page, options) -> Promise<void>` |
| `mergePdfs` | async | `(pdfBytesArray, context?) -> Promise<PDFDocument>` |
| `splitPdf` | async | `(pdfBytes, ranges, context?) -> Promise<PDFDocument[]>` |
| `fillForm` | **sync** | `(doc, options, context?) -> void` |
| `extractMetadata` | **sync** | `(doc) -> PdfMetadata` |
| `setMetadata` | **sync** | `(doc, metadata) -> void` |
| `extractText` | async | `(doc, options?, context?) -> Promise<ExtractTextResult>` |
| `saveDocument` | async | `(doc, context?) -> Promise<Uint8Array>` |

### Option types

```ts
interface AddPageOptions { height?: number; width?: number }  // default: 612x792 (US Letter)

interface DrawTextOptions {
  text: string; x: number; y: number;
  size?: number;        // default 12
  font?: PDFFont;       // default Helvetica
  color?: RGB;          // default black
  rotate?: number;      // degrees, default 0
  maxWidth?: number;    // enables word-wrap when set
  lineHeight?: number;  // multiplier, default 1.2
}

interface EmbedImageOptions { imageBytes: Uint8Array | ArrayBuffer; format: 'png' | 'jpg' }

interface DrawImageOptions {
  image: PDFImage; x: number; y: number;
  width?: number; height?: number;  // default: intrinsic dimensions
  rotate?: number; opacity?: number; // default: 0, 1
}

interface PageRange { start: number; end: number }  // 0-based, inclusive

interface FillFormOptions {
  fields: Record<string, string | boolean | number>;
  flatten?: boolean;  // default false — flatten removes form interactivity
}

interface ExtractTextOptions { mergePages?: boolean }  // default false

interface ExtractTextResult { text: string | string[]; totalPages: number }
// mergePages=true -> single string; false -> string[] per page

interface PdfMetadata {
  pageCount: number;
  title?: string; author?: string; subject?: string; keywords?: string;
  creator?: string; producer?: string;
  creationDate?: string; modificationDate?: string;  // ISO 8601
}

interface SetMetadataOptions {
  title?: string; author?: string; subject?: string; keywords?: string;
  creator?: string; producer?: string;
}
```

Also re-exports from `pdf-lib`: `PDFDocument`, `PDFFont`, `PDFImage`, `PDFPage`, `RGB`.

### Usage

```ts
// Create a PDF
const doc = await pdfParser.createDocument();
const page = pdfParser.addPage(doc, { width: 612, height: 792 });
const font = await pdfParser.embedFont(doc, 'Helvetica');
await pdfParser.drawText(page, { text: 'Hello', x: 50, y: 700, font, size: 24 });
const bytes = await pdfParser.saveDocument(doc);

// Extract text from existing PDF
const loaded = await pdfParser.loadDocument(existingBytes);
const result = await pdfParser.extractText(loaded, { mergePages: true });
// result: { text: 'full document text', totalPages: 5 }

// Merge multiple PDFs
const merged = await pdfParser.mergePdfs([pdf1Bytes, pdf2Bytes]);

// Fill form fields
pdfParser.fillForm(doc, {
  fields: { name: 'Alice', approved: true, score: 95 },
  flatten: true,
});
```

---

## `dateParser`

**Peer dep:** `chrono-node` (`bun add chrono-node`)

Unlike other parsers, `dateParser` is a plain object (not a class singleton) and `context` is **required**.

| Method | Signature | Returns |
|:-------|:----------|:--------|
| `parseDate` | `(text, context, refDate?) -> Promise<Date \| null>` | First parsed date, or `null` |
| `parse` | `(text, context, refDate?) -> Promise<chrono.ParsedResult[]>` | Full chrono results array |

Both use `forwardDate: true` — ambiguous relative dates resolve to the next future occurrence.

Also exported as standalone functions: `parseDateString` (= `parseDate`) and `parseDateStringDetailed` (= `parse`).

```ts
const date = await dateParser.parseDate('next Tuesday at 3pm', ctx);
// Date object for the upcoming Tuesday

const results = await dateParser.parse('between March 1 and March 15', ctx);
// Array of ParsedResult with start/end components
```

---

## `frontmatterParser`

**Peer dep:** inherits `js-yaml` via `yamlParser` (`bun add js-yaml`)

| Method | Signature |
|:-------|:----------|
| `parse` | `<T = unknown>(markdown, context?) -> Promise<FrontmatterResult<T>>` |

```ts
interface FrontmatterResult<T = unknown> {
  frontmatter: T;         // parsed YAML object, or {} if none found
  content: string;        // markdown body after frontmatter block
  hasFrontmatter: boolean;
}
```

Matches `--- ... ---` at the very start of the document. An empty `---\n---` block returns `frontmatter: {}` with `hasFrontmatter: true`. Delegates YAML parsing to `yamlParser`, so `<think>` blocks are also stripped from the YAML content.

```ts
const { frontmatter, content, hasFrontmatter } = await frontmatterParser.parse<SkillMeta>(markdown);
if (hasFrontmatter) {
  logger.info({ name: frontmatter.name, version: frontmatter.version }, 'parsed frontmatter');
}
```

---

## `thinkBlockRegex`

Exported from the barrel. Regex: `/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/`

- Group 1: content inside `<think>` tag
- Group 2: payload after the closing tag
- Only matches when `<think>` is the very first character of the string
