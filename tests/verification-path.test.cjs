const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const root = join(__dirname, '..');
const background = readFileSync(join(root, 'background/background.js'), 'utf8');
const content = readFileSync(join(root, 'content/content.js'), 'utf8');
const popup = readFileSync(join(root, 'popup/popup.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const voice = readFileSync(join(root, 'offscreen/voice.js'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('Verification has one product-native destination and no competing side panel', () => {
  assert.equal(manifest.side_panel, undefined);
  assert.equal(manifest.permissions.includes('sidePanel'), false);
  assert.equal(manifest.permissions.includes('contextMenus'), false);
  assert.doesNotMatch(background, /voidr:openLoopTestPanel|chrome\.sidePanel/);
  assert.match(background, /voidr:openLoopHandoff/);
  assert.match(content, /voidr:openLoopHandoff/);
  assert.match(popup, /voidr:openLoopHandoff/);
});

test('Verification capability stays generation-scoped in session storage and header transport', () => {
  assert.match(background, /chrome\.storage\.session/);
  assert.match(background, /Authorization:\s*`Bearer \$\{record\.token\}`/);
  assert.match(background, /verificationId.*generation/s);
  assert.doesNotMatch(background, /searchParams\.set\([^)]*(?:capability|token)/i);
});

test('Verification stop gives the durable chunk ACK enough time to beat the UI deadline', () => {
  assert.match(background, /COLLECTOR_TAB_STOP_TIMEOUT_MS\s*=\s*15000/);
  assert.match(content, /Recording stop timed out/);
  assert.match(content, /25000/);
});

test('Verification controls are interactive immediately when their toolbar becomes visible', () => {
  assert.match(content, /void verificationRuntimeMessage\(\{\s*action: 'voidr:verificationIngest'/);
  assert.doesNotMatch(
    content,
    /await verificationRuntimeMessage\(\{[\s\S]{0,500}idempotencyKey: `recording-started:/,
  );
  assert.match(content, /const finishRecording = async \(event\)/);
  assert.match(
    content,
    /panel\.querySelector\('#voidr-rec-stop'\)\?\.addEventListener\('click', finishRecording\)/,
  );
  assert.match(content, /const stopBtn = event\.currentTarget/);
});

test('localhost Verification uses an explicit adapter without logging payloads', () => {
  assert.match(background, /VERIFICATION_LOCAL_ADAPTER_ENABLED/);
  assert.match(background, /LOCAL_VERIFICATION_COLLECTOR_KEY/);
  assert.match(background, /\/verification-dev\$\{endpoint\}/);
  assert.match(background, /x-voidr-dev-key/);
  assert.match(background, /\[sensitive body redacted\]/);
  assert.match(background, /attemptPendingVerificationSeal/);
  assert.match(background, /await checkAuthenticationStatus\(\)/);
  assert.match(background, /Collector local read authorization returned no token/);
  assert.match(background, /fetch\(`\$\{API_CONFIG\.collectorUrl\}\/init`/);
  assert.match(background, /pendingSeal/);
  assert.doesNotMatch(content, /sessionStorage\.getItem\('voidr_jwt'\)/);
  assert.doesNotMatch(content, /collectorToken/);
  assert.doesNotMatch(background, /console\.log\([^)]*JSON\.stringify\(data\)/s);
});

test('Loop billing fails before capture with actionable 402 feedback and no response dump', () => {
  assert.match(background, /response\.status === 402/);
  assert.match(background, /Saldo de créditos insuficiente para iniciar este ciclo/);
  assert.match(popup, /error\?\.status === 402/);
  assert.doesNotMatch(background, /console\.warn\([^\n]*bodyText/);
});

test('annotation overlays are marked and never sent as product evidence', () => {
  assert.match(content, /data-voidr-verification-overlay/);
  assert.match(content, /beginElementAnnotation/);
  assert.match(content, /beginRegionAnnotation/);
  assert.match(content, /screenshotRef/);
  assert.match(content, /cropRef/);
  assert.match(content, /viewport:\s*\{[\s\S]*window\.innerWidth[\s\S]*window\.innerHeight/);
  assert.match(background, /Verification screenshot capture timed out/);
  assert.match(content, /retaining the text annotation/);
});

test('all recording chrome is blocked from rrweb in Loop and Session modes', () => {
  assert.match(content, /markVerificationOverlay\(border\)/);
  assert.match(content, /markVerificationOverlay\(countdown\)/);
  assert.match(content, /markVerificationOverlay\(panel\)/);
  assert.doesNotMatch(content, /if \(options\.verification\) markVerificationOverlay\((?:border|countdown|panel)\)/);
});

test('recording chrome exposes honest local signal counters without adding prompt payload', () => {
  for (const dependency of [
    'background/session-stop-helpers.js',
    'assets/lucide-icons.js',
    'shared/recording-signal-helpers.js',
    'shared/live-evidence-inspector.js',
  ]) {
    assert.match(background, new RegExp(dependency.replace(/[./-]/g, '\\$&')));
  }
  assert.match(content, /id="voidr-verification-capture"/);
  assert.match(content, /data-signal="clicks"/);
  assert.match(content, /data-signal="requests"/);
  assert.match(content, /PerformanceObserver/);
  assert.match(content, /VoidrRecordingSignals/);
  assert.match(content, /aria-label="Ver captura automática"/);
  assert.match(content, /aria-label="Adicionar nota"/);
  assert.match(content, /aria-label="Adicionar nota de voz"/);
  assert.doesNotMatch(content, /captureSignals[\s\S]{0,400}verificationIngest/);
});

test('live evidence inspector is lifecycle-fenced and progressively discloses every category', () => {
  assert.match(content, /id="voidr-live-evidence-inspector"/);
  for (const category of ['pages', 'clicks', 'requests', 'errors', 'notes', 'voiceNotes']) {
    assert.match(content, new RegExp(`data-evidence-category="${category}"`));
  }
  assert.match(content, /VoidrLiveEvidenceInspector/);
  assert.match(content, /action: 'voidr:getLiveRecordingContext'/);
  assert.match(background, /case 'voidr:getLiveRecordingContext'/);
  assert.match(background, /recording\.trackedTabIds\?\.includes\(tabId\)/);
  assert.match(background, /generation !== recording\.lifecycleGeneration/);
  assert.match(background, /window\.VoidrCollector\.getLiveContext/);
  assert.match(content, /O evento completo permanece no replay e no ClickHouse/);
});

test('notes stay available in every recording mode and enter the governed session stream', () => {
  assert.equal((content.match(/\$\{annotationToolsHtml\}/g) || []).length, 2);
  assert.match(content, /action: 'voidr:trackRecordingNote'/);
  assert.match(background, /case 'voidr:trackRecordingNote'/);
  assert.match(background, /window\.VoidrCollector\.track\('voidr\.note', sessionNote\)/);
  assert.match(background, /recording\.trackedTabIds\?\.includes\(tabId\)/);
  assert.match(background, /generation !== recording\.lifecycleGeneration/);
});

test('voice notes use an optional governed outbox and join the same seal fence', () => {
  assert.equal(manifest.permissions.includes('offscreen'), true);
  assert.match(packageJson.scripts['extension:build'], /\boffscreen\b/);
  assert.match(content, /id="voidr-verification-voice"/);
  assert.match(content, /voidr:startVerificationVoice/);
  assert.match(content, /voidr:stopVerificationVoice/);
  assert.match(background, /VERIFICATION_VOICE_PREFIX/);
  assert.match(background, /local-extension-outbox/);
  assert.match(background, /voice-segments/);
  assert.match(
    background,
    /await flushPendingVerificationVoice\(record\);\s*await reconcilePendingVerificationEvidence\(record\);/,
  );
  assert.match(voice, /TARGET_SAMPLE_RATE = 16_000/);
  assert.match(voice, /getUserMedia/);
  assert.doesNotMatch(`${background}\n${content}\n${voice}`, /DEEPGRAM_API_KEY|ELEVENLABS_API_KEY/);
});
