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

/**
 * Generate a CSS selector for a DOM element, walking up to maxDepth ancestors.
 */
export function generateSelector(el, maxDepth = 6) {
  if (!el || maxDepth === 0) return '';
  const parts = [];
  let current = el;

  for (let i = 0; i < maxDepth && current && current.nodeType === 1; i++) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector += `#${current.id}`;
      parts.unshift(selector);
      break;
    } else {
      const siblings = Array.from(current.parentNode ? current.parentNode.children : []);
      const sameTag = siblings.filter((s) => s.tagName === current.tagName);

      if (sameTag.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-child(${index})`;
      }
    }

    parts.unshift(selector);
    current = current.parentElement;
  }

  return parts.join(' > ');
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
