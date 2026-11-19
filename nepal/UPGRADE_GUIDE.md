# Capture NP (`capture-app-np`) — Architecture & Upstream Upgrade Guide

This repository maintains **Capture NP**, a custom Nepal overlay distribution of DHIS2 Capture (`coreApp: false`, title `"Capture NP"`, custom App Hub ID `c4f7a91e-8d2b-4f63-9a5c-7e1b3d0f82a4`). Instead of maintaining a full fork of 100,000+ lines of upstream `dhis2/capture-app`, this repo stores only Nepal-specific modules, branding assets, and automated overlay hooks.

---

## 1. Directory Layout

```text
src/
├── nepal/                                # Runtime Nepal extension (aliased as 'capture-nepal')
│   ├── index.ts                          # Public barrel export
│   ├── extensionEntry.ts                 # Standalone runtime bundle entrypoint (esbuild target)
│   ├── config/
│   │   └── nepalConfig.ts                # Typed branding metadata & feature flags
│   ├── runtime/
│   │   └── extensionHost.ts              # Host React/@dhis2/ui bridge + NepalDateAddonBridge
│   └── calendar/
│       ├── index.ts
│       ├── nepaliDate.ts                 # BS <-> AD conversion, validation, format support
│       └── NepaliDateAddon.component.tsx # Right-side BS button + floating top-right BS pill + popover
└── core_modules/                         # Reference copies of patched upstream hook files
    ├── capture-ui/DateAndTimeFields/DateField/Date.component.tsx
    └── capture-core-utils/hash/hashSHA256.ts

nepal/                                    # Overlay, branding, preview & verification automation
├── branding.json                         # Single source of truth for app ID, title, icon, upstream repo/tag
├── assets/
│   └── app-icon.png                      # Master Nepal Capture icon (PNG)
├── scripts/
│   ├── applyOverlayToBase.mjs            # Clones/caches upstream tag, stages .nepal-workspace, applies hooks & builds
│   ├── applyBranding.mjs                 # Idempotent stamper: d2.config.js, package.json, manifest, icons, i18n
│   ├── buildExtension.mjs                # Compiles src/nepal/** -> nepal-extension.js + meta.json (<0.5s)
│   ├── buildFast.mjs                     # ~1.5-2s incremental Nepal-only rebuild reusing cached workspace build/app
│   ├── buildRulesEngineCached.mjs        # Content-hashed cache wrapper for packages/rules-engine
│   ├── standalonePreview.mjs             # Serves full DHIS2 testing preview, /__dhis2 proxy, live ext & /api/bundles
│   └── verifyIntegration.mjs             # Verifies branding, aliases, hooks, BS<->AD roundtrips & --zip contents
└── UPGRADE_GUIDE.md                      # This guide

public/                                   # Committed prebuilt ZIP + .sha256 for instant `npm run dev` startup
.github/workflows/
└── release-capture-app-np.yml            # Builds, verifies, and attaches DHIS2 ZIP + .sha256 to GitHub Releases
```

> **Note on `.gitignore`**: `.nepal-cache/` (cached upstream clone + `node_modules`) and `.nepal-workspace/` (staged full Capture app build directory) are gitignored and must **never** be committed to GitHub.

---

## 2. Thin Upstream Hook Points (Applied Automatically)

During `npm run overlay` / `npm run build:full`, `nepal/scripts/applyOverlayToBase.mjs` patches only a small, auditable set of upstream `dhis2/capture-app` files inside `.nepal-workspace/` (all checked automatically by `nepal/scripts/verifyIntegration.mjs`):

| # | Core File (in staged workspace) | Purpose |
| --- | --- | --- |
| 0 | `src/index.tsx` | Calls `ensureNepalExtensionLoaded()` at startup to register the host bridge and preload `nepal-extension.js` |
| 1 | `src/core_modules/capture-ui/DateAndTimeFields/DateField/Date.component.tsx` | Imports `NepalDateAddonBridge` from `'capture-nepal/runtime/extensionHost'` and wraps `<CalendarInput>` |
| 2 | `src/core_modules/capture-ui/DateAndTimeFields/DateField/Date.types.ts` | Adds optional `hideNepaliPicker?: boolean` prop |
| 3 | `src/core_modules/capture-ui/DateAndTimeFields/DateRangeField/DateRangeField.component.tsx` | Passes `hideNepaliPicker` on filter date-range inputs |
| 4 | `src/core_modules/capture-ui/internal/AgeInput/AgeDateInput.component.tsx` (+ `AgeField/ageField.module.css`) | Widens DoB date field (`185px`) so both AD input + BS pill + BS icon fit cleanly |
| 5 | `src/core_modules/capture-core/storageControllers/mainStorageController.ts` | Fallback `DHIS2_CACHE_VERSION` (`'4'`) so IndexedDB never opens with `NaN` |
| 6 | `src/core_modules/capture-core-utils/hash/hashSHA256.ts` | Pure-JS SHA-256 fallback for HTTP (non-HTTPS) local/LAN DHIS2 deployments |

Branding files (`d2.config.js`, workspace `package.json` name/cacheVersion, `public/manifest.json`, `public/dhis2-app-icon.png`, favicons, and `__MANIFEST_APP_TITLE` in `i18n/*.pot`/`*.po`) are never edited manually—`nepal/scripts/applyBranding.mjs` regenerates them deterministically from `nepal/branding.json` and `nepal/assets/app-icon.png`.

---

## 3. Development, Preview & Build Workflows

### Instant Local DHIS2 Preview (`npm run dev`)

`npm run dev` runs Vite on `0.0.0.0:3000` with `nepal/scripts/standalonePreview.mjs`:

1. Loads the prebuilt Capture NP app from the newest `*.zip` in `dist/` or `public/` in memory without mutating the release ZIP on disk.
2. Enables `@dhis2/app-adapter` standalone testing mode (blank **Server**, **Username**, and **Password** login modal) and strips `<base target="_top" />` for iframe safety.
3. Routes requests to external DHIS2 servers through a transparent same-origin proxy (`/__dhis2/<base64url-server>/*`) with iframe-compatible `Set-Cookie` rewriting (`SameSite=None; Secure`), eliminating CORS and third-party cookie failures.
4. Intercepts `/nepal-extension.js` and `/nepal-extension.meta.json` and live-compiles `src/nepal/**` via `esbuild` whenever Nepal source files change (<0.5s).
5. Exposes untouched, checksum-verified release ZIP downloads at `/api/bundles` and `/api/bundles/<filename>`.

### Overlay Builds (`build:full` vs. `build:fast`)

- **One-time full build per upstream version**:
  ```bash
  npm run build:full
  ```
  Shallow-clones `upstreamRepo` at `upstreamBaseTag` into `.nepal-cache/upstream-base/`, stages `.nepal-workspace/`, installs dependencies, injects workspace scripts (`nepal:brand`, `nepal:build-ext`, `nepal:build-fast`, `nepal:verify`, `build:zip`), builds Capture NP, runs `verifyIntegration.mjs --zip`, and copies `dist/capture-app-np-<version>.zip`.
- **Fast ~1.5–2s Nepal-only incremental rebuild**:
  ```bash
  npm run build:fast
  ```
  Once `.nepal-workspace/build/app/index.html` exists, syncs only `src/nepal/**` and `nepal/**`, recompiles `nepal-extension.js` via `esbuild`, refreshes branding/icons, repacks the ZIP, runs full ZIP verification, and copies the updated ZIP to `dist/`—skipping all 7,300+ unchanged Capture core modules.
- **Extension-only build**:
  ```bash
  npm run build:ext
  ```
  Compiles only `src/nepal/extensionEntry.ts` into `dist/nepal-extension.js` + `dist/nepal-extension.meta.json`.

---

## 4. Upgrading to a New DHIS2 Capture Release

When DHIS2 publishes a new Capture version (for example `v108.0.0`):

1. Update `upstreamBaseTag` in `nepal/branding.json`:
   ```json
   "upstreamBaseTag": "v108.0.0"
   ```
2. Run a full overlay build & verification locally:
   ```bash
   npm run build:full
   ```
3. **If upstream refactored one of the hook files** and `applyOverlayToBase.mjs` or `verifyIntegration.mjs` reports a missed patch:
   - Inspect the target file inside `.nepal-workspace/src/...`.
   - Update the corresponding patch regex in `nepal/scripts/applyOverlayToBase.mjs` (or reference file under `src/core_modules/`).
   - Re-run `npm run build:full` until all verification checks pass.
4. Refresh the committed preview ZIP in `public/` so `npm run dev` boots the upgraded Capture base immediately:
   ```bash
   rm -f public/capture-app-np-*.zip public/capture-app-np-*.zip.sha256
   cp dist/capture-app-np-108.0.0.zip public/
   sha256sum dist/capture-app-np-108.0.0.zip | awk '{print $1 "  capture-app-np-108.0.0.zip"}' > public/capture-app-np-108.0.0.zip.sha256
   ```
5. Run `npm run lint` and `npm run build` to verify TypeScript and the standalone preview build, then commit your changes.

---

## 5. Publishing a Release ZIP via GitHub Actions

Push a tag matching `v<upstream-version>-np.<revision>` (for example `v108.0.0-np.1`):

```bash
git tag v108.0.0-np.1
git push origin main --tags
```

`.github/workflows/release-capture-app-np.yml` will automatically:
1. Read `upstreamRepo` and `upstreamBaseTag` from `nepal/branding.json` (or accept manual `workflow_dispatch` overrides for `upstream_tag` and `release_tag`).
2. Run `npm install --no-audit --no-fund`.
3. Run `npm run build:full -- --repo <upstreamRepo> --tag <upstreamTag>` (cloning upstream, applying the overlay, stamping branding, compiling the app & Nepal extension, and running `verifyIntegration.mjs --zip`).
4. Compute `dist/capture-app-np-<version>.zip.sha256`, upload both files as workflow artifacts, and attach them to a GitHub Release ready for **DHIS2 App Management → Manual Install**.

---

## 6. Adding Future Nepal-Specific Features

To keep future Nepal customizations isolated and upgrade-safe:

1. Create a dedicated subfolder under `src/nepal/<feature-name>/` (e.g. `src/nepal/wardSelector/`, `src/nepal/healthId/`).
2. Add a feature flag in `src/nepal/config/nepalConfig.ts` (`NEPAL_FEATURES`).
3. Re-export the feature from `src/nepal/index.ts` and `src/nepal/extensionEntry.ts`.
4. If the feature needs a new upstream hook point, add a minimal patch in `nepal/scripts/applyOverlayToBase.mjs` and a matching assertion in `nepal/scripts/verifyIntegration.mjs` so every future upgrade verifies it automatically.
