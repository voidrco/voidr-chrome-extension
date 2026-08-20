(function exposeVoidrLiveEvidenceInspector(root, factory) {
  const inspector = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = inspector;
  if (root) root.VoidrLiveEvidenceInspector = inspector;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLiveEvidenceInspector() {
  const VERSION = 'VOIDR-LIVE-CONTEXT/1';
  const CATEGORY_META = Object.freeze({
    pages: {
      label: 'Páginas',
      singular: 'Página',
      empty: 'As páginas visitadas aparecerão aqui.',
    },
    clicks: {
      label: 'Cliques',
      singular: 'Clique',
      empty: 'Os cliques do produto aparecerão aqui.',
    },
    requests: {
      label: 'Requests',
      singular: 'Request',
      empty: 'As requisições de rede aparecerão aqui.',
    },
    errors: {
      label: 'Erros',
      singular: 'Erro',
      empty: 'Nenhum erro foi observado até agora.',
    },
    notes: {
      label: 'Notas',
      singular: 'Nota',
      empty: 'Suas notas aparecerão aqui.',
    },
    voiceNotes: {
      label: 'Voz',
      singular: 'Nota de voz',
      empty: 'As notas de voz aparecerão aqui.',
    },
  });

  const asNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const compact = (value) => String(value ?? '').trim();

  function formatOffset(value) {
    const milliseconds = Math.max(0, asNumber(value) || 0);
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function formatDuration(value) {
    const milliseconds = asNumber(value);
    if (milliseconds == null) return '—';
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  }

  function formatBytes(value) {
    const bytes = asNumber(value);
    if (bytes == null) return '—';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function urlLabel(value) {
    const url = compact(value);
    if (!url) return 'URL indisponível';
    try {
      const parsed = new URL(url);
      return `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
    } catch {
      return url;
    }
  }

  function requestTone(item) {
    if (item.error || item.status == null) return item.error ? 'danger' : 'neutral';
    if (item.status >= 500) return 'danger';
    if (item.status >= 400) return 'warning';
    if (item.durationMs >= 2000) return 'warning';
    return 'success';
  }

  function itemPresentation(category, item = {}) {
    if (category === 'requests') {
      const status = item.status == null ? (item.error ? 'ERR' : '…') : String(item.status);
      return {
        title: urlLabel(item.url),
        eyebrow: `${compact(item.method) || 'GET'} · ${status}`,
        meta: [
          formatDuration(item.durationMs),
          item.contentType,
          item.thirdParty ? '3rd party' : '1st party',
        ]
          .filter(Boolean)
          .join(' · '),
        tone: requestTone(item),
      };
    }
    if (category === 'errors') {
      return {
        title: compact(item.message) || 'Erro sem mensagem',
        eyebrow: compact(item.plugin) || 'error',
        meta: [
          item.filename ? urlLabel(item.filename) : '',
          item.occurrence > 1 ? `×${item.occurrence}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        tone: 'danger',
      };
    }
    if (category === 'pages') {
      return {
        title: compact(item.title) || urlLabel(item.url),
        eyebrow: compact(item.trigger) || 'navigation',
        meta: urlLabel(item.url),
        tone: 'neutral',
      };
    }
    if (category === 'clicks') {
      return {
        title: compact(item.label) || compact(item.selector) || 'Elemento sem rótulo',
        eyebrow: [item.role, item.tag].filter(Boolean).join(' · ') || 'element',
        meta: effectSummary(item.effects),
        tone: item.effects && !hasAnyEffect(item.effects) ? 'warning' : 'neutral',
      };
    }
    return {
      title: compact(item.note) || (category === 'voiceNotes' ? 'Nota de voz' : 'Nota'),
      eyebrow: compact(item.kind) || compact(item.state) || CATEGORY_META[category]?.singular,
      meta: item.selector || item.pageUrl ? urlLabel(item.pageUrl) : '',
      tone: item.state === 'unavailable' ? 'warning' : 'neutral',
    };
  }

  function hasAnyEffect(effects) {
    if (!effects || typeof effects !== 'object') return false;
    return ['mutationMs', 'scrollMs', 'navMs', 'networkMs', 'selectionMs', 'visibilityMs'].some(
      (key) => effects[key] != null,
    );
  }

  function effectSummary(effects) {
    if (!effects || typeof effects !== 'object') return 'Aguardando efeito';
    const labels = [
      ['networkMs', 'request'],
      ['mutationMs', 'DOM'],
      ['navMs', 'navegação'],
      ['scrollMs', 'scroll'],
      ['selectionMs', 'seleção'],
    ]
      .filter(([key]) => effects[key] != null)
      .map(([, label]) => label);
    return labels.length ? `Efeito: ${labels.join(', ')}` : 'Sem efeito detectado';
  }

  function stringify(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function field(label, value, kind = 'text') {
    const normalized = stringify(value);
    return normalized ? { label, value: normalized, kind } : null;
  }

  function detailFields(category, item = {}) {
    const common = [
      field('Instante', formatOffset(item.offsetMs)),
      field('Evidence ID', item.id, 'code'),
      field('Página relacionada', item.pageRef, 'code'),
      field('Clique relacionado', item.clickRef, 'code'),
    ];
    let specific = [];
    if (category === 'requests') {
      specific = [
        field('URL', item.url, 'code'),
        field('Método', item.method),
        field(
          'Status',
          item.status == null
            ? item.error || 'Pendente'
            : `${item.status} ${item.statusText || ''}`,
        ),
        field('Duração', formatDuration(item.durationMs)),
        field(
          'Tamanho',
          `request ${formatBytes(item.requestSize)} · response ${formatBytes(item.responseSize)}`,
        ),
        field('Timing', item.timing, 'json'),
        field('Request headers', item.requestHeaders, 'json'),
        field('Request body · preview seguro', item.requestBodyPreview, 'json'),
        field('Response headers', item.responseHeaders, 'json'),
        field('Response body · preview seguro', item.responseBodyPreview, 'json'),
        field('GraphQL', item.graphql, 'json'),
        field('Trace ID', item.traceId, 'code'),
      ];
    } else if (category === 'errors') {
      specific = [
        field('Mensagem', item.message),
        field('Tipo', [item.name, item.plugin].filter(Boolean).join(' · ')),
        field('Origem', item.filename || item.blockedUrl, 'code'),
        field('Posição', item.position, 'code'),
        field('Diretiva', item.directive, 'code'),
        field('Ocorrência', item.occurrence),
        field('Stack', item.stack, 'code'),
      ];
    } else if (category === 'pages') {
      specific = [
        field('URL', item.url, 'code'),
        field('Título', item.title),
        field('Origem', item.from, 'code'),
        field('Trigger', item.trigger),
        field('Permanência', formatDuration(item.durationMs)),
      ];
    } else if (category === 'clicks') {
      specific = [
        field('Elemento', item.label),
        field('Role / tag', [item.role, item.tag].filter(Boolean).join(' · ')),
        field('Selector', item.selector, 'code'),
        field('Destino', item.href, 'code'),
        field('Posição', item.position, 'json'),
        field('Efeitos em até 2 s', item.effects, 'json'),
      ];
    } else {
      specific = [
        field(category === 'voiceNotes' ? 'Transcript' : 'Nota', item.note),
        field('Tipo', item.kind || item.state),
        field('Página', item.pageUrl, 'code'),
        field('Selector', item.selector, 'code'),
        field('Região', item.rect, 'json'),
        field('Assets', item.assetRefs, 'json'),
        field('Duração', formatDuration(item.durationMs)),
      ];
    }
    return [...specific, ...common].filter(Boolean);
  }

  function normalizeContext(context) {
    if (!context || context.version !== VERSION) return null;
    const counts = Object.fromEntries(
      Object.keys(CATEGORY_META).map((category) => [
        category,
        Math.max(0, Number(context.counts?.[category]) || 0),
      ]),
    );
    const categories = Object.fromEntries(
      Object.keys(CATEGORY_META).map((category) => [
        category,
        Array.isArray(context.categories?.[category]) ? context.categories[category] : [],
      ]),
    );
    return { ...context, counts, categories };
  }

  return {
    VERSION,
    CATEGORY_META,
    detailFields,
    effectSummary,
    formatBytes,
    formatDuration,
    formatOffset,
    itemPresentation,
    normalizeContext,
    requestTone,
    urlLabel,
  };
});
