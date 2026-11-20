#!/usr/bin/env node
/**
 * Serves and builds the full DHIS2 Capture NP app in standalone testing mode
 * (official @dhis2/app-adapter Server URL / Username / Password login screen)
 * directly from the persisted Capture NP release ZIP, overlaid with:
 *  - Transparent same-origin DHIS2 reverse proxy (/__dhis2/<b64url>/*) so any
 *    external DHIS2 server works inside the preview iframe without CORS or
 *    third-party cookie blocking.
 *  - Live incremental rebuilds of src/nepal/** (<0.5s).
 *  - Untouched verified /api/bundles ZIP & SHA-256 downloads.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildNepalExtension } from './buildExtension.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '../..');

const PROXY_PREFIX = '/__dhis2/';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webapp': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.zip': 'application/zip',
};

export function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

function decodeBase64Url(encoded) {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    return Buffer.from(normalized + '='.repeat(padLen), 'base64').toString('utf8');
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function isHttpsRequest(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    if (forwardedProto.includes('https')) return true;
    const origin = String(req.headers.origin || '');
    const referer = String(req.headers.referer || '');
    return origin.startsWith('https://') || referer.startsWith('https://');
}

function rewriteSetCookie(rawCookie, cookiePath, secureContext) {
    const parts = rawCookie
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean);
    if (parts.length === 0) return rawCookie;

    const nameValue = parts[0];
    const attrs = parts.slice(1).filter((attr) => {
        const lower = attr.toLowerCase();
        return (
            !lower.startsWith('domain=') &&
            !lower.startsWith('path=') &&
            !lower.startsWith('samesite=') &&
            lower !== 'secure'
        );
    });

    attrs.push(`Path=${cookiePath}`);
    if (secureContext) {
        attrs.push('SameSite=None');
        attrs.push('Secure');
    } else {
        attrs.push('SameSite=Lax');
    }

    return [nameValue, ...attrs].join('; ');
}

async function handleDhis2Proxy(req, res, rawUrl) {
    const queryIdx = rawUrl.indexOf('?');
    const urlPath = queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);
    const search = queryIdx === -1 ? '' : rawUrl.slice(queryIdx);

    const rest = urlPath.slice(PROXY_PREFIX.length);
    const slashIdx = rest.indexOf('/');
    const encodedBase = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const subPath = slashIdx === -1 ? '' : rest.slice(slashIdx);

    if (!encodedBase) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ status: 'ERROR', message: 'Missing DHIS2 target server' }));
        return;
    }

    let targetBaseUrl;
    try {
        const decoded = decodeBase64Url(encodedBase).trim().replace(/\/+$/, '');
        const parsed = new URL(decoded);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('Only http:// and https:// DHIS2 servers are supported');
        }
        targetBaseUrl = parsed.href.replace(/\/+$/, '');
    } catch (err) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ status: 'ERROR', message: `Invalid DHIS2 server URL: ${err?.message || err}` }));
        return;
    }

    const upstreamUrl = `${targetBaseUrl}${subPath || '/'}${search}`;
    const targetOrigin = new URL(targetBaseUrl).origin;
    const method = (req.method || 'GET').toUpperCase();

    const headers = new Headers();
    const forwardHeaders = [
        'accept',
        'accept-language',
        'authorization',
        'content-type',
        'cookie',
        'if-modified-since',
        'if-none-match',
        'x-requested-with',
    ];
    for (const h of forwardHeaders) {
        const val = req.headers[h];
        if (val !== undefined) {
            headers.set(h, Array.isArray(val) ? val.join(', ') : String(val));
        }
    }
    headers.set('origin', targetOrigin);
    headers.set('referer', `${targetBaseUrl}/`);

    let body;
    if (method !== 'GET' && method !== 'HEAD') {
        const buf = await readRequestBody(req);
        if (buf.length > 0) {
            body = buf;
        }
    }

    try {
        const upstreamRes = await fetch(upstreamUrl, {
            method,
            headers,
            body,
            redirect: 'manual',
        });

        const secureContext = isHttpsRequest(req);
        const cookiePath = `${PROXY_PREFIX}${encodedBase}`;
        const setCookies =
            typeof upstreamRes.headers.getSetCookie === 'function'
                ? upstreamRes.headers.getSetCookie()
                : [];

        const skipHeaders = new Set([
            'connection',
            'content-encoding',
            'content-length',
            'content-security-policy',
            'content-security-policy-report-only',
            'keep-alive',
            'set-cookie',
            'strict-transport-security',
            'transfer-encoding',
            'x-frame-options',
        ]);

        res.statusCode = upstreamRes.status;
        res.statusMessage = upstreamRes.statusText;

        for (const [key, value] of upstreamRes.headers.entries()) {
            const lower = key.toLowerCase();
            if (skipHeaders.has(lower)) continue;
            if (lower === 'location') {
                if (value.startsWith(targetBaseUrl)) {
                    res.setHeader('Location', `${cookiePath}${value.slice(targetBaseUrl.length) || '/'}`);
                } else if (value.startsWith('/')) {
                    const targetPathPrefix = new URL(targetBaseUrl).pathname.replace(/\/+$/, '');
                    if (targetPathPrefix && value.startsWith(targetPathPrefix)) {
                        res.setHeader('Location', `${cookiePath}${value.slice(targetPathPrefix.length) || '/'}`);
                    } else {
                        res.setHeader('Location', `${cookiePath}${value}`);
                    }
                } else {
                    res.setHeader('Location', value);
                }
                continue;
            }
            res.setHeader(key, value);
        }

        if (setCookies.length > 0) {
            res.setHeader(
                'Set-Cookie',
                setCookies.map((c) => rewriteSetCookie(c, cookiePath, secureContext)),
            );
        }

        const respBuf = Buffer.from(await upstreamRes.arrayBuffer());
        res.setHeader('Content-Length', String(respBuf.length));
        res.end(respBuf);
    } catch (err) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
            JSON.stringify({
                status: 'ERROR',
                httpStatusCode: 502,
                message: `Could not reach DHIS2 server (${targetBaseUrl}): ${err?.message || err}`,
            }),
        );
    }
}

/**
 * Pure Node.js ZIP archive reader using built-in node:zlib.
 * Supports STORED (0) and DEFLATED (8) entries.
 */
export function readZipEntries(zipBuffer) {
    const minOffset = Math.max(0, zipBuffer.length - 65557);
    let eocdOffset = -1;
    for (let i = zipBuffer.length - 22; i >= minOffset; i -= 1) {
        if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) {
        throw new Error('Invalid ZIP archive: EOCD signature not found');
    }

    const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
    const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

    const entries = new Map();
    let ptr = centralDirOffset;

    for (let idx = 0; idx < totalEntries; idx += 1) {
        if (zipBuffer.readUInt32LE(ptr) !== 0x02014b50) {
            throw new Error(`Invalid ZIP central directory entry at offset ${ptr}`);
        }
        const compressionMethod = zipBuffer.readUInt16LE(ptr + 10);
        const compressedSize = zipBuffer.readUInt32LE(ptr + 20);
        const fileNameLen = zipBuffer.readUInt16LE(ptr + 28);
        const extraLen = zipBuffer.readUInt16LE(ptr + 30);
        const commentLen = zipBuffer.readUInt16LE(ptr + 32);
        const localHeaderOffset = zipBuffer.readUInt32LE(ptr + 42);

        const rawName = zipBuffer.subarray(ptr + 46, ptr + 46 + fileNameLen).toString('utf8');
        const name = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
        ptr += 46 + fileNameLen + extraLen + commentLen;

        if (!name || name.endsWith('/')) {
            continue;
        }

        if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
            throw new Error(`Invalid ZIP local header for ${name}`);
        }
        const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
        const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

        let content;
        if (compressionMethod === 0) {
            content = Buffer.from(compressedData);
        } else if (compressionMethod === 8) {
            content = zlib.inflateRawSync(compressedData);
        } else {
            throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${name}`);
        }

        entries.set(name, content);
    }

    return entries;
}

/**
 * Finds all built Capture NP ZIP bundles across dist/ and public/,
 * preferring the newest file when the same filename exists in both.
 */
export function findZipBundles(rootDir = DEFAULT_ROOT) {
    const dirs = [path.resolve(rootDir, 'dist'), path.resolve(rootDir, 'public')];
    const bestByName = new Map();

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.zip')) continue;
            const fullPath = path.join(dir, name);
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;
            const existing = bestByName.get(name);
            if (!existing || stat.mtimeMs > existing.mtimeMs) {
                bestByName.set(name, { filename: name, fullPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, stat });
            }
        }
    }

    return Array.from(bestByName.values())
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map((item) => {
            const buf = fs.readFileSync(item.fullPath);
            const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
            return {
                filename: item.filename,
                fullPath: item.fullPath,
                sizeBytes: item.sizeBytes,
                mtimeMs: item.mtimeMs,
                updatedAt: item.stat.mtime.toISOString(),
                sha256,
                downloadUrl: `/api/bundles/${encodeURIComponent(item.filename)}`,
                sha256Url: `/api/bundles/${encodeURIComponent(`${item.filename}.sha256`)}`,
            };
        });
}

const PREVIEW_BOOTSTRAP_SCRIPT = `<script>
(function(){
  var P="${PROXY_PREFIX}";
  function toB64Url(s){return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");}
  function fromB64Url(s){var b=s.replace(/-/g,"+").replace(/_/g,"/");while(b.length%4)b+="=";return decodeURIComponent(escape(atob(b)));}
  function normalizeServer(raw){
    var s=String(raw||"").trim().replace(/\\/+$/,"");
    if(!s) return "";
    if(s.indexOf(P)!==-1){
      var idx=s.indexOf(P)+P.length;
      var enc=s.slice(idx).split("/")[0];
      try{return fromB64Url(enc);}catch(_e){return s;}
    }
    if(!/^https?:\\/\\//i.test(s)) s="https://"+s;
    return s.replace(/\\/+$/,"");
  }
  function toProxyUrl(raw){
    var clean=normalizeServer(raw);
    if(!clean) return "";
    return window.location.origin+P+toB64Url(clean);
  }
  window.__CAPTURE_NP_PREVIEW__={
    normalizeServer:normalizeServer,
    toProxyUrl:toProxyUrl,
    fromProxyUrl:normalizeServer
  };
  try{
    var cur=window.localStorage.getItem("DHIS2_BASE_URL");
    if(cur && cur.indexOf(P)===-1){
      window.localStorage.setItem("DHIS2_BASE_URL",toProxyUrl(cur));
    }
  }catch(_e){}
})();
</script>`;

function patchStandaloneEntries(entries) {
    const patched = new Map(entries);

    // 1. Make index.html iframe-safe by removing <base target="_top" /> and
    //    injecting the lightweight URL helper before the main module loads.
    const indexBuf = patched.get('index.html');
    if (indexBuf) {
        let html = indexBuf
            .toString('utf8')
            .replace(/<base\s+target=["']_top["']\s*\/?>/gi, '');
        if (!html.includes('__CAPTURE_NP_PREVIEW__')) {
            html = html.replace(/<head>/i, `<head>\n${PREVIEW_BOOTSTRAP_SCRIPT}`);
        }
        patched.set('index.html', Buffer.from(html, 'utf8'));
    }

    // 2. Enable standalone testing mode in the served preview bundle:
    //    (a) Default appConfig.url fallback from "../../.." to "" so @dhis2/app-adapter
    //        prompts with its default LoginModal when no server URL is stored yet.
    //    (b) Make dhis2-base-url-db opener self-healing (recreates missing object store
    //        automatically and migrates any raw stored URL through /__dhis2/*).
    //    (c) Restore the Server URL InputField in LoginModal (stripped by production
    //        dead-code elimination in the DHIS2-installable ZIP), show the clean
    //        human-readable DHIS2 URL, route requests via /__dhis2/<b64url> to
    //        eliminate CORS & third-party iframe cookie failures, and persist it.
    for (const [name, buf] of patched.entries()) {
        if (name.startsWith('assets/main-') && name.endsWith('.js')) {
            let js = buf.toString('utf8');
            let changed = false;

            const nextUrl = js.replace(
                /(url\s*:\s*[A-Za-z_$][\w$]*\(\)\s*\|\|\s*)(["'])\.\.\/\.\.\/\.\.\2/,
                '$1""',
            );
            if (nextUrl !== js) {
                js = nextUrl;
                changed = true;
            }

            const idbRe =
                /const ([A-Za-z_$][\w$]*)="dhis2-base-url-db",([A-Za-z_$][\w$]*)="dhis2-base-url-store",([A-Za-z_$][\w$]*)=1;function ([A-Za-z_$][\w$]*)\(\)\{return ([A-Za-z_$][\w$]*)\(\1,\3,\{upgrade\(([A-Za-z_$][\w$]*),[A-Za-z_$][\w$]*\)\{switch\([A-Za-z_$][\w$]*\)\{case 0:\6\.createObjectStore\(\2,\{keyPath:"appName"\}\);default:console\.debug\("\[sections-db\] Done upgrading DB"\)\}\}\}\)\}async function ([A-Za-z_$][\w$]*)\(\{appName:([A-Za-z_$][\w$]*),baseUrl:([A-Za-z_$][\w$]*)\}\)\{return\(await \4\(\)\)\.put\(\2,\{appName:\8,baseUrl:\9\}\)\}async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return\(await \4\(\)\)\.get\(\2,\11\)\.then\(([A-Za-z_$][\w$]*)=>\12==null\?void 0:\12\.baseUrl\)\}/;

            const nextIdb = js.replace(
                idbRe,
                (
                    _m,
                    dbConst,
                    storeConst,
                    verConst,
                    openFn,
                    openDbHelper,
                    _upDb,
                    putFn,
                    appNameArg,
                    baseUrlArg,
                    getFn,
                    getArg,
                ) =>
                    `const ${dbConst}="dhis2-base-url-db",${storeConst}="dhis2-base-url-store",${verConst}=1;` +
                    `async function ${openFn}(){` +
                    `const __opts={upgrade(__u){if(!__u.objectStoreNames.contains(${storeConst}))__u.createObjectStore(${storeConst},{keyPath:"appName"});}};` +
                    `let __db=await ${openDbHelper}(${dbConst},${verConst},__opts);` +
                    `if(!__db.objectStoreNames.contains(${storeConst})){` +
                    `__db.close();` +
                    `await new Promise(__r=>{try{const __d=indexedDB.deleteDatabase(${dbConst});__d.onsuccess=__r;__d.onerror=__r;__d.onblocked=__r;}catch(_e){__r();}});` +
                    `__db=await ${openDbHelper}(${dbConst},${verConst},__opts);` +
                    `}` +
                    `return __db;}` +
                    `async function ${putFn}({appName:${appNameArg},baseUrl:${baseUrlArg}}){return(await ${openFn}()).put(${storeConst},{appName:${appNameArg},baseUrl:${baseUrlArg}});}` +
                    `async function ${getFn}(${getArg}){` +
                    `const __rec=await(await ${openFn}()).get(${storeConst},${getArg});` +
                    `const __u=__rec==null?void 0:__rec.baseUrl;` +
                    `if(__u&&__u.indexOf("${PROXY_PREFIX}")===-1&&window.__CAPTURE_NP_PREVIEW__){` +
                    `const __p=window.__CAPTURE_NP_PREVIEW__.toProxyUrl(__u);` +
                    `try{await ${putFn}({appName:${getArg},baseUrl:__p});}catch(_e){}` +
                    `return __p;}` +
                    `return __u;}`,
            );
            if (nextIdb !== js) {
                js = nextIdb;
                changed = true;
            }

            const loginModalRe =
                /(\(\{appName:([A-Za-z_$][\w$]*),baseUrl:([A-Za-z_$][\w$]*),loginApp:([A-Za-z_$][\w$]*)=!1\}\)=>\{const\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\]=([A-Za-z_$][\w$]*)\.useState\()\3\|\|""(\)[\s\S]*?)(await\s+([A-Za-z_$][\w$]*)\(\5\)\?([A-Za-z_$][\w$]*)\(\{server:\5,([\s\S]*?)\}\):([A-Za-z_$][\w$]*)\(\{server:\5,([\s\S]*?)\}\))([\s\S]*?)(!1,)(!\4&&([A-Za-z_$][\w$]*)\.createElement\(\18\.Fragment,null,\18\.createElement\(([A-Za-z_$][\w$]*),\{dataTest:"dhis2-adapter-loginname",error:([A-Za-z_$][\w$]*))&&!([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),label:([A-Za-z_$][\w$]*)\.t\("Username"\)/;

            const nextModal = js.replace(
                loginModalRe,
                (
                    _full,
                    prefixBeforeInit,
                    appNameVar,
                    baseUrlVar,
                    _loginAppVar,
                    serverVar,
                    setServerVar,
                    _reactHooksVar,
                    afterInitBeforeLogin,
                    _loginBranch,
                    checkLoginConfigFn,
                    newLoginFn,
                    newLoginRest,
                    legacyLoginFn,
                    legacyLoginRest,
                    middle,
                    _falsePlaceholder,
                    usernameBranchPrefix,
                    reactVar,
                    inputCompVar,
                    submittedVar,
                    validFnVar,
                    usernameVar,
                    i18nVar,
                ) => {
                    const decodedInit = `(window.__CAPTURE_NP_PREVIEW__?window.__CAPTURE_NP_PREVIEW__.fromProxyUrl(${baseUrlVar}):(${baseUrlVar}||""))`;

                    const persistAndLogin =
                        `await (async()=>{` +
                        `const __p=window.__CAPTURE_NP_PREVIEW__?window.__CAPTURE_NP_PREVIEW__.toProxyUrl(${serverVar}):${serverVar}.trim().replace(/\\/+$/,"");` +
                        `try{window.localStorage.setItem("DHIS2_BASE_URL",__p);}catch(_e){}` +
                        `await new Promise(__res=>{try{const __req=indexedDB.open("dhis2-base-url-db",1);__req.onupgradeneeded=ev=>{const __db=ev.target.result;if(!__db.objectStoreNames.contains("dhis2-base-url-store"))__db.createObjectStore("dhis2-base-url-store",{keyPath:"appName"});};__req.onsuccess=ev=>{try{const __tx=ev.target.result.transaction("dhis2-base-url-store","readwrite");__tx.objectStore("dhis2-base-url-store").put({appName:${appNameVar},baseUrl:__p});__tx.oncomplete=()=>__res();__tx.onerror=()=>__res();}catch(_e){__res();}};__req.onerror=()=>__res();}catch(_e){__res();}});` +
                        `return await ${checkLoginConfigFn}(__p)?${newLoginFn}({server:__p,${newLoginRest}}):${legacyLoginFn}({server:__p,${legacyLoginRest}});` +
                        `})()`;

                    const serverInputEl =
                        `${reactVar}.createElement(${inputCompVar},{` +
                        `dataTest:"dhis2-adapter-loginserver",` +
                        `error:${submittedVar}&&!${validFnVar}(${serverVar}),` +
                        `label:${i18nVar}.t("Server"),` +
                        `name:"server",` +
                        `placeholder:"https://your-dhis2-server.org",` +
                        `type:"url",` +
                        `value:${serverVar},` +
                        `onChange:__ev=>${setServerVar}(__ev.value)` +
                        `}),`;

                    return (
                        `${prefixBeforeInit}${decodedInit}${afterInitBeforeLogin}${persistAndLogin}${middle}${serverInputEl}` +
                        `${usernameBranchPrefix}&&!${validFnVar}(${usernameVar}),label:${i18nVar}.t("Username")`
                    );
                },
            );

            if (nextModal !== js) {
                js = nextModal;
                changed = true;
            }

            if (changed) {
                patched.set(name, Buffer.from(js, 'utf8'));
            }
        }
    }

    return patched;
}

function getLatestNepalSourceMtime(rootDir) {
    let latest = 0;
    const scan = (target) => {
        if (!fs.existsSync(target)) return;
        const stat = fs.statSync(target);
        if (stat.isFile()) {
            if (stat.mtimeMs > latest) latest = stat.mtimeMs;
            return;
        }
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(target)) {
                scan(path.join(target, entry));
            }
        }
    };
    scan(path.join(rootDir, 'src', 'nepal'));
    scan(path.join(rootDir, 'nepal', 'branding.json'));
    return latest;
}

export function createStandalonePreviewController(rootDir = DEFAULT_ROOT) {
    let cachedZipPath = '';
    let cachedZipMtime = -1;
    let cachedEntries = new Map();

    let cachedExtMtime = -1;
    let cachedExtJs = null;
    let cachedExtMeta = null;
    let extBuildInFlight = null;

    function getPreviewEntries() {
        const bundles = findZipBundles(rootDir);
        const primary = bundles[0];
        if (!primary) {
            return null;
        }
        if (primary.fullPath !== cachedZipPath || primary.mtimeMs !== cachedZipMtime) {
            const rawBuf = fs.readFileSync(primary.fullPath);
            cachedEntries = patchStandaloneEntries(readZipEntries(rawBuf));
            cachedZipPath = primary.fullPath;
            cachedZipMtime = primary.mtimeMs;
        }
        return cachedEntries;
    }

    async function getLiveNepalExtension() {
        const latestMtime = getLatestNepalSourceMtime(rootDir);
        if (cachedExtJs && cachedExtMeta && latestMtime === cachedExtMtime) {
            return { js: cachedExtJs, meta: cachedExtMeta };
        }
        if (!extBuildInFlight) {
            const outDir = path.join(rootDir, '.nepal-cache', 'live-ext');
            extBuildInFlight = buildNepalExtension({ rootDir, outDirs: [outDir] })
                .then(() => {
                    cachedExtJs = fs.readFileSync(path.join(outDir, 'nepal-extension.js'));
                    cachedExtMeta = fs.readFileSync(path.join(outDir, 'nepal-extension.meta.json'));
                    cachedExtMtime = latestMtime;
                    return { js: cachedExtJs, meta: cachedExtMeta };
                })
                .finally(() => {
                    extBuildInFlight = null;
                });
        }
        return extBuildInFlight;
    }

    function middleware(req, res, next) {
        const rawUrl = req.url || '/';
        const urlPath = rawUrl.split('?')[0];

        // 0. /__dhis2/<b64url>/* — transparent same-origin DHIS2 reverse proxy
        if (urlPath.startsWith(PROXY_PREFIX)) {
            void handleDhis2Proxy(req, res, rawUrl);
            return;
        }

        // 1. /api/bundles — list and download untouched verified DHIS2 ZIP bundles
        if (urlPath === '/api/bundles') {
            const bundles = findZipBundles(rootDir).map(({ fullPath: _fp, mtimeMs: _mt, ...pub }) => pub);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({ bundles }));
            return;
        }

        if (urlPath.startsWith('/api/bundles/')) {
            const requested = decodeURIComponent(urlPath.slice('/api/bundles/'.length));
            if (!requested || requested.includes('/') || requested.includes('..')) {
                res.statusCode = 400;
                res.end('Invalid filename');
                return;
            }
            const isSha = requested.endsWith('.zip.sha256');
            const zipName = isSha ? requested.slice(0, -'.sha256'.length) : requested;
            if (!zipName.endsWith('.zip')) {
                res.statusCode = 404;
                res.end('Not found');
                return;
            }
            const match = findZipBundles(rootDir).find((b) => b.filename === zipName);
            if (!match) {
                res.statusCode = 404;
                res.end('Bundle not found');
                return;
            }
            if (isSha) {
                const body = `${match.sha256}  ${zipName}\n`;
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${requested}"`);
                res.setHeader('Cache-Control', 'no-store');
                res.end(body);
                return;
            }
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Length', String(match.sizeBytes));
            res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
            res.setHeader('Cache-Control', 'no-store');
            fs.createReadStream(match.fullPath).pipe(res);
            return;
        }

        // 2. Live-compiled Nepal extension overlay (<0.5s incremental rebuild on src/nepal/** edits)
        if (urlPath === '/nepal-extension.js' || urlPath === '/nepal-extension.meta.json') {
            getLiveNepalExtension()
                .then(({ js, meta }) => {
                    const isMeta = urlPath.endsWith('.json');
                    const payload = isMeta ? meta : js;
                    res.setHeader(
                        'Content-Type',
                        isMeta ? 'application/json; charset=utf-8' : 'application/javascript; charset=utf-8',
                    );
                    res.setHeader('Cache-Control', 'no-store');
                    res.end(payload);
                })
                .catch((err) => {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.end(`Failed to build Nepal extension: ${err?.message || err}`);
                });
            return;
        }

        // 3. Full DHIS2 Capture NP app in standalone testing mode
        const entries = getPreviewEntries();
        if (!entries) {
            next();
            return;
        }

        const cleanPath = decodeURIComponent(urlPath).replace(/^\/+/, '');
        const lookupKey = cleanPath === '' ? 'index.html' : cleanPath;

        if (entries.has(lookupKey)) {
            const payload = entries.get(lookupKey);
            res.setHeader('Content-Type', getMimeType(lookupKey));
            res.setHeader('Cache-Control', lookupKey === 'index.html' ? 'no-store' : 'public, max-age=300');
            res.end(payload);
            return;
        }

        // SPA fallback for HTML navigations without file extensions
        if (!path.extname(lookupKey) && entries.has('index.html')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(entries.get('index.html'));
            return;
        }

        next();
    }

    return { middleware, getPreviewEntries, getLiveNepalExtension };
}

export async function buildStandaloneDist(rootDir = DEFAULT_ROOT) {
    const bundles = findZipBundles(rootDir);
    const primary = bundles[0];
    if (!primary) {
        throw new Error('No built Capture NP ZIP found in public/ or dist/. Run `npm run build:full` first.');
    }

    // Preserve untouched release ZIP buffers before cleaning dist/
    const preservedZips = bundles.map((b) => ({
        filename: b.filename,
        sha256: b.sha256,
        buffer: fs.readFileSync(b.fullPath),
    }));

    const rawEntries = readZipEntries(preservedZips[0].buffer);
    const standaloneEntries = patchStandaloneEntries(rawEntries);

    // Compile fresh Nepal extension from src/nepal/**
    const liveExtDir = path.join(rootDir, '.nepal-cache', 'live-ext');
    await buildNepalExtension({ rootDir, outDirs: [liveExtDir] });
    standaloneEntries.set('nepal-extension.js', fs.readFileSync(path.join(liveExtDir, 'nepal-extension.js')));
    standaloneEntries.set('nepal-extension.meta.json', fs.readFileSync(path.join(liveExtDir, 'nepal-extension.meta.json')));

    const distDir = path.join(rootDir, 'dist');
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });

    for (const [relPath, buf] of standaloneEntries.entries()) {
        const dest = path.join(distDir, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
    }

    // Re-write untouched verified release ZIP + .sha256 into dist/
    for (const item of preservedZips) {
        fs.writeFileSync(path.join(distDir, item.filename), item.buffer);
        fs.writeFileSync(path.join(distDir, `${item.filename}.sha256`), `${item.sha256}  ${item.filename}\n`, 'utf8');
    }

    console.log(
        `[nepal:standalone] Built standalone DHIS2 Capture NP preview in dist/ (${standaloneEntries.size} assets + ${preservedZips.length} verified ZIP)`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    if (process.argv.includes('--build-dist')) {
        buildStandaloneDist(DEFAULT_ROOT).catch((err) => {
            console.error('[nepal:standalone] Build failed:', err);
            process.exit(1);
        });
    }
}
