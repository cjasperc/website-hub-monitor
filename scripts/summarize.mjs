// Turns one Lighthouse 13 report into the fields the hub stores, plus the failing audits per category.
const round = (n, d = 2) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const pct = (c) => (c && c.score != null ? Math.round(c.score * 100) : null);
const SKIP_MODES = ['manual', 'notApplicable', 'informative'];
const SKIP_GROUPS = ['metrics', 'hidden'];

function findSnippet(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return '';
  if (o.type === 'node' && o.snippet) return o.snippet;
  for (const v of Object.values(o)) {
    const s = findSnippet(v, depth + 1);
    if (s) return s;
  }
  return '';
}

// The file name at the end of a URL, without its query, so reports show "hero.mp4", not a long link.
function fileName(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.host).slice(0, 80);
  } catch {
    return String(url || '').slice(0, 80);
  }
}

// Where the bytes go: every request grouped by file name, with names that differ only by a
// number before the extension (frame_0116.webp, frame_0117.webp) as one group "frame_*.webp".
function heaviest(requests) {
  const groups = new Map();
  for (const it of requests) {
    const name = fileName(it.url);
    const key = name.replace(/\d+(?=\.[a-z0-9]+$)/i, '*');
    const g = groups.get(key) || { name, count: 0, bytes: 0 };
    groups.set(key, { name: g.name, count: g.count + 1, bytes: g.bytes + (it.transferSize || 0) });
  }
  return [...groups].sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 5)
    .map(([key, g]) => ({ file: g.count > 1 ? key : g.name, count: g.count, kib: Math.round(g.bytes / 1024) }));
}

// Audits that count against a category, as PageSpeed lists them.
function failingAudits(lhr, category) {
  return (lhr.categories[category]?.auditRefs || [])
    .filter((ref) => !SKIP_GROUPS.includes(ref.group))
    .map((ref) => ({ ref, audit: lhr.audits[ref.id] }))
    .filter(({ audit }) => audit && audit.score !== null && audit.score < 0.9 && !SKIP_MODES.includes(audit.scoreDisplayMode));
}

// Estimated saving of a speed audit: time first (worst of LCP, FCP, TBT, INP), then bytes.
function saving(audit) {
  const m = audit.metricSavings || {};
  const ms = Math.max(0, ...['LCP', 'FCP', 'TBT', 'INP'].map((k) => (Number.isFinite(m[k]) ? m[k] : 0)), audit.details?.overallSavingsMs || 0);
  const kib = /([\d,.]+)\s*KiB/i.exec(audit.displayValue || '');
  const bytes = audit.details?.overallSavingsBytes || (kib ? Number(kib[1].replace(/,/g, '')) * 1024 : 0);
  return { ms, bytes };
}

export function summarize(lhr) {
  const a = lhr.audits;
  const c = lhr.categories;
  const value = (id) => a[id]?.numericValue;

  const opportunities = failingAudits(lhr, 'performance')
    .filter(({ ref, audit }) => ['insights', 'diagnostics'].includes(ref.group) && /^Est savings/i.test(audit.displayValue || ''))
    .map(({ audit }) => ({ id: audit.id, title: audit.title, saving: audit.displayValue.replace(/^Est savings of\s*/i, ''), ...saving(audit) }))
    .sort((x, y) => y.ms - x.ms || y.bytes - x.bytes);

  const failing = {};
  for (const cat of ['performance', 'accessibility', 'best-practices', 'seo']) {
    failing[cat] = failingAudits(lhr, cat).slice(0, 15).map(({ audit }) => ({ id: audit.id, title: audit.title, display: audit.displayValue || '' }));
  }

  return {
    checkedAt: lhr.fetchTime,
    lighthouse: lhr.lighthouseVersion,
    finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || '',
    speed: pct(c.performance),
    accessibility: pct(c.accessibility),
    best_practices: pct(c['best-practices']),
    seo: pct(c.seo),
    fcp_s: round(value('first-contentful-paint') / 1000),
    lcp_s: round(value('largest-contentful-paint') / 1000),
    si_s: round(value('speed-index') / 1000),
    tbt_ms: value('total-blocking-time') == null ? null : Math.round(value('total-blocking-time')),
    cls: round(value('cumulative-layout-shift'), 3),
    payload_kib: value('total-byte-weight') == null ? null : Math.round(value('total-byte-weight') / 1024),
    requests: a['network-requests']?.details?.items?.length ?? null,
    fix_first: opportunities[0]?.title || '',
    fix_saving: opportunities[0]?.saving || '',
    opportunities: opportunities.slice(0, 6).map(({ id, title, saving: s }) => ({ id, title, saving: s })),
    seo_issues: failing.seo.map((x) => x.title).join('; '),
    lcp_element: findSnippet(a['lcp-breakdown-insight']?.details).slice(0, 200),
    heaviest: heaviest(a['network-requests']?.details?.items || []),
    failing,
  };
}
