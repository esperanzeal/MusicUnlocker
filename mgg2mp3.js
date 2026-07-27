/**
 * qmc-decrypt — QQ音乐 .mgg / .mflac 一键解密
 *   .mgg  → 解密输出 OGG（默认），加 --mp3 转 MP3
 *   .mflac → 解密输出 FLAC 无损
 *
 * 用法:
 *   node mgg2mp3.js <file.mgg|file.mflac>     单文件
 *   node mgg2mp3.js <directory>                批量处理目录
 *
 * 依赖: @clamber_l/crypto, ffmpeg
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('@clamber_l/crypto');

// ============================================================
//  WASM 初始化
// ============================================================

let _wasmReady = false;
async function ensureWasm() {
  if (_wasmReady) return;
  await crypto.ready;
  _wasmReady = true;
}

// ============================================================
//  ekey 提取
// ============================================================

/**
 * 解析 footer，按优先级尝试多种格式:
 *   A) QMCFooter.parse → 有 ekey 直接用
 *   B) QMCFooter.parse → 有 mediaName 无 ekey → 需 ixarea
 *   C) 字节级扫描尾部 base64 → 嵌入式密钥（兼容非标准 footer）
 */
function extractFooterInfo(buffer) {
  // 方式 A/B: 用 QMCFooter.parse 解析
  for (const size of [2048, 4096, 8192]) {
    try {
      const fb = buffer.slice(-size);
      const footer = crypto.QMCFooter.parse(fb);
      if (footer) {
        if (footer.ekey) {
          return { type: 'embedded', ekey: footer.ekey, footerSize: footer.size };
        }
        if (footer.mediaName) {
          return { type: 'musicex', mediaName: footer.mediaName, footerSize: footer.size };
        }
        // 有 footer 但既无 ekey 也无 mediaName — 继续尝试更大 buffer
      }
    } catch { /* 继续尝试 */ }
  }

  // 方式 C: 字节级扫描尾部 base64（非标准 footer）
  let lastEq = -1;
  for (let i = buffer.length - 2; i >= 0; i--) {
    if (buffer[i] === 0x3d && buffer[i + 1] === 0x3d) {
      lastEq = i;
      break;
    }
  }
  if (lastEq < 0) return null;

  let start = lastEq;
  while (start > 0) {
    const b = buffer[start - 1];
    const isB64 = (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) ||
                  (b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2f || b === 0x3d;
    if (!isB64) break;
    start--;
  }

  const ekey = buffer.slice(start, lastEq + 2).toString('ascii');
  if (ekey.length < 40) return null;

  return { type: 'embedded', ekey, footerSize: buffer.length - start };
}

// ============================================================
//  ixarea API（仅 MusicEx 格式需要）
// ============================================================

const IXAREA_BASE = 'https://um-api.ixarea.com';
const CACHE_FILE = path.join(__dirname, '.mgg2mp3_cache.json');

const API_CANDIDATES = [
  { method: 'GET',  path: (mn) => `/key/qq/${mn}` },
  { method: 'GET',  path: (mn) => `/api/qq/key/${mn}` },
  { method: 'GET',  path: (mn) => `/api/key/qq/${mn}` },
  { method: 'POST', path: (mn) => `/key/qq`,              body: (mn) => ({ id: mn }) },
  { method: 'POST', path: (mn) => `/api/qq/key`,          body: (mn) => ({ id: mn }) },
];

const ekeyCache = new Map();

function loadCache() {
  try {
    const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (d.ekeyMap) Object.entries(d.ekeyMap).forEach(([k, v]) => ekeyCache.set(k, v));
    return d;
  } catch { return null; }
}
function saveCache(extra) {
  const existing = loadCache() || {};
  Object.assign(existing, extra);
  existing.ekeyMap = Object.fromEntries(ekeyCache);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(existing, null, 2));
}
loadCache();

function extractEkeyFromResponse(data) {
  if (typeof data === 'string' && data.length > 40) return data;
  if (!data) return null;
  for (const key of ['ekey', 'key', 'eKey', 'EKey', 'data', 'result']) {
    if (data[key] && typeof data[key] === 'string' && data[key].length > 40) return data[key];
    if (data[key] && typeof data[key] === 'object') {
      const nested = extractEkeyFromResponse(data[key]);
      if (nested) return nested;
    }
  }
  return null;
}

async function probeIxarea(candidate, testMediaName) {
  const url = IXAREA_BASE + candidate.path(testMediaName);
  const opts = {
    method: candidate.method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  };
  if (candidate.body) opts.body = JSON.stringify(candidate.body(testMediaName));
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    const data = await res.json();
    return extractEkeyFromResponse(data);
  } catch { return null; }
}

async function getEkeyFromIxarea(mediaName) {
  if (ekeyCache.has(mediaName)) {
    console.log(`   🔑 ekey 缓存命中`);
    return ekeyCache.get(mediaName);
  }

  const cached = loadCache();
  if (cached && cached.apiIndex !== undefined) {
    const ekey = await probeIxarea(API_CANDIDATES[cached.apiIndex], mediaName);
    if (ekey) {
      ekeyCache.set(mediaName, ekey);
      saveCache({});
      return ekey;
    }
    console.log('   ⚠️ 缓存端点失效，重新探测...');
  }

  console.log('   🔍 探测 ixarea API...');
  for (let i = 0; i < API_CANDIDATES.length; i++) {
    process.stdout.write(`     → ${API_CANDIDATES[i].method} ${API_CANDIDATES[i].path('...')} `);
    const ekey = await probeIxarea(API_CANDIDATES[i], mediaName);
    if (ekey) {
      console.log('✅');
      ekeyCache.set(mediaName, ekey);
      saveCache({ apiIndex: i, discoveredAt: new Date().toISOString() });
      return ekey;
    }
    console.log('❌');
  }
  throw new Error('所有 ixarea 端点不通');
}

// ============================================================
//  单文件转换
// ============================================================

async function convertOne(inputPath, outDir) {
  const fname = path.basename(inputPath);
  console.log(`\n📂 ${fname}`);

  const buffer = fs.readFileSync(inputPath);
  console.log(`   大小: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

  // ---- 解析 footer 获取密钥 ----
  const footerInfo = extractFooterInfo(buffer);
  if (!footerInfo) throw new Error('无法解析文件格式 — 不支持的文件类型');

  let ekey;
  let data = buffer.slice(0, buffer.length - footerInfo.footerSize);

  if (footerInfo.type === 'embedded') {
    ekey = footerInfo.ekey;
    console.log(`   类型: 嵌入式密钥`);
  } else {
    console.log(`   类型: MusicEx, mediaName: ${footerInfo.mediaName}`);
    ekey = await getEkeyFromIxarea(footerInfo.mediaName);
  }

  // ---- QMC2 解密 ----
  const cipher = new crypto.QMC2(ekey);
  cipher.decrypt(data, 0);

  // ---- 检测音频类型 ----
  const audioType = crypto.detectAudioType(data.slice(0, 1024));
  const ext = audioType.audioType;
  console.log(`   原始格式: ${ext}`);

  // ---- 写解密文件（临时） ----
  const parsed = path.parse(inputPath);
  const targetDir = outDir || parsed.dir;
  const tmpPath = path.join(targetDir, `_tmp_${parsed.name}.${ext}`);
  fs.writeFileSync(tmpPath, data);

  // ---- 输出 ----
  const isMflac = fname.toLowerCase().endsWith('.mflac');

  if (isMflac || !toMp3) {
    // FLAC 无损 / OGG 不转码 → 直接输出
    const outPath = path.join(targetDir, `${parsed.name}.${ext}`);
    fs.renameSync(tmpPath, outPath);
    console.log(`   ✅ ${path.basename(outPath)}`);
    return outPath;
  }

  // 转 mp3
  const outPath = path.join(targetDir, `${parsed.name}.mp3`);
  try {
    execSync(
      `ffmpeg -y -i "${tmpPath}" -b:a 320k -map_metadata -1 "${outPath}"`,
      { stdio: 'pipe', timeout: 60000 }
    );
    console.log(`   ✅ ${path.basename(outPath)}`);
  } catch (e) {
    const fallbackPath = path.join(targetDir, `${parsed.name}.${ext}`);
    fs.renameSync(tmpPath, fallbackPath);
    console.log(`   ⚠️ ffmpeg 失败，保留为 ${ext}: ${path.basename(fallbackPath)}`);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  return outPath;
}

// ============================================================
//  批量处理
// ============================================================

async function main() {
  await ensureWasm();

  const args = process.argv.slice(2);
  const toMp3 = args.includes('--mp3');
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  const inputs = args.filter(a => !a.startsWith('--') && a !== (outDir || ''));

  if (inputs.length === 0) {
    console.log([
      'qmc-decrypt — QQ音乐 .mgg / .mflac 一键解密',
      '  .mgg  → 解密输出 OGG（默认），加 --mp3 转 MP3',
      '  .mflac → 解密输出 FLAC 无损',
      '',
      '用法:',
      '  node mgg2mp3.js <file>              单文件',
      '  node mgg2mp3.js <directory>          批量处理目录',
      '  node mgg2mp3.js <dir> --mp3          解密后转 MP3',
      '',
    ].join('\n'));
    process.exit(0);
  }

  let total = 0, ok = 0, fail = 0;
  const startTime = Date.now();

  for (const input of inputs) {
    const stat = fs.statSync(input);
    const files = [];
    if (stat.isFile()) {
      files.push(input);
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(input)) {
        const el = entry.toLowerCase();
        if (el.endsWith('.mgg') || el.endsWith('.mflac')) {
          const isMflac = el.endsWith('.mflac');
          const outExt = isMflac ? '.flac' : (toMp3 ? '.mp3' : '.ogg');
          const outPath = path.join(input, entry.replace(isMflac ? /\.mflac$/i : /\.mgg$/i, outExt));
          if (fs.existsSync(outPath)) {
            console.log(`⏭️  ${entry} (已有 ${outExt})`);
            continue;
          }
          files.push(path.join(input, entry));
        }
      }
    }

    for (const file of files) {
      total++;
      try {
        await convertOne(file, outDir);
        ok++;
      } catch (e) {
        console.error(`   ❌ ${e.message}`);
        fail++;
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(50)}`);
  console.log(`完成: ${ok} 成功, ${fail} 失败, 共 ${total} 个文件, 耗时 ${elapsed}s`);
}

main().catch(err => {
  console.error('\n💥 致命错误:', err.message);
  process.exit(1);
});
