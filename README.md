# Voidr Collector Script

This project contains the client-side script for Voidr data collection.

## Release Process

The deployment of this script is automated via Google Cloud Build and triggered by Git tags.

To create a new release, use the `release.sh` script.

### How it Works

1.  A developer runs `./release.sh [patch|minor|major]`.
2.  The script automatically bumps the version, creates a commit, and a Git tag (e.g., `v1.2.3`).
3.  The commit and tag are pushed to the `master` branch on GitHub.
4.  Pushing a new tag triggers a Google Cloud Build pipeline.
5.  Cloud Build builds the project and deploys `dist/recorder.min.js` to a versioned folder on Google Cloud Storage.

### How to Deploy

1.  Ensure your `master` branch is clean and synchronized with the remote repository.
2.  Run the release script with the desired version bump type:

**Patch Release (e.g., v1.0.0 → v1.0.1)**

```bash
./release.sh patch
```

**Minor Release (e.g., v1.0.1 → v1.1.0)**

```bash
./release.sh minor
```

**Major Release (e.g., v1.1.0 → v2.0.0)**

```bash
./release.sh major
```
