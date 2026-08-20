/**
 * URL milestone → tolerant RegExp, ported verbatim from
 * voidr-hive/lib/replay/compiler.ts `urlMilestonePattern` so quick runs and
 * compiled specs agree on what counts as "arrived at the milestone".
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function urlMilestonePattern(url: string): RegExp {
  let host: string;
  let pathname: string;
  try {
    const u = new URL(url);
    host = u.host;
    pathname = u.pathname;
  } catch {
    return new RegExp(escapeRegExp(url));
  }
  const segments = pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return '[^/]+';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg))
        return '[^/]+';
      if (/^[0-9a-f]{24}$/i.test(seg)) return '[^/]+';
      return escapeRegExp(seg);
    })
    .join('/');
  const path = segments === '/' || segments === '' ? '/?' : `${segments}/?`;
  return new RegExp(`https?://${escapeRegExp(host)}${path}([?#].*)?$`);
}
