import { state } from '../state.js';

/**
 * Record-time inlining of UNREADABLE cross-origin stylesheets.
 *
 * WHY: rrweb's `inlineStylesheet: true` embeds a stylesheet's text in the
 * snapshot by reading `sheet.cssRules` — which throws for cross-origin
 * <link rel=stylesheet> without `crossorigin="anonymous"` (a Chrome security
 * restriction). Those sheets travel in the snapshot only as an external URL
 * that the replay iframe (Voidr origin, strict CSP `style-src 'self'
 * 'unsafe-inline'`) can never load → the layout renders unstyled.
 *
 * Fix (record-side, mirrors OpenReplay's `inlineCss` tracker option): for each
 * stylesheet whose rules are NOT readable, fetch its text with an anonymous
 * CORS request (usually a browser-cache hit), inline its @import'ed sheets
 * recursively (they would be CSP-blocked in the replay iframe), rewrite the
 * remaining relative url()/@import references to absolute against the
 * response's POST-REDIRECT URL, and inject the result as a
 * <style data-voidr-inlined-css> right AFTER the <link> so the cascade order
 * is preserved. Because the <style> is in the DOM before the FullSnapshot,
 * rrweb captures its text and the replay renders the layout even when the
 * external CSS is unreachable.
 *
 * Safety: anonymous CORS fetch only (no credentials), hard caps on count/size,
 * per-fetch + total time budget, best-effort (never throws into the record
 * path). Disable via config `inlineStylesheets: false`.
 */

const MAX_SHEETS = 12; // cap distinct stylesheets inlined per session
const MAX_CSS_BYTES = 1024 * 1024; // skip anything larger than 1MB
const TOTAL_BUDGET_MS = 3000; // overall wall-clock budget
const PER_FETCH_MS = 2000; // per-sheet fetch timeout
const IMPORT_DEPTH = 2; // max @import nesting inlined recursively

/** True when the sheet's rules can be read by rrweb (same-origin or CORS-ok). */
function isReadable(sheet) {
  try {
    // Accessing cssRules throws SecurityError on unreadable cross-origin sheets.
    void sheet.cssRules;
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite relative url(...) and @import references to absolute URLs against
 * the stylesheet's own href so they still resolve when the text is inlined
 * into the page (and later replayed from a different origin).
 */
export function absolutizeCssUrls(cssText, baseHref) {
  const rewriteTarget = (target) => {
    const trimmed = target.trim();
    if (/^(data:|blob:|https?:|#)/i.test(trimmed) || trimmed === '') return trimmed;
    try {
      return new URL(trimmed, baseHref).href;
    } catch {
      return trimmed;
    }
  };

  let out = cssText.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (_m, quote, target) => `url(${quote}${rewriteTarget(target)}${quote})`,
  );
  // @import "foo.css" (the url(...) form is already covered above).
  out = out.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (_m, quote, target) => `@import ${quote}${rewriteTarget(target)}${quote}`,
  );
  return out;
}

/**
 * Fetch a stylesheet's text. Returns `{ text, baseUrl }` (or null): `baseUrl`
 * is the response's POST-REDIRECT url (`res.url`), which is the correct base
 * for resolving the sheet's relative url()/@import refs — resolving against
 * the original href would break when the request was redirected (e.g.
 * `/styles.css` → CDN).
 */
async function fetchCssText(href) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_FETCH_MS);
  try {
    const res = await fetch(href, {
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.length > MAX_CSS_BYTES) return null;
    return { text, baseUrl: res.url || href };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Inline @import'ed sheets recursively (depth/time-capped). Absolutizing the
 * @import alone is NOT enough for replay: the replay iframe runs under
 * `style-src 'self' 'unsafe-inline'`, so an external @import inside an inlined
 * <style> never loads. Each imported sheet is fetched (anonymous CORS), its
 * own imports inlined, its url() refs absolutized against ITS response URL,
 * and the text substituted in place (wrapped in `@media` when the @import had
 * a media list). Unreachable imports are left for absolutizeCssUrls — the
 * documented graceful degradation (external URL, blocked by the replay CSP,
 * same as before this fix).
 */
export async function inlineCssImports(cssText, baseHref, deadline, depth = 0, fetchImpl = fetchCssText) {
  if (depth >= IMPORT_DEPTH) return cssText;
  const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi;
  let out = cssText;
  const matches = [...cssText.matchAll(importRe)];
  for (const m of matches) {
    if (typeof deadline === 'number' && Date.now() > deadline) break;
    const target = (m[2] || m[4] || '').trim();
    if (!target || /^(data:|blob:|#)/i.test(target)) continue;
    let abs;
    try {
      abs = new URL(target, baseHref).href;
    } catch {
      continue;
    }
    const fetched = await fetchImpl(abs);
    if (!fetched) continue;
    const nested = await inlineCssImports(fetched.text, fetched.baseUrl, deadline, depth + 1, fetchImpl);
    const body = absolutizeCssUrls(nested, fetched.baseUrl);
    const media = (m[5] || '').trim();
    out = out.replace(m[0], media ? `@media ${media} { ${body} }` : body);
  }
  return out;
}

/**
 * Inline unreadable cross-origin stylesheets as <style> tags BEFORE recording
 * starts. Best-effort; returns the number of stylesheets inlined.
 */
export async function inlineUnreadableStylesheets() {
  try {
    if (typeof document === 'undefined' || typeof fetch !== 'function') return 0;
    if (state.config?.inlineStylesheets === false) return 0;

    const startedAt = Date.now();
    const sheets = Array.from(document.styleSheets || []);
    let inlined = 0;

    for (const sheet of sheets) {
      if (inlined >= MAX_SHEETS) break;
      if (Date.now() - startedAt > TOTAL_BUDGET_MS) break;

      const href = sheet.href;
      const owner = sheet.ownerNode;
      if (!href || !owner || isReadable(sheet)) continue;
      if (owner.getAttribute && owner.getAttribute('data-voidr-css-inlined')) continue;

      const fetched = await fetchCssText(href);
      if (!fetched) continue;

      const styleEl = document.createElement('style');
      styleEl.setAttribute('data-voidr-inlined-css', href);
      if (sheet.media && sheet.media.mediaText) {
        styleEl.setAttribute('media', sheet.media.mediaText);
      }
      // Base everything on the response's post-redirect URL, inline nested
      // @imports (replay CSP would block them), then absolutize what remains.
      const deadline = startedAt + TOTAL_BUDGET_MS;
      const withImports = await inlineCssImports(fetched.text, fetched.baseUrl, deadline);
      styleEl.textContent = absolutizeCssUrls(withImports, fetched.baseUrl);
      // Insert right after the <link> so cascade order (and thus specificity
      // ties) resolve exactly as the original sheet would.
      owner.parentNode?.insertBefore(styleEl, owner.nextSibling);
      owner.setAttribute && owner.setAttribute('data-voidr-css-inlined', '1');
      inlined += 1;
    }

    return inlined;
  } catch {
    return 0; // never block/break recording
  }
}
