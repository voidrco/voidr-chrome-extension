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
        try { ensureRefocusButtonPresent(); } catch (_) {}
      }, 3000);
    }
    ['visibilitychange', 'pageshow', 'focus', 'popstate', 'hashchange'].forEach((evt) => {
      try { window.addEventListener(evt, ensureRefocusButtonPresent, { passive: true }); } catch (_) {}
    });
  } catch (error) {
    console.error('Error initializing Voidr Extension:', error);
  }
}

// ── Refocus Button (Shadow DOM) ──────────────────────────────────────────────

function createRefocusButton() {
  try {
    const oldHost = document.getElementById('voidr-refocus-host');
    if (oldHost) oldHost.remove();

    const host = document.createElement('div');
    host.id = 'voidr-refocus-host';
    host.style.position = 'fixed';
    host.style.right = '16px';
    host.style.bottom = '16px';
    host.style.zIndex = '1000000';
    host.style.width = '56px';
    host.style.height = '56px';
    host.style.pointerEvents = 'auto';
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .btn {
        all: initial;
        display: inline-flex; align-items: center; justify-content: center;
        width: 56px; height: 56px; border-radius: 50%; background: #000; color: #fff;
        border: 1px solid rgba(255,255,255,0.18); cursor: pointer;
        box-shadow: 0 10px 30px rgba(0,0,0,0.45);
        transition: box-shadow 0.12s ease, transform 0.12s ease;
      }
      .btn:hover { box-shadow: 0 14px 36px rgba(0,0,0,0.55); transform: translateY(-1px); }
      svg { width: 26px; height: 26px; display: block; }
    `;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.title = 'Open Voidr Assistant';
    btn.innerHTML = `
      <svg viewBox="0 0 4521 4521" xmlns="http://www.w3.org/2000/svg" fill="white" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M2260.5 4521C3508.94 4521 4521 3508.94 4521 2260.49C4521 1012.06 3508.94 0 2260.5 0C1012.06 0 0 1012.06 0 2260.49C0 3508.94 1012.06 4521 2260.5 4521ZM3334.24 2024.28C3334.24 2154.74 3228.47 2260.49 3098.02 2260.49H2504.44C2373.99 2260.49 2268.22 2366.26 2268.22 2496.72V3098.01C2268.22 3228.48 2162.46 3334.24 2032.01 3334.24H1422.98C1292.52 3334.24 1186.76 3228.48 1186.76 3098.01V2496.72C1186.76 2366.26 1292.52 2260.49 1422.98 2260.49H2016.56C2147.01 2260.49 2252.78 2154.74 2252.78 2024.28V1422.99C2252.78 1292.52 2358.53 1186.76 2488.99 1186.76H3098.02C3228.47 1186.76 3334.24 1292.52 3334.24 1422.99V2024.28Z"/>
      </svg>
    `;
    shadow.appendChild(style);
    shadow.appendChild(btn);

    btn.addEventListener('click', () => {
      try {
        if (!chrome.runtime?.id) {
          window.location.reload();
          return;
        }
        const rect = host.getBoundingClientRect();
        const left = Math.round(rect.left + window.screenX - (420 - rect.width));
        const top = Math.round(rect.top + window.screenY - 550);
        chrome.runtime.sendMessage(
          { action: 'focusOrOpenPopup', position: { left, top } },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn('[Voidr] Could not open popup:', chrome.runtime.lastError.message);
              window.location.reload();
            }
          },
        );
      } catch (e) {
        window.location.reload();
      }
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
    return str.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  } catch (_) { return str; }
}

function buildRecordingContext(providedName, options = {}) {
  const mode = options.mode || 'test-case';
  const slug = options.slug || undefined;
  const timestamp = new Date().toISOString();
  const effectiveName = (providedName && String(providedName).trim())
    ? providedName
    : mode === 'defect'
      ? `Sample Defect ${timestamp}`
      : `Sample Test Case ${timestamp}`;
  const userId = mode === 'defect' ? 'voidr-defect-assistant' : 'voidr-test-case-assistant';
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
        flows: init.flows || undefined,
      },
    };
    if (init.applicationId) initOptions.applicationId = init.applicationId;
    if (init.mode === 'onboarding') initOptions.samplingRate = 1;

    chrome.runtime.sendMessage({ action: 'voidr:injectCollectorAndInit', initOptions }, () => {});
  } catch (_) {}
}

async function startVoidrSessionRecording(testCaseName, options = {}) {
  try {
    const { mode, slug, userId, effectiveName } = buildRecordingContext(testCaseName, options);

    document.querySelectorAll('.voidr-rec-border, .voidr-rec-countdown, .voidr-rec-panel').forEach((n) => n.remove());

    const border = document.createElement('div');
    border.className = 'voidr-rec-border' + (options.mode === 'defect' ? ' voidr-rec-border--defect' : '');
    document.documentElement.appendChild(border);

    if (!options.skipCountdown) {
      const countdown = document.createElement('div');
      countdown.className = 'voidr-rec-countdown';
      document.documentElement.appendChild(countdown);

      let value = 3;
      countdown.textContent = String(value);
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          value -= 1;
          if (value <= 0) { clearInterval(timer); resolve(); }
          else { countdown.textContent = String(value); }
        }, 1000);
      });
      countdown.remove();
    }

    // Recording panel
    const recFlows = options.flows || [];
    const recFlowsHtml = recFlows.length
      ? `<div class="voidr-rec-flows">${recFlows.map((f, i) =>
          `<span class="voidr-rec-flow-chip"><span class="voidr-rec-flow-num">${i + 1}.</span> ${escapeHtml(f.name || f.id)}</span>`
        ).join('')}</div>`
      : '';

    const panel = document.createElement('div');
    panel.className = 'voidr-rec-panel';
    panel.innerHTML = `
      <div class="voidr-rec-icon">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="#ef4444"><circle cx="12" cy="12" r="6" /></svg>
      </div>
      <div class="voidr-rec-title">Recording session for &quot;${escapeHtml(effectiveName)}&quot;</div>
      <div class="voidr-rec-actions">
        <button class="voidr-rec-btn" id="voidr-rec-rollback">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15A9 9 0 1 0 7 4.6"></path>
          </svg>
          Rollback
        </button>
        <button class="voidr-rec-btn danger" id="voidr-rec-stop">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect>
          </svg>
          Stop
        </button>
      </div>
      ${recFlowsHtml}
    `;
    document.documentElement.appendChild(panel);

    // Inject collector (skip if resuming — background already re-injected it)
    if (!options.skipCountdown) {
      const inlineApiKey = options.apiKey;
      const applicationId = options.applicationId || slug;
      const onboardingRunId = options.onboardingRunId;
      sendCollectorInit({ mode, slug, userId, effectiveName, apiKey: inlineApiKey, applicationId, onboardingRunId, flows: options.flows });
    }

    // Handlers
    document.getElementById('voidr-rec-rollback')?.addEventListener('click', () => {
      startVoidrSessionRecording(testCaseName, options);
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

      try {
        const result = await Promise.race([
          new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'voidr:sessionStopped', onboardingRunId: activeRunId }, (res) => {
              resolve(res || { success: false });
            });
          }),
          new Promise((resolve) => setTimeout(() => resolve({ success: false, timeout: true }), 5000)),
        ]);
        sessionId = result.sessionId || null;
        allSessionIds = result.sessionIds || (sessionId ? [sessionId] : []);
      } catch (_) {}

      if (allSessionIds.length > 0 && stopBtn) {
        stopBtn.innerHTML = `${spinnerSvg} Validando sessão...`;

        // Validate the latest session (most recent, needs time to reach the collector)
        const latestSid = sessionId || allSessionIds[allSessionIds.length - 1];
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const res = await new Promise((resolve) => {
              chrome.runtime.sendMessage({ action: 'voidr:validateSession', sessionId: latestSid }, (r) => {
                resolve(r || { found: false });
              });
            });
            if (res.found) break;
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 2000));
        }

        for (const sid of allSessionIds) {
          broadcastSessionToOnboarding(sid, activeRunId);
        }
        lastCapturedSessionId = latestSid;
      }

      border.remove();
      panel.remove();
      document.querySelectorAll('.voidr-rec-countdown').forEach((n) => n.remove());
      showOnboardingDoneBanner(mode);
    });
  } catch (e) {
    console.error('Voidr session recording error:', e);
  }
}

// ── Onboarding banners ───────────────────────────────────────────────────────

function showOnboardingDoneBanner(mode) {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done';
  const message = mode === 'onboarding'
    ? 'Sessão capturada com sucesso — pode fechar esta aba e voltar ao onboarding.'
    : 'Sessão capturada com sucesso — pode fechar esta aba e voltar à extensão.';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#86efac" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
    ${message}
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => { if (banner.parentNode) banner.remove(); }, 15000);
}

function broadcastSessionToOnboarding(sessionId, onboardingRunId) {
  try {
    const payload = JSON.stringify({
      type: 'voidr:sessionCaptured',
      sessionId,
      onboardingRunId: onboardingRunId || undefined,
    });
    const script = document.createElement('script');
    script.textContent = `try{var bc=new BroadcastChannel('voidr-onboarding');bc.postMessage(${payload});bc.close();}catch(_){}`;
    document.documentElement.appendChild(script);
    script.remove();
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
        apiKey: request.apiKey,
        onboardingRunId: request.onboardingRunId,
        flows: request.flows || [],
      });
      break;
    case 'voidr:resumeRecordingUI':
      document.querySelectorAll('.voidr-rec-border, .voidr-rec-countdown, .voidr-rec-panel').forEach((n) => n.remove());
      startVoidrSessionRecording(request.testCaseName || 'Test Case', {
        mode: request.mode,
        slug: request.applicationId,
        applicationId: request.applicationId,
        onboardingRunId: request.onboardingRunId,
        flows: request.flows || [],
        skipCountdown: true,
      });
      break;
    case 'voidr:sessionCaptured':
      if (request.sessionId) {
        lastCapturedSessionId = request.sessionId;
        broadcastSessionToOnboarding(request.sessionId, request.onboardingRunId);
        showOnboardingDoneBanner();
      }
      break;
  }
});

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
  document.addEventListener('DOMContentLoaded', () => initVoidrExtension());
} else {
  initVoidrExtension();
}
