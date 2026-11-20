# DHIS2 Capture App Nepal Overlay

This repository stores **only Nepal-specific features, branding, assets, and minimal integration hooks**—never the 100,000+ lines of upstream DHIS2 Capture core.

## Local Preview & Live Testing (`npm run dev`)

You can preview and test the full Capture NP app against any external DHIS2 server immediately without cloning upstream Capture first:

```bash
npm install
npm run dev
```

This starts a Vite server on `0.0.0.0:3000` powered by the committed `public/capture-app-np-<version>.zip` bundle:

- **Default DHIS2 Testing Login**: Opens directly to the official DHIS2 **Please sign in** modal (**Server**, **Username**, **Password**). Enter any external DHIS2 server URL (for example `https://play.im.dhis2.org/dev` or your Nepal HMIS instance) and sign in.
- **Built-In Same-Origin Proxy (`/__dhis2/*`)**: Automatically proxies requests and rewrites session cookies (`SameSite=None; Secure`) on port `3000` so external DHIS2 servers work inside browser previews/iframes without CORS whitelist errors.
- **Live Nepal Extension Reloads**: Any edit to `src/nepal/**` or `nepal/branding.json` automatically recompiles `/nepal-extension.js` in under 0.5 seconds—refresh the page to see changes inside the full Capture NP app.
- **Direct ZIP & Checksum Downloads**:
  - `GET /api/bundles` — JSON metadata (filename, size, timestamp, SHA-256, download URLs)
  - `GET /api/bundles/capture-app-np-<version>.zip` — Untouched, verified DHIS2 App Management ZIP
  - `GET /api/bundles/capture-app-np-<version>.zip.sha256` — SHA-256 checksum file

## Building the Installable DHIS2 Bundle

The upstream Git repository and release tag are configured in `nepal/branding.json`:

```json
{
  "upstreamRepo": "https://github.com/dhis2/capture-app.git",
  "upstreamBaseTag": "v107.9.3"
}
```

1. **One-time full base build** (shallow-clones `upstreamRepo` at `upstreamBaseTag` into `.nepal-cache/upstream-base/`, stages `.nepal-workspace/`, applies Nepal hooks & branding, builds Capture core once, verifies the bundle, and outputs `dist/capture-app-np-<version>.zip`):

   ```bash
   npm install
   npm run build:full
   ```

   Override the upstream repo/tag or use a local checkout anytime:

   ```bash
   npm run build:full -- --repo https://github.com/dhis2/capture-app.git --tag v108.0.0
   # or
   CAPTURE_BASE_REPO=https://github.com/dhis2/capture-app.git CAPTURE_BASE_TAG=v108.0.0 npm run build:full
   # or point to an existing local capture-app directory
   npm run build:full -- --base /path/to/local/capture-app
   ```

2. **Fast ~1.5–2s Nepal-only rebuilds** (after editing `src/nepal/**`, `nepal/branding.json`, or `nepal/assets/app-icon.png` — skips recompiling all 7,300+ unchanged Capture core modules):

   ```bash
   npm run build:fast
   ```

3. **Minimal build without Nepali dates in displays** (keeps Capture NP branding and the BS date picker input addon, skips all read-only dual-date display hooks for pure upstream display rendering, and outputs `dist/capture-app-np-<version>-minimal.zip` using an isolated `.nepal-workspace-minimal/` directory):

   ```bash
   npm run build:minimal
   # subsequent ~2s minimal rebuilds:
   npm run build:fast:minimal
   ```

## Available Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Starts the standalone DHIS2 Capture NP preview server on `0.0.0.0:3000` with live `src/nepal/**` reloads |
| `npm run build` | Builds the standalone preview output into `dist/` (preserving untouched release `.zip` + `.sha256`) |
| `npm run preview` | Serves the built preview on `0.0.0.0:3000` |
| `npm run lint` | Typechecks `src/nepal/**` and `src/core_modules/capture-core-utils/**` (`tsc --noEmit`) |
| `npm run overlay` | Stages `.nepal-workspace/` and applies the full Nepal overlay without compiling a ZIP |
| `npm run overlay:minimal` | Stages `.nepal-workspace-minimal/` without dual-date display hooks |
| `npm run build:full` | Full upstream overlay build + verification → `dist/capture-app-np-<version>.zip` |
| `npm run build:minimal` | Minimal upstream overlay build (picker + branding, stock AD displays) → `dist/capture-app-np-<version>-minimal.zip` |
| `npm run build:fast` | ~1.5–2s Nepal-only incremental rebuild (full profile) + ZIP verification |
| `npm run build:fast:minimal` | ~1.5–2s Nepal-only incremental rebuild (minimal profile) + ZIP verification |
| `npm run build:ext` | Compiles only `src/nepal/**` into `dist/nepal-extension.js` + `dist/nepal-extension.meta.json` |

## What Stays in Git vs. `.gitignore`

- **Keep gitignored**: `.nepal-cache/`, `.nepal-workspace/`, `.nepal-workspace-minimal/`, `dist/`, `build/`, and `node_modules/` are intentionally excluded in `.gitignore` so upstream Capture source and build caches never bloat Git.
- **Tracked in `public/`**: `public/capture-app-np-<version>.zip` (and `.sha256`) stays tracked so `npm run dev` boots instantly into the DHIS2 testing interface on fresh checkouts or ephemeral containers.

## Upgrading to a New DHIS2 Capture Release

1. Update `upstreamBaseTag` in `nepal/branding.json` (e.g. `v108.0.0`).
2. Run `npm run build:full` to verify all hooks, BS ↔ AD conversions, and the generated ZIP against the new tag.
3. Replace the prebuilt preview bundle in `public/` with the new ZIP and checksum from `dist/` (remove the old versioned files in `public/`).
4. Commit, tag, and push to trigger automated GitHub Actions release builds:

   ```bash
   git tag v108.0.0-np.1
   git push origin main --tags
   ```

GitHub Actions (`.github/workflows/release-capture-app-np.yml`) automatically clones the pinned upstream tag once, builds and verifies both profiles, and publishes **two separate GitHub Releases**:

- **Full Release** (`<tag>`, e.g. `v108.0.0-np.1`, marked Latest) — attaches `capture-app-np-<version>.zip` + `.sha256` (BS date picker, working-list Absolute range BS filter, and dual AD + BS displays).
- **Minimal Release** (`<tag>-minimal`, e.g. `v108.0.0-np.1-minimal`) — attaches `capture-app-np-<version>-minimal.zip` + `.sha256` (BS date picker, working-list Absolute range BS filter, and pure upstream AD displays).

You can also trigger the workflow manually via **Actions → Release Capture NP (Full & Minimal) → Run workflow** and choose `profile: both` (default), `full`, or `minimal`.

For detailed hook points, architecture, and troubleshooting, see [`nepal/UPGRADE_GUIDE.md`](nepal/UPGRADE_GUIDE.md).
