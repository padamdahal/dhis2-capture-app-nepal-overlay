# Capture NP (`capture-app-np`) — Nepal-Only Overlay Repo

This repository stores **only Nepal-specific features, branding, assets, and minimal integration hooks**—never the 100,000+ lines of upstream DHIS2 Capture core.

## Quick Start (Directly From Upstream Git Repo)

The upstream Git repository and release tag are configured in `nepal/branding.json`:

```json
{
  "upstreamRepo": "https://github.com/dhis2/capture-app.git",
  "upstreamBaseTag": "v107.9.3"
}
```

1. **One-time base build** (automatically shallow-clones `upstreamRepo` at `upstreamBaseTag` into `.nepal-cache/upstream-base/`, caches `node_modules`, applies Nepal hooks, builds Capture core once, and outputs `dist/capture-app-np-<version>.zip`):

   ```bash
   npm install
   npm run build:full
   ```

   You can also override the Git repo or tag at any time via CLI flags or environment variables:

   ```bash
   npm run build:full -- --repo https://github.com/dhis2/capture-app.git --tag v108.0.0
   # or
   CAPTURE_BASE_REPO=https://github.com/dhis2/capture-app.git CAPTURE_BASE_TAG=v108.0.0 npm run build:full
   # or use a local directory instead if preferred
   npm run build:full -- --base /path/to/local/capture-app
   ```

2. **Fast ~1.5-Second Nepal-Only Rebuilds** (every time you edit `src/nepal/**`, `nepal/branding.json`, or `nepal/assets/app-icon.png` — zero network calls, zero Capture core recompile):

   ```bash
   npm run build:fast
   ```

## Upgrading to a New DHIS2 Capture Release

1. Update `upstreamBaseTag` in `nepal/branding.json` (e.g. `v108.0.0`).
2. Run `npm run build:full` to verify locally against the new tag.
3. Tag and push to trigger automated GitHub Actions release builds:

   ```bash
   git tag v108.0.0-np.1
   git push origin main --tags
   ```

GitHub Actions automatically clones the pinned upstream tag, overlays your Nepal features, verifies the bundle, and attaches the installable DHIS2 `.zip` + `.sha256` checksum to a GitHub Release.
