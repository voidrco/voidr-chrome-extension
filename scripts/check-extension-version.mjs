#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { compareChromeVersions, requiresVersionBump } from './extension-version.mjs';

const [baseRevision, headRevision = 'HEAD'] = process.argv.slice(2);

if (!baseRevision) {
  console.error('Usage: node scripts/check-extension-version.mjs <base-revision> [head-revision]');
  process.exit(2);
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function manifestAt(revision) {
  return JSON.parse(git('show', `${revision}:manifest.json`));
}

function packageAt(revision) {
  return JSON.parse(git('show', `${revision}:package.json`));
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

const changedPaths = git('diff', '--name-only', `${baseRevision}...${headRevision}`)
  .split('\n')
  .filter(Boolean);
const packageChanged = requiresVersionBump(changedPaths);
const baseVersion = manifestAt(baseRevision).version;
const headVersion = manifestAt(headRevision).version;
const packageVersion = packageAt(headRevision).version;

setOutput('package_changed', packageChanged);
setOutput('extension_version', headVersion);

if (packageVersion !== headVersion) {
  console.error(`package.json (${packageVersion}) must match manifest.json (${headVersion}).`);
  process.exit(1);
}

if (!packageChanged) {
  console.log(`No packaged files changed. Version remains ${headVersion}.`);
  process.exit(0);
}

if (compareChromeVersions(headVersion, baseVersion) <= 0) {
  console.error(
    `Packaged files changed, but manifest version ${headVersion} is not greater than main version ${baseVersion}.`,
  );
  process.exit(1);
}

console.log(`Packaged files changed and version increased from ${baseVersion} to ${headVersion}.`);
