@echo off
cd /d "%~dp0"
start "" http://localhost:8765
node mgg2mp3-server.js
pause
