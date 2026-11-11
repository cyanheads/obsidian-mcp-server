# Parsing Utilities (`utils/parsing`)

```ts
import { yamlParser, xmlParser, csvParser, jsonParser, pdfParser, htmlExtractor, dateParser, frontmatterParser } from '@cyanheads/mcp-ts-core/utils';
```

All parsers are **Tier 3** — lazy-load their peer dependency on first call. All methods are **async** unless noted.

**Common behavior:**

- Singleton instances exported alongside classes
- `<think>...</think>` blocks at the start of input are automatically stripped and logged at `debug` level (except `dateParser`, `pdfParser`, and `htmlExtractor`)
- Every `context?` parameter is optional (synthetic context created if omitted) and accepts the handler `Context` as well as a `RequestContext` bag
- Input budgets are opt-in: a parser is unbounded unless the caller passes `maxBytes`, which then rejects an over-budget input with `ValidationError` (`reason: 'parser_input_too_large'`). `DEFAULT_TEXT_PARSER_MAX_BYTES` (1 MiB) and `DEFAULT_BINARY_PARSER_MAX_BYTES` (25 MiB) are exported as starting points, not applied defaults
- Errors throw `McpError` — never return error values. The message is `<summary>: <library message>`, so it carries the underlying parser's diagnostic; `data` carries only `{ reason }` (`csvParser` adds Papa's `errors` list and a content sample), and the input sample and stack stay on `cause`. Input that is empty after `<think>` stripping and trimming rejects with `ValidationError` (`reason: 'parser_input_empty'`). The `context` you pass is for log correlation only — it never becomes error `data`, which reaches the client

---

## `yamlParser`

**Peer dep:** `js-yaml` (`bun add js-yaml`)

| Method | Signature |
|:-------|:----------|
| `parse` | `<T = unknown>(yamlString, context?) -> Promise<T>` |

Uses `js-yaml` (v5) `YAML11_SCHEMA` (YAML 1.1 load semantics). Throws `ConfigurationError` if dep missing, `ValidationError` on empty/malformed input.

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

`options` is `Papa.ParseConfig` forwarded verbatim — key options: `header`, `delimiter`, `dynamicTyping`. Returns `{ data: T[], errors: ParseError[], meta: ParseMeta }`. Throws `ValidationError` if `result.errors` is non-empty, with `data: { reason: 'csv_parse_failed', errors, originalContentSample }`.

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
| `loadDocument` | async | `(pdfBytes, context?, budget?) -> Promise<PDFDocument>` |
| `addPage` | **sync** | `(doc, options?) -> PDFPage` |
| `embedFont` | async | `(doc, fontName?, context?) -> Promise<PDFFont>` |
| `embedImage` | async | `(doc, options, context?) -> Promise<PDFImage>` |
| `drawText` | async | `(page, options) -> Promise<void>` |
| `drawImage` | async | `(page, options) -> Promise<void>` |
| `mergePdfs` | async | `(pdfBytesArray, context?, budget?) -> Promise<PDFDocument>` |
| `splitPdf` | async | `(pdfBytes, ranges, context?, budget?) -> Promise<PDFDocument[]>` |
| `fillForm` | **sync** | `(doc, options, context?) -> void` |
| `extractMetadata` | **sync** | `(doc) -> PdfMetadata` |
| `setMetadata` | **sync** | `(doc, metadata) -> void` |
| `extractText` | async | `(input, options?, context?) -> Promise<ExtractTextResult>` |
| `saveDocument` | async | `(doc, context?) -> Promise<Uint8Array>` |

`budget` is `ParserInputBudgetOptions` (`{ maxBytes?: number }`); on `mergePdfs` it bounds the inputs' combined size. `extractText`'s `input` is raw bytes (`Uint8Array | ArrayBuffer`, the `unpdf`-only path; a Node `Buffer` from `readFile` works) or a loaded `PDFDocument`, which is serialized with `save()` first. Bytes are read from a copy, so the same buffer can go to `loadDocument` or storage afterward.

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

interface EmbedImageOptions {
  imageBytes: Uint8Array | ArrayBuffer; format: 'png' | 'jpg';
  maxBytes?: number;    // input budget; unbounded when omitted
}

interface DrawImageOptions {
  image: PDFImage; x: number; y: number;
  width?: number; height?: number;  // default: intrinsic dimensions
  rotate?: number; opacity?: number; // default: 0, 1
}

interface PageRange { start: number; end: number }  // 0-based page indices, end inclusive

interface FillFormOptions {
  fields: Record<string, string | boolean | number>;
  flatten?: boolean;  // default false — flatten removes form interactivity
}

interface ExtractTextOptions {
  mergePages?: boolean;   // default false
  maxBytes?: number;      // input budget; unbounded when omitted
  maxImageSize?: number;  // pixel ceiling on one decoded image, passed to pdf.js; unbounded when omitted
}

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

### Errors

A caller-supplied PDF that cannot be read fails as `ValidationError`; every other failure is `InternalError`. The `reason` names the operation either way (`pdf_load_failed`, `pdf_merge_failed`, `pdf_split_failed`, `pdf_text_extract_failed`), and a missing peer passes through as `ConfigurationError`.

- **`extractText`** classifies by the pdf.js exception name: `InvalidPDFException` (empty body, no PDF structure, a trailer `/Root` that is not a catalog) and `PasswordException` (encrypted; `extractText` takes no password) are `ValidationError`. `UnknownErrorException` and anything else, and a `save()` failure when a `PDFDocument` is passed, are `InternalError`.
- **`loadDocument`, `mergePdfs`, `splitPdf`** fail as `ValidationError` when `pdf-lib` cannot load a source: no PDF header, encrypted, or no document catalog. pdf-lib loads a catalog-less file without complaint and only breaks on first use, so the parser rejects it at load. A failure after loading is `InternalError`.
- **`splitPdf`** checks every range against the loaded page count before copying anything: a range that is not integers with `0 <= start <= end < pageCount` fails as `ValidationError` (`pdf_split_failed`), and the message names the range as `ranges[i] { start, end }` with the valid bounds.

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

## `htmlExtractor`

**Peer deps:** `defuddle` + `linkedom` (`bun add defuddle linkedom`)

| Method | Signature |
|:-------|:----------|
| `extract` | `(html, options?, context?) -> Promise<ExtractArticleResult>` |

Extracts a page's main article content with Defuddle over a `linkedom` DOM, as Markdown (the default) or cleaned HTML, plus best-effort metadata. Only `content` is guaranteed; every other field is omitted when the page does not provide it.

```ts
interface ExtractArticleOptions {
  format?: 'markdown' | 'html';  // default 'markdown'
  url?: string;                  // the page's URL, for site-specific extractors and link resolution
  contentSelector?: string;      // main-content element; auto-detection when it matches nothing
  removeImages?: boolean;        // default false
  language?: string;             // preferred BCP 47 language
  useAsync?: boolean;            // default false; true lets Defuddle fetch from third-party APIs when the HTML holds no content
  debug?: boolean;               // Defuddle debug logging, no div flattening
  maxBytes?: number;             // UTF-8 input budget; unbounded when omitted
}

interface ExtractArticleResult {
  content: string;
  title?: string; author?: string; description?: string; published?: string;
  site?: string; domain?: string; favicon?: string; image?: string; language?: string;
  metaTags?: Record<string, string>;  // keyed by name, else property
  schemaOrgData?: unknown;
  wordCount?: number;
  parseTime?: number;                 // ms Defuddle spent
}
```

**Cost.** The extraction runs synchronously on the calling thread and blocks the event loop until it finishes. It takes no abort signal and cannot be interrupted once it starts, and `maxBytes` bounds the input's size, not the CPU time spent on it. A server that extracts untrusted HTML should run `htmlExtractor` off its serving thread, in a worker thread or a child process, so one request cannot stall every other request on the process.

HTML that is empty after trimming rejects with `ValidationError` (`parser_input_empty`), a Defuddle failure with `ValidationError` (`html_extract_failed`), and a missing peer with `ConfigurationError`.

```ts
const article = await htmlExtractor.extract(html, { url: 'https://example.com/post' });
// article.content is Markdown; title, author, and the other fields are set when the page has them
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
