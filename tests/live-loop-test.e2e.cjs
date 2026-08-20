const { chromium } = require('../../voidr-hive/node_modules/playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function launchExtensionContext(extensionPath, profileDir) {
  if (process.platform !== 'darwin') {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    return { context, browserProcess: null };
  }

  // Chromium's remote-debugging pipe can stall during a headed macOS launch.
  // A loopback-only ephemeral CDP port exercises the same unpacked extension
  // without depending on that pipe handshake.
  const port = 9400 + Math.floor(Math.random() * 400);
  const browserProcess = spawn(
    chromium.executablePath(),
    [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      // Avoid a macOS Keychain consent prompt stalling the CDP endpoint before
      // the extension can be exercised in an unattended smoke run.
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  browserProcess.unref();
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 75_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) {
    browserProcess.kill('SIGKILL');
    throw new Error('Chromium CDP endpoint did not become ready');
  }
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Chromium did not expose a persistent extension context');
  return { context, browserProcess, browser };
}

async function findVoidrWorker(context) {
  for (const candidate of context.serviceWorkers()) {
    const name = await candidate
      .evaluate(() => chrome.runtime.getManifest().name)
      .catch(() => null);
    if (name === 'Voidr Capture') return candidate;
  }
  return null;
}

async function main() {
  const recordingUrl = process.env.RECORDING_URL;
  if (!recordingUrl) throw new Error('RECORDING_URL is required');
  const stopSurface = process.env.STOP_SURFACE === 'popup' ? 'popup' : 'page';

  const extensionPath = path.resolve(__dirname, '..');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voidr-loop-test-e2e-'));
  const startedAt = Date.now();
  let context;
  let browser;
  let browserProcess;

  try {
    ({ context, browser, browserProcess } = await launchExtensionContext(
      extensionPath,
      profileDir,
    ));

    let worker = await findVoidrWorker(context);
    const workerDeadline = Date.now() + 15_000;
    while (!worker && Date.now() < workerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      worker = await findVoidrWorker(context);
    }
    if (!worker) throw new Error('Voidr extension service worker did not start');
    const extensionId = new URL(worker.url()).host;
    const page = context.pages()[0] || (await context.newPage());
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });

    await page.goto(recordingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const panel = page.locator('#voidr-rec-stop');
    try {
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      // Exercise the extension's persisted-navigation recovery once more after
      // the identity provider has settled.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await panel.waitFor({ state: 'visible', timeout: 20_000 });
    }
    const recordingReadyAt = Date.now();

    // Prefer the deterministic fixture action; on a login page, focus only.
    const harmlessAction = page.locator('#harmless-action');
    const publicInput = page.locator('input:visible').first();
    if (await harmlessAction.count()) {
      await harmlessAction.click();
    } else if (await publicInput.count()) {
      const inputId = await publicInput.getAttribute('id');
      const label = inputId ? page.locator(`label[for="${inputId}"]`) : null;
      if (label && (await label.count())) await label.click();
      else await publicInput.focus();
    } else {
      await page.locator('body').click({ position: { x: 24, y: 24 } });
    }
    await page.waitForTimeout(8_000);

    let feedbackPage = page;
    let popupUrl = null;
    const stopRequestedAt = Date.now();
    if (stopSurface === 'popup') {
      feedbackPage = await context.newPage();
      popupUrl = await worker.evaluate(() => chrome.runtime.getURL('popup/popup.html'));
      await feedbackPage.goto(popupUrl, {
        waitUntil: 'domcontentloaded',
      });
      const popupStop = feedbackPage.locator('#finish-loop-btn');
      await popupStop.waitFor({ state: 'visible', timeout: 8_000 });
      await popupStop.click();
    } else {
      await panel.click();
    }

    const stopResult = await worker.evaluate(async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const { voidrLastStopResult } = await chrome.storage.session.get('voidrLastStopResult');
        if (voidrLastStopResult) return voidrLastStopResult;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Timed out waiting for extension stop result');
    });
    const stoppedAt = stopResult.stoppedAt || Date.now();
    const handoffPanel =
      stopSurface === 'popup'
        ? feedbackPage.locator('.loop-finalization-view')
        : feedbackPage.locator('.voidr-handoff');
    await handoffPanel.waitFor({ state: 'visible', timeout: 8_000 });
    const initialHandoffFeedback = (await handoffPanel.textContent())?.replace(/\s+/g, ' ').trim();
    const finalization = await worker.evaluate(async () => {
      const deadline = Date.now() + 75_000;
      while (Date.now() < deadline) {
        const { voidrLastLoopFinalization } = await chrome.storage.session.get(
          'voidrLastLoopFinalization',
        );
        if (
          voidrLastLoopFinalization &&
          ['available', 'acknowledged', 'product_ready'].includes(voidrLastLoopFinalization.state)
        ) {
          return voidrLastLoopFinalization;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('Timed out waiting for resumable Loop finalization');
    });
    const handoffFeedback = (await handoffPanel.textContent())?.replace(/\s+/g, ' ').trim();
    let resumedFeedback = null;
    if (stopSurface === 'popup' && popupUrl) {
      await feedbackPage.close();
      feedbackPage = await context.newPage();
      await feedbackPage.goto(popupUrl, { waitUntil: 'domcontentloaded' });
      const resumed = feedbackPage.locator('.loop-finalization-view');
      await resumed.waitFor({ state: 'visible', timeout: 8_000 });
      resumedFeedback = (await resumed.textContent())?.replace(/\s+/g, ' ').trim();
    }

    console.log(
      JSON.stringify({
        extensionId,
        stopSurface,
        profileDir,
        pageOrigin: new URL(page.url()).origin,
        sessionId: stopResult.sessionId,
        sessionIds: stopResult.sessionIds,
        success: stopResult.success,
        finalized: stopResult.finalized,
        partial: stopResult.partial,
        degraded: stopResult.degraded,
        error: stopResult.error,
        finalizations: stopResult.finalizations,
        verification: stopResult.verification,
        loopFinalization: finalization,
        initialHandoffFeedback,
        handoffFeedback,
        resumedFeedback,
        tabResults: stopResult.tabResults,
        browserErrors: browserErrors.slice(0, 10),
        timingsMs: {
          launchToRecordingReady: recordingReadyAt - startedAt,
          stopRequestToAcknowledgement: stoppedAt - stopRequestedAt,
        },
      }),
    );
    if (
      !stopResult.success ||
      !stopResult.finalized ||
      !initialHandoffFeedback ||
      !handoffFeedback ||
      (stopSurface === 'popup' && !resumedFeedback) ||
      !['available', 'acknowledged', 'product_ready'].includes(finalization.state)
    ) {
      process.exitCode = 2;
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    else if (context) await context.close().catch(() => {});
    if (browserProcess && browserProcess.exitCode === null) browserProcess.kill('SIGTERM');
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (_) {
      // The macOS browser process may still be releasing profile files. The
      // system temp directory owns eventual cleanup; never mask the E2E result.
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
