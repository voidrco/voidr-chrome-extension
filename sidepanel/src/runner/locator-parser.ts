/**
 * Parser for the constrained Playwright locator expressions stored in the
 * VoidrJourney IR (`VoidrTarget.locator`).
 *
 * The IR compiler side (voidr-hive lib/replay: normalize.ts,
 * screenmap-match.ts, heal.ts) emits ONLY these shapes:
 *
 *   page.getByTestId('X')
 *   page.getByRole('role', { name: 'Name' })
 *   page.getByLabel('X')
 *   page.getByPlaceholder('X')
 *   page.getByText('X')
 *   page.locator('css selector')
 *   page.locator('tag', { hasText: 'X' })
 *
 * MV3 extension pages forbid eval/new Function, so the expressions are parsed
 * structurally instead of evaluated. Unparseable expressions return null and
 * the runner simply moves on to the next ranked candidate — same contract as
 * the compiled resolveTarget (a bad candidate is a miss, not a crash).
 */

export type LocatorMethod =
  | 'getByTestId'
  | 'getByRole'
  | 'getByLabel'
  | 'getByPlaceholder'
  | 'getByText'
  | 'locator';

export interface ParsedLocator {
  method: LocatorMethod;
  /** First (string) argument: selector, test id, role, label, text… */
  arg: string;
  /** Options object literal, when present ({ name } / { hasText }). */
  options?: { name?: string; hasText?: string; exact?: boolean };
}

const SUPPORTED_METHODS: ReadonlySet<string> = new Set([
  'getByTestId',
  'getByRole',
  'getByLabel',
  'getByPlaceholder',
  'getByText',
  'locator',
]);

/** Scan a single-quoted JS string literal starting at `start` (the quote). */
function scanString(src: string, start: number): { value: string; end: number } | null {
  if (src[start] !== "'") return null;
  let out = '';
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === undefined) return null;
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else out += next; // \' \\ and any other escaped char verbatim
      i += 2;
      continue;
    }
    if (ch === "'") return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  return null;
}

function skipWs(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i])) i += 1;
  return i;
}

/** Scan `{ key: 'value', ... }` with string/boolean values only. */
function scanOptions(
  src: string,
  start: number,
): { value: Record<string, string | boolean>; end: number } | null {
  let i = skipWs(src, start);
  if (src[i] !== '{') return null;
  i = skipWs(src, i + 1);
  const out: Record<string, string | boolean> = {};
  while (i < src.length && src[i] !== '}') {
    const keyMatch = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (!keyMatch) return null;
    const key = keyMatch[0];
    i = skipWs(src, i + key.length);
    if (src[i] !== ':') return null;
    i = skipWs(src, i + 1);
    if (src[i] === "'") {
      const str = scanString(src, i);
      if (!str) return null;
      out[key] = str.value;
      i = str.end;
    } else if (src.startsWith('true', i)) {
      out[key] = true;
      i += 4;
    } else if (src.startsWith('false', i)) {
      out[key] = false;
      i += 5;
    } else {
      return null;
    }
    i = skipWs(src, i);
    if (src[i] === ',') i = skipWs(src, i + 1);
  }
  if (src[i] !== '}') return null;
  return { value: out, end: i + 1 };
}

export function parseLocatorExpression(expression: string): ParsedLocator | null {
  const src = String(expression || '').trim();
  const head = /^page\.([A-Za-z]+)\(/.exec(src);
  if (!head || !SUPPORTED_METHODS.has(head[1])) return null;
  const method = head[1] as LocatorMethod;

  let i = head[0].length;
  i = skipWs(src, i);
  const first = scanString(src, i);
  if (!first) return null;
  i = skipWs(src, first.end);

  let options: ParsedLocator['options'];
  if (src[i] === ',') {
    const opts = scanOptions(src, i + 1);
    if (!opts) return null;
    options = {};
    if (typeof opts.value.name === 'string') options.name = opts.value.name;
    if (typeof opts.value.hasText === 'string') options.hasText = opts.value.hasText;
    if (typeof opts.value.exact === 'boolean') options.exact = opts.value.exact;
    i = skipWs(src, opts.end);
  }

  if (src[i] !== ')') return null;
  i = skipWs(src, i + 1);
  // Nothing may follow the call (no chains are emitted by the compiler).
  if (i !== src.length && src.slice(i) !== ';') return null;

  return { method, arg: first.value, options };
}
