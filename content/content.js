// Voidr Extension — Content Script
// Injects refocus button + handles session recording on pages

let lastCapturedSessionId = null;

// ── Font injection ───────────────────────────────────────────────────────────

try {
  const fontStyle = document.createElement('style');
  fontStyle.setAttribute('data-voidr-verification-overlay', 'true');
  fontStyle.textContent = `
    .voidr-rec-panel, .voidr-rec-panel *, .voidr-rec-countdown,
    .voidr-onb-panel, .voidr-onb-panel *, .voidr-onb-done,
    .voidr-loop-launch-status, .voidr-loop-launch-status * {
      font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, system-ui, sans-serif !important;
    }
  `;
  document.head.appendChild(fontStyle);
} catch (_) {}

// ── Initialization ───────────────────────────────────────────────────────────

async function initVoidrExtension() {
  // Product-native Capture V2 has only two entry points: the Chrome action
  // popup and the in-recording toolbar. The old draggable assistant FAB was
  // intentionally removed from the dispatch path because it covered product
  // controls and created a third, competing mental model.
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
      handle.setAttribute('aria-label', 'Reabrir Voidr Capture');
      handle.title = 'Reabrir Voidr Capture';
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
      <button class="fab" type="button" aria-label="Abrir Voidr Capture" title="Voidr Capture — arraste para mover">
        ${logoSvg}
      </button>
      <span class="label">Voidr Capture</span>
      <button class="dock" type="button" aria-label="Recolher para a borda" title="Recolher para a borda">
        ${voidrIcon('X', 11, 2)}
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
          : mode === 'loop-test'
            ? `Loop Test ${timestamp}`
            : mode === 'verification'
              ? `Verification ${timestamp}`
              : `Sample Test Case ${timestamp}`;
  const userId =
    mode === 'defect'
      ? 'voidr-defect-assistant'
      : mode === 'evidence'
        ? 'voidr-evidence-assistant'
        : mode === 'loop-test'
          ? 'voidr-loop-test-assistant'
          : mode === 'verification'
            ? 'voidr-verification-assistant'
            : 'voidr-test-case-assistant';
  return { mode, slug, userId, effectiveName };
}

function getCollectorPageUrl(mode) {
  if (!['loop-test', 'verification'].includes(mode)) return window.location.href;
  try {
    const url = new URL(window.location.href);
    [
      'voidr_token',
      'voidr_record',
      'voidr_mode',
      'voidr_bootstrap',
      'voidr_scenario_id',
      'voidr_cycle_id',
      'voidr_session_n',
    ].forEach((key) => url.searchParams.delete(key));
    return url.toString();
  } catch (_) {
    return `${window.location.origin}${window.location.pathname}`;
  }
}

function sendCollectorInit(init) {
  return new Promise((resolve, reject) => {
    try {
      const initOptions = {
        user: { id: init.userId },
        apiKey: init.apiKey,
        system: true,
        // Never copy the Loop capability token from the navigation URL into
        // collector metadata or persisted extension recording state.
        url: getCollectorPageUrl(init.mode),
        meta: {
          testCase: init.effectiveName,
          mode: init.mode,
          slug: init.slug,
          onboardingRunId: init.onboardingRunId || undefined,
          code: init.code || undefined,
          flows: init.flows || undefined,
          evidence: init.evidence || undefined,
          loopTest: init.loopTest
            ? {
                scenarioId: init.loopTest.scenarioId,
                cycleId: init.loopTest.cycleId,
                cycleNumber: init.loopTest.cycleNumber,
              }
            : undefined,
          verification: init.verification
            ? {
                version: 'HIL/1',
                verificationId: init.verification.verificationId,
                generation: init.verification.generation,
                bindingId: init.verification.bindingId,
                loopId: init.verification.loopId,
                cycleNumber: init.verification.cycleNumber,
              }
            : undefined,
        },
        loopTest: init.loopTest || undefined,
        verification: init.verification || undefined,
        // Extension-driven recordings are the future replay targets: opt into the
        // session environment bundle (localStorage/sessionStorage/cookies/viewport)
        // so the collector snapshots the page state for local replay bootstrap.
        captureEnvironmentBundle: true,
      };
      if (init.applicationId) initOptions.applicationId = init.applicationId;
      if (init.environmentSlug) initOptions.environment = init.environmentSlug;
      // Capturas pela extensão são deliberadas (o usuário clicou "Gravar"), então
      // sempre gravam 100% — ignoram a taxa de amostragem de produção do app (ex. 10%).
      // Sem isto, o VoidrCollector v1.15.0 não amostra a sessão e o init() vira no-op.
      // (Cobre também onboarding/evidence, que nunca podem ser amostrados fora.)
      initOptions.samplingRate = 1;

      chrome.runtime.sendMessage(
        {
          action: 'voidr:injectCollectorAndInit',
          initOptions,
          lifecycleGeneration: init.lifecycleGeneration || null,
        },
        (response) => {
          if (chrome.runtime.lastError || !response?.success) {
            reject(
              new Error(
                response?.error ||
                  chrome.runtime.lastError?.message ||
                  'Não foi possível iniciar o gravador.',
              ),
            );
            return;
          }
          resolve(response);
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

function verificationRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        reject(
          new Error(
            response?.error || chrome.runtime.lastError?.message || 'Verification operation failed',
          ),
        );
        return;
      }
      resolve(response);
    });
  });
}

function markVerificationOverlay(node) {
  if (node) node.setAttribute('data-voidr-verification-overlay', 'true');
  return node;
}

function renderVerificationHandoff(panel, state, options, details = {}) {
  if (!panel || !globalThis.VoidrVerificationHandoffUx) return;
  const verification = details.verification || options.verification || {};
  const harness = verification.harness || options.verification?.harness;
  const view = globalThis.VoidrVerificationHandoffUx.viewModel(state, harness, {
    cycleNumber:
      verification.cycleNumber ||
      options.loopTest?.cycleNumber ||
      options.verification?.cycleNumber,
    error: details.error,
  });
  panel.className = `voidr-rec-panel voidr-rec-panel--verification voidr-handoff voidr-handoff--${view.tone}`;
  markVerificationOverlay(panel);
  panel.setAttribute('role', view.terminal ? 'status' : 'progressbar');
  panel.setAttribute('aria-live', 'polite');
  panel.innerHTML = `
    <div class="voidr-handoff-brand">
      <img src="${escapeHtml(chrome.runtime.getURL('assets/logo-light.svg'))}" alt="Voidr" />
    </div>
    <div class="voidr-handoff-main">
      <div class="voidr-handoff-kicker">
        <span>${escapeHtml(view.eyebrow)}</span>
        ${
          view.harness.connected
            ? `<span class="voidr-handoff-harness">${escapeHtml(view.harness.name)}</span>`
            : ''
        }
      </div>
      <div class="voidr-handoff-title">${escapeHtml(view.title)}</div>
      <div class="voidr-handoff-detail">${escapeHtml(view.detail)}</div>
      <div class="voidr-handoff-steps" aria-label="Progresso">
        ${view.steps
          .map(
            (step) => `
              <div class="voidr-handoff-step is-${step.state}">
                <span class="voidr-handoff-step-mark">${
                  step.state === 'done' ? voidrIcon('CheckCircle2', 12, 2) : ''
                }</span>
                <span>${escapeHtml(step.label)}</span>
              </div>`,
          )
          .join('')}
      </div>
    </div>
    <div class="voidr-handoff-actions">
      ${
        view.retryable
          ? '<button type="button" class="voidr-handoff-button is-primary" data-voidr-handoff-retry>Tentar novamente</button>'
          : ''
      }
      ${
        view.terminal && (verification.loopId || options.loopTest?.scenarioId)
          ? '<button type="button" class="voidr-handoff-button is-primary" data-voidr-handoff-open>Abrir ciclo</button>'
          : ''
      }
      ${
        view.terminal
          ? '<button type="button" class="voidr-handoff-button" data-voidr-handoff-close aria-label="Fechar">Fechar</button>'
          : '<span class="voidr-handoff-orbit" aria-hidden="true"><i></i></span>'
      }
    </div>
  `;
  panel
    .querySelector('[data-voidr-handoff-close]')
    ?.addEventListener('click', () => panel.remove());
  panel.querySelector('[data-voidr-handoff-retry]')?.addEventListener('click', (event) => {
    if (typeof details.onRetry === 'function') void details.onRetry(event);
  });
  panel.querySelector('[data-voidr-handoff-open]')?.addEventListener('click', () => {
    const scenarioId = verification.loopId || options.loopTest?.scenarioId;
    const cycleId =
      verification.cycleId ||
      verification.verificationId ||
      options.loopTest?.cycleId ||
      options.verification?.verificationId;
    chrome.runtime.sendMessage({ action: 'voidr:openLoopCycle', scenarioId, cycleId });
  });
}

async function monitorVerificationHandoffAck(panel, options, initialVerification) {
  const verificationId = options.verification?.verificationId;
  if (!verificationId || initialVerification?.harnessDelivery?.state === 'acknowledged') return;
  const deadline = Date.now() + 45000;
  while (panel?.isConnected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      const response = await verificationRuntimeMessage({
        action: 'voidr:verificationHandoffStatus',
        verificationId,
      });
      if (response.verification?.harnessDelivery?.state === 'acknowledged') {
        renderVerificationHandoff(panel, 'acknowledged', options, {
          verification: response.verification,
        });
        return;
      }
    } catch (_) {
      return;
    }
  }
}

function verificationPageUrl() {
  try {
    const url = new URL(window.location.href);
    for (const key of [...url.searchParams.keys()]) {
      if (/voidr_|token|secret|password|authorization|api[_-]?key|session/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.username = '';
    url.password = '';
    return url.toString();
  } catch (_) {
    return `${window.location.origin}${window.location.pathname}`;
  }
}

function voidrIcon(name, size = 14, strokeWidth = 1.5) {
  return typeof globalThis.getIcon === 'function'
    ? globalThis.getIcon(name, size, strokeWidth)
    : '';
}

function verificationSelector(element) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const testId = element.getAttribute('data-testid') || element.getAttribute('data-test-id');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  const parts = [];
  let current = element;
  while (current && current !== document.body && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName)
      : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

async function cropVerificationScreenshot(dataUrl, rect) {
  if (!dataUrl || !rect || rect.width < 2 || rect.height < 2) return null;
  const image = new Image();
  image.src = dataUrl;
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
  });
  const scaleX = image.naturalWidth / window.innerWidth;
  const scaleY = image.naturalHeight / window.innerHeight;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * scaleX));
  canvas.height = Math.max(1, Math.round(rect.height * scaleY));
  const context = canvas.getContext('2d');
  context.drawImage(
    image,
    rect.x * scaleX,
    rect.y * scaleY,
    rect.width * scaleX,
    rect.height * scaleY,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas.toDataURL('image/webp', 0.82);
}

async function persistRecordingAnnotation(annotationContext, selection) {
  const note = await requestVerificationAnnotationNote(selection);
  if (!note) return false;
  const verification = annotationContext?.verification;
  const noteInput = {
    version: 'SESSION-NOTE/1',
    kind: selection.kind,
    note,
    pageUrl: verificationPageUrl(),
    timestampMs: Math.max(0, Math.round(performance.now())),
    selector: selection.selector,
    rect: selection.rect,
    viewport: {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
    },
  };
  if (!verification?.verificationId || !verification?.generation) {
    await verificationRuntimeMessage({
      action: 'voidr:trackRecordingNote',
      lifecycleGeneration: annotationContext?.lifecycleGeneration,
      input: noteInput,
    });
    incrementVerificationAnnotationCount();
    showVerificationAnnotationToast('Nota salva na sessão');
    return true;
  }
  const overlayNodes = [...document.querySelectorAll('[data-voidr-verification-overlay]')];
  const visibility = overlayNodes.map((node) => node.style.visibility);
  overlayNodes.forEach((node) => {
    node.style.visibility = 'hidden';
  });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  let screenshot = null;
  try {
    screenshot = await verificationRuntimeMessage({
      action: 'voidr:captureVerificationEvidence',
      verificationId: verification.verificationId,
      generation: verification.generation,
      rect: selection.rect,
    });
  } catch (error) {
    console.warn(
      '[Voidr Verification] screenshot unavailable; retaining the text annotation:',
      error?.message || error,
    );
  } finally {
    overlayNodes.forEach((node, index) => {
      node.style.visibility = visibility[index];
    });
  }
  let cropRef = null;
  if (selection.rect && screenshot?.dataUrl) {
    const crop = await cropVerificationScreenshot(screenshot.dataUrl, selection.rect);
    if (crop) {
      const storedCrop = await verificationRuntimeMessage({
        action: 'voidr:storeVerificationCrop',
        verificationId: verification.verificationId,
        generation: verification.generation,
        dataUrl: crop,
      });
      cropRef = storedCrop.ref;
    }
  }
  await verificationRuntimeMessage({
    action: 'voidr:verificationIngest',
    verificationId: verification.verificationId,
    generation: verification.generation,
    endpoint: 'annotations',
    idempotencyKey: `annotation:${verification.generation}:${crypto.randomUUID()}`,
    queueWhenOffline: true,
    input: {
      ...noteInput,
      version: 'HIL/1',
      screenshotRef: screenshot?.ref,
      cropRef: cropRef || undefined,
    },
  });
  void verificationRuntimeMessage({
    action: 'voidr:trackRecordingNote',
    lifecycleGeneration: annotationContext?.lifecycleGeneration,
    input: noteInput,
  }).catch(() => {});
  incrementVerificationAnnotationCount();
  showVerificationAnnotationToast('Anotação salva');
  return true;
}

function requestVerificationAnnotationNote(selection) {
  return new Promise((resolve) => {
    const shell = markVerificationOverlay(document.createElement('div'));
    shell.className = 'voidr-verification-composer-shell';
    const selectionLabel =
      selection.kind === 'element'
        ? 'Nota em elemento'
        : selection.kind === 'region'
          ? 'Nota em região'
          : 'Nota na tela';
    shell.innerHTML = `
      <section class="voidr-verification-composer" role="dialog" aria-modal="true" aria-labelledby="voidr-annotation-title">
        <div class="voidr-verification-composer-head">
          <div>
            <span class="voidr-verification-composer-kicker">${selectionLabel}</span>
            <h2 id="voidr-annotation-title">O que deve ser investigado?</h2>
          </div>
          <button type="button" class="voidr-verification-icon-btn" data-action="cancel" aria-label="Cancelar anotação">${voidrIcon('X', 14)}</button>
        </div>
        <textarea maxlength="1000" placeholder="Ex.: depois do retry, o botão continua desabilitado"></textarea>
        <div class="voidr-verification-composer-actions">
          <span>Inclua esperado × observado quando ajudar · Enter salva</span>
          <button type="button" class="voidr-verification-save" data-action="save" disabled>Salvar anotação</button>
        </div>
      </section>
    `;
    document.documentElement.appendChild(shell);
    const textarea = shell.querySelector('textarea');
    const save = shell.querySelector('[data-action="save"]');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      shell.remove();
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(null);
      } else if (event.key === 'Enter' && !event.shiftKey && textarea.value.trim()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(textarea.value.trim());
      }
    };
    textarea.addEventListener('input', () => {
      save.disabled = !textarea.value.trim();
    });
    shell.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(null));
    save.addEventListener('click', () => finish(textarea.value.trim() || null));
    document.addEventListener('keydown', onKeyDown, true);
    requestAnimationFrame(() => textarea.focus());
  });
}

function incrementVerificationAnnotationCount() {
  const badge = document.getElementById('voidr-verification-annotation-count');
  if (!badge) return;
  const count = Number(badge.dataset.count || 0) + 1;
  badge.dataset.count = String(count);
  badge.textContent = String(count);
  badge.hidden = false;
  document.dispatchEvent(new CustomEvent('voidr:verificationAnnotationSaved'));
}

function showVerificationAnnotationToast(message) {
  document.querySelectorAll('.voidr-verification-toast').forEach((node) => node.remove());
  const toast = markVerificationOverlay(document.createElement('div'));
  toast.className = 'voidr-verification-toast';
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  document.documentElement.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

function beginElementAnnotation(annotationContext) {
  document.documentElement.style.cursor = 'crosshair';
  const highlight = markVerificationOverlay(document.createElement('div'));
  highlight.className = 'voidr-verification-element-highlight';
  const hint = markVerificationOverlay(document.createElement('div'));
  hint.className = 'voidr-verification-selection-hint';
  hint.textContent = 'Selecione um elemento · Esc para cancelar';
  document.documentElement.append(highlight, hint);
  const cleanup = () => {
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.style.cursor = '';
    highlight.remove();
    hint.remove();
  };
  const onMove = (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('[data-voidr-verification-overlay]')) return;
    const rect = target.getBoundingClientRect();
    Object.assign(highlight.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
  };
  const onClick = async (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('[data-voidr-verification-overlay]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
    const rect = target.getBoundingClientRect();
    try {
      await persistRecordingAnnotation(annotationContext, {
        kind: 'element',
        selector: verificationSelector(target),
        rect: {
          x: Math.max(0, rect.x),
          y: Math.max(0, rect.y),
          width: rect.width,
          height: rect.height,
        },
      });
    } catch (error) {
      console.warn('[Voidr Verification] annotation failed:', error?.message || error);
    }
  };
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
}

function beginRegionAnnotation(annotationContext) {
  const overlay = markVerificationOverlay(document.createElement('div'));
  overlay.className = 'voidr-verification-region-overlay';
  overlay.innerHTML =
    '<div class="voidr-verification-region-box"></div><div class="voidr-verification-selection-hint">Arraste para selecionar · Esc para cancelar</div>';
  document.documentElement.appendChild(overlay);
  const box = overlay.firstElementChild;
  let start = null;
  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
  };
  const move = (event) => {
    if (!start) return;
    const x = Math.min(start.x, event.clientX);
    const y = Math.min(start.y, event.clientY);
    const width = Math.abs(event.clientX - start.x);
    const height = Math.abs(event.clientY - start.y);
    Object.assign(box.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  };
  overlay.addEventListener('pointerdown', (event) => {
    start = { x: event.clientX, y: event.clientY };
    move(event);
  });
  overlay.addEventListener('pointermove', move);
  overlay.addEventListener('pointerup', async (event) => {
    if (!start) return;
    const rect = {
      x: Math.min(start.x, event.clientX),
      y: Math.min(start.y, event.clientY),
      width: Math.abs(event.clientX - start.x),
      height: Math.abs(event.clientY - start.y),
    };
    cleanup();
    if (rect.width < 8 || rect.height < 8) return;
    try {
      await persistRecordingAnnotation(annotationContext, { kind: 'region', rect });
    } catch (error) {
      console.warn('[Voidr Verification] annotation failed:', error?.message || error);
    }
  });
  document.addEventListener('keydown', onKeyDown, true);
}

async function captureVerificationScreen(annotationContext) {
  try {
    await persistRecordingAnnotation(annotationContext, { kind: 'screen' });
  } catch (error) {
    console.warn('[Voidr Verification] screen annotation failed:', error?.message || error);
    showVerificationAnnotationToast('Não foi possível salvar a anotação');
  }
}

async function startVoidrSessionRecording(testCaseName, options = {}) {
  try {
    const { mode, slug, userId, effectiveName } = buildRecordingContext(testCaseName, options);
    let lifecycleGeneration = options.lifecycleGeneration || null;

    // Automatic Loop URLs are fresh missions and receive a deterministic
    // top-of-page baseline. Manual captures and in-flight recovery retain the
    // user's actual viewport.
    if (
      mode === 'loop-test' &&
      globalThis.__voidrLoopBootstrapFreshViewport === true &&
      !options.collectorAlreadyInitialized
    ) {
      globalThis.VoidrLoopBootstrap?.prepareAutomaticLoopViewport?.(window);
      globalThis.__voidrLoopBootstrapFreshViewport = false;
    }
    let stopCapability = options.stopCapability || null;

    document
      .querySelectorAll('.voidr-rec-border, .voidr-rec-countdown, .voidr-rec-panel')
      .forEach((n) => n.remove());

    const border = document.createElement('div');
    border.className =
      'voidr-rec-border' +
      (options.mode === 'defect' ? ' voidr-rec-border--defect' : '') +
      (options.mode === 'evidence' ? ' voidr-rec-border--evidence' : '') +
      (options.mode === 'loop-test' ? ' voidr-rec-border--loop-test' : '') +
      (options.mode === 'verification' ? ' voidr-rec-border--verification' : '');
    markVerificationOverlay(border);
    document.documentElement.appendChild(border);

    // Start the visible countdown immediately and bootstrap the collector in
    // parallel. If CSP forces a reload, the background resumes this UI with
    // collectorAlreadyInitialized=true and explicitly asks for a fresh countdown.
    let countdown = null;
    let countdownPromise = Promise.resolve();
    if (!options.skipCountdown) {
      countdown = document.createElement('div');
      countdown.className = 'voidr-rec-countdown';
      markVerificationOverlay(countdown);
      document.documentElement.appendChild(countdown);

      let value = 3;
      countdown.textContent = String(value);
      countdownPromise = new Promise((resolve) => {
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
    }

    try {
      const startupPromise = options.collectorAlreadyInitialized
        ? Promise.resolve({ lifecycleGeneration })
        : sendCollectorInit({
            mode,
            slug,
            userId,
            effectiveName,
            apiKey: options.apiKey,
            applicationId: options.applicationId || slug,
            environmentSlug: options.environmentSlug,
            onboardingRunId: options.onboardingRunId,
            code: options.code,
            flows: options.flows,
            evidence: options.evidence,
            loopTest: options.loopTest,
            verification: options.verification,
            lifecycleGeneration,
          });
      const [startup] = await Promise.all([startupPromise, countdownPromise]);
      lifecycleGeneration = startup.lifecycleGeneration;
      stopCapability = startup.stopCapability || stopCapability;
    } finally {
      countdown?.remove();
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
    // instead of the generic "recording session" copy. In loop-test mode it
    // shows the session counter so the dev knows which of the 3 samples this is.
    const evidenceCaseName = options.evidence?.caseName || effectiveName;
    const loopTest = options.loopTest || null;
    const recTitleHtml =
      options.mode === 'loop-test' && loopTest
        ? `${escapeHtml(effectiveName)}${
            loopTest.cycleNumber
              ? ` <span class="voidr-rec-scenario">Ciclo #${loopTest.cycleNumber}</span>`
              : ''
          }`
        : options.mode === 'verification' && options.verification
          ? `${escapeHtml(options.verification.mission)}${
              options.verification.cycleNumber
                ? ` <span class="voidr-rec-scenario">Ciclo #${options.verification.cycleNumber}</span>`
                : ''
            }`
          : options.mode === 'evidence'
            ? `Gravando evidência — &quot;${escapeHtml(evidenceCaseName)}&quot;`
            : `Gravando sessão — &quot;${escapeHtml(effectiveName)}&quot;`;
    const recorderBrandHtml = `
      <div class="voidr-rec-brand" aria-label="Voidr">
        <img src="${escapeHtml(chrome.runtime.getURL('assets/logo-light.svg'))}" alt="" />
      </div>`;
    const annotationToolsHtml = `
      <div class="voidr-rec-tool-wrap">
        <button class="voidr-rec-btn accent" id="voidr-verification-annotate" aria-label="Adicionar nota" aria-expanded="false" aria-haspopup="menu" title="Adicionar uma nota à gravação">
          ${voidrIcon('MessageSquare', 14)}
          <span>Nota</span>
          <span class="voidr-rec-count-badge" id="voidr-verification-annotation-count" data-count="0" aria-hidden="true" hidden>0</span>
        </button>
        <div class="voidr-rec-tool-menu" id="voidr-verification-tools" role="menu" hidden>
          <button type="button" role="menuitem" data-annotation-mode="element">
            <span class="voidr-rec-tool-icon">${voidrIcon('MousePointer', 14)}</span>
            <span><strong>Elemento</strong><small>Selecione algo na tela</small></span>
          </button>
          <button type="button" role="menuitem" data-annotation-mode="region">
            <span class="voidr-rec-tool-icon">${voidrIcon('Maximize2', 14)}</span>
            <span><strong>Região</strong><small>Arraste sobre uma área</small></span>
          </button>
          <button type="button" role="menuitem" data-annotation-mode="screen">
            <span class="voidr-rec-tool-icon">${voidrIcon('Camera', 14)}</span>
            <span><strong>Tela</strong><small>Capture o viewport atual</small></span>
          </button>
        </div>
      </div>`;

    const panel = document.createElement('div');
    panel.className =
      'voidr-rec-panel' +
      (options.mode === 'evidence' ? ' voidr-rec-panel--evidence' : '') +
      (options.mode === 'loop-test' ? ' voidr-rec-panel--loop-test' : '') +
      (options.mode === 'verification' ? ' voidr-rec-panel--verification' : '');
    panel.dataset.voidrLifecycleGeneration = lifecycleGeneration || '';
    markVerificationOverlay(panel);
    panel.innerHTML = options.verification
      ? `
        ${recorderBrandHtml}
        <div class="voidr-rec-live" aria-label="Gravação ativa">
          <span class="voidr-rec-live-dot"></span>
          <span id="voidr-rec-elapsed">00:00</span>
        </div>
        <div class="voidr-rec-title" title="${escapeHtml(effectiveName)}">${recTitleHtml}</div>
        <div class="voidr-rec-actions">
          <div class="voidr-rec-tool-wrap">
            <button class="voidr-rec-btn voidr-rec-capture" id="voidr-verification-capture" aria-label="Ver captura automática" aria-expanded="false" aria-haspopup="dialog" title="Ver o que está sendo capturado">
              ${voidrIcon('Activity', 14)}
              <span>Capturando</span>
            </button>
            <section class="voidr-rec-signal-panel" id="voidr-verification-signals" aria-label="Captura automática" hidden>
              <header>
                <strong>Captura automática</strong>
                <small>Sem configurar nada</small>
              </header>
              <div class="voidr-rec-signal-summary" data-evidence-view="summary">
                <div class="voidr-rec-signal-grid">
                  <button type="button" class="voidr-rec-signal" data-evidence-category="pages" aria-controls="voidr-live-evidence-inspector">${voidrIcon('Globe2', 13)}<span>Páginas</span><b data-signal="pages">1</b>${voidrIcon('ChevronRight', 11)}</button>
                  <button type="button" class="voidr-rec-signal" data-evidence-category="clicks" aria-controls="voidr-live-evidence-inspector">${voidrIcon('MousePointer', 13)}<span>Cliques</span><b data-signal="clicks">0</b>${voidrIcon('ChevronRight', 11)}</button>
                  <button type="button" class="voidr-rec-signal" data-evidence-category="requests" aria-controls="voidr-live-evidence-inspector">${voidrIcon('Network', 13)}<span>Requests</span><b data-signal="requests">0</b>${voidrIcon('ChevronRight', 11)}</button>
                  <button type="button" class="voidr-rec-signal" data-evidence-category="errors" aria-controls="voidr-live-evidence-inspector">${voidrIcon('Terminal', 13)}<span>Erros</span><b data-signal="errors">0</b>${voidrIcon('ChevronRight', 11)}</button>
                  <button type="button" class="voidr-rec-signal" data-evidence-category="notes" aria-controls="voidr-live-evidence-inspector">${voidrIcon('MessageSquare', 13)}<span>Notas</span><b data-signal="notes">0</b>${voidrIcon('ChevronRight', 11)}</button>
                  <button type="button" class="voidr-rec-signal" data-evidence-category="voiceNotes" aria-controls="voidr-live-evidence-inspector">${voidrIcon('Mic', 13)}<span>Voz</span><b data-signal="voiceNotes">0</b>${voidrIcon('ChevronRight', 11)}</button>
                </div>
                <p>O Loop guarda a evidência completa. O agente recebe apenas o contexto necessário.</p>
              </div>
              <section class="voidr-live-evidence" id="voidr-live-evidence-inspector" data-evidence-view="detail" aria-live="polite" hidden>
                <header class="voidr-live-evidence-head">
                  <button type="button" class="voidr-live-evidence-back" aria-label="Voltar para captura automática">${voidrIcon('ArrowLeft', 14)}</button>
                  <div>
                    <strong data-evidence-title>Requests</strong>
                    <small><span class="voidr-live-dot" aria-hidden="true"></span><span data-evidence-status>Ao vivo</span></small>
                  </div>
                  <span class="voidr-live-evidence-count" data-evidence-count>0</span>
                </header>
                <div class="voidr-live-evidence-layout">
                  <div class="voidr-live-evidence-feed">
                    <div class="voidr-live-evidence-feed-head">
                      <span>Mais recentes</span>
                      <small>contexto seguro</small>
                    </div>
                    <div class="voidr-live-evidence-list" data-evidence-list role="list"></div>
                  </div>
                  <article class="voidr-live-evidence-detail" data-evidence-detail>
                    <div class="voidr-live-evidence-empty">Selecione uma evidência para inspecionar.</div>
                  </article>
                </div>
                <footer>
                  ${voidrIcon('Layers', 12)}
                  <span>O evento completo permanece no replay e no ClickHouse.</span>
                </footer>
              </section>
            </section>
          </div>
          ${annotationToolsHtml}
          <button class="voidr-rec-btn voidr-rec-voice" id="voidr-verification-voice" aria-label="Adicionar nota de voz" aria-pressed="false" title="Adicionar uma nota de voz ao replay">
            ${voidrIcon('Mic', 14)}
            <span>Voz</span>
          </button>
          <button class="voidr-rec-btn voidr-rec-finish" id="voidr-rec-stop">
            ${voidrIcon('Square', 13)}
            Finalizar
          </button>
        </div>
        <div class="voidr-rec-voice-caption" id="voidr-verification-voice-caption" role="status" aria-live="polite" hidden></div>
      `
      : `
        ${recorderBrandHtml}
        <div class="voidr-rec-icon">
          <span class="voidr-rec-recording-icon" aria-hidden="true"></span>
        </div>
        <div class="voidr-rec-title">${recTitleHtml}</div>
        <div class="voidr-rec-actions">
          ${annotationToolsHtml}
          <button class="voidr-rec-btn" id="voidr-rec-pause">${voidrIcon('Pause', 14)} Pausar</button>
          <button class="voidr-rec-btn" id="voidr-rec-rollback">
            ${voidrIcon('RefreshCw', 14)}
            Reiniciar
          </button>
          <button class="voidr-rec-btn danger" id="voidr-rec-delete">${voidrIcon('Trash2', 14)} Excluir</button>
          <button class="voidr-rec-btn danger" id="voidr-rec-stop">
            ${voidrIcon('Square', 14)}
            Finalizar
          </button>
        </div>
        ${recFlowsHtml}
      `;
    document.documentElement.appendChild(panel);

    let recordingTimer = null;
    let annotationShortcut = null;
    let voiceStatusListener = null;
    let voiceActive = false;
    let captureSignalCleanup = null;
    let recordCaptureSignal = () => {};
    let recordingStartedAt = Date.now();
    const annotationContext = {
      verification: options.verification || null,
      lifecycleGeneration,
    };
    const annotationButton = panel.querySelector('#voidr-verification-annotate');
    const annotationTools = panel.querySelector('#voidr-verification-tools');
    const captureButton = panel.querySelector('#voidr-verification-capture');
    const captureSignalPanel = panel.querySelector('#voidr-verification-signals');
    annotationButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = annotationTools.hidden;
      annotationTools.hidden = !willOpen;
      annotationButton.setAttribute('aria-expanded', String(willOpen));
      if (willOpen && captureSignalPanel) {
        captureSignalPanel.hidden = true;
        captureButton?.setAttribute('aria-expanded', 'false');
      }
    });
    annotationTools?.querySelectorAll('[data-annotation-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        annotationTools.hidden = true;
        annotationButton?.setAttribute('aria-expanded', 'false');
        const annotationMode = button.dataset.annotationMode;
        if (annotationMode === 'element') beginElementAnnotation(annotationContext);
        else if (annotationMode === 'region') beginRegionAnnotation(annotationContext);
        else void captureVerificationScreen(annotationContext);
      });
    });
    panel.addEventListener('click', (event) => {
      if (!event.target.closest('.voidr-rec-tool-wrap')) {
        if (annotationTools) annotationTools.hidden = true;
        annotationButton?.setAttribute('aria-expanded', 'false');
        if (captureSignalPanel) captureSignalPanel.hidden = true;
        captureButton?.setAttribute('aria-expanded', 'false');
      }
    });
    annotationShortcut = (event) => {
      if (event.altKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        beginElementAnnotation(annotationContext);
      }
    };
    document.addEventListener('keydown', annotationShortcut, true);

    if (options.verification) {
      const elapsed = panel.querySelector('#voidr-rec-elapsed');
      const voiceButton = panel.querySelector('#voidr-verification-voice');
      const voiceCaption = panel.querySelector('#voidr-verification-voice-caption');
      const trackedVoiceSegments = new Set();
      const signalHelpers = globalThis.VoidrRecordingSignals;
      const inspectorHelpers = globalThis.VoidrLiveEvidenceInspector;
      const captureSignals = signalHelpers?.create(verificationPageUrl());
      const evidenceSummary = captureSignalPanel?.querySelector('[data-evidence-view="summary"]');
      const evidenceInspector = captureSignalPanel?.querySelector('[data-evidence-view="detail"]');
      const evidenceTitle = captureSignalPanel?.querySelector('[data-evidence-title]');
      const evidenceStatus = captureSignalPanel?.querySelector('[data-evidence-status]');
      const evidenceCount = captureSignalPanel?.querySelector('[data-evidence-count]');
      const evidenceList = captureSignalPanel?.querySelector('[data-evidence-list]');
      const evidenceDetail = captureSignalPanel?.querySelector('[data-evidence-detail]');
      let authoritativeSignalCounts = null;
      let activeEvidenceCategory = null;
      let selectedEvidenceId = null;
      let liveEvidenceTimer = null;
      let liveEvidenceRequest = null;
      let liveEvidenceContext = null;
      const renderCaptureSignals = () => {
        const localSnapshot = signalHelpers?.snapshot(captureSignals) || {};
        const snapshot = authoritativeSignalCounts
          ? Object.fromEntries(
              Object.keys(localSnapshot).map((key) => [
                key,
                Math.max(
                  Number(localSnapshot[key]) || 0,
                  Number(authoritativeSignalCounts[key]) || 0,
                ),
              ]),
            )
          : localSnapshot;
        for (const [key, value] of Object.entries(snapshot)) {
          const node = captureSignalPanel?.querySelector(`[data-signal="${key}"]`);
          if (node) node.textContent = String(value);
        }
      };
      const incrementCaptureSignal = (key, amount = 1) => {
        signalHelpers?.increment(captureSignals, key, amount);
        renderCaptureSignals();
      };
      recordCaptureSignal = incrementCaptureSignal;
      const onProductClick = (event) => {
        if (event.target?.closest?.('[data-voidr-verification-overlay]')) return;
        incrementCaptureSignal('clicks');
      };
      const onProductError = () => incrementCaptureSignal('errors');
      const onAnnotationSaved = () => incrementCaptureSignal('notes');
      document.addEventListener('click', onProductClick, true);
      window.addEventListener('error', onProductError, true);
      window.addEventListener('unhandledrejection', onProductError, true);
      document.addEventListener('voidr:verificationAnnotationSaved', onAnnotationSaved);
      let resourceObserver = null;
      try {
        resourceObserver = new PerformanceObserver((list) => {
          incrementCaptureSignal('requests', list.getEntries().length);
        });
        resourceObserver.observe({ type: 'resource', buffered: false });
      } catch (_) {}

      const renderEvidenceDetail = (category, item) => {
        if (!evidenceDetail) return;
        if (!item) {
          evidenceDetail.innerHTML = `<div class="voidr-live-evidence-empty">Selecione uma evidência para inspecionar.</div>`;
          return;
        }
        const presentation = inspectorHelpers?.itemPresentation(category, item) || {};
        const fields = inspectorHelpers?.detailFields(category, item) || [];
        evidenceDetail.innerHTML = `
          <div class="voidr-live-evidence-detail-head">
            <span class="voidr-live-evidence-tone is-${escapeHtml(presentation.tone || 'neutral')}"></span>
            <div>
              <small>${escapeHtml(presentation.eyebrow || '')}</small>
              <h3>${escapeHtml(presentation.title || 'Evidência')}</h3>
            </div>
          </div>
          <div class="voidr-live-evidence-fields">
            ${fields
              .map((field) => {
                const value = escapeHtml(field.value || '');
                if (field.kind === 'json' || field.kind === 'code') {
                  return `<details class="voidr-live-evidence-field" ${field.label === 'URL' || field.label === 'Mensagem' ? 'open' : ''}>
                    <summary>${escapeHtml(field.label)}</summary>
                    <pre>${value}</pre>
                  </details>`;
                }
                return `<div class="voidr-live-evidence-field is-inline"><span>${escapeHtml(field.label)}</span><strong>${value}</strong></div>`;
              })
              .join('')}
          </div>`;
      };

      const renderEvidenceFeed = (context, category) => {
        if (!evidenceList || !evidenceInspector) return;
        const meta = inspectorHelpers?.CATEGORY_META?.[category] || {
          label: category,
          empty: 'Nenhuma evidência observada.',
        };
        const items = context?.categories?.[category] || [];
        const count = Number(context?.counts?.[category]) || items.length;
        if (evidenceTitle) evidenceTitle.textContent = meta.label;
        if (evidenceCount) evidenceCount.textContent = String(count);
        if (!items.length) {
          selectedEvidenceId = null;
          evidenceList.innerHTML = `<div class="voidr-live-evidence-empty">${escapeHtml(meta.empty)}</div>`;
          renderEvidenceDetail(category, null);
          return;
        }
        if (!items.some((item) => item.id === selectedEvidenceId)) {
          selectedEvidenceId = items[0].id;
        }
        evidenceList.innerHTML = items
          .map((item) => {
            const presentation = inspectorHelpers?.itemPresentation(category, item) || {};
            const selected = item.id === selectedEvidenceId;
            return `<div role="listitem"><button type="button" class="voidr-live-evidence-item" data-evidence-id="${escapeHtml(item.id)}" aria-pressed="${selected}">
              <span class="voidr-live-evidence-tone is-${escapeHtml(presentation.tone || 'neutral')}"></span>
              <span class="voidr-live-evidence-item-copy">
                <small>${escapeHtml(presentation.eyebrow || '')}</small>
                <strong>${escapeHtml(presentation.title || 'Evidência')}</strong>
                <span>${escapeHtml(presentation.meta || '')}</span>
              </span>
              <time>${escapeHtml(inspectorHelpers?.formatOffset(item.offsetMs) || '00:00')}</time>
            </button></div>`;
          })
          .join('');
        const selected = items.find((item) => item.id === selectedEvidenceId) || items[0];
        renderEvidenceDetail(category, selected);
        evidenceList.querySelectorAll('[data-evidence-id]').forEach((button) => {
          button.addEventListener('click', () => {
            selectedEvidenceId = button.dataset.evidenceId;
            renderEvidenceFeed(context, category);
          });
        });
      };

      const setEvidenceStatus = (label, state = 'live') => {
        if (evidenceStatus) evidenceStatus.textContent = label;
        evidenceInspector?.setAttribute('data-state', state);
      };

      const readLiveEvidence = async (category = null) => {
        if (liveEvidenceRequest) return liveEvidenceRequest;
        setEvidenceStatus('Atualizando…', 'loading');
        liveEvidenceRequest = verificationRuntimeMessage({
          action: 'voidr:getLiveRecordingContext',
          lifecycleGeneration,
          category,
          limit: 30,
        })
          .then((response) => {
            if (!response?.success) throw new Error(response?.error || 'Contexto indisponível');
            const normalized = inspectorHelpers?.normalizeContext(response.context);
            if (!normalized) {
              setEvidenceStatus('Collector em modo compatível', 'degraded');
              return null;
            }
            liveEvidenceContext = {
              ...liveEvidenceContext,
              ...normalized,
              categories: {
                ...(liveEvidenceContext?.categories || {}),
                ...(normalized.categories || {}),
              },
            };
            authoritativeSignalCounts = normalized.counts;
            renderCaptureSignals();
            setEvidenceStatus('Ao vivo', 'live');
            if (activeEvidenceCategory) {
              renderEvidenceFeed(liveEvidenceContext, activeEvidenceCategory);
            }
            return liveEvidenceContext;
          })
          .catch(() => {
            setEvidenceStatus(navigator.onLine ? 'Atualização indisponível' : 'Offline', 'error');
            return null;
          })
          .finally(() => {
            liveEvidenceRequest = null;
          });
        return liveEvidenceRequest;
      };

      const startLiveEvidencePolling = () => {
        if (liveEvidenceTimer) clearInterval(liveEvidenceTimer);
        void readLiveEvidence(activeEvidenceCategory);
        liveEvidenceTimer = setInterval(() => {
          if (!captureSignalPanel?.hidden) void readLiveEvidence(activeEvidenceCategory);
        }, 1200);
      };

      const showEvidenceCategory = (category) => {
        if (!inspectorHelpers?.CATEGORY_META?.[category]) return;
        activeEvidenceCategory = category;
        selectedEvidenceId = null;
        if (evidenceSummary) evidenceSummary.hidden = true;
        if (evidenceInspector) evidenceInspector.hidden = false;
        captureSignalPanel?.classList.add('is-inspecting');
        captureSignalPanel
          ?.querySelectorAll('[data-evidence-category]')
          .forEach((button) =>
            button.setAttribute(
              'aria-selected',
              String(button.dataset.evidenceCategory === category),
            ),
          );
        renderEvidenceFeed(liveEvidenceContext, category);
        startLiveEvidencePolling();
        requestAnimationFrame(() =>
          evidenceInspector?.querySelector('.voidr-live-evidence-back')?.focus(),
        );
      };

      const showEvidenceSummary = () => {
        activeEvidenceCategory = null;
        selectedEvidenceId = null;
        if (evidenceSummary) evidenceSummary.hidden = false;
        if (evidenceInspector) evidenceInspector.hidden = true;
        captureSignalPanel?.classList.remove('is-inspecting');
        startLiveEvidencePolling();
        requestAnimationFrame(() =>
          captureSignalPanel?.querySelector('[data-evidence-category]')?.focus(),
        );
      };

      captureSignalPanel?.querySelectorAll('[data-evidence-category]').forEach((button) => {
        button.addEventListener('click', () =>
          showEvidenceCategory(button.dataset.evidenceCategory),
        );
      });
      evidenceInspector
        ?.querySelector('.voidr-live-evidence-back')
        ?.addEventListener('click', showEvidenceSummary);
      const onEvidenceKeyDown = (event) => {
        if (event.key !== 'Escape' || captureSignalPanel?.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        if (activeEvidenceCategory) showEvidenceSummary();
        else {
          captureSignalPanel.hidden = true;
          captureButton?.setAttribute('aria-expanded', 'false');
          if (liveEvidenceTimer) clearInterval(liveEvidenceTimer);
        }
      };
      document.addEventListener('keydown', onEvidenceKeyDown, true);
      captureSignalCleanup = () => {
        document.removeEventListener('click', onProductClick, true);
        window.removeEventListener('error', onProductError, true);
        window.removeEventListener('unhandledrejection', onProductError, true);
        document.removeEventListener('voidr:verificationAnnotationSaved', onAnnotationSaved);
        document.removeEventListener('keydown', onEvidenceKeyDown, true);
        if (liveEvidenceTimer) clearInterval(liveEvidenceTimer);
        resourceObserver?.disconnect();
      };
      renderCaptureSignals();
      recordingStartedAt = Date.now();
      const updateElapsed = () => {
        const seconds = Math.max(0, Math.floor((Date.now() - recordingStartedAt) / 1000));
        const minutes = Math.floor(seconds / 60);
        const remainder = seconds % 60;
        if (elapsed)
          elapsed.textContent = `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
        signalHelpers?.observeUrl(captureSignals, verificationPageUrl());
        renderCaptureSignals();
      };
      updateElapsed();
      recordingTimer = setInterval(updateElapsed, 1000);
      const renderVoiceState = (state, detail = {}) => {
        voiceButton?.classList.toggle('is-listening', state === 'listening');
        voiceButton?.classList.toggle('is-busy', state === 'starting' || state === 'queued');
        voiceButton?.classList.toggle('is-unavailable', state === 'unavailable');
        voiceButton?.setAttribute('aria-pressed', String(state === 'listening'));
        if (voiceButton) {
          voiceButton.disabled = state === 'starting';
          const label = voiceButton.querySelector('span');
          if (label) {
            label.textContent =
              state === 'starting'
                ? 'Abrindo…'
                : state === 'listening'
                  ? 'Ouvindo'
                  : state === 'queued'
                    ? 'Salvando…'
                    : 'Voz';
          }
          voiceButton.title =
            state === 'unavailable'
              ? 'Microfone indisponível. A gravação de tela continua normalmente.'
              : state === 'listening'
                ? 'Parar nota de voz'
                : 'Adicionar uma nota de voz ao replay';
        }
        if (voiceCaption) {
          const transcript = String(detail.transcript || '').trim();
          voiceCaption.hidden = !transcript && state !== 'unavailable';
          voiceCaption.textContent = transcript
            ? `“${transcript.slice(0, 180)}”`
            : state === 'unavailable'
              ? 'Sem acesso ao microfone. A captura de tela não foi interrompida.'
              : '';
        }
      };
      voiceButton?.addEventListener('click', async () => {
        if (voiceButton.disabled) return;
        if (voiceActive) {
          renderVoiceState('queued');
          try {
            await verificationRuntimeMessage({
              action: 'voidr:stopVerificationVoice',
              verificationId: options.verification.verificationId,
              generation: options.verification.generation,
            });
            voiceActive = false;
            incrementCaptureSignal('voiceNotes');
            renderVoiceState('stopped');
          } catch (error) {
            renderVoiceState('unavailable', { error: error?.message });
          }
          return;
        }
        renderVoiceState('starting');
        try {
          await verificationRuntimeMessage({
            action: 'voidr:startVerificationVoice',
            verificationId: options.verification.verificationId,
            generation: options.verification.generation,
            baseOffsetMs: Date.now() - recordingStartedAt,
            language: document.documentElement.lang || navigator.language || 'pt-BR',
          });
          voiceActive = true;
          renderVoiceState('listening');
        } catch (error) {
          voiceActive = false;
          renderVoiceState('unavailable', { error: error?.message });
        }
      });
      voiceStatusListener = (message) => {
        if (message.action !== 'voidr:verificationVoiceStatus') return;
        if (message.state === 'stopped') voiceActive = false;
        renderVoiceState(message.state, message);
        const transcript = String(message.transcript || '').trim();
        const voiceKey = String(message.segmentId || transcript);
        if (transcript && !trackedVoiceSegments.has(voiceKey)) {
          trackedVoiceSegments.add(voiceKey);
          void verificationRuntimeMessage({
            action: 'voidr:trackRecordingVoice',
            lifecycleGeneration,
            input: {
              transcript,
              segmentId: message.segmentId,
              pageUrl: verificationPageUrl(),
              timestampMs: Date.now() - recordingStartedAt,
              language: document.documentElement.lang || navigator.language || 'pt-BR',
            },
          }).catch(() => {});
        }
      };
      chrome.runtime.onMessage.addListener(voiceStatusListener);
      captureButton?.addEventListener('click', (event) => {
        event.stopPropagation();
        const willOpen = captureSignalPanel.hidden;
        captureSignalPanel.hidden = !willOpen;
        captureButton.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) {
          annotationTools.hidden = true;
          annotationButton?.setAttribute('aria-expanded', 'false');
          showEvidenceSummary();
        } else if (liveEvidenceTimer) {
          clearInterval(liveEvidenceTimer);
          liveEvidenceTimer = null;
        }
      });
      // The toolbar is already visible at this point. Do not block control
      // binding on a lifecycle network round-trip: a slow ingest used to leave
      // "Finalizar" visible but inert until the page was reloaded.
      void verificationRuntimeMessage({
        action: 'voidr:verificationIngest',
        verificationId: options.verification.verificationId,
        generation: options.verification.generation,
        endpoint: 'lifecycle-events',
        idempotencyKey: `recording-started:${options.verification.generation}`,
        queueWhenOffline: true,
        input: {
          version: 'HIL/1',
          type: 'recording.started',
          occurredAt: new Date().toISOString(),
          payload: { pageUrl: verificationPageUrl() },
        },
      }).catch(() => {});
      window.addEventListener(
        'online',
        () => {
          verificationRuntimeMessage({
            action: 'voidr:flushVerificationQueue',
            verificationId: options.verification.verificationId,
            generation: options.verification.generation,
          }).catch(() => {});
        },
        { once: true },
      );
    }

    // Handlers
    let voidrPaused = false;
    const pauseBtn = panel.querySelector('#voidr-rec-pause');
    const PAUSE_SVG = voidrIcon('Pause', 14);
    const PLAY_SVG = voidrIcon('Play', 14);
    pauseBtn?.addEventListener('click', () => {
      voidrPaused = !voidrPaused;
      chrome.runtime.sendMessage(
        {
          action: voidrPaused ? 'voidr:pauseSession' : 'voidr:resumeSession',
          lifecycleGeneration,
        },
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
    panel.querySelector('#voidr-rec-rollback')?.addEventListener('click', (event) => {
      const restartBtn = event.currentTarget;
      restartBtn.disabled = true;
      chrome.runtime.sendMessage(
        { action: 'voidr:discardSession', lifecycleGeneration },
        (response) => {
          const error = chrome.runtime.lastError?.message || response?.error;
          if (!response?.success || error) {
            restartBtn.disabled = false;
            showDiscardFailedBanner(error);
            return;
          }
          border.remove();
          panel.remove();
          if (recordingTimer) clearInterval(recordingTimer);
          if (annotationShortcut) document.removeEventListener('keydown', annotationShortcut, true);
          if (voiceStatusListener) chrome.runtime.onMessage.removeListener(voiceStatusListener);
          captureSignalCleanup?.();
          document.querySelectorAll('.voidr-rec-countdown').forEach((n) => n.remove());
          startVoidrSessionRecording(testCaseName, { ...options, skipCountdown: false });
        },
      );
    });

    // Excluir: confirma antes de encerrar/descartar a sessão (não salva).
    panel.querySelector('#voidr-rec-delete')?.addEventListener('click', (event) => {
      const ok = window.confirm(
        'Descartar esta sessão? A gravação atual será perdida e não será salva.',
      );
      if (!ok) return;
      const deleteBtn = event.currentTarget;
      deleteBtn.disabled = true;
      chrome.runtime.sendMessage(
        { action: 'voidr:discardSession', lifecycleGeneration },
        (response) => {
          const error = chrome.runtime.lastError?.message || response?.error;
          if (!response?.success || error) {
            deleteBtn.disabled = false;
            showDiscardFailedBanner(error);
            return;
          }
          border.remove();
          panel.remove();
          if (recordingTimer) clearInterval(recordingTimer);
          if (annotationShortcut) document.removeEventListener('keydown', annotationShortcut, true);
          if (voiceStatusListener) chrome.runtime.onMessage.removeListener(voiceStatusListener);
          captureSignalCleanup?.();
          document.querySelectorAll('.voidr-rec-countdown').forEach((n) => n.remove());
          showDiscardedBanner();
        },
      );
    });

    const finishRecording = async (event) => {
      const stopBtn = event.currentTarget;
      const spinnerSvg = `<span class="voidr-rec-spinner">${voidrIcon('Loader', 14)}</span>`;

      // sessionCaptured is emitted by the background as soon as the collector
      // seal exists. Keep this panel mounted until the Verification seal and
      // harness handoff have rendered their own truthful terminal state.
      if (options.verification) panel.dataset.voidrFinalizing = 'true';

      if (options.verification && voiceActive) {
        stopBtn.disabled = true;
        stopBtn.innerHTML = `${spinnerSvg} Salvando voz…`;
        try {
          await verificationRuntimeMessage({
            action: 'voidr:stopVerificationVoice',
            verificationId: options.verification.verificationId,
            generation: options.verification.generation,
          });
        } catch (_) {
          // The PCM segment is already in the extension outbox. The seal retry
          // owns delivery and will not revoke the capability until it is sent.
        }
        voiceActive = false;
        recordCaptureSignal('voiceNotes');
      }

      if (options.verification) {
        renderVerificationHandoff(panel, 'stopping', options);
      } else if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.innerHTML = `${spinnerSvg} Finalizando gravação...`;
      }

      const activeRunId = options.onboardingRunId || undefined;
      let sessionId = null;
      let allSessionIds = [];
      let stopResult = null;

      try {
        stopResult = await Promise.race([
          new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                action: 'voidr:sessionStopped',
                onboardingRunId: activeRunId,
                lifecycleGeneration,
                stopCapability,
              },
              (res) => {
                if (chrome.runtime.lastError) {
                  resolve({
                    success: false,
                    finalized: false,
                    error: chrome.runtime.lastError.message,
                  });
                  return;
                }
                resolve(res || { success: false, finalized: false });
              },
            );
          }),
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  success: false,
                  finalized: false,
                  timeout: true,
                  error: 'Recording stop timed out',
                }),
              25000,
            ),
          ),
        ]);
      } catch (error) {
        stopResult = {
          success: false,
          finalized: false,
          error: error?.message || String(error),
        };
      }

      const captureConfirmed =
        typeof globalThis.VoidrSessionStopHelpers !== 'undefined'
          ? globalThis.VoidrSessionStopHelpers.isConfirmedCapture(stopResult)
          : stopResult?.success === true && stopResult?.finalized === true;
      if (!captureConfirmed) {
        if (options.verification) {
          renderVerificationHandoff(panel, 'failed', options, {
            error: stopResult?.error,
            onRetry: finishRecording,
          });
        } else if (stopBtn) {
          stopBtn.disabled = false;
          stopBtn.textContent = 'Tentar novamente';
          stopBtn.title = stopResult?.error || 'Não foi possível finalizar a gravação';
        }
        showCaptureFailedBanner();
        return;
      }

      sessionId = stopResult.sessionId || null;
      allSessionIds = stopResult.sessionIds || (sessionId ? [sessionId] : []);

      // Só afirmamos "capturada" se o servidor confirmar que a sessão persistiu.
      // Sem isto o banner verde aparecia sempre (até quando o stop dava timeout
      // sem sessionId), gerando falso positivo.
      let validated = false;
      let loopAttachmentConfirmed = stopResult?.attachmentPending !== true;
      let verificationSealResult = null;
      if (allSessionIds.length > 0) {
        if (options.verification) {
          renderVerificationHandoff(panel, 'sealing', options);
        } else if (stopBtn) {
          stopBtn.innerHTML = `${spinnerSvg} Seal confirmado · indexando...`;
        }

        // Generic sessions still use the authenticated lookup. Verification has
        // a stronger gate below: ensure-indexed + the generation-bound seal.
        const latestSid = sessionId || allSessionIds[allSessionIds.length - 1];
        if (!options.verification) {
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
        }

        // If the durable seal succeeded but the background attach failed, retry
        // only the idempotent binding. Never invoke Stop again: that would append
        // new chunks to an already sealed collector session.
        if (mode === 'loop-test' && options.loopTest && stopResult?.attachmentPending === true) {
          loopAttachmentConfirmed = await retryLoopTestAttachment(
            options.loopTest,
            latestSid,
            stopResult.lifecycleGeneration,
          );
        }

        if (mode !== 'loop-test' || loopAttachmentConfirmed) {
          for (const sid of allSessionIds) {
            broadcastSessionToOnboarding(
              sid,
              activeRunId,
              options.evidence,
              loopTestBroadcastPayload(options.loopTest),
            );
          }
        }
        lastCapturedSessionId = latestSid;

        if (mode === 'loop-test' && options.loopTest && loopAttachmentConfirmed) {
          await recordLoopTestSessionCaptured(options.loopTest, latestSid);
        }
        if (options.verification) {
          renderVerificationHandoff(panel, 'context', options);
          try {
            verificationSealResult = await verificationRuntimeMessage({
              action: 'voidr:verificationSeal',
              verificationId: options.verification.verificationId,
              generation: options.verification.generation,
              verification: stopResult.verification || options.verification,
              stopResult,
            });
            validated = true;
          } catch (error) {
            console.warn('[Voidr Verification] seal failed:', error?.message || error);
            validated = false;
          }
        }
      }

      border.remove();
      if (recordingTimer) clearInterval(recordingTimer);
      if (annotationShortcut) document.removeEventListener('keydown', annotationShortcut, true);
      if (voiceStatusListener) chrome.runtime.onMessage.removeListener(voiceStatusListener);
      captureSignalCleanup?.();
      document.querySelectorAll('.voidr-rec-countdown').forEach((n) => n.remove());
      if (options.verification) {
        const handoffState =
          validated && verificationSealResult?.verification?.harness == null
            ? 'product_ready'
            : (globalThis.VoidrVerificationHandoffUx?.stateFromDelivery(
                verificationSealResult?.verification?.harnessDelivery,
              ) ?? (validated ? 'product_ready' : 'pending'));
        renderVerificationHandoff(panel, validated ? handoffState : 'pending', options, {
          verification: verificationSealResult?.verification,
        });
        if (validated && handoffState === 'available') {
          void monitorVerificationHandoffAck(panel, options, verificationSealResult?.verification);
        }
        return;
      }
      panel.remove();
      if (mode === 'loop-test' && options.loopTest && loopAttachmentConfirmed) {
        showLoopTestDoneBanner(options.loopTest);
      } else if (mode === 'loop-test' && options.loopTest) {
        showLoopTestAttachmentPendingBanner();
      } else if (validated) {
        showRecordingDoneBanner(mode);
      } else if (allSessionIds.length > 0) {
        /**
         * Session captured and send to collector
         * But confirmation still not on the validation window
         * This may be a fake-negative, so we can't affirm failure
         */
        showCapturePendingBanner(mode);
      }
    };
    panel.querySelector('#voidr-rec-stop')?.addEventListener('click', finishRecording);
  } catch (e) {
    console.error('Voidr session recording error:', e);
    document
      .querySelectorAll('.voidr-rec-border, .voidr-rec-countdown, .voidr-rec-panel')
      .forEach((node) => node.remove());
    if (options.mode === 'loop-test') {
      reportLoopStartupFailure(
        'Não foi possível preparar o gravador neste site. Atualize a página e tente novamente.',
      );
    }
  }
}

// ── Recording result banners ─────────────────────────────────────────────────

function showDiscardedBanner() {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done voidr-onb-done--discard';
  banner.innerHTML = `
    ${voidrIcon('CircleX', 14)}
    Sessão descartada.
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 6000);
}

function showDiscardFailedBanner(reason) {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done voidr-onb-done--warn';
  const message =
    typeof reason === 'string' && reason
      ? reason
      : 'Não foi possível descartar a gravação. Aguarde a finalização ou tente novamente.';
  banner.textContent = `A gravação continua ativa. ${message}`;
  document.documentElement.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 10000);
}

function showCaptureFailedBanner() {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done voidr-onb-done--warn';
  banner.innerHTML = `
    ${voidrIcon('AlertCircle', 14)}
    A gravação não foi selada. Clique em “Tentar novamente”; seus dados continuam preservados.
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 10000);
}

function showLoopTestAttachmentPendingBanner() {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done voidr-onb-done--warn';
  banner.innerHTML = `
    ${voidrIcon('AlertCircle', 14)}
    Gravação selada e preservada. O vínculo com o Loop ficou pendente; não grave novamente.
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 12000);
}

function showCapturePendingBanner(mode) {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done voidr-onb-done--pending';
  const where =
    mode === 'onboarding'
      ? 'na sessão vinculada'
      : mode === 'evidence'
        ? 'na execução manual'
        : 'na extensão';
  banner.innerHTML = `
    ${voidrIcon('Clock', 14)}
    Gravação selada e em indexação — pode levar alguns segundos para aparecer ${where}. Não precisa gravar de novo.
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 12000);
}

function showRecordingDoneBanner(mode) {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done';
  const message =
    mode === 'onboarding'
      ? 'Sessão capturada com sucesso — pode fechar esta aba e voltar à Voidr.'
      : mode === 'evidence'
        ? 'Evidência capturada com sucesso — pode fechar esta aba e voltar à execução manual.'
        : mode === 'verification'
          ? 'Artifact VAP criado — acompanhe o diagnóstico e a decisão humana na Evidence Room.'
          : 'Sessão capturada com sucesso — pode fechar esta aba e voltar à extensão.';
  banner.innerHTML = `
    ${voidrIcon('CheckCircle2', 14)}
    ${message}
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 15000);
}

function broadcastSessionToOnboarding(sessionId, onboardingRunId, evidence, loopTest) {
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
      // In loop-test mode, carry the scenario coordinates so the platform/service
      // can attach this session as one of the scenario's baseline samples.
      loopTest: loopTest || undefined,
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
    case 'voidr:startSessionRecording':
      startVoidrSessionRecording(request.testCaseName || 'Test Case', {
        mode: request.mode,
        slug: request.slug,
        applicationId: request.applicationId,
        environmentSlug: request.environmentSlug,
        apiKey: request.apiKey,
        onboardingRunId: request.onboardingRunId,
        code: request.code,
        flows: request.flows || [],
        evidence: request.evidence,
        loopTest: request.loopTest,
      });
      break;
    case 'voidr:startVerificationRecording':
      (async () => {
        const apiKey = await resolveCollectorApiKey();
        if (!apiKey) {
          sendResponse({ success: false, error: 'Collector API key is unavailable' });
          return;
        }
        try {
          await startVoidrSessionRecording(request.verification?.mission || 'Verification', {
            mode: 'verification',
            applicationId: request.verification?.applicationId,
            apiKey,
            verification: request.verification,
          });
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, error: error?.message || String(error) });
        }
      })();
      return true;
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
        loopTest: request.loopTest,
        verification: request.verification,
        skipCountdown: request.showCountdown !== true,
        collectorAlreadyInitialized: true,
        lifecycleGeneration: request.lifecycleGeneration,
        stopCapability: request.stopCapability,
      });
      break;
    case 'voidr:sessionCaptured':
      if (request.sessionId) {
        const activeHandoffPanel = document.querySelector(
          '.voidr-rec-panel[data-voidr-finalizing="true"]',
        );
        const preserveHandoff = Boolean(
          request.loopTest &&
            activeHandoffPanel &&
            (!request.lifecycleGeneration ||
              activeHandoffPanel.dataset.voidrLifecycleGeneration === request.lifecycleGeneration),
        );
        document
          .querySelectorAll(
            preserveHandoff
              ? '.voidr-rec-border, .voidr-rec-countdown'
              : '.voidr-rec-border, .voidr-rec-countdown, .voidr-rec-panel',
          )
          .forEach((node) => node.remove());
        lastCapturedSessionId = request.sessionId;
        // The in-page finalizer performs the post-attach broadcast after the
        // Verification seal. Avoid duplicating it while that controller owns
        // the handoff UI.
        if (!preserveHandoff) {
          broadcastSessionToOnboarding(
            request.sessionId,
            request.onboardingRunId,
            request.evidence,
            request.loopTest,
          );
        }
        // Loop-test stops render their own banner (with the next-session action)
        // in the recording tab — skip the generic one here.
        if (!request.loopTest) {
          showRecordingDoneBanner(request.evidence ? 'evidence' : undefined);
        }
      }
      break;
  }
});

// ── Evidence deep-link (platform -> extension) ───────────────────────────────
// For manual test execution the platform opens the app URL with recording
// params (voidr_record=1&voidr_mode=evidence&voidr_plan_id=...&…). Unlike the
// recording-code flow — which pairs through the popup + a VDR code — evidence mode is
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

// Strip every voidr_* deep-link param (including the loop-test capability
// token) from the address bar BEFORE recording starts: rrweb captures the
// page URL, so anything left in location.search leaks into the session's
// initialUrl/navigation events. Everything else in the URL (foreign query
// params, hash) is preserved. The parsed deep-link object already holds all
// the coordinates the flow needs, so nothing downstream reads them from the
// URL again ("next session" reloads rebuild the params from memory).
function stripVoidrParamsFromUrl() {
  try {
    const url = new URL(window.location.href);
    const voidrKeys = [...url.searchParams.keys()].filter((k) => k.startsWith('voidr_'));
    if (voidrKeys.length === 0) return;
    voidrKeys.forEach((k) => url.searchParams.delete(k));
    history.replaceState(history.state, '', url.toString());
  } catch (_) {}
}

function consumeStagedLoopTestDeepLink() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'voidr:consumeLoopDeepLink' }, (response) => {
        if (chrome.runtime.lastError || !response?.staged) {
          resolve(null);
          return;
        }
        resolve(response.staged);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function reportLoopStartupFailure(reason, lifecycleGeneration = null) {
  try {
    chrome.runtime.sendMessage(
      {
        action: 'voidr:loopStartupFailed',
        reason,
        lifecycleGeneration,
      },
      () => void chrome.runtime.lastError,
    );
  } catch (_) {}
}

function clearLoopLaunchStatus() {
  document.querySelectorAll('.voidr-loop-launch-status').forEach((node) => node.remove());
}

function showLoopLaunchStatus(state, code = null) {
  clearLoopLaunchStatus();
  const isError = state === 'error';
  const copy =
    code === 'malformed_bootstrap' || code === 'missing_capability'
      ? {
          title: 'Link de gravação incompleto',
          detail: 'Gere um novo link no Cursor ou na Voidr. Nenhuma gravação foi iniciada.',
        }
      : code === 'extension_unavailable' || code === 'stage_timeout'
        ? {
            title: 'Voidr Capture precisa ser recarregada',
            detail: 'Recarregue a extensão e abra novamente o link do ciclo.',
          }
        : code === 'authorization_failed'
          ? {
              title: 'Este ciclo não está mais disponível',
              detail: 'O link expirou ou o Loop foi removido. Gere um novo ciclo para continuar.',
            }
          : {
              title: 'Preparando o ciclo',
              detail: 'Validando o link e conectando o gravador…',
            };
  const panel = markVerificationOverlay(document.createElement('section'));
  panel.className = `voidr-loop-launch-status${isError ? ' is-error' : ''}`;
  panel.setAttribute('role', isError ? 'alert' : 'status');
  panel.setAttribute('aria-live', 'polite');
  panel.innerHTML = `
    <div class="voidr-loop-launch-brand">
      <img src="${escapeHtml(chrome.runtime.getURL('assets/logo-light.svg'))}" alt="Voidr" />
    </div>
    <div class="voidr-loop-launch-indicator" aria-hidden="true">${
      isError ? voidrIcon('AlertCircle', 16) : '<span></span>'
    }</div>
    <div class="voidr-loop-launch-copy">
      <strong>${copy.title}</strong>
      <small>${copy.detail}</small>
    </div>
    ${
      isError
        ? '<button type="button" class="voidr-loop-launch-open">Abrir Voidr Capture</button>'
        : ''
    }
  `;
  panel.querySelector('.voidr-loop-launch-open')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'focusOrOpenPopup' }, () => void chrome.runtime.lastError);
  });
  document.documentElement.appendChild(panel);
}

function validateLoopTestRecording(deepLink) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: 'voidr:validateLoopRecordingToken',
        scenarioId: deepLink.scenarioId,
        token: deepLink.token,
        cycleId: deepLink.cycleId,
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          resolve({
            valid: false,
            error:
              response?.error ||
              chrome.runtime.lastError?.message ||
              'A autorização de gravação expirou.',
          });
          return;
        }
        resolve(response.data || null);
      },
    );
  });
}

async function maybeStartLoopTestFromDeepLink() {
  if (window.__voidr_loop_test_started__) return;
  let stageResult = null;
  if (globalThis.__voidrLoopBootstrapStagePromise) {
    stageResult = await Promise.race([
      globalThis.__voidrLoopBootstrapStagePromise,
      new Promise((resolve) =>
        setTimeout(() => resolve({ ok: false, code: 'stage_timeout' }), 1500),
      ),
    ]);
    delete globalThis.__voidrLoopBootstrapStagePromise;
  }
  const bootstrapFailure =
    globalThis.__voidrLoopBootstrapFailureCode ||
    (stageResult?.ok === false ? stageResult.code : null);
  delete globalThis.__voidrLoopBootstrapFailureCode;
  if (bootstrapFailure) {
    showLoopLaunchStatus('error', bootstrapFailure);
    reportLoopStartupFailure(
      bootstrapFailure === 'malformed_bootstrap' || bootstrapFailure === 'missing_capability'
        ? 'O link de gravação está incompleto. Gere um novo link no Cursor ou na Voidr.'
        : 'A Voidr Capture precisa ser recarregada antes de abrir o link.',
    );
    return;
  }
  const deepLink = await consumeStagedLoopTestDeepLink();
  if (!deepLink) {
    if (stageResult) showLoopLaunchStatus('error', 'stage_timeout');
    return;
  }
  window.__voidr_loop_test_started__ = true;
  showLoopLaunchStatus('starting');

  const scenarioId = deepLink.scenarioId;
  const context = await validateLoopTestRecording(deepLink);
  deepLink.token = null;
  if (!context?.valid || !context.collectorApiKey) {
    console.warn('[Voidr] Loop Test recording authorization failed');
    reportLoopStartupFailure(
      /expired|401|403|unauthorized/i.test(context?.error || '')
        ? 'O link de gravação expirou. Gere um novo link pela extensão.'
        : 'Não foi possível autorizar a gravação do Loop.',
      context?.lifecycleGeneration,
    );
    showLoopLaunchStatus('error', 'authorization_failed');
    window.__voidr_loop_test_started__ = false;
    return;
  }

  clearLoopLaunchStatus();
  await startVoidrSessionRecording(context.scenarioName || 'Loop Test', {
    mode: 'loop-test',
    slug: context.applicationId,
    applicationId: context.applicationId,
    apiKey: context.collectorApiKey,
    loopTest: {
      scenarioId,
      cycleId: context.verification?.cycleId || context.verification?.verificationId,
      cycleNumber: context.verification?.cycleNumber,
    },
    verification: context.verification,
    lifecycleGeneration: context.lifecycleGeneration,
  });
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

  // Deep link parsed — remove the voidr_* params so they never enter the capture.
  stripVoidrParamsFromUrl();

  const apiKey = await resolveCollectorApiKey();
  if (!apiKey) {
    console.warn(
      '[Voidr] Evidence deep-link detected but no collector API key (not authenticated?)',
    );
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

// ── Loop-test deep-link (voidr-service -> extension) ─────────────────────────
// The loop-test MCP flow generates a signed recording URL:
//   {targetUrl}?voidr_record=1&voidr_mode=loop-test
//     &voidr_scenario_id={scenarioId}&voidr_token={token}&voidr_session_n={n}
// Like evidence mode, this is fully deep-link driven: on page load we auto-start
// a loop-test recording. The scenario expects a SINGLE baseline session: after
// Stop the session is attached and the done-banner shows the completed state.

const LOOP_TEST_MAX_ATTEMPTS = 1;
const LOOP_TEST_PROGRESS_STORAGE_KEY = 'voidrLoopTestProgress';

function parseLoopTestDeepLink() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('voidr_record') !== '1') return null;
    if (params.get('voidr_mode') !== 'loop-test') return null;
    const scenarioId = params.get('voidr_scenario_id');
    if (!scenarioId) return null;
    const rawN = parseInt(params.get('voidr_session_n') || '1', 10);
    const attemptIndex = Number.isInteger(rawN)
      ? Math.min(Math.max(rawN, 1), LOOP_TEST_MAX_ATTEMPTS)
      : 1;
    return {
      applicationId: params.get('voidr_application_id') || undefined,
      loopTest: {
        scenarioId,
        attemptIndex,
        maxAttempts: LOOP_TEST_MAX_ATTEMPTS,
        token: params.get('voidr_token') || undefined,
      },
    };
  } catch (_) {
    return null;
  }
}

function shortLoopTestScenarioId(scenarioId) {
  const id = String(scenarioId || '');
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

// Real scenario name resolved (async, best-effort) from the recording-token
// validate endpoint — per page load, keyed to the scenario it belongs to.
let loopTestScenarioName = null;

function buildLoopTestTitleHtml(loopTest) {
  const counter = 'Loop Test — Gravação';
  const nameHtml =
    loopTestScenarioName?.scenarioId === loopTest.scenarioId && loopTestScenarioName.name
      ? ` — &quot;${escapeHtml(loopTestScenarioName.name)}&quot;`
      : '';
  return `${counter}${nameHtml} <span class="voidr-rec-scenario">${escapeHtml(shortLoopTestScenarioId(loopTest.scenarioId))}</span>`;
}

// Validate the recording token on voidr-service (public, token-authenticated)
// to fetch the scenario name for the panel. Purely cosmetic: recording start
// never blocks on this, and any failure keeps the short-id-only title.
function validateLoopTestRecordingToken(loopTest) {
  return new Promise((resolve) => {
    if (!loopTest?.scenarioId || !loopTest.token) {
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(
        {
          action: 'apiRequest',
          endpoint: '/loop-test/scenarios/recording-token/validate',
          method: 'POST',
          data: { token: loopTest.token, scenarioId: loopTest.scenarioId },
        },
        (res) => {
          if (chrome.runtime.lastError || !res?.success) {
            resolve(null);
            return;
          }
          const data = res.data?.data || res.data || {};
          resolve(data && typeof data === 'object' ? data : null);
        },
      );
    } catch (_) {
      resolve(null);
    }
  });
}

function refreshLoopTestPanelTitle(loopTest) {
  try {
    const title = document.querySelector('.voidr-rec-panel--loop-test .voidr-rec-title');
    if (title) title.innerHTML = buildLoopTestTitleHtml(loopTest);
  } catch (_) {}
}

function getLoopTestProgress() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([LOOP_TEST_PROGRESS_STORAGE_KEY], (res) => {
        resolve(res?.[LOOP_TEST_PROGRESS_STORAGE_KEY] || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function setLoopTestProgress(progress) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [LOOP_TEST_PROGRESS_STORAGE_KEY]: progress }, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function clearLoopTestProgress() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove([LOOP_TEST_PROGRESS_STORAGE_KEY], () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

// Progress survives reloads and service-worker restarts in chrome.storage.local:
// { scenarioId, attemptIndex, maxAttempts, sessionsCaptured[], startUrl, updatedAt }
async function syncLoopTestProgressOnStart(loopTest) {
  const existing = await getLoopTestProgress();
  const sameScenario = existing?.scenarioId === loopTest.scenarioId;
  const progress = {
    scenarioId: loopTest.scenarioId,
    attemptIndex: loopTest.attemptIndex,
    maxAttempts: loopTest.maxAttempts || LOOP_TEST_MAX_ATTEMPTS,
    sessionsCaptured:
      sameScenario && Array.isArray(existing.sessionsCaptured) ? existing.sessionsCaptured : [],
    // Every session restarts from the same entry point: keep the original
    // deep-link URL of session 1 so "next session" reloads land there even if
    // the user navigated away during the recording.
    startUrl: sameScenario && existing.startUrl ? existing.startUrl : window.location.href,
    updatedAt: Date.now(),
  };
  await setLoopTestProgress(progress);
  return progress;
}

async function recordLoopTestSessionCaptured(loopTest, sessionId) {
  const existing = await getLoopTestProgress();
  const sameScenario = existing?.scenarioId === loopTest.scenarioId;
  const sessionsCaptured =
    sameScenario && Array.isArray(existing.sessionsCaptured) ? existing.sessionsCaptured : [];
  if (sessionId && !sessionsCaptured.includes(sessionId)) sessionsCaptured.push(sessionId);
  await setLoopTestProgress({
    scenarioId: loopTest.scenarioId,
    attemptIndex: loopTest.attemptIndex,
    maxAttempts: loopTest.maxAttempts || LOOP_TEST_MAX_ATTEMPTS,
    sessionsCaptured,
    startUrl: (sameScenario && existing.startUrl) || window.location.href,
    updatedAt: Date.now(),
  });
}

// Broadcast payload never carries the recording token — only the coordinates
// the platform needs to attach the session to the scenario.
function loopTestBroadcastPayload(loopTest) {
  if (!loopTest) return undefined;
  return {
    scenarioId: loopTest.scenarioId,
    cycleId: loopTest.cycleId,
    cycleNumber: loopTest.cycleNumber,
    attemptIndex: loopTest.attemptIndex,
  };
}

function retryLoopTestAttachment(loopTest, sessionId, lifecycleGeneration) {
  return new Promise((resolve) => {
    if (!loopTest?.scenarioId || !sessionId || !lifecycleGeneration) {
      resolve(false);
      return;
    }
    try {
      chrome.runtime.sendMessage(
        {
          action: 'voidr:retryLoopAttach',
          scenarioId: loopTest.scenarioId,
          sessionId,
          lifecycleGeneration,
        },
        (res) => {
          if (chrome.runtime.lastError || res?.attached !== true) {
            console.warn(
              '[Voidr] Sealed Loop session attachment retry failed:',
              chrome.runtime.lastError?.message || res?.error || 'unknown error',
            );
            resolve(false);
            return;
          }
          resolve(true);
        },
      );
    } catch (error) {
      console.warn('[Voidr] Sealed Loop session attachment retry failed:', error?.message || error);
      resolve(false);
    }
  });
}

// Legacy single-recording completion uses the same product-native destination
// as Verification. There is no second Loop UI inside the extension.
async function showLoopTestDoneBanner(loopTest) {
  document.querySelectorAll('.voidr-onb-done, .voidr-loop-banner').forEach((n) => n.remove());
  const scenarioShort = shortLoopTestScenarioId(loopTest.scenarioId);

  const banner = document.createElement('div');
  banner.className = 'voidr-loop-banner voidr-loop-banner--complete';
  banner.innerHTML = `
    ${voidrIcon('CheckCircle2', 14)}
    <span>Gravação concluída — o primeiro ciclo do loop foi iniciado <span class="voidr-loop-banner-scenario">${escapeHtml(scenarioShort)}</span></span>
    <button class="voidr-loop-banner-btn" id="voidr-loop-open-panel">
      ${voidrIcon('PanelRight', 14)}
      Acompanhar loop
    </button>
  `;
  document.documentElement.appendChild(banner);
  banner.querySelector('#voidr-loop-open-panel')?.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage(
        { action: 'voidr:openLoop', scenarioId: loopTest.scenarioId },
        () => {
          void chrome.runtime.lastError;
        },
      );
    } catch (_) {}
  });
  await clearLoopTestProgress();
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 15000);
}

async function showLoopCycleDoneBanner(loopTest) {
  document.querySelectorAll('.voidr-onb-done, .voidr-loop-banner').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-loop-banner voidr-loop-banner--complete';
  banner.innerHTML = `
    ${voidrIcon('CheckCircle2', 14)}
    <span>Ciclo #${Number(loopTest.cycleNumber) || 1} concluído. A Voidr pode consolidar as evidências para o agente de código.</span>
    <button class="voidr-loop-banner-btn" id="voidr-loop-open-cycle">Consolidar e resolver</button>
  `;
  markVerificationOverlay(banner);
  document.documentElement.appendChild(banner);
  banner.querySelector('#voidr-loop-open-cycle')?.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage(
        {
          action: 'voidr:openLoopHandoff',
          scenarioId: loopTest.scenarioId,
          cycleId: loopTest.cycleId,
          agent: 'codex',
        },
        () => void chrome.runtime.lastError,
      );
    } catch (_) {}
  });
  await clearLoopTestProgress();
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 15000);
}

async function maybeStartLegacyLoopTestFromDeepLink() {
  if (window.__voidr_loop_test_started__) return;
  const deepLink = parseLoopTestDeepLink();
  if (!deepLink) return;
  window.__voidr_loop_test_started__ = true;

  // Deep link parsed — strip voidr_* params (ABOVE ALL the capability token)
  // before the recording starts, so neither the rrweb capture nor the stored
  // loop-test progress (startUrl) ever sees them. The token lives on only in
  // deepLink.loopTest.token (memory) for validate/attach/next-session.
  stripVoidrParamsFromUrl();

  const apiKey = await resolveCollectorApiKey();
  if (!apiKey) {
    console.warn(
      '[Voidr] Loop-test deep-link detected but no collector API key (not authenticated?)',
    );
    window.__voidr_loop_test_started__ = false;
    return;
  }

  await syncLoopTestProgressOnStart(deepLink.loopTest);

  const { loopTest } = deepLink;

  // Fire-and-forget: resolve the real scenario name for the panel title. The
  // recording (countdown + collector init) never waits on this; whenever it
  // resolves the panel title is refreshed in place.
  validateLoopTestRecordingToken(loopTest).then((info) => {
    const name = info?.name || info?.scenarioName || null;
    if (!name) return;
    loopTestScenarioName = { scenarioId: loopTest.scenarioId, name: String(name) };
    refreshLoopTestPanelTitle(loopTest);
  });

  const sessionName = `Loop Test ${shortLoopTestScenarioId(loopTest.scenarioId)} — Gravação`;
  startVoidrSessionRecording(sessionName, {
    mode: 'loop-test',
    slug: deepLink.applicationId,
    applicationId: deepLink.applicationId,
    apiKey,
    loopTest,
  });
}

// ── Recording-code auto-connect (platform -> extension) ──────────────────────

try {
  // Channel/event/action names are legacy wire identifiers retained for platform compatibility.
  const recordingCodeCompatibilityChannel = new BroadcastChannel('voidr-onboarding');
  recordingCodeCompatibilityChannel.onmessage = (event) => {
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
    maybeStartLoopTestFromDeepLink();
  });
} else {
  initVoidrExtension();
  maybeStartEvidenceFromDeepLink();
  maybeStartLoopTestFromDeepLink();
}
