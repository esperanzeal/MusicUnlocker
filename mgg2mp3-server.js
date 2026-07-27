/**
 * mgg2mp3-server — MusicUnlocker 网页版
 * 启动: node mgg2mp3-server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { ensureWasm, parseFooter, decrypt, toMp3 } = require('./lib');

const PORT = 8765;
const CACHE_FILE = path.join(__dirname, '.mgg2mp3_cache.json');
const DEFAULT_OUT = path.join(__dirname, 'output');


// ── HTML ─────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MusicUnlocker</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.container{text-align:center;max-width:600px;padding:40px}
h1{font-size:28px;margin-bottom:4px}
.sub{color:#888;margin-bottom:8px;font-size:14px}
.out{color:#666;margin-bottom:24px;font-size:12px}
.dropzone{border:2px dashed #444;border-radius:16px;padding:60px 20px;transition:all .3s;cursor:pointer;background:#1a1a1a}
.dropzone:hover,.dropzone.drag{border-color:#1db954;background:#1a2a1a}
.dropzone .icon{font-size:48px;margin-bottom:16px}
.dropzone p{font-size:18px;color:#aaa}
label{display:block;margin-top:16px;color:#aaa;cursor:pointer;user-select:none}
label input{margin-right:6px}
#status{margin-top:24px}
.file-row{display:flex;align-items:center;padding:10px 16px;background:#1a1a1a;border-radius:8px;margin:8px 0}
.file-row .name{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-row .state{margin-left:12px;font-size:14px}
.state.ok{color:#1db954}.state.err{color:#e74c3c}.state.wait{color:#888}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid #444;border-top-color:#1db954;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="container">
  <h1>🎵 MusicUnlocker</h1>
  <p class="sub">.mgg/.mflac 拖入即解密</p>
  <input type="text" id="outDir" value="${escapeHtml(DEFAULT_OUT)}" 
    style="display:block;width:100%;margin:8px 0 16px;padding:8px 12px;background:#1a1a1a;border:1px solid #444;border-radius:8px;color:#ccc;font-size:13px;text-align:center"
    placeholder="输出目录">

  <div class="dropzone" id="dropzone">
    <div class="icon">📁</div>
    <p>点击或拖拽 .mgg / .mflac 文件</p>
    <input type="file" id="fileInput" accept=".mgg,.mflac" multiple hidden>
  </div>

  <label><input type="checkbox" id="toMp3">转 MP3（否则输出 OGG）</label>

  <div id="status"></div>
</div>
<script>
const dropzone=document.getElementById('dropzone'),fileInput=document.getElementById('fileInput'),statusDiv=document.getElementById('status');
dropzone.addEventListener('click',()=>fileInput.click());
fileInput.addEventListener('change',e=>handleFiles(e.target.files));
dropzone.addEventListener('dragover',e=>{e.preventDefault();dropzone.classList.add('drag')});
dropzone.addEventListener('dragleave',()=>dropzone.classList.remove('drag'));
dropzone.addEventListener('drop',e=>{e.preventDefault();dropzone.classList.remove('drag');handleFiles(e.dataTransfer.files)});
async function handleFiles(files){
  const qmcFiles=[...files].filter(f=>{const n=f.name.toLowerCase();return n.endsWith('.mgg')||n.endsWith('.mflac')});
  if(!qmcFiles.length){alert('请选择 .mgg 或 .mflac 文件');return}
  statusDiv.innerHTML='';const toMp3=document.getElementById('toMp3').checked;
  for(const file of qmcFiles){
    const row=document.createElement('div');row.className='file-row';
    row.innerHTML='<span class="name">'+escapeHtml(file.name)+'</span><span class="state wait"><span class="spinner"></span> 转换中...</span>';
    statusDiv.appendChild(row);
    try{
      const fd=new FormData();fd.append('file',file);
      const outDir=encodeURIComponent(document.getElementById('outDir').value);
      const res=await fetch('/convert?mp3='+toMp3+'&out='+outDir,{method:'POST',body:fd});
      if(!res.ok){const e=await res.text();throw new Error(e)}
      row.querySelector('.state').className='state ok';
      row.querySelector('.state').textContent='✅ 完成';
    }catch(e){
      row.querySelector('.state').className='state err';
      row.querySelector('.state').textContent='❌ '+e.message.substring(0,80);
    }
  }
}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
</script>
</body>
</html>`;
function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── multipart 解析 ──────────────────────────────────────
function parseMultipart(raw, boundary) {
  // boundary 是 ASCII，用 latin1 保留字节映射
  const str = raw.toString('latin1');
  const parts = str.split('--' + boundary);
  for (const part of parts) {
    if (!part.includes('filename=')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;

    const header = part.substring(0, headerEnd);
    const nameMatch = header.match(/filename="(.+?)"/);
    const fileName = nameMatch
      ? Buffer.from(nameMatch[1], 'latin1').toString('utf8')  // UTF-8 文件名还原
      : 'unknown.mgg';

    let bodyStr = part.substring(headerEnd + 4);
    const trailIdx = bodyStr.lastIndexOf('\r\n');
    if (trailIdx > 0) bodyStr = bodyStr.substring(0, trailIdx);
    return { fileName, buffer: Buffer.from(bodyStr, 'latin1') };
  }
  return null;
}

// ── HTTP ─────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/convert')) {
    const qs=new URLSearchParams(req.url.split('?')[1]||'');const toMp3Flag=qs.get('mp3')==='true';const outDir=qs.get('out')||DEFAULT_OUT;if(!fs.existsSync(outDir))fs.mkdirSync(outDir,{recursive:true});
    const chunks = [];
    const ct = req.headers['content-type'] || '';
    const boundary = ct.split('boundary=')[1];
    if (!boundary) { res.writeHead(400); res.end('bad request'); return; }

    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const parsed = parseMultipart(Buffer.concat(chunks), boundary);
        if (!parsed) throw new Error('No file data');

        const { buffer, fileName } = parsed;
        const info = parseFooter(buffer);
        if (!info) throw new Error('无法识别的文件格式');

        const { data, ext } = await decrypt(buffer, info, CACHE_FILE);
        const baseName = path.parse(fileName).name;
        const isMflac = fileName.toLowerCase().endsWith('.mflac');

        if (isMflac || !toMp3Flag) {
          const outName = `${baseName}.${ext}`;
          const outPath = path.join(outDir, outName);
          fs.writeFileSync(outPath, data);
        } else {
          const tmpPath = path.join(outDir, `_tmp_${baseName}.${ext}`);
          fs.writeFileSync(tmpPath, data);
          try {
            toMp3(tmpPath, path.join(outDir, `${baseName}.mp3`));
          } catch (e) {
            const fallback = path.join(outDir, `${baseName}.${ext}`);
            fs.renameSync(tmpPath, fallback);
            throw new Error(`${e.message}，已保留为 ${ext}`);
          } finally {
            try { fs.unlinkSync(tmpPath); } catch {}
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(e.message);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, async () => {
  await ensureWasm();
  console.log('\n  🎵 MusicUnlocker');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  默认输出: ${DEFAULT_OUT}\n`);
  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}`);
});
