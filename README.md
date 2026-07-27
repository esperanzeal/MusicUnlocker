# MusicUnlocker

QQ音乐 .mgg / .mflac 解密工具。拖拽到网页、一键解密输出 OGG/FLAC，可选转 MP3。

## 使用

双击 `MGG转MP3_网页版.bat`，浏览器打开后拖入文件即可。勾选"转换为 MP3"则自动用 ffmpeg 转码。

## 命令行

```bash
node mgg2mp3.js <file|dir>           # 解密输出 OGG/FLAC
node mgg2mp3.js <file|dir> --mp3     # 解密后转 MP3
node mgg2mp3.js <dir> --mp3 --out E:\Music  # 指定输出目录
```

## 依赖

- Node.js ≥ 18
- ffmpeg（可选，转 MP3 时需要）
