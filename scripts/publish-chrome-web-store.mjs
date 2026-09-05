#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { releaseDisposition } from './chrome-web-store-release.mjs';

const accessToken = process.env.CHROME_WEBSTORE_ACCESS_TOKEN;
const publisherId = process.env.CHROME_WEBSTORE_PUBLISHER_ID;
const extensionId = process.env.CHROME_WEBSTORE_EXTENSION_ID;
const zipPath = process.env.CHROME_WEBSTORE_ZIP_PATH || 'dist/voidr-extension.zip';

for (const [name, value] of Object.entries({
  CHROME_WEBSTORE_ACCESS_TOKEN: accessToken,
  CHROME_WEBSTORE_PUBLISHER_ID: publisherId,
  CHROME_WEBSTORE_EXTENSION_ID: extensionId,
})) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
}

const itemName = `publishers/${publisherId}/items/${extensionId}`;
const apiUrl = `https://chromewebstore.googleapis.com/v2/${itemName}`;
const headers = { Authorization: `Bearer ${accessToken}` };
const localVersion = JSON.parse(await readFile('manifest.json', 'utf8')).version;

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Chrome Web Store API ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

function uploadState(value) {
  return String(value || '').replace(/^UPLOAD_/, '');
}

async function waitForUpload(initialState) {
  let state = uploadState(initialState);

  for (let attempt = 0; state === 'IN_PROGRESS' && attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const status = await request(`${apiUrl}:fetchStatus`);
    state = uploadState(status.lastAsyncUploadState);
  }

  if (state !== 'SUCCEEDED') {
    throw new Error(`Chrome Web Store upload ended with state ${state || 'UNKNOWN'}.`);
  }
}

const status = await request(`${apiUrl}:fetchStatus`);
const disposition = releaseDisposition(status, localVersion);

if (disposition.action === 'skip') {
  console.log(disposition.reason);
  process.exit(0);
}

if (disposition.action === 'blocked') {
  throw new Error(disposition.reason);
}

const zip = await readFile(zipPath);
const upload = await request(`https://chromewebstore.googleapis.com/upload/v2/${itemName}:upload`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/zip' },
  body: zip,
});

await waitForUpload(upload.uploadState);
console.log(`Uploaded Chrome extension ${upload.crxVersion || ''}.`);

const publication = await request(`${apiUrl}:publish`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true }),
});

console.log(`Submitted Chrome extension for review with state ${publication.state}.`);
