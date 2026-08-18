export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Safe JSON.stringify that handles circular references.
 */
export function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}

// Attributes a test can rely on, in the order a human would pick them. A
// positional `nth-child` is the last resort: it breaks whenever the app
// reorders siblings.
const STABLE_ATTRIBUTES = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'name',
  'aria-label',
];

/**
 * Generate a CSS selector for a DOM element, walking up to maxDepth ancestors.
 *
 * The walk crosses shadow boundaries: inside a shadow root the top element has
 * no parentElement, so climbing by parentElement alone stopped there and
 * produced fragments like `span > slot`. Crossing to the host and marking the
 * boundary with `>>>` keeps the path complete and pierceable — Playwright and
 * the platform's own locator engine read that separator.
 */
export function generateSelector(el, maxDepth = 6) {
  if (!el || maxDepth === 0) return '';
  const parts = [];
  let current = el;
  // Tracks whether the step above `current` crosses a shadow boundary, so the
  // separator is decided when the parent part is unshifted.
  let separators = [];

  for (let i = 0; i < maxDepth && current && current.nodeType === 1; i++) {
    const selector = describeElement(current);
    parts.unshift(selector);

    if (current.id) break;

    const parent = current.parentElement;
    if (parent) {
      separators.unshift(' > ');
      current = parent;
      continue;
    }

    const host = shadowHost(current);
    if (!host) break;
    separators.unshift(' >>> ');
    current = host;
  }

  return parts.reduce(
    (path, part, index) => (index === 0 ? part : path + separators[index - 1] + part),
    '',
  );
}

function describeElement(el) {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;

  if (typeof el.getAttribute === 'function') {
    for (const attribute of STABLE_ATTRIBUTES) {
      const value = el.getAttribute(attribute);
      if (value) return `${tag}[${attribute}="${cssEscapeValue(value)}"]`;
    }
  }

  const siblings = Array.from(el.parentNode ? el.parentNode.children : []);
  const sameTag = siblings.filter((sibling) => sibling.tagName === el.tagName);
  if (sameTag.length > 1) {
    return `${tag}:nth-child(${siblings.indexOf(el) + 1})`;
  }
  return tag;
}

// The element that hosts the shadow root `el` lives in, when there is one.
function shadowHost(el) {
  const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
  const host = root && root !== el ? root.host : null;
  return host && host.nodeType === 1 ? host : null;
}

function cssEscapeValue(value) {
  return String(value).replace(/(["\\])/g, '\\$1');
}

/**
 * Extract text content from an element, trimmed and truncated to 100 chars.
 */
export function getTextContent(el) {
  return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * Throttle function execution to at most once per delay ms.
 */
export function throttle(fn, delay) {
  let lastCall = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      fn.apply(this, args);
      lastCall = now;
    }
  };
}

/**
 * Debounce function execution, resetting the timer on each call.
 */
export function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Truncate a string to maxLength, appending '...' if truncated.
 */
export function truncate(text, maxLength) {
  if (typeof text !== 'string') return '';
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}
