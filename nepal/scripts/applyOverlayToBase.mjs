#!/usr/bin/env node
/**
 * Overlays ONLY the Nepal features, branding, and minimal host hooks onto an
 * upstream `dhis2/capture-app` Git repository (defaulting to `upstreamRepo` +
 * `upstreamBaseTag` in `nepal/branding.json`) OR an existing local directory.
 *
 * When a Git URL is used, the shallow clone + installed `node_modules` are cached
 * under `.nepal-cache/upstream-base/` so subsequent builds and 1.5s fast rebuilds
 * never re-clone or re-download packages.
 *
 * Usage:
 *   npm run build:full                                              # Uses nepal/branding.json Git URL & tag
 *   npm run build:full -- --repo https://github.com/dhis2/capture-app.git --tag v107.9.3
 *   CAPTURE_BASE_REPO=https://github.com/dhis2/capture-app.git CAPTURE_BASE_TAG=v107.9.3 npm run build:full
 *   npm run build:full -- --base /path/to/local/capture-app         # Optional local directory
 *   npm run build:fast                                              # ~1.5s Nepal-only rebuild
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OVERLAY_ROOT = path.resolve(__dirname, '../..');

function readBrandingDefaults() {
    const brandingPath = path.join(OVERLAY_ROOT, 'nepal', 'branding.json');
    if (!fs.existsSync(brandingPath)) {
        return { upstreamRepo: 'https://github.com/dhis2/capture-app.git', upstreamBaseTag: 'v107.9.3' };
    }
    return JSON.parse(fs.readFileSync(brandingPath, 'utf8'));
}

function isGitUrl(value) {
    if (!value) return false;
    return /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/i.test(value) || value.endsWith('.git');
}

function parseArgs(argv) {
    const branding = readBrandingDefaults();
    const opts = {
        baseDir: process.env.CAPTURE_BASE_DIR || '',
        repoUrl: process.env.CAPTURE_BASE_REPO || '',
        repoTag: process.env.CAPTURE_BASE_TAG || branding.upstreamBaseTag || 'v107.9.3',
        defaultRepoUrl: branding.upstreamRepo || 'https://github.com/dhis2/capture-app.git',
        workspaceDir: path.join(OVERLAY_ROOT, '.nepal-workspace'),
        workspaceExplicit: false,
        buildFull: false,
        buildFast: false,
        minimal: false,
        install: false,
        refreshBase: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--base' && argv[i + 1]) {
            opts.baseDir = argv[i + 1];
            i += 1;
        } else if (arg === '--repo' && argv[i + 1]) {
            opts.repoUrl = argv[i + 1];
            i += 1;
        } else if ((arg === '--tag' || arg === '--ref') && argv[i + 1]) {
            opts.repoTag = argv[i + 1];
            i += 1;
        } else if (arg === '--workspace' && argv[i + 1]) {
            opts.workspaceDir = path.resolve(OVERLAY_ROOT, argv[i + 1]);
            opts.workspaceExplicit = true;
            i += 1;
        } else if (arg === '--build-full') {
            opts.buildFull = true;
        } else if (arg === '--build-fast') {
            opts.buildFast = true;
        } else if (arg === '--minimal') {
            opts.minimal = true;
        } else if (arg === '--install') {
            opts.install = true;
        } else if (arg === '--refresh-base') {
            opts.refreshBase = true;
        }
    }

    if (opts.minimal && !opts.workspaceExplicit) {
        opts.workspaceDir = path.join(OVERLAY_ROOT, '.nepal-workspace-minimal');
    }

    // If user passed a Git URL in --base or CAPTURE_BASE_DIR, automatically treat it as --repo
    if (isGitUrl(opts.baseDir)) {
        opts.repoUrl = opts.baseDir;
        opts.baseDir = '';
    }

    // Default to nepal/branding.json upstreamRepo when no local baseDir is given
    if (!opts.baseDir && !opts.repoUrl) {
        opts.repoUrl = opts.defaultRepoUrl;
    }

    return opts;
}

function resolveCachedGitBase(repoUrl, repoTag, refreshBase) {
    const safeTag = String(repoTag || 'HEAD').replace(/[^0-9A-Za-z._-]+/g, '_');
    const repoHash = crypto.createHash('sha256').update(repoUrl).digest('hex').slice(0, 8);
    const cacheDir = path.join(OVERLAY_ROOT, '.nepal-cache', 'upstream-base', `${safeTag}-${repoHash}`);

    if (refreshBase && fs.existsSync(cacheDir)) {
        console.log(`[overlay] Refreshing cached upstream clone at ${path.relative(OVERLAY_ROOT, cacheDir)}...`);
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }

    if (!fs.existsSync(path.join(cacheDir, 'package.json'))) {
        fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
        console.log(`[overlay] Cloning ${repoUrl} (${repoTag}) into ${path.relative(OVERLAY_ROOT, cacheDir)}...`);
        try {
            execFileSync('git', ['clone', '--branch', repoTag, '--depth', '1', repoUrl, cacheDir], {
                cwd: OVERLAY_ROOT,
                stdio: 'inherit',
            });
        } catch {
            // Fallback for raw commit SHAs that cannot be passed directly to --branch
            fs.rmSync(cacheDir, { recursive: true, force: true });
            execFileSync('git', ['clone', '--no-checkout', repoUrl, cacheDir], {
                cwd: OVERLAY_ROOT,
                stdio: 'inherit',
            });
            execFileSync('git', ['checkout', repoTag], {
                cwd: cacheDir,
                stdio: 'inherit',
            });
        }
    } else {
        console.log(`[overlay] Reusing cached Git base: ${path.relative(OVERLAY_ROOT, cacheDir)} (${repoTag})`);
    }

    if (!fs.existsSync(path.join(cacheDir, 'node_modules'))) {
        console.log('[overlay] Installing upstream Capture dependencies once into cached base...');
        execSync('npm install --legacy-peer-deps --no-audit --no-fund', {
            cwd: cacheDir,
            stdio: 'inherit',
        });
    }

    return cacheDir;
}

function patchFile(filePath, patcher, label) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`[overlay] Expected upstream file not found for ${label}: ${filePath}`);
    }
    const before = fs.readFileSync(filePath, 'utf8');
    const after = patcher(before);
    if (after !== before) {
        fs.writeFileSync(filePath, after, 'utf8');
        console.log(`  [patched] ${label}`);
    } else {
        console.log(`  [ok]      ${label}`);
    }
}

function stageBaseCapture(baseDir, workspaceDir) {
    const resolvedBase = path.resolve(baseDir);
    if (!fs.existsSync(path.join(resolvedBase, 'package.json')) || !fs.existsSync(path.join(resolvedBase, 'src'))) {
        throw new Error(`Invalid capture-app base directory: ${resolvedBase} (missing package.json or src/)`);
    }

    const preserveBuild = fs.existsSync(path.join(workspaceDir, 'build', 'app', 'index.html'));
    const tempBuildBackup = path.join(OVERLAY_ROOT, '.nepal-cache', 'workspace-build-backup');

    if (preserveBuild) {
        fs.rmSync(tempBuildBackup, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(tempBuildBackup), { recursive: true });
        fs.cpSync(path.join(workspaceDir, 'build'), tempBuildBackup, { recursive: true });
    }

    fs.mkdirSync(workspaceDir, { recursive: true });

    const copyItems = [
        'src',
        'public',
        'i18n',
        'packages',
        'scripts',
        'config',
        'patches',
        'd2.config.js',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'vite.config.mts',
        'vite.config.ts',
    ];

    for (const item of copyItems) {
        const src = path.join(resolvedBase, item);
        const dst = path.join(workspaceDir, item);
        if (!fs.existsSync(src)) continue;
        fs.rmSync(dst, { recursive: true, force: true });
        fs.cpSync(src, dst, { recursive: true, force: true });
    }

    // Reuse base node_modules via symlink when available (huge speed win)
    const baseNodeModules = path.join(resolvedBase, 'node_modules');
    const wsNodeModules = path.join(workspaceDir, 'node_modules');
    if (fs.existsSync(baseNodeModules)) {
        fs.rmSync(wsNodeModules, { recursive: true, force: true });
        fs.symlinkSync(baseNodeModules, wsNodeModules, 'dir');
    }

    if (preserveBuild && fs.existsSync(tempBuildBackup)) {
        fs.rmSync(path.join(workspaceDir, 'build'), { recursive: true, force: true });
        fs.cpSync(tempBuildBackup, path.join(workspaceDir, 'build'), { recursive: true });
        fs.rmSync(tempBuildBackup, { recursive: true, force: true });
    }
}

function applyMinimalConfigToWorkspace(workspaceDir) {
    patchFile(
        path.join(workspaceDir, 'src', 'nepal', 'config', 'nepalConfig.ts'),
        raw => raw.replace(/nepaliDateDisplay:\s*true/, 'nepaliDateDisplay: false'),
        'nepalConfig.ts disable nepaliDateDisplay (minimal profile)',
    );
}

function applyNepalOverlay(workspaceDir, { minimal = false } = {}) {
    console.log(
        `[overlay] Profile: ${minimal ? 'minimal (skipping dual BS date display hooks)' : 'full (BS date picker + dual AD/BS display)'}`,
    );
    console.log('[overlay] Copying isolated Nepal extension & scripts...');
    fs.rmSync(path.join(workspaceDir, 'src', 'nepal'), { recursive: true, force: true });
    fs.cpSync(path.join(OVERLAY_ROOT, 'src', 'nepal'), path.join(workspaceDir, 'src', 'nepal'), { recursive: true });

    fs.rmSync(path.join(workspaceDir, 'nepal'), { recursive: true, force: true });
    fs.cpSync(path.join(OVERLAY_ROOT, 'nepal'), path.join(workspaceDir, 'nepal'), { recursive: true });

    if (minimal) {
        applyMinimalConfigToWorkspace(workspaceDir);
    }

    console.log('[overlay] Applying thin upstream hooks...');

    // 1. tsconfig.json alias
    patchFile(
        path.join(workspaceDir, 'tsconfig.json'),
        (raw) => {
            if (raw.includes('"capture-nepal"')) return raw;
            return raw.replace(
                /("capture-core-utils\/\*":\s*\[[^\]]+\])/,
                '$1,\n      "capture-nepal": ["./src/nepal"],\n      "capture-nepal/*": ["./src/nepal/*"]',
            );
        },
        'tsconfig.json capture-nepal alias',
    );

    // 2. vite.config.mts alias + cache version define
    const vitePath = fs.existsSync(path.join(workspaceDir, 'vite.config.mts'))
        ? path.join(workspaceDir, 'vite.config.mts')
        : path.join(workspaceDir, 'vite.config.ts');
    if (fs.existsSync(vitePath)) {
        patchFile(
            vitePath,
            (raw) => {
                let next = raw;
                if (!next.includes("'capture-nepal'")) {
                    next = next.replace(
                        /('capture-core-utils':[^\n]+,)/,
                        "$1\n                'capture-nepal': path.resolve(__dirname, 'src/nepal'),",
                    );
                }
                if (!next.includes('DHIS2_CACHE_VERSION')) {
                    next = next.replace(
                        /(define:\s*\{)/,
                        "$1\n            'process.env.DHIS2_CACHE_VERSION': JSON.stringify(process.env.DHIS2_CACHE_VERSION || '4'),",
                    );
                }
                return next;
            },
            `${path.basename(vitePath)} capture-nepal alias`,
        );
    }

    // 3. src/index.tsx preload hook
    patchFile(
        path.join(workspaceDir, 'src', 'index.tsx'),
        (raw) => {
            if (raw.includes('ensureNepalExtensionLoaded')) return raw;
            return raw
                .replace(
                    /(import\s+\{\s*AppStart\s*\}\s+from\s+['"][^'"]+['"];)/,
                    "$1\nimport { ensureNepalExtensionLoaded } from 'capture-nepal/runtime/extensionHost';",
                )
                .replace(
                    /(export\s+default\s+)/,
                    'void ensureNepalExtensionLoaded();\n\n$1',
                );
        },
        'src/index.tsx Nepal extension preload',
    );

    // 4. Date.types.ts hideNepaliPicker prop
    patchFile(
        path.join(workspaceDir, 'src/core_modules/capture-ui/DateAndTimeFields/DateField/Date.types.ts'),
        (raw) => {
            if (raw.includes('hideNepaliPicker')) return raw;
            return raw.replace(
                /(validation\?:\s*ValidationProps\s*\|\s*null;)/,
                '$1\n    hideNepaliPicker?: boolean;',
            );
        },
        'Date.types.ts hideNepaliPicker prop',
    );

    // 5. Date.component.tsx NepalDateAddonBridge hook
    patchFile(
        path.join(workspaceDir, 'src/core_modules/capture-ui/DateAndTimeFields/DateField/Date.component.tsx'),
        (raw) => {
            if (raw.includes('NepalDateAddonBridge')) return raw;
            // Sync clean decoupled Date.component.tsx from overlay repo if present
            const referencePath = path.join(OVERLAY_ROOT, 'src/core_modules/capture-ui/DateAndTimeFields/DateField/Date.component.tsx');
            if (fs.existsSync(referencePath)) {
                return fs.readFileSync(referencePath, 'utf8');
            }
            return raw;
        },
        'Date.component.tsx NepalDateAddonBridge hook',
    );

    // 6. DateRangeField.component.tsx hideNepaliPicker
    patchFile(
        path.join(workspaceDir, 'src/core_modules/capture-ui/DateAndTimeFields/DateRangeField/DateRangeField.component.tsx'),
        (raw) => {
            if (raw.includes('hideNepaliPicker')) return raw;
            return raw.replace(
                /(onChange=\{this\.handle(?:From|To)Change\})/g,
                '$1\n                    hideNepaliPicker',
            );
        },
        'DateRangeField.component.tsx hideNepaliPicker',
    );

    // 7. AgeDateInput width=185 & ageField.module.css width: 185px
    patchFile(
        path.join(workspaceDir, 'src/core_modules/capture-ui/internal/AgeInput/AgeDateInput.component.tsx'),
        raw => raw.replace(/width=\{150\}/, 'width={185}'),
        'AgeDateInput.component.tsx DoB width=185',
    );
    patchFile(
        path.join(workspaceDir, 'src/core_modules/capture-ui/AgeField/ageField.module.css'),
        raw => raw.replace(/(\.ageDateInputContainerHorizontal\s*\{[^}]*width:\s*)150px/, '$1185px'),
        'ageField.module.css DoB container 185px',
    );

    // 8. mainStorageController.ts DHIS2_CACHE_VERSION fallback
    patchFile(
        path.join(workspaceDir, 'src/core_modules/capture-core/storageControllers/mainStorageController.ts'),
        (raw) => {
            if (raw.includes("process.env.DHIS2_CACHE_VERSION || '4'")) return raw;
            return raw.replace(
                /const\s+computeAppCacheVersion\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\};/,
                `const computeAppCacheVersion = () => {\n    const appCacheVersionAsString = process.env.DHIS2_CACHE_VERSION || '4';\n    const appCacheVersion = Number(appCacheVersionAsString);\n    return compute4DigitVersionString(Number.isFinite(appCacheVersion) ? appCacheVersion : 4);\n};`,
            );
        },
        'mainStorageController.ts cache version fallback',
    );

    // 9. hashSHA256.ts non-HTTPS fallback
    const refHash = path.join(OVERLAY_ROOT, 'src/core_modules/capture-core-utils/hash/hashSHA256.ts');
    patchFile(
        path.join(workspaceDir, 'src/core_modules/capture-core-utils/hash/hashSHA256.ts'),
        (raw) => {
            if (raw.includes('sha256Fallback')) return raw;
            if (fs.existsSync(refHash)) {
                return fs.readFileSync(refHash, 'utf8');
            }
            return raw;
        },
        'hashSHA256.ts non-HTTPS fallback',
    );

    // 9b. D2Date.component.tsx opt-in NepalDateAddonBridge (core hook: active in both Full & Minimal)
    patchFile(
        path.join(workspaceDir, 'src/core_modules/capture-core/components/FormFields/DateAndTime/D2Date/D2Date.component.tsx'),
        (raw) => {
            if (raw.includes('NepalDateAddonBridge')) return raw;
            return raw
                .replace(
                    /(import\s+\{\s*CalendarInput\s*\}\s+from\s+'@dhis2\/ui';)/,
                    "$1\nimport { NepalDateAddonBridge } from 'capture-nepal/runtime/extensionHost';",
                )
                .replace(
                    /(dense\?:\s*boolean;)/,
                    '$1\n    showNepaliPicker?: boolean;',
                )
                .replace(
                    /(this\.props\.onDateSelectedFromCalendar && this\.props\.onDateSelectedFromCalendar\(\);\s*\})/,
                    `$1\n\n    handleNepaliDateSelected = (adDate: string | null, validationOptions?: { error?: string | null }) => {\n        const hasError = Boolean(validationOptions?.error);\n        this.props.onBlur({\n            value: adDate ?? '',\n            error: validationOptions?.error || undefined,\n            isValid: !hasError,\n        });\n    }`,
                )
                .replace(
                    /(disabled,\s*\.\.\.passOnProps\s*\} = this\.props;)/,
                    'disabled,\n            showNepaliPicker,\n            ...passOnProps\n        } = this.props;',
                )
                .replace(
                    /return \(\s*<div>\s*<CalendarInput([\s\S]*?)\/>\s*<\/div>\s*\);/,
                    `const normalizedFormat = format === 'DD-MM-YYYY' ? 'DD-MM-YYYY' : 'YYYY-MM-DD';\n        const enableNepaliAddon = Boolean(showNepaliPicker) && (calendarType === 'gregory' || calendarType === 'iso8601');\n\n        const calendarInputElement = (\n            <CalendarInput$1/>\n        );\n\n        if (enableNepaliAddon) {\n            return (\n                <NepalDateAddonBridge\n                    adValue={typeof value === 'string' ? value : null}\n                    dateFormat={normalizedFormat}\n                    disabled={!!disabled}\n                    dense={!!this.props.dense}\n                    width={inputWidth || '100%'}\n                    onSelectAdDate={this.handleNepaliDateSelected}\n                    onDateSelectedFromCalendar={onDateSelectedFromCalendar}\n                >\n                    {calendarInputElement}\n                </NepalDateAddonBridge>\n            );\n        }\n\n        return (\n            <div>\n                {calendarInputElement}\n            </div>\n        );`,
                )
                .replace(
                    /inputWidth=\{inputWidth\}/,
                    "inputWidth={enableNepaliAddon ? '100%' : inputWidth}",
                );
        },
        'D2Date.component.tsx opt-in NepalDateAddonBridge',
    );

    // 9c. Working list AbsoluteRangeFilter From/To compact BS picker trigger (core hook: Full & Minimal)
    patchFile(
        path.join(workspaceDir, 'src/core_modules/capture-core/components/FiltersForTypes/Date/AbsoluteRangeFilter.component.tsx'),
        (raw) => {
            if (raw.includes('showNepaliPicker')) return raw;
            return raw.replace(
                /inputWidth="150px"\s*calendarWidth="330px"\s*dense/g,
                'inputWidth="168px"\n                            calendarWidth="330px"\n                            dense\n                            showNepaliPicker',
            );
        },
        'AbsoluteRangeFilter.component.tsx compact BS picker trigger',
    );

    if (!minimal) {
        // 10. clientToView.tsx dual AD + BS read-only view formatting
        patchFile(
            path.join(workspaceDir, 'src/core_modules/capture-core/converters/clientToView.tsx'),
            (raw) => {
                if (raw.includes('capture-nepal/runtime/dateDisplayBridge')) return raw;
                return raw
                    .replace(
                        /(import\s+\{\s*convertIsoToLocalCalendar\s*\}\s+from\s+'\.\.\/utils\/converters\/date';)/,
                        "$1\nimport { systemSettingsStore } from '../metaDataMemoryStores';\nimport { formatDisplayDate, formatDisplayDateTime } from 'capture-nepal/runtime/dateDisplayBridge';",
                    )
                    .replace(
                        /function convertDateForView\(rawValue: string\): string \{\s*return convertIsoToLocalCalendar\(rawValue\);\s*\}/,
                        `function convertDateForView(rawValue: string): string {\n    const localDate = convertIsoToLocalCalendar(rawValue);\n    const { calendar, dateFormat } = systemSettingsStore.get();\n    return formatDisplayDate(localDate, { rawValue, calendar, dateFormat });\n}`,
                    )
                    .replace(
                        /function convertDateTimeForView\(rawValue: string\): string \{\s*const timeString = formatMomentEn\(rawValue, 'HH:mm'\);\s*const localDate = convertIsoToLocalCalendar\(rawValue\);\s*return `\$\{localDate\} \$\{timeString\}`;\s*\}/,
                        `function convertDateTimeForView(rawValue: string): string {\n    const timeString = formatMomentEn(rawValue, 'HH:mm');\n    const localDate = convertIsoToLocalCalendar(rawValue);\n    const { calendar, dateFormat } = systemSettingsStore.get();\n    return formatDisplayDateTime(localDate, timeString, { rawValue, calendar, dateFormat });\n}`,
                    );
            },
            'clientToView.tsx dual AD + BS display',
        );

        // 11. clientToList.tsx dual AD + BS list, table & range formatting
        patchFile(
            path.join(workspaceDir, 'src/core_modules/capture-core/converters/clientToList.tsx'),
            (raw) => {
                if (raw.includes('capture-nepal/runtime/dateDisplayBridge')) return raw;
                return raw
                    .replace(
                        /(import\s+\{\s*convertIsoToLocalCalendar\s*\}\s+from\s+'\.\.\/utils\/converters\/date';)/,
                        "$1\nimport { systemSettingsStore } from '../metaDataMemoryStores';\nimport { formatDisplayDate, formatDisplayDateTime } from 'capture-nepal/runtime/dateDisplayBridge';",
                    )
                    .replace(
                        /function convertDateForListDisplay\(rawValue: string\): string \{\s*return convertIsoToLocalCalendar\(rawValue\);\s*\}/,
                        `function convertDateForListDisplay(rawValue: string): string {\n    const localDate = convertIsoToLocalCalendar(rawValue);\n    const { calendar, dateFormat } = systemSettingsStore.get();\n    return formatDisplayDate(localDate, { rawValue, calendar, dateFormat });\n}`,
                    )
                    .replace(
                        /function convertDateTimeForListDisplay\(rawValue: string\): string \{\s*const timeString = formatMomentEn\(rawValue, 'HH:mm'\);\s*const localDate = convertIsoToLocalCalendar\(rawValue\);\s*return `\$\{localDate\} \$\{timeString\}`;\s*\}/,
                        `function convertDateTimeForListDisplay(rawValue: string): string {\n    const timeString = formatMomentEn(rawValue, 'HH:mm');\n    const localDate = convertIsoToLocalCalendar(rawValue);\n    const { calendar, dateFormat } = systemSettingsStore.get();\n    return formatDisplayDateTime(localDate, timeString, { rawValue, calendar, dateFormat });\n}`,
                    )
                    .replace(
                        /convertRangeForDisplay\(convertIsoToLocalCalendar,\s*value\)/g,
                        'convertRangeForDisplay(convertDateForListDisplay, value)',
                    );
            },
            'clientToList.tsx dual AD + BS display',
        );

        // 12. WidgetEnrollment/Date/Date.component.tsx edit-safety guard (keep inline editor seeded with plain AD)
        patchFile(
            path.join(workspaceDir, 'src/core_modules/capture-core/components/WidgetEnrollment/Date/Date.component.tsx'),
            (raw) => {
                if (raw.includes('setSelectedDate(convertIsoToLocalCalendar(date))')) return raw;
                return raw
                    .replace(
                        /import\s+\{\s*convertDateObjectToDateFormatString\s*\}\s+from\s+'capture-core\/utils\/converters\/date';/,
                        "import { convertDateObjectToDateFormatString, convertIsoToLocalCalendar } from 'capture-core/utils/converters/date';",
                    )
                    .replace(
                        /setSelectedDate\(String\(convertValueClientToView\(date,\s*dataElementTypes\.DATE\)\)\);/,
                        'setSelectedDate(convertIsoToLocalCalendar(date));',
                    );
            },
            'WidgetEnrollment Date.component.tsx edit-mode AD initializer',
        );

        // 13. WidgetStagesAndEvents StageDetail scheduled status badge dual AD + BS display
        patchFile(
            path.join(workspaceDir, 'src/core_modules/capture-core/components/WidgetStagesAndEvents/Stages/Stage/StageDetail/hooks/helpers.ts'),
            (raw) => {
                if (raw.includes('capture-nepal/runtime/dateDisplayBridge')) return raw;
                return raw
                    .replace(
                        /(import\s+\{\s*convertIsoToLocalCalendar\s*\}\s+from\s+'\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/utils\/converters\/date';)/,
                        "$1\nimport { systemSettingsStore } from '../../../../../../metaDataMemoryStores';\nimport { formatDisplayDate } from 'capture-nepal/runtime/dateDisplayBridge';",
                    )
                    .replace(
                        /return\s+\{\s*status:\s*statusTypes\.SCHEDULE,\s*options:\s*convertIsoToLocalCalendar\(event\.scheduledAt\)\s*\};/,
                        `const localScheduledDate = convertIsoToLocalCalendar(event.scheduledAt);\n        const { calendar, dateFormat } = systemSettingsStore.get();\n        return {\n            status: statusTypes.SCHEDULE,\n            options: formatDisplayDate(localScheduledDate, { rawValue: event.scheduledAt, calendar, dateFormat }),\n        };`,
                    );
            },
            'StageDetail helpers.ts scheduled status dual AD + BS',
        );

        // 14a. Working list active Date filter button summary chip dual AD + BS display
        patchFile(
            path.join(workspaceDir, 'src/core_modules/capture-core/components/ListView/Filters/FilterButton/buttonTextBuilder/converters/dateConverter.ts'),
            (raw) => {
                if (raw.includes('capture-nepal/runtime/dateDisplayBridge')) return raw;
                return raw
                    .replace(
                        /(import\s+\{\s*convertIsoToLocalCalendar\s*\}\s+from\s+'\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/utils\/converters\/date';)/,
                        "$1\nimport { systemSettingsStore } from '../../../../../../metaDataMemoryStores';\nimport { formatDisplayDate } from 'capture-nepal/runtime/dateDisplayBridge';",
                    )
                    .replace(
                        /function translateAbsoluteDate\(/,
                        `function formatFilterDateForChip(rawValue?: string | null): string {\n    const localDate = convertIsoToLocalCalendar(rawValue);\n    const { calendar, dateFormat } = systemSettingsStore.get();\n    return formatDisplayDate(localDate, { rawValue, calendar, dateFormat });\n}\n\nfunction translateAbsoluteDate(`,
                    )
                    .replace(
                        /convertIsoToLocalCalendar\((fromValue|toValue)\)/g,
                        'formatFilterDateForChip($1)',
                    );
            },
            'FilterButton dateConverter.ts dual AD + BS chip',
        );

        // 14b. Working list active DateTime filter button summary chip dual AD + BS display
        patchFile(
            path.join(workspaceDir, 'src/core_modules/capture-core/components/ListView/Filters/FilterButton/buttonTextBuilder/converters/dateTimeConverter.ts'),
            (raw) => {
                if (raw.includes('capture-nepal/runtime/dateDisplayBridge')) return raw;
                return raw
                    .replace(
                        /(import\s+\{\s*convertIsoToLocalCalendar\s*\}\s+from\s+'\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/utils\/converters\/date';)/,
                        "$1\nimport { systemSettingsStore } from '../../../../../../metaDataMemoryStores';\nimport { formatDisplayDateTime } from 'capture-nepal/runtime/dateDisplayBridge';",
                    )
                    .replace(
                        /return `\$\{convertIsoToLocalCalendar\(datePart\)\} \$\{timePart\?\.slice\(0, 5\) \?\? ''\}`\.trim\(\);/,
                        `const localDate = convertIsoToLocalCalendar(datePart);\n    const { calendar, dateFormat } = systemSettingsStore.get();\n    return formatDisplayDateTime(localDate, timePart?.slice(0, 5) ?? '', { rawValue: datePart, calendar, dateFormat });`,
                    );
            },
            'FilterButton dateTimeConverter.ts dual AD + BS chip',
        );

        // 15. WidgetEventSchedule InfoBox auto-scheduled date banner dual AD + BS display
        patchFile(
            path.join(workspaceDir, 'src/core_modules/capture-core/components/WidgetEventSchedule/InfoBox/InfoBox.component.tsx'),
            (raw) => {
                if (raw.includes('capture-nepal/runtime/dateDisplayBridge')) return raw;
                return raw
                    .replace(
                        /(import\s+\{\s*LabelKeys,\s*useTermLabel\s*\}\s+from\s+'\.\.\/\.\.\/\.\.\/customLabels';)/,
                        "$1\nimport { convertIsoToLocalCalendar } from '../../../utils/converters/date';\nimport { systemSettingsStore } from '../../../metaDataMemoryStores';\nimport { formatDisplayDate } from 'capture-nepal/runtime/dateDisplayBridge';",
                    )
                    .replace(
                        /const scheduledDateMatchesSuggested = scheduleDate === suggestedScheduleDate;/,
                        `const scheduledDateMatchesSuggested = scheduleDate === suggestedScheduleDate;\n    const { calendar, dateFormat } = systemSettingsStore.get();\n    const suggestedScheduleDateDisplay = formatDisplayDate(\n        convertIsoToLocalCalendar(suggestedScheduleDate) || suggestedScheduleDate,\n        { rawValue: suggestedScheduleDate, calendar, dateFormat },\n    );`,
                    )
                    .replace(
                        /i18n\.t\('Scheduled automatically for \{\{suggestedScheduleDate\}\}',\s*\{\s*suggestedScheduleDate\s*\}\)/,
                        "i18n.t('Scheduled automatically for {{suggestedScheduleDate}}', { suggestedScheduleDate: suggestedScheduleDateDisplay })",
                    );
            },
            'WidgetEventSchedule InfoBox.component.tsx dual AD + BS banner',
        );
    } else {
        console.log('  [skip]    Hooks #7-#12 (dual AD + BS display) skipped for minimal build');
    }

    // 16. Ensure package.json includes Nepal scripts & nepali-date-converter
    patchFile(
        path.join(workspaceDir, 'package.json'),
        (raw) => {
            const pkg = JSON.parse(raw);
            pkg.dependencies = pkg.dependencies || {};
            if (!pkg.dependencies['nepali-date-converter']) {
                pkg.dependencies['nepali-date-converter'] = '^3.4.2';
            }
            pkg.scripts = pkg.scripts || {};
            pkg.scripts['nepal:brand'] = 'node nepal/scripts/applyBranding.mjs';
            pkg.scripts['nepal:build-ext'] = 'node nepal/scripts/buildExtension.mjs --out public';
            pkg.scripts['nepal:build-fast'] = 'node nepal/scripts/buildFast.mjs';
            pkg.scripts['nepal:verify'] = 'node nepal/scripts/verifyIntegration.mjs';
            pkg.scripts['build:zip'] =
                'npm run nepal:brand && node nepal/scripts/buildRulesEngineCached.mjs && npm run nepal:build-ext && npm run verifyCacheVersion && DHIS2_CACHE_VERSION=4 NODE_ENV=production NODE_OPTIONS="--max-old-space-size=1792" GENERATE_SOURCEMAP=false d2-app-scripts build';
            return `${JSON.stringify(pkg, null, 4)}\n`;
        },
        'package.json Nepal scripts & dependency',
    );
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const t0 = Date.now();
    console.log(`[overlay] Staging workspace: ${opts.workspaceDir}`);

    if (opts.buildFast && fs.existsSync(path.join(opts.workspaceDir, 'build', 'app', 'index.html'))) {
        // Ultra-fast path: only refresh src/nepal and nepal/ in workspace, then run buildFast (zero network/git needed)
        console.log('[overlay] Existing workspace base detected; syncing ONLY src/nepal and nepal/...');
        fs.rmSync(path.join(opts.workspaceDir, 'src', 'nepal'), { recursive: true, force: true });
        fs.cpSync(path.join(OVERLAY_ROOT, 'src', 'nepal'), path.join(opts.workspaceDir, 'src', 'nepal'), { recursive: true });
        fs.rmSync(path.join(OVERLAY_ROOT, 'nepal', '.DS_Store'), { force: true });
        fs.rmSync(path.join(opts.workspaceDir, 'nepal'), { recursive: true, force: true });
        fs.cpSync(path.join(OVERLAY_ROOT, 'nepal'), path.join(opts.workspaceDir, 'nepal'), { recursive: true });
        if (opts.minimal) {
            applyMinimalConfigToWorkspace(opts.workspaceDir);
        }
        const fastArgs = [path.join(opts.workspaceDir, 'nepal', 'scripts', 'buildFast.mjs')];
        if (opts.minimal) {
            fastArgs.push('--minimal');
        }
        execFileSync('node', fastArgs, {
            cwd: opts.workspaceDir,
            stdio: 'inherit',
        });
    } else {
        const resolvedBaseDir = opts.baseDir
            ? path.resolve(opts.baseDir)
            : resolveCachedGitBase(opts.repoUrl, opts.repoTag, opts.refreshBase);

        console.log(`[overlay] Base capture-app: ${resolvedBaseDir}`);
        stageBaseCapture(resolvedBaseDir, opts.workspaceDir);
        applyNepalOverlay(opts.workspaceDir, { minimal: opts.minimal });

        // Ensure nepali-date-converter is installed (copy from overlay repo's node_modules if present to avoid full npm install!)
        const wsNodeModules = path.join(opts.workspaceDir, 'node_modules');
        const hasNepaliPkg = fs.existsSync(path.join(wsNodeModules, 'nepali-date-converter'));
        const overlayNepaliPkg = path.join(OVERLAY_ROOT, 'node_modules', 'nepali-date-converter');
        if (!hasNepaliPkg && fs.existsSync(overlayNepaliPkg) && fs.existsSync(wsNodeModules)) {
            console.log('[overlay] Linking nepali-date-converter from overlay repo...');
            fs.cpSync(overlayNepaliPkg, path.join(wsNodeModules, 'nepali-date-converter'), { recursive: true });
        } else if (opts.install || !hasNepaliPkg) {
            console.log('[overlay] Installing missing dependencies in workspace...');
            execSync('npm install --legacy-peer-deps --no-audit --no-fund', { cwd: opts.workspaceDir, stdio: 'inherit' });
        }

        execFileSync('node', [path.join(opts.workspaceDir, 'nepal', 'scripts', 'applyBranding.mjs')], {
            cwd: opts.workspaceDir,
            stdio: 'inherit',
        });

        if (opts.buildFull || opts.buildFast) {
            execSync('npm run build:zip', { cwd: opts.workspaceDir, stdio: 'inherit' });

            if (opts.minimal) {
                const wsBundleDir = path.join(opts.workspaceDir, 'build', 'bundle');
                if (fs.existsSync(wsBundleDir)) {
                    for (const f of fs.readdirSync(wsBundleDir).filter(n => n.endsWith('.zip') && !n.endsWith('-minimal.zip'))) {
                        const targetName = f.replace(/\.zip$/, '-minimal.zip');
                        fs.renameSync(path.join(wsBundleDir, f), path.join(wsBundleDir, targetName));
                    }
                }
            }

            const verifyArgs = [path.join(opts.workspaceDir, 'nepal', 'scripts', 'verifyIntegration.mjs'), '--zip'];
            if (opts.minimal) {
                verifyArgs.push('--minimal');
            }
            execFileSync('node', verifyArgs, {
                cwd: opts.workspaceDir,
                stdio: 'inherit',
            });
        }
    }

    // Copy built ZIP back to overlay root's dist/ for easy pickup
    const wsBundleDir = path.join(opts.workspaceDir, 'build', 'bundle');
    if (fs.existsSync(wsBundleDir)) {
        const outDist = path.join(OVERLAY_ROOT, 'dist');
        fs.mkdirSync(outDist, { recursive: true });
        const zipFiles = fs
            .readdirSync(wsBundleDir)
            .filter(n => (opts.minimal ? n.endsWith('-minimal.zip') : n.endsWith('.zip') && !n.endsWith('-minimal.zip')));
        for (const f of zipFiles) {
            fs.copyFileSync(path.join(wsBundleDir, f), path.join(outDist, f));
            console.log(`[overlay] Output ZIP -> dist/${f}`);
        }
    }

    console.log(`[overlay] Completed in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
}

main();
