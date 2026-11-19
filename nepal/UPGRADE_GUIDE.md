# Capture NP (`capture-app-np`) — Architecture & Upstream Upgrade Guide

This repository maintains **Capture NP**, a custom Nepal distribution of DHIS2 Capture (`coreApp: false`, title `"Capture NP"`, custom UUID `c4f7a91e-8d2b-4f63-9a5c-7e1b3d0f82a4`), organized so that future upstream `dhis2/capture-app` upgrades require minimal conflict resolution and zero manual re-branding.

---

## 1. Directory Layout

All Nepal-specific code, configuration, assets, and release automation live in two dedicated top-level folders:

```text
src/nepal/                                # Runtime Nepal extension (aliased as 'capture-nepal')
├── index.ts                              # Public barrel export
├── config/
│   └── nepalConfig.ts                    # Typed branding metadata & feature flags
└── calendar/
    ├── index.ts
    ├── nepaliDate.ts                     # BS <-> AD conversion, validation, format support
    └── NepaliDateAddon.component.tsx     # Right-side BS button + floating top-right BS pill + popover

nepal/                                    # Build, branding & upgrade automation
├── branding.json                         # Single source of truth for app ID, title, icon, upstream tag
├── assets/
│   └── app-icon.png                      # Master Nepal Capture icon (125x125 PNG)
├── scripts/
│   ├── applyBranding.mjs                 # Idempotent stamper: d2.config.js, package.json, manifest, icons, i18n
│   ├── verifyIntegration.mjs             # Checks aliases, 6 thin hooks, BS<->AD roundtrips, and --zip bundle
│   └── upgradeUpstream.sh                # Automated upstream DHIS2 Capture tag merge & build script
└── UPGRADE_GUIDE.md                      # This guide

.github/workflows/
└── release-capture-app-np.yml            # Builds, verifies, and attaches DHIS2 ZIP to GitHub Releases
```

---

## 2. Thin Upstream Hook Points (Only 6 Core Files)

Upstream `dhis2/capture-app` files are kept untouched except for 6 tiny, auditable hooks (all checked automatically by `npm run nepal:verify`):

| # | Core File | Purpose |
|---|-----------|---------|
| 0 | `src/index.tsx` | Calls `ensureNepalExtensionLoaded()` at startup to register the host bridge and preload `nepal-extension.js` |
| 1 | `src/core_modules/capture-ui/DateAndTimeFields/DateField/Date.component.tsx` | Imports `NepalDateAddonBridge` from `'capture-nepal/runtime/extensionHost'` and wraps `<CalendarInput>` |
| 2 | `src/core_modules/capture-ui/DateAndTimeFields/DateField/Date.types.ts` | Adds optional `hideNepaliPicker?: boolean` prop |
| 3 | `src/core_modules/capture-ui/DateAndTimeFields/DateRangeField/DateRangeField.component.tsx` | Passes `hideNepaliPicker` on filter date-range inputs |
| 4 | `src/core_modules/capture-ui/internal/AgeInput/AgeDateInput.component.tsx` (+ `AgeField/ageField.module.css`) | Widens DoB date field (`185px`) so both AD input + BS pill + BS icon fit cleanly |
| 5 | `src/core_modules/capture-core/storageControllers/mainStorageController.ts` | Fallback `DHIS2_CACHE_VERSION` (`'4'`) so IndexedDB never opens with `NaN` |
| 6 | `src/core_modules/capture-core-utils/hash/hashSHA256.ts` | Pure-JS SHA-256 fallback for HTTP (non-HTTPS) local/LAN DHIS2 deployments |

Branding files (`d2.config.js`, `package.json` name, `public/manifest.json`, `public/dhis2-app-icon.png`, favicons, and `__MANIFEST_APP_TITLE` in `i18n/*.pot`/`*.po`) are **never merged by hand** — `npm run nepal:brand` regenerates them deterministically from `nepal/branding.json` and `nepal/assets/app-icon.png`.

---

## 2B. Fast ~2–3s Nepal-Only Rebuilds (Skipping Unchanged Capture Core)

Because `DateField` loads `nepal-extension.js` through the runtime host bridge (`src/nepal/runtime/extensionHost.ts`), you only run `npm run build:zip` **once per upstream DHIS2 Capture version**.

Whenever you edit anything under `src/nepal/**`, `nepal/branding.json`, or `nepal/assets/app-icon.png`, run:

```bash
npm run nepal:build-fast
```

This recompiles **only** `src/nepal/**` with `esbuild` (~0.3s), updates branding/icons and cache-busting metadata, repacks `build/bundle/capture-app-np-<version>.zip`, and verifies the ZIP in ~2–3 seconds total—without touching the 7,300+ unchanged Capture modules.

### Building Directly From the Upstream Capture Git Repo (or a Local Directory)

To maintain a tiny Nepal-only GitHub repository (zero upstream Capture core files committed):
1. Generate or download the clean template via `npm run nepal:export-repo` (outputs `nepal-repo-template/` and `build/bundle/capture-app-np-overlay-repo.zip`).
2. Push that clean template to GitHub. `nepal/branding.json` already defines `upstreamRepo` (`https://github.com/dhis2/capture-app.git`) and `upstreamBaseTag` (`v107.9.3`), so you simply run:
   ```bash
   npm install
   npm run build:full   # Clones & caches upstream tag once, overlays Nepal changes, builds ZIP
   npm run build:fast   # ~1.5s after any Nepal feature change (zero network/core rebuild)
   ```
   You can also override the Git repo/tag anytime (`--repo <git-url> --tag <tag>` or `CAPTURE_BASE_REPO` / `CAPTURE_BASE_TAG`), or point to an existing local checkout (`--base /path/to/capture-app`).

---

## 3. Upgrading to a New DHIS2 Capture Release

When DHIS2 releases a new Capture version (for example `v108.0.0`):

```bash
npm run nepal:upgrade -- v108.0.0
```

What the script does automatically:
1. Fetches tags from `upstream` (`https://github.com/dhis2/capture-app.git`).
2. Creates an upgrade branch `upgrade/v108.0.0` and merges `v108.0.0`.
3. Auto-resolves branding/i18n conflicts (`i18n/*`, `public/*`, `d2.config.js`) in favor of upstream because `nepal:brand` re-stamps them cleanly.
4. Updates `upstreamBaseTag` in `nepal/branding.json`.
5. Runs `npm install` → `npm run nepal:brand` → `npm run nepal:verify` → `npm run lint` → `npm run build:zip` → ZIP verification.

If upstream refactored one of the 6 hook files and Git pauses with a conflict:
1. Resolve only the listed source file(s), preserving the thin hook from the table above.
2. Stage your resolution (`git add <file>`).
3. Run:
   ```bash
   npm install && npm run nepal:brand && npm run nepal:verify && npm run lint && npm run build:zip && node nepal/scripts/verifyIntegration.mjs --zip
   ```
4. Commit the merge.

---

## 4. Publishing a Release ZIP via GitHub Actions

Push a tag matching `v<upstream-version>-np.<revision>` (for example `v108.0.0-np.1`):

```bash
git tag v108.0.0-np.1
git push origin v108.0.0-np.1
```

`.github/workflows/release-capture-app-np.yml` will automatically:
- Stamp Nepal branding (`npm run nepal:brand`)
- Verify all hooks and BS ↔ AD conversions (`npm run nepal:verify`)
- Typecheck (`npm run lint`)
- Build `build/bundle/capture-app-np-<version>.zip` (`npm run build:zip`)
- Inspect the ZIP's `manifest.webapp`, `manifest.webapp.translations.json`, and `dhis2-app-icon.png`
- Attach the verified `.zip` and `.sha256` checksum to a GitHub Release ready for DHIS2 App Management upload.

You can also trigger a manual build anytime from GitHub Actions via **Run workflow** (`workflow_dispatch`).

---

## 5. Adding Future Nepal-Specific Features

To keep future Nepal customizations just as clean and upgrade-safe:
1. Create a dedicated subfolder under `src/nepal/<feature-name>/` (e.g. `src/nepal/wardSelector/`, `src/nepal/healthId/`).
2. Add a feature flag in `src/nepal/config/nepalConfig.ts` (`NEPAL_FEATURES`).
3. Re-export the feature from `src/nepal/index.ts`.
4. Wire it into upstream Capture via a 1–3 line import from `'capture-nepal'` gated by `NEPAL_FEATURES.<flag>`.
5. Add an assertion for the new hook in `nepal/scripts/verifyIntegration.mjs` so every future upgrade verifies it automatically.
