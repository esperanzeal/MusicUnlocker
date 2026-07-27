/**
 * qmc-decrypt-server — 启动本地网页界面
 * 拖拽 .mgg / .mflac 文件即可转换
 * 用法: node mgg2mp3-server.js
 *       然后浏览器打开 http://localhost:8765
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('@clamber_l/crypto');

const PORT = 8765;
const OUT_DIR = 'E:\\Music';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

// ============================================================
//  WASM
// ============================================================
let _ready = false;
async function ensureWasm() { if (!_ready) { await crypto.ready; _ready = true; } }

// ============================================================
//  Footer 解析（同 mgg2mp3.js）
// ============================================================
function extractFooterInfo(buffer) {
  for (const size of [2048, 4096, 8192]) {
    try {
      const fb = buffer.slice(-size);
      const footer = crypto.QMCFooter.parse(fb);
      if (footer) {
        if (footer.ekey) return { type: 'embedded', ekey: footer.ekey, footerSize: footer.size };
        if (footer.mediaName) return { type: 'musicex', mediaName: footer.mediaName, footerSize: footer.size };
      }
    } catch {}
  }
  // Fallback: byte-level base64 scan
  let lastEq = -1;
  for (let i = buffer.length - 2; i >= 0; i--) {
    if (buffer[i] === 0x3d && buffer[i + 1] === 0x3d) { lastEq = i; break; }
  }
  if (lastEq < 0) return null;
  let start = lastEq;
  while (start > 0) {
    const b = buffer[start - 1];
    if (!((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2f || b === 0x3d)) break;
    start--;
  }
  const ekey = buffer.slice(start, lastEq + 2).toString('ascii');
  if (ekey.length < 40) return null;
  return { type: 'embedded', ekey, footerSize: buffer.length - start };
}

// ============================================================
//  转换（解密 → ffmpeg 转 mp3）
// ============================================================
async function convert(buffer, originalName, toMp3 = false) {
  await ensureWasm();

  const info = extractFooterInfo(buffer);
  if (!info) throw new Error('无法识别的文件格式');

  let ekey;
  if (info.type === 'embedded') {
    ekey = info.ekey;
  } else {
    throw new Error('此文件为 MusicEx 格式，需联网查密钥');
  }

  const data = buffer.slice(0, buffer.length - info.footerSize);
  const cipher = new crypto.QMC2(ekey);
  cipher.decrypt(data, 0);

  const audioType = crypto.detectAudioType(data.slice(0, 1024));
  const ext = audioType.audioType;
  const baseName = path.parse(originalName).name;
  const isMflac = originalName.toLowerCase().endsWith('.mflac');

  // mflac 始终 flac，mgg 默认 ogg
  if (isMflac || !toMp3) {
    const outName = `${baseName}.${ext}`;
    const outPath = path.join(OUT_DIR, outName);
    fs.writeFileSync(outPath, data);
    return { outPath, outName, ext };
  }

  // 转 mp3
  const tmpPath = path.join(OUT_DIR, `_tmp_${baseName}.${ext}`);
  fs.writeFileSync(tmpPath, data);
  const outName = `${baseName}.mp3`;
  const outPath = path.join(OUT_DIR, outName);
  execSync(
    `ffmpeg -y -i "${tmpPath}" -b:a 320k -map_metadata -1 "${outPath}"`,
    { stdio: 'pipe', timeout: 60000 }
  );
  try { fs.unlinkSync(tmpPath); } catch {}

  return { outPath, outName, ext };
}

// ============================================================
//  HTTP 服务
// ============================================================
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MGG → MP3 转换器</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, "Microsoft YaHei", sans-serif;
  background: #0f0f0f; color: #e0e0e0; min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
}
.container { text-align: center; max-width: 600px; padding: 40px; }
h1 { font-size: 28px; margin-bottom: 8px; }
.sub { color: #888; margin-bottom: 32px; font-size: 14px; }

.dropzone {
  border: 2px dashed #444; border-radius: 16px; padding: 60px 20px;
  transition: all 0.3s; cursor: pointer; background: #1a1a1a;
}
.dropzone:hover, .dropzone.drag { border-color: #1db954; background: #1a2a1a; }
.dropzone p { font-size: 18px; color: #aaa; }
.dropzone .icon { font-size: 48px; margin-bottom: 16px; }

#status { margin-top: 24px; min-height: 24px; }
.file-row {
  display: flex; align-items: center; padding: 10px 16px;
  background: #1a1a1a; border-radius: 8px; margin: 8px 0;
}
.file-row .name { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-row .state { margin-left: 12px; font-size: 14px; }
.state.ok { color: #1db954; }
.state.err { color: #e74c3c; }
.state.wait { color: #888; }
.spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #444; border-top-color: #1db954; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

</style>
</head>
<body>
<div class="container">
  <h1>🎵 QQ音乐 解密转换</h1>
  <p class="sub">.mgg → OGG ｜ .mflac → FLAC 无损</p>

  <div class="dropzone" id="dropzone">
    <div class="icon">📁</div>
    <p>点击选择文件 或 拖拽 .mgg / .mflac 文件到此处</p>
    <input type="file" id="fileInput" accept=".mgg,.mflac" multiple hidden>
  </div>

  <label style="display:block; margin-top:16px; color:#aaa; cursor:pointer; user-select:none;">
    <input type="checkbox" id="toMp3" style="margin-right:6px;">
    将 .mgg 转换为 MP3（否则输出 OGG）
  </label>

  <div id="status"></div>
</div>

<script>
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const statusDiv = document.getElementById('status');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  handleFiles(e.dataTransfer.files);
});

async function handleFiles(files) {
  const qmcFiles = [...files].filter(f => {
    const n = f.name.toLowerCase();
    return n.endsWith('.mgg') || n.endsWith('.mflac');
  });
  if (qmcFiles.length === 0) { alert('请选择 .mgg 或 .mflac 文件'); return; }

  statusDiv.innerHTML = '';

  for (const file of qmcFiles) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = \`
      <span class="name">\${file.name}</span>
      <span class="state wait"><span class="spinner"></span> 转换中...</span>
    \`;
    statusDiv.appendChild(row);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const toMp3 = document.getElementById('toMp3').checked;
      const res = await fetch('/convert?mp3=' + toMp3, { method: 'POST', body: formData });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(err);
      }

      const data = await res.json();
      row.querySelector('.state').className = 'state ok';
      row.querySelector('.state').textContent = '✅ 完成';
    } catch (e) {
      row.querySelector('.state').className = 'state err';
      row.querySelector('.state').textContent = '❌ ' + e.message.substring(0, 60);
    }
  }
}

</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET / — 主页面
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // POST /convert — 上传并转换
  if (req.method === 'POST' && req.url.startsWith('/convert')) {
    const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
    const toMp3 = urlParams.get('mp3') === 'true';
    const chunks = [];
    const contentType = req.headers['content-type'] || '';
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) { res.writeHead(400); res.end('bad request'); return; }

    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks);
        const rawStr = raw.toString('binary');

        // 简易 multipart 解析
        const parts = rawStr.split('--' + boundary);
        let fileBuffer = null, fileName = 'unknown.mgg';

        for (const part of parts) {
          if (!part.includes('filename=')) continue;
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd < 0) continue;

          const header = part.substring(0, headerEnd);
          const nameMatch = header.match(/filename="(.+?)"/);
          if (nameMatch) {
            // 浏览器通过 multipart 发送的文件名是 UTF-8 编码的字节
            // 但 raw.toString('binary') 会把每个字节当成一个 latin1 字符
            // 所以需要把 latin1 字符还原回 UTF-8
            fileName = Buffer.from(nameMatch[1], 'latin1').toString('utf8');
          }

          let body = part.substring(headerEnd + 4);
          // Remove trailing \r\n-- if present
          const trailIdx = body.lastIndexOf('\r\n');
          if (trailIdx > 0) body = body.substring(0, trailIdx);
          fileBuffer = Buffer.from(body, 'binary');
          break;
        }

        if (!fileBuffer) throw new Error('No file data');

        const result = await convert(fileBuffer, fileName, toMp3);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(e.message);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// 启动
server.listen(PORT, async () => {
  await ensureWasm();
  console.log(`\n  🎵 MGG → MP3 转换器已启动\n`);
  console.log(`  浏览器打开: http://localhost:${PORT}\n`);
  console.log(`  拖入 .mgg / .mflac 文件即可转换\n`);
  console.log(`  输出目录: ${OUT_DIR}\n`);
  console.log(`  ──────────────────────────────`);
  console.log(`  ⚠ 关闭本窗口即可停止服务\n`);

  // 自动打开浏览器
  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}`);
});
