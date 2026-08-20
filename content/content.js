// Voidr Extension — Content Script
// Injects refocus button + handles session recording on pages

let lastCapturedSessionId = null;

// ── Font injection ───────────────────────────────────────────────────────────

try {
  const fontStyle = document.createElement('style');
  fontStyle.textContent = `
    .voidr-rec-panel, .voidr-rec-panel *, .voidr-rec-countdown,
    .voidr-onb-panel, .voidr-onb-panel *, .voidr-onb-done {
      font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, system-ui, sans-serif !important;
    }
  `;
  document.head.appendChild(fontStyle);
} catch (_) {}

// ── Initialization ───────────────────────────────────────────────────────────

async function initVoidrExtension() {
  try {
    createRefocusButton();
    ensureRefocusButtonPresent();

    if (!window.__voidr_refocus_check__) {
      window.__voidr_refocus_check__ = setInterval(() => {
        try {
          ensureRefocusButtonPresent();
        } catch (_) {}
      }, 3000);
    }
    ['visibilitychange', 'pageshow', 'focus', 'popstate', 'hashchange'].forEach((evt) => {
      try {
        window.addEventListener(evt, ensureRefocusButtonPresent, { passive: true });
      } catch (_) {}
    });

    // Keep the button inside the viewport (and correctly docked) on resize.
    if (!window.__voidr_fab_resize__) {
      window.__voidr_fab_resize__ = true;
      window.addEventListener(
        'resize',
        () => {
          try {
            const host = document.getElementById('voidr-refocus-host');
            if (!host) return;
            voidrStorageGet([VOIDR_FAB.posKey, VOIDR_FAB.hiddenKey]).then((state) => {
              if (state[VOIDR_FAB.hiddenKey]) renderDocked(host, host.dataset.side || 'right');
              else voidrApplyPosition(host, state[VOIDR_FAB.posKey]);
            });
          } catch (_) {}
        },
        { passive: true },
      );
    }
  } catch (error) {
    console.error('Error initializing Voidr Extension:', error);
  }
}

// ── Refocus Button (Shadow DOM, draggable + snap-to-edge) ────────────────────

const VOIDR_FAB = {
  size: 56,
  margin: 16,
  dragThreshold: 5,
  handleW: 9,
  handleH: 54,
  posKey: 'voidr_fab_pos', // { side: 'left' | 'right', topRatio: 0..1 }
  hiddenKey: 'voidr_fab_hidden', // boolean — docked to the edge as a thin handle
};

function voidrStorageGet(keys) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.storage?.local) return resolve({});
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    } catch (_) {
      resolve({});
    }
  });
}
function voidrStorageSet(obj) {
  try {
    if (chrome?.storage?.local) chrome.storage.local.set(obj);
  } catch (_) {}
}
function voidrClamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function voidrViewport() {
  return {
    w: window.innerWidth || document.documentElement.clientWidth || 0,
    h: window.innerHeight || document.documentElement.clientHeight || 0,
  };
}

function voidrApplyPosition(host, pos) {
  const { w, h } = voidrViewport();
  const side = pos && pos.side === 'left' ? 'left' : 'right';
  const left = side === 'left' ? VOIDR_FAB.margin : w - VOIDR_FAB.margin - VOIDR_FAB.size;
  const ratio = pos && typeof pos.topRatio === 'number' ? pos.topRatio : 1;
  const top = voidrClamp(ratio * h, VOIDR_FAB.margin, h - VOIDR_FAB.margin - VOIDR_FAB.size);
  host.style.width = VOIDR_FAB.size + 'px';
  host.style.height = VOIDR_FAB.size + 'px';
  host.style.left = Math.round(left) + 'px';
  host.style.top = Math.round(top) + 'px';
  host.style.right = 'auto';
  host.style.bottom = 'auto';
  host.dataset.side = side;
}

// First-run safety net: if the resting spot lands on an interactive element,
// nudge the button up so it never blocks a page control out of the box.
function voidrAutoDodge(host) {
  try {
    const r = host.getBoundingClientRect();
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 6, r.top + 6],
      [r.right - 6, r.bottom - 6],
    ];
    const interactive = 'button,a,input,textarea,select,[role="button"],[contenteditable="true"]';
    let hit = false;
    for (const [x, y] of pts) {
      const els = document.elementsFromPoint(x, y) || [];
      if (
        els.some((el) => el.id !== 'voidr-refocus-host' && el.closest && el.closest(interactive))
      ) {
        hit = true;
        break;
      }
    }
    if (hit) {
      const { h } = voidrViewport();
      const newTop = voidrClamp(
        r.top - 72,
        VOIDR_FAB.margin,
        h - VOIDR_FAB.margin - VOIDR_FAB.size,
      );
      host.style.top = Math.round(newTop) + 'px';
    }
  } catch (_) {}
}

// Collapse the FAB into a thin handle flush against the nearest edge.
function renderDocked(host, side) {
  try {
    const shadow = host.shadowRoot;
    if (!shadow) return;
    side = side === 'left' ? 'left' : 'right';
    host.dataset.side = side;
    const { w } = voidrViewport();
    const curTop = parseInt(host.style.top, 10) || VOIDR_FAB.margin;
    host.style.width = VOIDR_FAB.handleW + 'px';
    host.style.height = VOIDR_FAB.handleH + 'px';
    host.style.left = (side === 'left' ? 0 : w - VOIDR_FAB.handleW) + 'px';
    host.style.top = Math.round(curTop) + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';

    const wrap = shadow.querySelector('.wrap');
    if (wrap) wrap.remove();
    let handle = shadow.querySelector('.dock-handle');
    if (!handle) {
      handle = document.createElement('button');
      handle.className = 'dock-handle';
      handle.type = 'button';
      handle.setAttribute('aria-label', 'Reabrir Voidr Session Capture');
      handle.title = 'Reabrir Voidr Session Capture';
      handle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        voidrStorageSet({ [VOIDR_FAB.hiddenKey]: false });
        createRefocusButton(true);
      });
      shadow.appendChild(handle);
    }
    host.style.opacity = '1';
  } catch (_) {}
}

function createRefocusButton(forceShow) {
  try {
    const oldHost = document.getElementById('voidr-refocus-host');
    if (oldHost) oldHost.remove();

    const host = document.createElement('div');
    host.id = 'voidr-refocus-host';
    host.style.position = 'fixed';
    host.style.left = '-9999px'; // parked off-screen until stored state loads (no flash)
    host.style.top = '0px';
    host.style.zIndex = '2147483000'; // below the recording overlays (…646/647)
    host.style.width = VOIDR_FAB.size + 'px';
    host.style.height = VOIDR_FAB.size + 'px';
    host.style.pointerEvents = 'none'; // FIX: host no longer eats clicks; only the circle does
    host.style.opacity = '0';
    host.style.transition = 'opacity .18s ease';
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap { position: relative; width: ${VOIDR_FAB.size}px; height: ${VOIDR_FAB.size}px; pointer-events: none; }
      .fab {
        position: absolute; inset: 0; margin: 0; padding: 0;
        display: inline-flex; align-items: center; justify-content: center;
        width: ${VOIDR_FAB.size}px; height: ${VOIDR_FAB.size}px; border-radius: 50%;
        background: radial-gradient(120% 120% at 30% 24%, #2b2b2f 0%, #050505 72%);
        color: #fff; border: 1px solid rgba(255,255,255,0.16);
        box-shadow: 0 8px 22px rgba(0,0,0,0.42), 0 2px 6px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.10);
        cursor: grab; pointer-events: auto; touch-action: none;
        -webkit-tap-highlight-color: transparent;
        transition: transform .16s cubic-bezier(.2,.7,.3,1), box-shadow .16s ease;
      }
      .fab:hover { transform: scale(1.06); box-shadow: 0 14px 32px rgba(0,0,0,0.5), 0 0 0 4px rgba(255,255,255,0.06); }
      .fab:focus-visible { outline: none; box-shadow: 0 10px 28px rgba(0,0,0,0.5), 0 0 0 3px rgba(99,102,241,0.7); }
      .fab:active { cursor: grabbing; transform: scale(0.96); }
      .wrap.dragging .fab { transition: none; cursor: grabbing; transform: scale(1.1); box-shadow: 0 22px 46px rgba(0,0,0,0.6); }
      .fab svg { width: 26px; height: 26px; display: block; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.4)); pointer-events: none; }

      .label {
        position: absolute; top: 50%; transform: translateY(-50%) scale(0.96);
        white-space: nowrap; font-family: 'Space Grotesk', -apple-system, system-ui, sans-serif;
        font-size: 12.5px; font-weight: 600; letter-spacing: .2px; color: #fff;
        background: rgba(10,10,12,0.92); border: 1px solid rgba(255,255,255,0.14);
        padding: 7px 11px; border-radius: 10px; pointer-events: none;
        box-shadow: 0 8px 22px rgba(0,0,0,0.4); opacity: 0;
        transition: opacity .16s ease, transform .16s ease;
      }
      :host([data-side="right"]) .label { right: ${VOIDR_FAB.size + 10}px; }
      :host([data-side="left"])  .label { left:  ${VOIDR_FAB.size + 10}px; }
      .wrap:not(.dragging):hover .label { opacity: 1; transform: translateY(-50%) scale(1); }

      .dock {
        position: absolute; top: -4px; right: -4px; width: 20px; height: 20px; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        background: #1a1a1e; color: #d1d5db; border: 1px solid rgba(255,255,255,0.18);
        cursor: pointer; pointer-events: auto; opacity: 0; transform: scale(0.7);
        transition: opacity .14s ease, transform .14s ease, background .14s ease;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      }
      :host([data-side="left"]) .dock { right: auto; left: -4px; }
      .wrap:not(.dragging):hover .dock { opacity: 1; transform: scale(1); }
      .dock:hover { background: #2a2a30; color: #fff; }
      .dock svg { width: 11px; height: 11px; }

      .dock-handle {
        position: absolute; inset: 0; display: block; margin: 0; padding: 0;
        cursor: pointer; pointer-events: auto;
        background: radial-gradient(120% 120% at 30% 24%, #2b2b2f 0%, #050505 72%);
        border: 1px solid rgba(255,255,255,0.16);
        box-shadow: 0 6px 18px rgba(0,0,0,0.4);
      }
      :host([data-side="right"]) .dock-handle { border-radius: 8px 0 0 8px; border-right: none; }
      :host([data-side="left"])  .dock-handle { border-radius: 0 8px 8px 0; border-left: none; }
      .dock-handle:hover { background: #17171b; }
      .dock-handle::before {
        content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 3px; height: 22px; border-radius: 3px; background: rgba(255,255,255,0.55);
      }

      @media (prefers-reduced-motion: reduce) {
        .fab, .label, .dock { transition: none; }
      }
    `;

    const logoSvg = `
      <svg viewBox="0 0 4521 4521" xmlns="http://www.w3.org/2000/svg" fill="#fff" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M2260.5 4521C3508.94 4521 4521 3508.94 4521 2260.49C4521 1012.06 3508.94 0 2260.5 0C1012.06 0 0 1012.06 0 2260.49C0 3508.94 1012.06 4521 2260.5 4521ZM3334.24 2024.28C3334.24 2154.74 3228.47 2260.49 3098.02 2260.49H2504.44C2373.99 2260.49 2268.22 2366.26 2268.22 2496.72V3098.01C2268.22 3228.48 2162.46 3334.24 2032.01 3334.24H1422.98C1292.52 3334.24 1186.76 3228.48 1186.76 3098.01V2496.72C1186.76 2366.26 1292.52 2260.49 1422.98 2260.49H2016.56C2147.01 2260.49 2252.78 2154.74 2252.78 2024.28V1422.99C2252.78 1292.52 2358.53 1186.76 2488.99 1186.76H3098.02C3228.47 1186.76 3334.24 1292.52 3334.24 1422.99V2024.28Z"/>
      </svg>`;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <button class="fab" type="button" aria-label="Abrir Voidr Session Capture" title="Voidr Session Capture — arraste para mover">
        ${logoSvg}
      </button>
      <span class="label">Voidr Session Capture</span>
      <button class="dock" type="button" aria-label="Recolher para a borda" title="Recolher para a borda">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    `;
    shadow.appendChild(style);
    shadow.appendChild(wrap);

    const btn = wrap.querySelector('.fab');
    const dockBtn = wrap.querySelector('.dock');

    // Open the assistant popup — only on a genuine click, never after a drag.
    function openAssistant() {
      try {
        if (!chrome.runtime?.id) {
          window.location.reload();
          return;
        }
        const rect = host.getBoundingClientRect();
        const left = Math.round(rect.left + window.screenX - (420 - rect.width));
        const top = Math.round(rect.top + window.screenY - 550);
        chrome.runtime.sendMessage({ action: 'focusOrOpenPopup', position: { left, top } }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[Voidr] Could not open popup:', chrome.runtime.lastError.message);
            window.location.reload();
          }
        });
      } catch (e) {
        window.location.reload();
      }
    }

    // Drag + snap-to-edge.
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let offX = 0;
    let offY = 0;

    function onPointerDown(e) {
      if (e.button != null && e.button !== 0) return;
      const rect = host.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      moved = false;
      dragging = true;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (_) {}
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp, { passive: true });
    }
    function onPointerMove(e) {
      if (!dragging) return;
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < VOIDR_FAB.dragThreshold)
        return;
      if (!moved) {
        moved = true;
        wrap.classList.add('dragging');
      }
      e.preventDefault();
      const { w, h } = voidrViewport();
      const left = voidrClamp(
        e.clientX - offX,
        VOIDR_FAB.margin,
        w - VOIDR_FAB.margin - VOIDR_FAB.size,
      );
      const top = voidrClamp(
        e.clientY - offY,
        VOIDR_FAB.margin,
        h - VOIDR_FAB.margin - VOIDR_FAB.size,
      );
      host.style.left = Math.round(left) + 'px';
      host.style.top = Math.round(top) + 'px';
    }
    function onPointerUp() {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      dragging = false;
      wrap.classList.remove('dragging');
      if (!moved) {
        openAssistant();
        return;
      }
      // Snap to the nearest horizontal edge; remember vertical position as a ratio.
      const { w, h } = voidrViewport();
      const rect = host.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      const side = center < w / 2 ? 'left' : 'right';
      const topRatio = voidrClamp(rect.top / h, 0, 1);
      // Ease the snap instead of teleporting. The transition lives only for the
      // glide (host normally has no left/top transition, keeping the drag 1:1).
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      if (!reduceMotion) {
        host.style.transition =
          'opacity .18s ease, left .32s cubic-bezier(.22,.88,.26,1.08), top .32s cubic-bezier(.22,.88,.26,1.08)';
        host.addEventListener(
          'transitionend',
          () => {
            host.style.transition = 'opacity .18s ease';
          },
          { once: true },
        );
      }
      voidrApplyPosition(host, { side, topRatio });
      voidrStorageSet({ [VOIDR_FAB.posKey]: { side, topRatio } });
    }

    btn.addEventListener('pointerdown', onPointerDown);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openAssistant();
      }
    });

    dockBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    dockBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      voidrStorageSet({ [VOIDR_FAB.hiddenKey]: true });
      renderDocked(host, host.dataset.side || 'right');
    });

    // Restore saved state (position + docked), then reveal to avoid a flash.
    voidrStorageGet([VOIDR_FAB.posKey, VOIDR_FAB.hiddenKey]).then((state) => {
      const pos = state[VOIDR_FAB.posKey];
      voidrApplyPosition(host, pos);
      if (!pos) voidrAutoDodge(host); // only fuss with collisions on first run
      if (!forceShow && state[VOIDR_FAB.hiddenKey]) {
        renderDocked(host, host.dataset.side || 'right');
      }
      host.style.opacity = '1';
    });
  } catch (e) {}
}

function ensureRefocusButtonPresent() {
  try {
    if (!document.getElementById('voidr-refocus-host')) createRefocusButton();
  } catch (_) {}
}

// ── Session Recording ────────────────────────────────────────────────────────

function escapeHtml(str) {
  try {
    return str.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
  } catch (_) {
    return str;
  }
}

function buildRecordingContext(providedName, options = {}) {
  const mode = options.mode || 'test-case';
  const slug = options.slug || undefined;
  const timestamp = new Date().toISOString();
  const effectiveName =
    providedName && String(providedName).trim()
      ? providedName
      : mode === 'defect'
        ? `Sample Defect ${timestamp}`
        : mode === 'evidence'
          ? `Evidência ${timestamp}`
          : `Sample Test Case ${timestamp}`;
  const userId =
    mode === 'defect'
      ? 'voidr-defect-assistant'
      : mode === 'evidence'
        ? 'voidr-evidence-assistant'
        : 'voidr-test-case-assistant';
  return { mode, slug, userId, effectiveName };
}

function sendCollectorInit(init) {
  try {
    const initOptions = {
      user: { id: init.userId },
      apiKey: init.apiKey,
      system: true,
      url: window.location.href,
      meta: {
        testCase: init.effectiveName,
        mode: init.mode,
        slug: init.slug,
        onboardingRunId: init.onboardingRunId || undefined,
        code: init.code || undefined,
        flows: init.flows || undefined,
        evidence: init.evidence || undefined,
      },
      // Extension-driven recordings are the future replay targets: opt into the
      // session environment bundle (localStorage/sessionStorage/cookies/viewport)
      // so the collector snapshots the page state for local replay bootstrap.
      captureEnvironmentBundle: true,
    };
    if (init.applicationId) initOptions.applicationId = init.applicationId;
    // Capturas pela extensão são deliberadas (o usuário clicou "Gravar"), então
    // sempre gravam 100% — ignoram a taxa de amostragem de produção do app (ex. 10%).
    // Sem isto, o VoidrCollector v1.15.0 não amostra a sessão e o init() vira no-op.
    // (Cobre também onboarding/evidence, que nunca podem ser amostrados fora.)
    initOptions.samplingRate = 1;

    chrome.runtime.sendMessage({ action: 'voidr:injectCollectorAndInit', initOptions }, () => {});
  } catch (_) {}
}

async function startVoidrSessionRecording(testCaseName, options = {}) {
  try {
    const { mode, slug, userId, effectiveName } = buildRecordingContext(testCaseName, options);

    document
      .querySelectorAll('.voidr-rec-border, .voidr-rec-countdown, .voidr-rec-panel')
      .forEach((n) => n.remove());

    const border = document.createElement('div');
    border.className =
      'voidr-rec-border' +
      (options.mode === 'defect' ? ' voidr-rec-border--defect' : '') +
      (options.mode === 'evidence' ? ' voidr-rec-border--evidence' : '');
    document.documentElement.appendChild(border);

    // Inicia o collector ANTES do countdown para que a gravação já esteja ativa
    // quando o "1" some e o usuário começa a agir. Antes, a init só era disparada
    // DEPOIS do countdown (+ latência de fetch do CDN/inject/POST /init), então os
    // primeiros segundos da sessão se perdiam. O countdown 3-2-1 vira o aquecimento.
    // (skip no resume: o background já reinjetou o collector.)
    if (!options.skipCountdown) {
      sendCollectorInit({
        mode,
        slug,
        userId,
        effectiveName,
        apiKey: options.apiKey,
        applicationId: options.applicationId || slug,
        onboardingRunId: options.onboardingRunId,
        code: options.code,
        flows: options.flows,
        evidence: options.evidence,
      });
    }

    if (!options.skipCountdown) {
      const countdown = document.createElement('div');
      countdown.className = 'voidr-rec-countdown';
      document.documentElement.appendChild(countdown);

      let value = 3;
      countdown.textContent = String(value);
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          value -= 1;
          if (value <= 0) {
            clearInterval(timer);
            resolve();
          } else {
            countdown.textContent = String(value);
          }
        }, 1000);
      });
      countdown.remove();
    }

    // Recording panel
    const recFlows = options.flows || [];
    const recFlowsHtml = recFlows.length
      ? `<div class="voidr-rec-flows">${recFlows
          .map(
            (f, i) =>
              `<span class="voidr-rec-flow-chip"><span class="voidr-rec-flow-num">${i + 1}.</span> ${escapeHtml(f.name || f.id)}</span>`,
          )
          .join('')}</div>`
      : '';

    // In evidence mode the panel reflects the manual-run case being proven,
    // instead of the generic "recording session" copy.
    const evidenceCaseName = options.evidence?.caseName || effectiveName;
    const recTitleHtml = options.mode === 'evidence'
      ? `Gravando evidência — &quot;${escapeHtml(evidenceCaseName)}&quot;`
      : `Gravando sessão &quot;${escapeHtml(effectiveName)}&quot;`;

    const panel = document.createElement('div');
    panel.className = 'voidr-rec-panel' + (options.mode === 'evidence' ? ' voidr-rec-panel--evidence' : '');
    panel.innerHTML = `
      <div class="voidr-rec-icon">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="#ef4444"><circle cx="12" cy="12" r="6" /></svg>
      </div>
      <div class="voidr-rec-title">${recTitleHtml}</div>
      <div class="voidr-rec-actions">
        <button class="voidr-rec-btn" id="voidr-rec-pause">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <line x1="9" y1="5" x2="9" y2="19"></line><line x1="15" y1="5" x2="15" y2="19"></line>
          </svg>
          Pausar
        </button>
        <button class="voidr-rec-btn" id="voidr-rec-rollback">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15A9 9 0 1 0 7 4.6"></path>
          </svg>
          Reiniciar
        </button>
        <button class="voidr-rec-btn danger" id="voidr-rec-delete">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
          Excluir
        </button>
        <button class="voidr-rec-btn primary" id="voidr-rec-stop">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect>
          </svg>
          Parar
        </button>
      </div>
      ${recFlowsHtml}
    `;
    document.documentElement.appendChild(panel);

    // Handlers
    let voidrPaused = false;
    const pauseBtn = document.getElementById('voidr-rec-pause');
    const PAUSE_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><line x1="9" y1="5" x2="9" y2="19"></line><line x1="15" y1="5" x2="15" y2="19"></line></svg>`;
    const PLAY_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 4v16l13-8z"></path></svg>`;
    pauseBtn?.addEventListener('click', () => {
      voidrPaused = !voidrPaused;
      chrome.runtime.sendMessage(
        { action: voidrPaused ? 'voidr:pauseSession' : 'voidr:resumeSession' },
        () => void chrome.runtime.lastError,
      );
      pauseBtn.innerHTML = voidrPaused ? `${PLAY_SVG} Retomar` : `${PAUSE_SVG} Pausar`;
      border.classList.toggle('voidr-rec-border--paused', voidrPaused);
      const titleEl = panel.querySelector('.voidr-rec-title');
      if (titleEl) {
        titleEl.textContent =
          (voidrPaused ? 'Gravação pausada — "' : 'Gravando sessão "') + effectiveName + '"';
      }
    });

    // Reiniciar: descarta o que foi gravado e recomeça mostrando o timer (3-2-1).
    document.getElementById('voidr-rec-rollback')?.addEventListener('click', () => {
      border.remove();
      panel.remove();
      document.querySelectorAll('.voidr-rec-countdown').forEach((n) => n.remove());
      chrome.runtime.sendMessage({ action: 'voidr:discardSession' }, () => {
        startVoidrSessionRecording(testCaseName, { ...options, skipCountdown: false });
      });
    });

    // Excluir: confirma antes de encerrar/descartar a sessão (não salva).
    document.getElementById('voidr-rec-delete')?.addEventListener('click', () => {
      const ok = window.confirm(
        'Descartar esta sessão? A gravação atual será perdida e não será salva.',
      );
      if (!ok) return;
      chrome.runtime.sendMessage(
        { action: 'voidr:discardSession' },
        () => void chrome.runtime.lastError,
      );
      border.remove();
      panel.remove();
      document.querySelectorAll('.voidr-rec-countdown').forEach((n) => n.remove());
      showDiscardedBanner();
    });

    document.getElementById('voidr-rec-stop')?.addEventListener('click', async () => {
      const stopBtn = document.getElementById('voidr-rec-stop');
      const spinnerSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>`;

      if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.innerHTML = `${spinnerSvg} Salvando...`;
      }

      const activeRunId = options.onboardingRunId || undefined;
      let sessionId = null;
      let allSessionIds = [];
      let result = null;

      try {
        result = await Promise.race([
          new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { action: 'voidr:sessionStopped', onboardingRunId: activeRunId },
              (res) => {
                resolve(res || { success: false });
              },
            );
          }),
          new Promise((resolve) =>
            setTimeout(() => resolve({ success: false, timeout: true }), 20000),
          ),
        ]);
        sessionId = result.sessionId || null;
        allSessionIds = result.sessionIds || (sessionId ? [sessionId] : []);
      } catch (_) {}

      // Só afirmamos "capturada" se o servidor confirmar que a sessão persistiu.
      // Sem isto o banner verde aparecia sempre (até quando o stop dava timeout
      // sem sessionId), gerando falso positivo.
      let validated = false;
      if (allSessionIds.length > 0) {
        if (stopBtn) stopBtn.innerHTML = `${spinnerSvg} Validando sessão...`;

        // Validate the latest session (most recent, needs time to reach the collector)
        const latestSid = sessionId || allSessionIds[allSessionIds.length - 1];
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const res = await new Promise((resolve) => {
              chrome.runtime.sendMessage(
                { action: 'voidr:validateSession', sessionId: latestSid },
                (r) => {
                  resolve(r || { found: false });
                },
              );
            });
            if (res.found) {
              validated = true;
              break;
            }
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 2000));
        }

        for (const sid of allSessionIds) {
          broadcastSessionToOnboarding(sid, activeRunId, options.evidence);
        }
        lastCapturedSessionId = latestSid;
      }

      border.remove();
      panel.remove();
      document.querySelectorAll('.voidr-rec-countdown').forEach((n) => n.remove());
      if (validated) {
        showOnboardingDoneBanner(mode);
      } else if (result?.timeout) {
        // Estourar o tempo do stop nao e o mesmo que nao ter capturado nada: o
        // flush pode estar em andamento. Tratar como pendente evita dizer que
        // falhou uma gravacao que salvou — o que acontecia em app pesado.
        showCapturePendingBanner(mode);
      } else if (allSessionIds.length > 0) {
        /**
         * Session captured and send to collector
         * But confirmation still not on the validation window
         * This may be a fake-negative, so we can't affirm failure
         */
        showCapturePendingBanner(mode);
      } else {
        // No session captured --> real failure
        showCaptureFailedBanner();
      }
    });
  } catch (e) {
    console.error('Voidr session recording error:', e);
  }
}

// ── Onboarding banners ───────────────────────────────────────────────────────

function showDiscardedBanner() {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done voidr-onb-done--discard';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fca5a5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
    Sessão descartada.
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 6000);
}

function showCaptureFailedBanner() {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done voidr-onb-done--warn';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fcd34d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    Não foi possível confirmar o salvamento da sessão — tente gravar novamente.
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 10000);
}

function showCapturePendingBanner(mode) {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done voidr-onb-done--pending';
  const where =
    mode === 'onboarding'
      ? 'no onboarding'
      : mode === 'evidence'
        ? 'na execução manual'
        : 'na extensão';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#93c5fd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 7 12 12 15 14"/></svg>
    Sessão enviada — pode levar alguns segundos para aparecer ${where}. Não precisa gravar de novo.
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 12000);
}

function showOnboardingDoneBanner(mode) {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done';
  const message =
    mode === 'onboarding'
      ? 'Sessão capturada com sucesso — pode fechar esta aba e voltar ao onboarding.'
      : mode === 'evidence'
        ? 'Evidência capturada com sucesso — pode fechar esta aba e voltar à execução manual.'
        : 'Sessão capturada com sucesso — pode fechar esta aba e voltar à extensão.';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#86efac" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
    ${message}
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 15000);
}

function broadcastSessionToOnboarding(sessionId, onboardingRunId, evidence) {
  try {
    // Post straight from the content script: BroadcastChannel is origin-scoped
    // (the auto-connect listener below already relies on it), and injecting an
    // inline <script> instead trips the CSP of strict pages (platform, most
    // client apps) with a red console error on every stop. Platform tabs are
    // additionally covered by the background's executeScript broadcast, which
    // is what actually crosses origins.
    const bc = new BroadcastChannel('voidr-onboarding');
    bc.postMessage({
      type: 'voidr:sessionCaptured',
      sessionId,
      onboardingRunId: onboardingRunId || undefined,
      // In evidence mode, carry the manual-run coordinates back to the platform
      // so it can auto-attach this session as evidence without re-deriving them.
      evidence: evidence || undefined,
    });
    bc.close();
  } catch (_) {}
}

// ── Message handling (background) ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'authenticationCompleted':
      initVoidrExtension();
      break;
    case 'voidr:restoreFab':
      // Clicking the toolbar icon brings the floating button back if it was docked.
      voidrStorageSet({ [VOIDR_FAB.hiddenKey]: false });
      createRefocusButton(true);
      break;
    case 'voidr:startSessionRecording':
      startVoidrSessionRecording(request.testCaseName || 'Test Case', {
        mode: request.mode,
        slug: request.slug,
        applicationId: request.applicationId,
        apiKey: request.apiKey,
        onboardingRunId: request.onboardingRunId,
        code: request.code,
        flows: request.flows || [],
        evidence: request.evidence,
      });
      break;
    case 'voidr:resumeRecordingUI':
      document
        .querySelectorAll('.voidr-rec-border, .voidr-rec-countdown, .voidr-rec-panel')
        .forEach((n) => n.remove());
      startVoidrSessionRecording(request.testCaseName || 'Test Case', {
        mode: request.mode,
        slug: request.applicationId,
        applicationId: request.applicationId,
        onboardingRunId: request.onboardingRunId,
        flows: request.flows || [],
        evidence: request.evidence,
        skipCountdown: true,
      });
      break;
    case 'voidr:sessionCaptured':
      if (request.sessionId) {
        lastCapturedSessionId = request.sessionId;
        broadcastSessionToOnboarding(request.sessionId, request.onboardingRunId, request.evidence);
        showOnboardingDoneBanner(request.evidence ? 'evidence' : undefined);
      }
      break;
  }
});

// ── Evidence deep-link (platform -> extension) ───────────────────────────────
// For manual test execution the platform opens the app URL with recording
// params (voidr_record=1&voidr_mode=evidence&voidr_plan_id=...&…). Unlike the
// onboarding flow — which pairs through the popup + a VDR code — evidence mode is
// fully deep-link driven: we read the params here and auto-start an evidence
// recording so the tester just performs the case. The apiKey is resolved in the
// background (authenticated), so it never rides in the URL.

function parseEvidenceDeepLink() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('voidr_record') !== '1') return null;
    if (params.get('voidr_mode') !== 'evidence') return null;
    const caseName = params.get('voidr_case_name') || 'Execução manual';
    return {
      applicationId: params.get('voidr_application_id') || undefined,
      caseName,
      evidence: {
        planId: params.get('voidr_plan_id') || undefined,
        moduleSlug: params.get('voidr_module_slug') || undefined,
        suiteSlug: params.get('voidr_suite_slug') || undefined,
        caseSlug: params.get('voidr_case_slug') || undefined,
        caseName,
      },
    };
  } catch (_) {
    return null;
  }
}

function resolveCollectorApiKey() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { action: 'apiRequest', endpoint: '/customer-configs', method: 'GET' },
        (res) => {
          if (chrome.runtime.lastError || !res?.success) {
            resolve(null);
            return;
          }
          const data = res.data || {};
          resolve(data?.data?.apiKey || data?.apiKey || null);
        },
      );
    } catch (_) {
      resolve(null);
    }
  });
}

async function maybeStartEvidenceFromDeepLink() {
  if (window.__voidr_evidence_started__) return;
  const deepLink = parseEvidenceDeepLink();
  if (!deepLink) return;
  window.__voidr_evidence_started__ = true;

  const apiKey = await resolveCollectorApiKey();
  if (!apiKey) {
    console.warn('[Voidr] Evidence deep-link detected but no collector API key (not authenticated?)');
    window.__voidr_evidence_started__ = false;
    return;
  }

  startVoidrSessionRecording(deepLink.caseName, {
    mode: 'evidence',
    slug: deepLink.applicationId,
    applicationId: deepLink.applicationId,
    apiKey,
    evidence: deepLink.evidence,
  });
}

// ── Onboarding code auto-connect (platform -> extension) ─────────────────────

try {
  const onboardingBC = new BroadcastChannel('voidr-onboarding');
  onboardingBC.onmessage = (event) => {
    if (event.data?.type === 'voidr:onboardingCode' && event.data.code) {
      chrome.runtime.sendMessage({
        action: 'voidr:autoConnectOnboarding',
        code: event.data.code,
      });
    }
  };
} catch (_) {}

// ── Boot ─────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initVoidrExtension();
    maybeStartEvidenceFromDeepLink();
  });
} else {
  initVoidrExtension();
  maybeStartEvidenceFromDeepLink();
}
