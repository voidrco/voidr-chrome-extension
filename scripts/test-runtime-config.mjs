import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'background/background.js'), 'utf8');

function createEvent(listeners, name) {
  return {
    addListener(listener) {
      listeners[name] = listener;
    },
    removeListener() {},
  };
}

function createStorageArea(values) {
  return {
    async get(keys) {
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        selected.filter((key) => values.has(key)).map((key) => [key, values.get(key)]),
      );
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) values.set(key, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
}

async function loadBackground(name, initialValues = {}) {
  const listeners = {};
  const createdWindows = [];
  const removedWindows = [];
  const values = new Map(Object.entries(initialValues));
  const local = createStorageArea(values);
  const sync = createStorageArea(new Map());
  const event = (eventName) => createEvent(listeners, eventName);
  const chrome = {
    action: { onClicked: event('action.onClicked') },
    runtime: {
      getManifest: () => ({ name }),
      onInstalled: event('runtime.onInstalled'),
      onMessage: event('runtime.onMessage'),
      onStartup: event('runtime.onStartup'),
      sendMessage: async () => {},
    },
    storage: { local, sync, onChanged: event('storage.onChanged') },
    tabs: {
      onActivated: event('tabs.onActivated'),
      onCreated: event('tabs.onCreated'),
      onRemoved: event('tabs.onRemoved'),
      onUpdated: event('tabs.onUpdated'),
      async query() {
        return [];
      },
    },
    windows: {
      onRemoved: event('windows.onRemoved'),
      async create(specs) {
        createdWindows.push(specs);
        return { id: createdWindows.length };
      },
      async remove(windowId) {
        removedWindows.push(windowId);
      },
    },
  };

  const context = vm.createContext({
    chrome,
    clearInterval() {},
    clearTimeout,
    console: { error() {}, log() {}, warn() {} },
    importScripts() {},
    setInterval() {},
    setTimeout,
    URL,
  });
  vm.runInContext(source, context);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  const sendMessage = (request, sender = {}) =>
    new Promise((resolvePromise) =>
      listeners['runtime.onMessage'](request, sender, resolvePromise),
    );

  return { createdWindows, removedWindows, sendMessage, values };
}

const production = await loadBackground('Voidr Testing Assistant');
const productionConfig = await production.sendMessage({ action: 'getRuntimeConfig' });
assert.equal(productionConfig.isDebugBuild, false);
assert.equal(productionConfig.serviceUrl, 'https://api.voidr.co/v1');
assert.equal(productionConfig.collectorUrl, 'https://collector.voidr.co');
assert.equal(
  (
    await production.sendMessage({
      action: 'saveDebugServiceUrl',
      serviceUrl: 'https://preview.voidr.co',
    })
  ).success,
  false,
);

const productionWithOverride = await loadBackground('Voidr Testing Assistant', {
  voidrDebugServiceUrl: 'https://preview.voidr.co/v1',
});
assert.equal(
  (await productionWithOverride.sendMessage({ action: 'getRuntimeConfig' })).serviceUrl,
  'https://api.voidr.co/v1',
);

const debug = await loadBackground('Voidr Testing Assistant [DEBUG]');
assert.equal((await debug.sendMessage({ action: 'getRuntimeConfig' })).isDebugBuild, true);

const saved = await debug.sendMessage({
  action: 'saveDebugServiceUrl',
  serviceUrl: 'https://release-unified-hive-chat.api-preview.voidr.co',
});
assert.equal(saved.success, true);
assert.equal(saved.authenticationReset, true);
assert.equal(saved.config.serviceUrl, 'https://release-unified-hive-chat.api-preview.voidr.co/v1');
assert.equal(saved.config.platformUrl, 'https://release-unified-hive-chat.app-preview.voidr.co');
assert.equal(saved.config.collectorUrl, 'https://collector-staging.voidr.co');
assert.equal(saved.authWindowOpened, true);
assert.equal(
  debug.createdWindows.at(-1).url,
  'https://release-unified-hive-chat.app-preview.voidr.co/auth/extension-connect',
);
assert.equal(
  debug.values.get('voidrDebugServiceUrl'),
  'https://release-unified-hive-chat.api-preview.voidr.co/v1',
);

const restartedDebug = await loadBackground('Voidr Testing Assistant [DEBUG]', {
  voidrDebugServiceUrl: 'https://release-unified-hive-chat.api-preview.voidr.co/v1',
  voidrAuthPlatformUrl: 'https://release-unified-hive-chat.app-preview.voidr.co',
});
assert.equal(
  (await restartedDebug.sendMessage({ action: 'getRuntimeConfig' })).serviceUrl,
  'https://release-unified-hive-chat.api-preview.voidr.co/v1',
);
assert.equal(
  (await restartedDebug.sendMessage({ action: 'getRuntimeConfig' })).collectorUrl,
  'https://collector-staging.voidr.co',
);
assert.equal(
  (await restartedDebug.sendMessage({ action: 'getAuthConnectUrl' })).url,
  'https://release-unified-hive-chat.app-preview.voidr.co/auth/extension-connect',
);

const ignoredProductionToken = await restartedDebug.sendMessage(
  { action: 'validateAndStoreToken', token: 'production-token' },
  { tab: { url: 'https://platform.voidr.co/dashboard' } },
);
assert.equal(ignoredProductionToken.ignored, true);
assert.equal(restartedDebug.values.has('voidrAuth'), false);

await restartedDebug.sendMessage(
  { action: 'validateAndStoreToken', token: 'preview-token' },
  { tab: { url: 'https://release-unified-hive-chat.app-preview.voidr.co/dashboard' } },
);
assert.equal(
  restartedDebug.values.get('voidrAuthPlatformUrl'),
  'https://release-unified-hive-chat.app-preview.voidr.co',
);

const migratedDebug = await loadBackground('Voidr Testing Assistant [DEBUG]', {
  voidrDebugServiceUrl: 'https://release-unified-hive-chat.api-preview.voidr.co/v1',
  voidrAuth: { token: 'old-production-token' },
});
assert.equal(migratedDebug.values.has('voidrAuth'), false);

for (const serviceUrl of ['http://preview.voidr.co', 'https://preview.voidr.co/v2', 'not-a-url']) {
  const rejected = await debug.sendMessage({ action: 'saveDebugServiceUrl', serviceUrl });
  assert.equal(rejected.success, false);
}

const localhost = await debug.sendMessage({
  action: 'saveDebugServiceUrl',
  serviceUrl: 'http://localhost:3000',
});
assert.equal(localhost.success, true);
assert.equal(localhost.config.serviceUrl, 'http://localhost:3000/v1');

const reset = await debug.sendMessage({ action: 'saveDebugServiceUrl', serviceUrl: '' });
assert.equal(reset.success, true);
assert.equal(reset.config.serviceUrl, 'https://api.voidr.co/v1');
assert.equal(reset.config.platformUrl, 'https://platform.voidr.co');
assert.equal(reset.config.collectorUrl, 'https://collector.voidr.co');
assert.equal(debug.values.has('voidrDebugServiceUrl'), false);

debug.values.set('voidrActiveRecording', {
  canonicalSessionId: 'voidr-debug-test',
  trackedTabIds: [1],
});
const blockedDuringRecording = await debug.sendMessage({
  action: 'saveDebugServiceUrl',
  serviceUrl: 'https://release-unified-hive-chat.api-preview.voidr.co/v1',
});
assert.equal(blockedDuringRecording.success, false);
assert.match(blockedDuringRecording.error, /gravação/);

console.log('Runtime config tests passed');
