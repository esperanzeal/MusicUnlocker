#!/usr/bin/env node
/**
 * mgg2mp3 — QQ音乐 .mgg / .mflac 命令行解密
 *
 *   node mgg2mp3.js <file|dir>              解密输出 OGG/FLAC
 *   node mgg2mp3.js <file|dir> --mp3         解密后转 MP3
 *   node mgg2mp3.js <file|dir> --out <dir>   指定输出目录
 */

const fs = require('fs');
const path = require('path');
const { ensureWasm, parseFooter, decrypt, toMp3, scanFiles } = require('./lib');

const CACHE_FILE = path.join(__dirname, '.mgg2mp3_cache.json');

async function convertOne(inputPath, toMp3Flag, outDir) {
  const fname = path.basename(inputPath);
  console.log(`\n📂 ${fname}`);

  const buffer = fs.readFileSync(inputPath);
  console.log(`   大小: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

  const info = parseFooter(buffer);
  if (!info) throw new Error('无法解析文件格式');

  const { data, ext } = await decrypt(buffer, info, CACHE_FILE);
  console.log(`   原始格式: ${ext}`);

  const parsed = path.parse(inputPath);
  const targetDir = outDir || parsed.dir;
  const isMflac = fname.toLowerCase().endsWith('.mflac');

  if (isMflac || !toMp3Flag) {
    const outPath = path.join(targetDir, `${parsed.name}.${ext}`);
    fs.writeFileSync(outPath, data);
    console.log(`   ✅ ${path.basename(outPath)}`);
    return;
  }

  // 转 mp3
  const tmpPath = path.join(targetDir, `_tmp_${parsed.name}.${ext}`);
  fs.writeFileSync(tmpPath, data);
  try {
    const outPath = path.join(targetDir, `${parsed.name}.mp3`);
    toMp3(tmpPath, outPath);
    console.log(`   ✅ ${path.basename(outPath)}`);
  } catch (e) {
    const fallback = path.join(targetDir, `${parsed.name}.${ext}`);
    fs.renameSync(tmpPath, fallback);
    console.log(`   ⚠️ ${e.message}，保留为 ${ext}`);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

async function main() {
  await ensureWasm();

  const args = process.argv.slice(2);
  const toMp3Flag = args.includes('--mp3');
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  const inputs = args.filter(a => !a.startsWith('--') && a !== outDir);

  if (inputs.length === 0) {
    console.log([
      'mgg2mp3 — QQ音乐 .mgg / .mflac 解密',
      '  .mgg  → OGG（默认）| --mp3 转 MP3',
      '  .mflac → FLAC 无损',
      '',
      '用法:',
      '  node mgg2mp3.js <file>              单文件',
      '  node mgg2mp3.js <directory>          批量处理',
      '  node mgg2mp3.js <dir> --mp3          解密后转 MP3',
      '  node mgg2mp3.js <file> --out <dir>   指定输出目录',
    ].join('\n'));
    process.exit(0);
  }

  let ok = 0, fail = 0;
  const start = Date.now();

  for (const input of inputs) {
    const stat = fs.statSync(input);
    if (stat.isFile()) {
      try { await convertOne(input, toMp3Flag, outDir); ok++; }
      catch (e) { console.error(`   ❌ ${e.message}`); fail++; }
    } else {
      for (const { inputPath } of scanFiles(input, toMp3Flag)) {
        try { await convertOne(inputPath, toMp3Flag, outDir); ok++; }
        catch (e) { console.error(`   ❌ ${e.message}`); fail++; }
      }
    }
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`完成: ${ok} 成功, ${fail} 失败, 耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

main().catch(err => { console.error('\n💥', err.message); process.exit(1); });
