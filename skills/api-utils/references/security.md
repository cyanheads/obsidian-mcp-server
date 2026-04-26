# Security Utilities (`utils/security`)

```ts
import { sanitization, RateLimiter, IdGenerator, idGenerator, generateUUID, generateRequestContextId } from '@cyanheads/mcp-ts-core/utils';
```

---

## `sanitization`

Pre-constructed singleton of `Sanitization`. Tier 3 peers: `sanitize-html`, `validator` (install as needed per method).

### Methods

| Method | Async | Peer dep | Signature |
|:-------|:------|:---------|:----------|
| `sanitizeHtml` | yes | `sanitize-html` | `(input, config?) -> Promise<string>` |
| `sanitizeString` | yes | `sanitize-html` / `validator` | `(input, options?) -> Promise<string>` |
| `sanitizeUrl` | yes | `validator` | `(input, allowedProtocols?) -> Promise<string>` |
| `sanitizeNumber` | yes | `validator` (string input) | `(input, min?, max?) -> Promise<number>` |
| `sanitizePath` | **no** | Node.js only | `(input, options?) -> SanitizedPathInfo` |
| `sanitizeJson` | **no** | none | `<T>(input, maxSize?) -> T` |
| `sanitizeForLogging` | **no** | none | `(input) -> unknown` |
| `redactSensitiveFields` | **no** | none | `(data, fields?, ctx?) -> unknown` |
| `getSensitivePinoFields` | **no** | none | `() -> string[]` |

### Option types

```ts
interface HtmlSanitizeConfig {
  allowedTags?: string[];
  allowedAttributes?: sanitizeHtml.IOptions['allowedAttributes'];
  preserveComments?: boolean;
  transformTags?: sanitizeHtml.IOptions['transformTags'];
}

interface SanitizeStringOptions {
  context?: 'text' | 'html' | 'attribute' | 'url' | 'javascript';  // default: 'text'
  allowedTags?: string[];          // only used when context: 'html'
  allowedAttributes?: Record<string, string[]>;  // only used when context: 'html'
}

interface PathSanitizeOptions {
  allowAbsolute?: boolean;  // default: false
  rootDir?: string;         // resolved via path.resolve before use
  toPosix?: boolean;        // normalize backslashes to /
}

interface SanitizedPathInfo {
  sanitizedPath: string;
  originalInput: string;
  wasAbsolute: boolean;
  convertedToRelative: boolean;
  optionsUsed: PathSanitizeOptions;
}
```

### Behavior notes

- `sanitizeHtml`: returns `''` for falsy input; `<a>` tags get `rel="noopener noreferrer"` by default
- `sanitizeString`: `'javascript'` context always throws `McpError(ValidationError)` — no JavaScript allowed
- `sanitizeUrl`: default protocols `['http', 'https']`; always blocks `javascript:`, `data:`, `vbscript:`
- `sanitizePath`: **Node-only** — throws `McpError(InternalError)` in Workers. Throws `McpError(ValidationError)` on path traversal or null bytes.
- `sanitizeJson`: `maxSize` is bytes (UTF-8); uses `Buffer.byteLength` / `TextEncoder` / `string.length` fallback chain
- `sanitizeNumber`: `NaN`/`Infinity` always rejected; out-of-range values silently clamped with debug log
- `sanitizeForLogging`: deep clones via `structuredClone`; returns `'[Log Sanitization Failed]'` on clone error

### Sensitive fields

Pre-populated: `password`, `token`, `secret`, `apiKey`, `credential`, `jwt`, `ssn`, `cvv`, `authorization`, `cookie`, `clientsecret`, `client_secret`, `private_key`, `privatekey`.

Manage with `setSensitiveFields(fields)` (merges, deduped, lowercased) and `getSensitiveFields()`. `getSensitivePinoFields()` generates 3-depth pino `redact.paths` patterns from the current list.

### Usage

```ts
// HTML sanitization
const clean = await sanitization.sanitizeHtml(userHtml, {
  allowedTags: ['p', 'b', 'i', 'a'],
  allowedAttributes: { a: ['href'] },
});

// URL validation
const safeUrl = await sanitization.sanitizeUrl(userUrl, ['http', 'https', 'mailto']);

// Path sanitization (Node-only)
const info = sanitization.sanitizePath(userPath, { rootDir: '/app/data', allowAbsolute: false });
// info.sanitizedPath is safe to use in fs operations

// JSON with size limit
const data = sanitization.sanitizeJson<Config>(rawJson, 1024 * 1024); // 1MB max

// Logging redaction
const safe = sanitization.sanitizeForLogging({ password: 'secret', name: 'Alice' });
// { password: '[REDACTED]', name: 'Alice' }
```

Also exported: `sanitizeInputForLogging(input)` — convenience wrapper around `sanitization.sanitizeForLogging`.

---

## `RateLimiter`

In-process sliding window rate limiter with LRU eviction and OTEL span annotations.

### Constructor

```ts
new RateLimiter(config: AppConfig, logger: Logger)
```

Reads initial settings from `AppConfig`. Call `configure()` to override at runtime.

### Configuration

```ts
interface RateLimitConfig {
  maxRequests: number;            // required
  windowMs: number;               // required, in milliseconds
  cleanupInterval?: number;       // ms between expired entry purges
  maxTrackedKeys?: number;        // default 10,000; LRU eviction beyond this
  skipInDevelopment?: boolean;    // skips limiting when environment === 'development'
  errorMessage?: string;          // supports {waitTime} placeholder
  keyGenerator?: (identifier: string, context?: RequestContext) => string;
}
```

Defaults: `windowMs` 15 min, `maxRequests` 100, `cleanupInterval` 5 min, `maxTrackedKeys` 10,000.

### Methods

| Method | Signature | Notes |
|:-------|:----------|:------|
| `configure` | `(config: Partial<RateLimitConfig>) -> void` | Merges partial config; restarts cleanup timer if `cleanupInterval` changed |
| `check` | `(key, context?) -> void` | Throws `McpError(RateLimited)` with data `{ waitTimeSeconds, key, limit, windowMs }` when exceeded; annotates active OTEL span |
| `getStatus` | `(key) -> { current, limit, remaining, resetTime } \| null` | Does NOT apply `keyGenerator` — pass the already-resolved key |
| `getConfig` | `() -> RateLimitConfig` | Shallow copy of effective config |
| `reset` | `() -> void` | Clears all tracked entries (no per-key reset) |
| `dispose` | `() -> void` | Stops cleanup timer and clears all entries; call on shutdown |

### Usage

```ts
// In a service — check before expensive operation
rateLimiter.check(`api:${ctx.tenantId}`, ctx);

// Check status without consuming a request
const status = rateLimiter.getStatus('api:tenant-123');
if (status) {
  logger.info(`${status.remaining} requests left, resets at ${new Date(status.resetTime)}`);
}

// Runtime reconfiguration
rateLimiter.configure({ maxRequests: 200, windowMs: 60_000 });

// Cleanup on shutdown
rateLimiter.dispose();
```

---

## `IdGenerator` / `idGenerator`

Crypto-random ID generation via Web Crypto API (`crypto.getRandomValues`). Rejection sampling prevents modulo bias.

### Constructor

```ts
new IdGenerator(entityPrefixes?: EntityPrefixConfig)
```

`idGenerator` is the pre-constructed singleton (no prefixes registered by default).

### Configuration

```ts
interface EntityPrefixConfig {
  [key: string]: string;  // entityType -> prefix, e.g. { project: 'PROJ', task: 'TASK' }
}

interface IdGenerationOptions {
  charset?: string;    // default: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  length?: number;     // default: 6 (random part length)
  separator?: string;  // default: '_'
}
```

### Methods

| Method | Signature | Notes |
|:-------|:----------|:------|
| `generate` | `(prefix?, options?) -> string` | `PREFIX_XXXXXX` or just `XXXXXX` if no prefix |
| `generateForEntity` | `(entityType, options?) -> string` | Uses registered prefix; throws `McpError(ValidationError)` if type unknown |
| `generateRandomString` | `(length?, charset?) -> string` | Raw random string; defaults: length 6, charset `A-Z0-9` |
| `isValid` | `(id, entityType, options?) -> boolean` | Regex-validates format against prefix + separator + charset{length} |
| `getEntityType` | `(id, separator?) -> string` | Resolves entity type from prefix; throws `McpError(ValidationError)` if unknown |
| `normalize` | `(id, separator?) -> string` | Canonical prefix casing + uppercase random part |
| `stripPrefix` | `(id, separator?) -> string` | Returns random part; returns original if separator not found |
| `setEntityPrefixes` | `(config) -> void` | Replaces all prefixes and rebuilds reverse lookup |
| `getEntityPrefixes` | `() -> EntityPrefixConfig` | Copy of current config |

### Standalone exports

| Export | Returns | Notes |
|:-------|:--------|:------|
| `generateUUID()` | `string` | `crypto.randomUUID()` — UUID v4 |
| `generateRequestContextId()` | `string` | `XXXXX-XXXXX` format (5+5 alphanumeric, hyphen-joined) |

### Usage

```ts
// Simple ID with prefix
const id = idGenerator.generate('PROJ'); // 'PROJ_A7K2M9'

// Entity-based generation
const gen = new IdGenerator({ project: 'PROJ', task: 'TASK' });
const taskId = gen.generateForEntity('task'); // 'TASK_X3B8P1'
const valid = gen.isValid('TASK_X3B8P1', 'task'); // true
const type = gen.getEntityType('TASK_X3B8P1'); // 'task'

// Raw random string
const token = idGenerator.generateRandomString(32); // 32-char alphanumeric

// UUIDs
const uuid = generateUUID(); // 'a1b2c3d4-e5f6-...'
```
