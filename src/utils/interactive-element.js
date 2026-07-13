/**
 * Shared helpers to resolve the REAL interactive element behind a user
 * interaction and to give it a usable name.
 *
 * Clicks land on the deepest node of the composed path (an icon's <svg> or
 * <path>), which has no text and yields a positional selector. Both the click
 * listener (events.js) and the ElementMapper (element-mapper.js) need the same
 * answer to "which control did the user actually activate?" — this module is
 * the single source of truth for that.
 *
 * All checks are structural (no `el.matches`) so the helpers can be unit-tested
 * with plain fake objects under `node --test`.
 */

const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'combobox']);

/** CSS selector used by the ElementMapper's periodic scan. */
export const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[data-testid]',
  '[data-test-id]',
].join(', ');

function attr(el, name) {
  try {
    return el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
  } catch {
    return null;
  }
}

/** Structural equivalent of INTERACTIVE_SELECTOR for a single element. */
export function isInteractiveElement(el) {
  const tag = el && el.tagName ? String(el.tagName).toLowerCase() : null;
  if (!tag) return false;
  if (['button', 'select', 'textarea', 'summary'].includes(tag)) return true;
  if (tag === 'input') return attr(el, 'type') !== 'hidden';
  if (tag === 'a') return !!attr(el, 'href');
  const role = attr(el, 'role');
  if (role && INTERACTIVE_ROLES.has(String(role).toLowerCase())) return true;
  if (attr(el, 'data-testid') || attr(el, 'data-test-id')) return true;
  return false;
}

/**
 * Walk the event's composedPath (deepest node first) and return the first
 * interactive element, or null. Stops at body/html — a click that bubbles that
 * far without hitting a control was not on a control.
 */
export function resolveInteractiveTarget(path, maxDepth = 10) {
  if (!path || typeof path.length !== 'number') return null;
  const limit = Math.min(path.length, maxDepth);
  for (let i = 0; i < limit; i++) {
    const node = path[i];
    const tag = node && node.tagName ? String(node.tagName).toLowerCase() : null;
    if (!tag) continue; // text nodes, shadow roots, window/document
    if (tag === 'body' || tag === 'html') break;
    if (isInteractiveElement(node)) return node;
  }
  return null;
}

/**
 * Last usable pathname segment of a href — the only name an icon-only link
 * offers ('/notification-templates/?x=1' → 'notification-templates').
 * Returns null for fragment-only and pseudo-protocol hrefs.
 */
export function nameFromHref(href) {
  if (!href) return null;
  const value = String(href);
  if (value.startsWith('#')) return null;
  if (/^(javascript|mailto|tel):/i.test(value)) return null;
  const path = value.split(/[?#]/)[0] || '';
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Simplified accessible-name resolution:
 * aria-label → aria-labelledby → textContent → title → descendant img[alt] →
 * name derived from href. Returns '' when nothing is available.
 */
export function getAccessibleLabel(el, maxLength = 100) {
  const clean = (v) => (v ? String(v).replace(/\s+/g, ' ').trim().slice(0, maxLength) : '');

  const aria = clean(attr(el, 'aria-label'));
  if (aria) return aria;

  const labelledby = attr(el, 'aria-labelledby');
  if (labelledby && typeof document !== 'undefined') {
    const text = String(labelledby)
      .split(/\s+/)
      .map((id) => {
        const ref = document.getElementById(id);
        return ref && ref.textContent ? ref.textContent : '';
      })
      .join(' ');
    const resolved = clean(text);
    if (resolved) return resolved;
  }

  const text = clean(el && el.textContent);
  if (text) return text;

  const title = clean(attr(el, 'title'));
  if (title) return title;

  try {
    const img = el && typeof el.querySelector === 'function' ? el.querySelector('img[alt]') : null;
    const alt = clean(img && img.getAttribute('alt'));
    if (alt) return alt;
  } catch {
    // querySelector unavailable on fakes/odd nodes
  }

  return clean(nameFromHref(attr(el, 'href')));
}
