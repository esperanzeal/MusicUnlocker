/**
 * lib.js — MusicUnlocker 共享模块
 * footer 解析 / ixarea API / 转码逻辑
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('@clamber_l/crypto');

// ── WASM ────────────────────────────────────────────────
let _wasmReady = false;
async function ensureWasm() {
  if (_wasmReady) return;
  await crypto.ready;
  _wasmReady = true;
}

// ── footer 解析 ──────────────────────────────────────────
function parseFooter(buffer) {
  // A) QMCFooter.parse
  for (const size of [2048, 4096, 8192]) {
    try {
      const footer = crypto.QMCFooter.parse(buffer.slice(-size));
      if (footer?.ekey) return { type: 'embedded', ekey: footer.ekey, footerSize: footer.size };
      if (footer?.mediaName) return { type: 'musicex', mediaName: footer.mediaName, footerSize: footer.size };
    } catch {}
  }

  // B) 字节级 base64 扫描
  let lastEq = -1;
  for (let i = buffer.length - 2; i >= 0; i--) {
    if (buffer[i] === 0x3d && buffer[i + 1] === 0x3d) { lastEq = i; break; }
  }
  if (lastEq < 0) return null;

  let start = lastEq;
  while (start > 0) {
    const b = buffer[start - 1];
    if (!((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) ||
          (b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2f || b === 0x3d)) break;
    start--;
  }
  const ekey = buffer.slice(start, lastEq + 2).toString('ascii');
  if (ekey.length < 40) return null;
  return { type: 'embedded', ekey, footerSize: buffer.length - start };
}

// ── ixarea API ──────────────────────────────────────────
const IXAREA_BASE = 'https://um-api.ixarea.com';
const API_CANDIDATES = [
  { method: 'GET',  path: (mn) => `/key/qq/${mn}` },
  { method: 'GET',  path: (mn) => `/api/qq/key/${mn}` },
  { method: 'GET',  path: (mn) => `/api/key/qq/${mn}` },
  { method: 'POST', path: (mn) => `/key/qq`,              body: (mn) => ({ id: mn }) },
  { method: 'POST', path: (mn) => `/api/qq/key`,          body: (mn) => ({ id: mn }) },
];

function loadCache(cachePath) {
  try { return JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { return {}; }
}
function saveCache(cachePath, data) {
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
}

async function fetchEkey(mediaName, cachePath) {
  const cache = loadCache(cachePath);

  // 缓存命中
  if (cache.ekeyMap?.[mediaName]) return cache.ekeyMap[mediaName];

  // 已探测过的端点
  if (cache.apiIndex !== undefined) {
    const ekey = await probeIxarea(API_CANDIDATES[cache.apiIndex], mediaName);
    if (ekey) {
      cache.ekeyMap ??= {};
      cache.ekeyMap[mediaName] = ekey;
      saveCache(cachePath, cache);
      return ekey;
    }
  }

  // 逐个探测
  for (let i = 0; i < API_CANDIDATES.length; i++) {
    const ekey = await probeIxarea(API_CANDIDATES[i], mediaName);
    if (ekey) {
      cache.apiIndex = i;
      cache.ekeyMap ??= {};
      cache.ekeyMap[mediaName] = ekey;
      saveCache(cachePath, cache);
      return ekey;
    }
  }
  throw new Error('无法连接 ixarea API，请检查网络');
}

async function probeIxarea(candidate, mediaName) {
  const url = IXAREA_BASE + candidate.path(mediaName);
  const opts = {
    method: candidate.method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  };
  if (candidate.body) opts.body = JSON.stringify(candidate.body(mediaName));
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return extractEkey(await res.json());
  } catch { return null; }
}

function extractEkey(data) {
  if (typeof data === 'string' && data.length > 40) return data;
  if (!data) return null;
  for (const key of ['ekey', 'key', 'eKey', 'EKey', 'data', 'result']) {
    if (data[key] && typeof data[key] === 'string' && data[key].length > 40) return data[key];
    if (data[key] && typeof data[key] === 'object') {
      const nested = extractEkey(data[key]);
      if (nested) return nested;
    }
  }
  return null;
}

// ── 解密 ────────────────────────────────────────────────
async function decrypt(buffer, info, cachePath) {
  await ensureWasm();

  let ekey;
  if (info.type === 'embedded') {
    ekey = info.ekey;
  } else {
    ekey = await fetchEkey(info.mediaName, cachePath);
  }

  const data = buffer.slice(0, buffer.length - info.footerSize);
  const cipher = new crypto.QMC2(ekey);
  cipher.decrypt(data, 0);

  const ext = crypto.detectAudioType(data.slice(0, 1024)).audioType;
  return { data, ext };
}

// ── 转码 ────────────────────────────────────────────────
function toMp3(inputPath, outputPath) {
  try {
    execSync(
      `ffmpeg -y -i "${inputPath}" -b:a 320k -map_metadata -1 "${outputPath}"`,
      { stdio: 'pipe', timeout: 60000 }
    );
  } catch (e) {
    // 提取 ffmpeg 的错误信息
    const stderr = e.stderr?.toString('utf8') || '';
    const lines = stderr.split('\n').filter(l => l.trim());
    const lastLine = lines[lines.length - 1] || '';
    throw new Error(`ffmpeg: ${lastLine || e.message}`);
  }
}

// ── 文件扫描 ────────────────────────────────────────────
function* scanFiles(dir, toMp3) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const el = entry.name.toLowerCase();
    if (!el.endsWith('.mgg') && !el.endsWith('.mflac')) continue;
    const isMflac = el.endsWith('.mflac');
    const outExt = isMflac ? '.flac' : (toMp3 ? '.mp3' : '.ogg');
    const outPath = path.join(dir, entry.name.replace(isMflac ? /\.mflac$/i : /\.mgg$/i, outExt));
    if (fs.existsSync(outPath)) { console.log(`⏭️  ${entry.name} (已有 ${outExt})`); continue; }
    yield { inputPath: path.join(dir, entry.name), outExt, isMflac };
  }
}

module.exports = { ensureWasm, parseFooter, fetchEkey, decrypt, toMp3, scanFiles };
