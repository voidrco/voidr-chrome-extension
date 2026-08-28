const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  isLoopScenarioEligible,
  isAllowedLoopTarget,
  isSafeHttpUrl,
  normalizeLoopScenarios,
  sanitizeActiveRecording,
  unwrapApiData,
} = require('../shared/recording-ux-helpers.js');

const root = path.resolve(__dirname, '..');

test('unwraps successful API envelopes and normalizes the Loop list', () => {
  const envelope = {
    success: true,
    data: [
      {
        id: 'loop-1',
        name: 'Checkout',
        status: 'draft',
        cycle: 2,
        sessionsRecorded: 0,
      },
    ],
  };

  assert.deepEqual(unwrapApiData(envelope), envelope.data);
  assert.deepEqual(normalizeLoopScenarios(envelope), [
    {
      id: 'loop-1',
      name: 'Checkout',
      status: 'draft',
      cycle: 2,
      sessionsRecorded: 0,
      targetUrl: '',
      applicationName: '',
    },
  ]);
  assert.equal(isLoopScenarioEligible(normalizeLoopScenarios(envelope)[0]), true);
  assert.equal(
    isLoopScenarioEligible({ ...normalizeLoopScenarios(envelope)[0], sessionsRecorded: 1 }),
    true,
  );
  assert.equal(isLoopScenarioEligible({ id: 'loop-busy', status: 'recording' }), false);
  assert.equal(isLoopScenarioEligible({ id: 'loop-ready', status: 'fix_required' }), true);
});

test('accepts only navigable signed HTTP(S) URLs', () => {
  assert.equal(isSafeHttpUrl('https://example.com/path?voidr_token=secret'), true);
  assert.equal(isSafeHttpUrl('http://localhost:3000/record'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('chrome-extension://abc/popup.html'), false);
  assert.equal(isSafeHttpUrl('not a url'), false);
});

test('Loop targets allow HTTP only for local development', () => {
  assert.equal(isAllowedLoopTarget('https://checkout.example.com'), true);
  assert.equal(isAllowedLoopTarget('http://localhost:8080'), true);
  assert.equal(isAllowedLoopTarget('http://127.0.0.1:4173'), true);
  assert.equal(isAllowedLoopTarget('http://checkout.local'), true);
  assert.equal(isAllowedLoopTarget('http://checkout.example.com'), false);
  assert.equal(isAllowedLoopTarget('ftp://localhost/file'), false);
});

test('sanitized active state never exposes capability or collector secrets', () => {
  const sanitized = sanitizeActiveRecording({
    mode: 'loop-test',
    testCaseName: 'Checkout Loop',
    startedAt: 1234,
    initOptions: {
      apiKey: 'collector-secret',
      loopTest: { token: 'capability-secret' },
    },
    sessionIds: ['private-session-id'],
    trackedTabIds: [42],
    lifecycleGeneration: 'opaque-generation',
  });

  assert.deepEqual(sanitized, {
    active: true,
    mode: 'loop-test',
    name: 'Checkout Loop',
    startedAt: 1234,
    status: 'recording',
    generation: 'opaque-generation',
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /secret|session-id|trackedTabIds|apiKey|token/);
});

test('popup home exposes capture intents and the assistant recording code', () => {
  const popup = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');
  const mainView = popup.slice(
    popup.indexOf('function showMainView'),
    popup.indexOf('// ── Loop recording'),
  );
  assert.match(mainView, /O que deseja capturar/);
  assert.match(mainView, /Gravar sessão/);
  assert.match(mainView, /Iniciar Loop/);
  assert.match(mainView, /showSelectProductView/);
  assert.match(mainView, /showLoopListView/);
  assert.match(mainView, /Código de gravação/);
  assert.match(mainView, /voidr:getRecordingByCode/);
  assert.doesNotMatch(mainView, /Abra o link enviado pelo seu harness|Loop Test/);
  assert.match(popup, /Gravando ciclo/);
  assert.match(popup, /Finalizar gravação/);
  assert.match(popup, /voidr:getRecordingState/);
  assert.match(popup, /voidr:sessionStopped/);
  assert.match(content, /action: 'voidr:sessionStopped'[\s\S]{0,220}stopCapability/);
  assert.match(background, /createStopCapabilityStore/);
  assert.match(popup, /Confirme um ambiente cadastrado ou escolha criar outro/);
  assert.match(popup, /session-environment-choice/);
  assert.match(popup, /session-target-url/);
});

test('the deprecated draggable assistant FAB is no longer in the Capture dispatch path', () => {
  const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  const initializer = content.slice(
    content.indexOf('async function initVoidrExtension'),
    content.indexOf('// ── Refocus Button'),
  );
  assert.doesNotMatch(initializer, /createRefocusButton|ensureRefocusButtonPresent|setInterval/);
  assert.match(initializer, /old draggable assistant FAB was/);
});

test('session summary defines its reusable card before rendering pending state', () => {
  const popup = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
  const summary = popup.slice(popup.indexOf('function showSessionSummaryView'));
  const definitionIndex = summary.indexOf('const card = `');
  const firstRenderIndex = summary.indexOf('${card}');
  assert.ok(definitionIndex >= 0);
  assert.ok(firstRenderIndex > definitionIndex);
});

test('deep-link failures are persisted for the popup and badge', () => {
  const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');
  assert.match(content, /voidr:loopStartupFailed/);
  assert.match(background, /LOOP_STARTUP_FAILURE_STORAGE_KEY/);
  assert.match(background, /setBadgeText\(\{ text: '!' \}\)/);
  assert.match(background, /voidr:getRecordingState/);
  assert.match(content, /showLoopLaunchStatus\('error'/);
  assert.match(content, /Link de gravação incompleto/);
});

test('capability token is validated but not copied into active recording state', () => {
  const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(root, 'content/bootstrap.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');
  assert.match(content, /const scenarioId = deepLink\.scenarioId/);
  assert.match(content, /deepLink\.token = null/);
  assert.match(content, /loopTest: \{\s*scenarioId,\s*cycleId: context\.verification\?\.cycleId/);
  assert.match(content, /cycleNumber: context\.verification\?\.cycleNumber/);
  assert.match(content, /url: getCollectorPageUrl\(init\.mode\)/);
  assert.match(bootstrap, /window\.history\.replaceState/);
  assert.match(bootstrap, /voidr:stageLoopDeepLink/);
  assert.match(bootstrap, /transportVersion: parsed\.staged\.transportVersion/);
  assert.match(background, /request\.token = null/);
  assert.match(background, /const attachCapability = validation\?\.attachToken/);
  assert.match(background, /loopCapabilitySecrets\.stage\([\s\S]{0,180}attachCapability/);
  assert.doesNotMatch(content, /loopTest:\s*deepLink/);
  assert.match(
    background,
    /focusExistingAssistantWindow\(\)[\s\S]{0,180}openAssistantWindowAt\(\)/,
  );
  assert.match(
    fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8'),
    /\['loop-test', 'verification'\]\.includes\(request\.mode\)[\s\S]{0,100}initializeExtension\(\)/,
  );
});

test('restart and delete keep controls until discard succeeds and surface failures', () => {
  const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');

  assert.match(content, /const restartBtn = event\.currentTarget/);
  assert.match(
    content,
    /if \(!response\?\.success \|\| error\) \{\s*restartBtn\.disabled = false;\s*showDiscardFailedBanner\(error\);\s*return;/,
  );
  assert.match(content, /const deleteBtn = event\.currentTarget/);
  assert.match(
    content,
    /if \(!response\?\.success \|\| error\) \{\s*deleteBtn\.disabled = false;\s*showDiscardFailedBanner\(error\);\s*return;/,
  );
  assert.match(
    content,
    /document\.querySelectorAll\('\.voidr-rec-countdown'\)[\s\S]{0,180}showDiscardedBanner\(\)/,
  );
  assert.match(content, /showDiscardFailedBanner\(error\)/);
  assert.match(background, /authorizeDiscardRequest/);
  assert.match(background, /\['starting', 'recording'\]/);
});

test('stop controls carry lifecycle generation and keep the governed handoff visible', () => {
  const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  const popup = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');

  assert.match(content, /action: 'voidr:sessionStopped'[\s\S]{0,160}lifecycleGeneration/);
  assert.match(popup, /action: 'voidr:sessionStopped',\s*lifecycleGeneration/);
  assert.match(background, /authorizeStopRequest/);
  assert.match(background, /function isTrustedAssistantSender/);
  assert.match(
    background,
    /const authorizationSenderTabId = isTrustedAssistantSender\(sender\)[\s\S]{0,100}\? null/,
  );
  assert.match(content, /panel\.dataset\.voidrFinalizing = 'true'/);
  assert.match(content, /case 'voidr:sessionCaptured':[\s\S]{0,500}preserveHandoff/);
  assert.match(content, /preserveHandoff[\s\S]{0,240}'\.voidr-rec-border, \.voidr-rec-countdown'/);
  assert.match(content, /if \(!preserveHandoff\) \{[\s\S]{0,100}broadcastSessionToOnboarding/);
});

test('popup and in-page Finish use the same Verification seal and resumable feedback', () => {
  const popup = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');

  assert.match(popupHtml, /shared\/verification-handoff-ux\.js/);
  assert.match(popup, /showLoopFinalizationView\(\{[\s\S]{0,120}state: 'stopping'/);
  assert.match(popup, /action: 'voidr:verificationSeal'/);
  assert.match(popup, /voidr:verificationHandoffStatus/);
  assert.match(popup, /Voidr continuará em segundo plano/);
  assert.match(background, /LOOP_FINALIZATION_STORAGE_KEY/);
  assert.match(
    background,
    /stageVerificationSeal\(found\.record, verificationCoordinates, stopResponse\)/,
  );
  assert.match(background, /scheduleVerificationSealRetry\(found\.record\)/);
  assert.match(background, /voidr:loopFinalizationUpdated/);
  assert.match(background, /const stored = await readLoopFinalization/);
  assert.match(background, /duplicate: true/);
});

test('Verification skips the weaker generic lookup and waits on collector readiness', () => {
  const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');

  assert.match(content, /if \(!options\.verification\) \{[\s\S]{0,500}voidr:validateSession/);
  assert.match(background, /waitForCollectorReadiness\(pending\.sessionId, undefined, timeoutMs\)/);
  assert.match(background, /attemptPendingVerificationSeal\(found\.record, 20000\)/);
});

test('a sealed Loop retries only its capability attachment and never Stop', () => {
  const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');

  assert.match(content, /attachmentPending[\s\S]{0,300}retryLoopTestAttachment/);
  assert.match(content, /Gravação selada e preservada[\s\S]{0,120}não grave novamente/);
  assert.match(background, /case 'voidr:retryLoopAttach'/);
  assert.match(background, /classifyStopOutcome/);
  assert.match(background, /attachmentPending: stopOutcome\.attachmentPending/);
  assert.match(background, /preserveLoopCapability: stopOutcome\.attachmentPending/);
});

test('completed Loop cycles do not reopen a competing popup experience', () => {
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');
  assert.match(background, /const isLoopCycleCapture = Boolean/);
  assert.match(background, /!isLoopCycleCapture/);
});

test('countdown starts alongside collector bootstrap and survives a CSP reload resume', () => {
  const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');

  assert.match(
    content,
    /countdownPromise[\s\S]{0,1800}Promise\.all\(\[startupPromise, countdownPromise\]\)/,
  );
  assert.match(content, /collectorAlreadyInitialized: true/);
  assert.match(
    background,
    /sendResumeRecordingUi\(targetTabId, readyRecording, \{ showCountdown: true \}\)/,
  );
  assert.match(
    background,
    /chrome\.runtime[\s\S]{0,80}\.sendMessage\([\s\S]{0,180}\.catch\(\(\) => \{\}\)/,
  );
});

test('sanitized lifecycle exposes preparation without leaking recording internals', () => {
  const sanitized = sanitizeActiveRecording({
    mode: 'loop-test',
    lifecycle: 'starting',
    testCaseName: 'Checkout Loop',
    canonicalSessionId: 'private',
  });
  assert.equal(sanitized.status, 'starting');
  assert.equal(sanitized.generation, null);
  assert.doesNotMatch(JSON.stringify(sanitized), /canonicalSessionId|private/);
});

test('packaged popup and manifest contain no user-facing onboarding copy', () => {
  const popupHtml = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
  const manifest = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  const popupJs = fs
    .readFileSync(path.join(root, 'popup/popup.js'), 'utf8')
    .replaceAll('onboardingRunId', '')
    .replaceAll('pendingOnboardingContext', '')
    .replaceAll("mode: 'onboarding'", '');

  assert.doesNotMatch(popupHtml, /onboarding/i);
  assert.doesNotMatch(manifest, /onboarding/i);
  assert.doesNotMatch(popupJs, /onboarding/i);
});
