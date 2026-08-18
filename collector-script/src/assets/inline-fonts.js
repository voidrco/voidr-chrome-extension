import { state } from '../state.js';

/**
 * Record-time icon-font inlining.
 *
 * WHY: self-hosted icon fonts (FontAwesome / Material / custom) are referenced
 * from CSS as `@font-face { src: url(/assets/fonts/fa-solid.woff2) }`. rrweb's
 * `inlineStylesheet` embeds the CSS *text* (so the @font-face rule travels in the
 * snapshot) but NOT the font binary, and `collectFonts` only records the url
 * string. At replay the iframe lives on the Voidr origin under a strict CSP
 * (font-src 'self' https://fonts.gstatic.com data:), so the original
 * relative/cross-origin url() 404s or is blocked → glyphs render as tofu (□).
 *
 * rrweb 2.x — both the pinned 2.0.0-alpha.18 AND 2.1.0 — does NOT expose a
 * `captureAssets` record option (verified against the installed type defs: only
 * inlineStylesheet/collectFonts/inlineImages exist), so we cannot delegate asset
 * inlining to rrweb. Instead we do it ourselves, ONCE, just before recording
 * starts: scan the document stylesheets for @font-face url() sources, fetch the
 * SAME-ORIGIN ones, convert them to base64 `data:` URIs and inject a single
 * <style data-voidr-inlined-fonts> with rewritten @font-face rules. Because that
 * style is in the DOM before the FullSnapshot, rrweb captures the data: URIs,
 * which render fine under the replay CSP. Declared last, these rules win the
 * cascade over the original (unreachable) ones for the same family/weight/style.
 *
 * Safety: same-origin fonts are fetched with credentials; cross-origin fonts
 * are fetched anonymously in CORS mode (browsers ALREADY require CORS for CSS
 * fonts, so any font a page renders is CORS-readable — Google Fonts, CDNs,
 * FontAwesome all send ACAO:*). Hard caps on count/size, per-fetch + total time
 * budget, and the whole thing is best-effort (never throws into the record
 * path). Disable via config `inlineFonts: false`.
 */

const FONT_MIME = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
};

const MAX_FONTS = 4;
const MAX_FONT_BYTES = 256 * 1024;
const MAX_TOTAL_FONT_BYTES = 1024 * 1024;
const TOTAL_BUDGET_MS = 1500;
const PER_FETCH_MS = 1000;

function extensionOf(url) {
  const clean = url.split('?')[0].split('#')[0];
  const m = clean.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

function formatKeyword(ext) {
  switch (ext) {
    case 'woff2':
      return 'woff2';
    case 'woff':
      return 'woff';
    case 'ttf':
      return 'truetype';
    case 'otf':
      return 'opentype';
    case 'eot':
      return 'embedded-opentype';
    default:
      return undefined;
  }
}

/** Collect CSSFontFaceRule objects from all readable stylesheets. */
function collectFontFaceRules() {
  const out = [];
  const sheets = Array.from(document.styleSheets || []);
  for (const sheet of sheets) {
    let cssRules;
    try {
      cssRules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet without CORS — not readable
    }
    if (!cssRules) continue;
    for (const rule of Array.from(cssRules)) {
      // 5 === CSSRule.FONT_FACE_RULE
      if (rule.type === 5 && rule.style) {
        out.push({ rule, baseHref: sheet.href || document.baseURI || window.location.href });
        if (out.length >= 64) return out;
      }
    }
  }
  return out;
}

/** Extract the url() targets from a `src:` descriptor value, in order. */
function parseSrcUrls(srcValue) {
  const urls = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m;
  while ((m = re.exec(srcValue))) {
    urls.push(m[2].trim());
  }
  return urls;
}

function bufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function readFontBuffer(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (contentLength > MAX_FONT_BYTES) return null;
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength <= MAX_FONT_BYTES ? buffer : null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += chunk.byteLength;
    if (total > MAX_FONT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function fetchFontAsDataUri(
  absUrl,
  crossOrigin,
  { signal, deadline = Date.now() + TOTAL_BUDGET_MS } = {},
) {
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0 || signal?.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(PER_FETCH_MS, remainingMs));
  try {
    // Cross-origin fonts must be CORS-readable to render at all (per CSS spec),
    // so an anonymous CORS fetch normally hits the browser cache and succeeds.
    const res = await fetch(
      absUrl,
      crossOrigin
        ? { mode: 'cors', credentials: 'omit', signal: controller.signal }
        : { credentials: 'same-origin', signal: controller.signal },
    );
    if (!res.ok) return null;
    const buffer = await readFontBuffer(res);
    if (!buffer) return null;
    const ext = extensionOf(absUrl);
    const mime = FONT_MIME[ext] || 'application/octet-stream';
    return {
      dataUri: `data:${mime};base64,${bufferToBase64(buffer)}`,
      ext,
      bytes: buffer.byteLength,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Fetch same-origin @font-face sources and inject a <style> with data: URIs so
 * they survive the replay CSP. Best-effort; returns the number of fonts inlined.
 */
export async function inlineIconFonts(
  lifecycleId = state.lifecycleId,
  signal = null,
  deadline = Date.now() + TOTAL_BUDGET_MS,
) {
  try {
    if (typeof document === 'undefined' || typeof fetch !== 'function') return 0;
    if (state.config?.inlineFonts !== true) return 0;
    if (document.querySelector('[data-voidr-inlined-fonts]')) return 0;

    const isCurrent = () =>
      state.lifecycleId === lifecycleId && !state.forceStop && !state.isPaused && !signal?.aborted;
    const faceRules = collectFontFaceRules();
    if (faceRules.length === 0) return 0;

    const cache = new Map();
    const generated = [];
    let totalBytes = 0;

    for (const { rule, baseHref } of faceRules) {
      if (generated.length >= MAX_FONTS) break;
      if (!isCurrent() || Date.now() >= deadline) break;

      const style = rule.style;
      const src = style.getPropertyValue('src');
      if (!src) continue;

      // Pick the first not-yet-inlined url(), preferring SAME-ORIGIN sources.
      // Skip the rule entirely if it already has a data:/blob: source (nothing
      // to do). Cross-origin sources are kept as a fallback and fetched in
      // anonymous CORS mode (see fetchFontAsDataUri).
      let chosenSameOrigin = null;
      let chosenCrossOrigin = null;
      let alreadyInline = false;
      for (const raw of parseSrcUrls(src)) {
        if (/^(data:|blob:)/i.test(raw)) {
          alreadyInline = true;
          break;
        }
        let abs;
        try {
          abs = new URL(raw, baseHref);
        } catch {
          continue;
        }
        if (abs.origin === window.location.origin) {
          chosenSameOrigin = abs.href;
          break;
        }
        if (!chosenCrossOrigin && /^https?:$/.test(abs.protocol)) {
          chosenCrossOrigin = abs.href;
        }
      }
      const chosen = chosenSameOrigin || chosenCrossOrigin;
      if (alreadyInline || !chosen) continue;
      let fetched = cache.get(chosen);
      if (fetched === undefined) {
        fetched = await fetchFontAsDataUri(chosen, !chosenSameOrigin, { signal, deadline });
        cache.set(chosen, fetched || null);
        if (fetched) {
          if (totalBytes + fetched.bytes > MAX_TOTAL_FONT_BYTES) break;
          totalBytes += fetched.bytes;
        }
      }
      if (!fetched || !isCurrent()) continue;

      const family = style.getPropertyValue('font-family');
      const weight = style.getPropertyValue('font-weight');
      const fontStyle = style.getPropertyValue('font-style');
      const unicodeRange = style.getPropertyValue('unicode-range');
      const fmt = formatKeyword(fetched.ext);
      const decls = [
        family ? `font-family: ${family};` : '',
        weight ? `font-weight: ${weight};` : '',
        fontStyle ? `font-style: ${fontStyle};` : '',
        unicodeRange ? `unicode-range: ${unicodeRange};` : '',
        `src: url(${fetched.dataUri})${fmt ? ` format('${fmt}')` : ''};`,
        'font-display: swap;',
      ]
        .filter(Boolean)
        .join(' ');
      generated.push(`@font-face { ${decls} }`);
    }

    if (generated.length === 0) return 0;
    if (!isCurrent() || document.querySelector('[data-voidr-inlined-fonts]')) return 0;

    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-voidr-inlined-fonts', String(generated.length));
    styleEl.textContent = generated.join('\n');
    (document.head || document.documentElement).appendChild(styleEl);
    state.inlinedAssetNodes.push(styleEl);
    return generated.length;
  } catch {
    return 0; // never block/break recording
  }
}
