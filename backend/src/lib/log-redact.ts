/**
 * What a log line may not carry: the data a Postgres error quotes (work-k5fk.30).
 *
 * A constraint violation's DETAIL quotes the row — "Failing row contains (<every column>)" for a CHECK or NOT
 * NULL, "Key (<cols>)=(<values>)" for a unique or foreign key — and with no FIELD_ENCRYPTION_KEY (dev, test, and
 * production until REQUIRE_FIELD_ENCRYPTION) those columns are plaintext: a private message, a need, an empathy
 * attempt. errorHandler already answers and logs a violation by its SQLSTATE and constraint only; this is the
 * same rule for every other log call (`logger.error('… failed', error)` in the services), applied once in the
 * logger's format, so it reaches the console and Sentry alike.
 *
 * Where it hides, per driver shape (errors.ts has the full list): a node-postgres DatabaseError's own `detail`
 * (and `message` when a function RAISEs with one in it); a Prisma error's `meta.driverAdapterError.cause.detail`
 * and `cause.originalMessage`; Prisma 6's `meta.message`, which embeds "DETAIL: …". Every `detail` string is
 * dropped and every other string has its quoting tail cut (scrubPgDetail); identifiers (code, constraint,
 * column, table) stay, so a log still says which rule fired.
 */

/**
 * Removes the parts of a Postgres error text that quote data. Over-strips by
 * design: values can contain parentheses and newlines, so everything from the
 * first marker to the end of the text goes.
 */
export function scrubPgDetail(text: string): string {
  return text
    .replace(/\bDETAIL:[\s\S]*$/, 'DETAIL: [redacted]')
    .replace(/Failing row contains[\s\S]*$/, 'Failing row contains [redacted]')
    .replace(/\bKey \([\s\S]*$/, 'Key [redacted]');
}

const MAX_DEPTH = 8;

/** A copy of `value` safe to log: every `detail` string redacted, every other string scrubbed. */
export function redactForLog(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubPgDetail(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(v => redactForLog(v, depth + 1, seen));
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const out: Record<string, unknown> = {};
  // An Error's name, message and stack are own non-enumerable (or inherited) properties: carry them over too.
  if (value instanceof Error) {
    out.name = value.name;
    out.message = scrubPgDetail(value.message);
    if (value.stack) out.stack = scrubStack(value.stack);
  }
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      k === 'detail' && typeof v === 'string'
        ? '[redacted]'
        : k === 'stack' && typeof v === 'string'
          ? scrubStack(v)
          : redactForLog(v, depth + 1, seen);
  }
  return out;
}

/** A stack whose header quoted data keeps its frames under the scrubbed header. */
function scrubStack(stack: string): string {
  const scrubbed = scrubPgDetail(stack);
  if (scrubbed === stack) return stack;
  const frames = stack.split('\n').filter(line => /^\s+at /.test(line));
  return [scrubbed.split('\n')[0], ...frames].join('\n');
}

/**
 * Redacts a winston info object in place (its string keys; the splat's arguments too, which a transport could
 * read), for logger.ts's format.
 */
export function redactLogInfo<T extends Record<string | symbol, unknown>>(info: T): T {
  for (const k of Object.keys(info)) {
    const v = info[k];
    (info as Record<string, unknown>)[k] =
      k === 'detail' && typeof v === 'string'
        ? '[redacted]'
        : k === 'stack' && typeof v === 'string'
          ? scrubStack(v)
          : redactForLog(v);
  }
  const splat = Symbol.for('splat');
  if (Array.isArray(info[splat]))
    (info as Record<symbol, unknown>)[splat] = (info[splat] as unknown[]).map(v => redactForLog(v));
  return info;
}
