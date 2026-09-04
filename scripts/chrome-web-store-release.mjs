import { compareChromeVersions } from './extension-version.mjs';

function revisionVersions(revision) {
  return (revision?.distributionChannels || [])
    .map((channel) => channel.crxVersion)
    .filter(Boolean);
}

export function releaseDisposition(status, localVersion) {
  const publishedVersions = revisionVersions(status.publishedItemRevisionStatus);
  if (publishedVersions.includes(localVersion)) {
    return { action: 'skip', reason: `Version ${localVersion} is already published.` };
  }

  for (const publishedVersion of publishedVersions) {
    if (compareChromeVersions(localVersion, publishedVersion) <= 0) {
      return {
        action: 'blocked',
        reason: `Version ${localVersion} is not newer than published version ${publishedVersion}.`,
      };
    }
  }

  const submitted = status.submittedItemRevisionStatus;
  if (submitted && ['PENDING_REVIEW', 'STAGED'].includes(submitted.state)) {
    const submittedVersions = revisionVersions(submitted);
    if (submittedVersions.includes(localVersion)) {
      return {
        action: 'skip',
        reason: `Version ${localVersion} is already ${submitted.state.toLowerCase()}.`,
      };
    }

    return {
      action: 'blocked',
      reason: `Another version is ${submitted.state.toLowerCase()}; it will not be replaced automatically.`,
    };
  }

  return { action: 'publish' };
}
