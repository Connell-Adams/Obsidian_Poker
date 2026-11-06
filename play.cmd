@echo off
setlocal
cd /d "%~dp0"

rem Find a Node runtime: PATH first, then the copy bundled with LM Studio.
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%USERPROFILE%\.lmstudio\.internal\utils\node.exe" set "NODE_EXE=%USERPROFILE%\.lmstudio\.internal\utils\node.exe"

if defined NODE_EXE if exist "dist\index.html" (
  echo Starting Obsidian Room at http://localhost:4173
  start "" "http://localhost:4173"
  "%NODE_EXE%" tools\serve-dist.mjs 4173
  goto :eof
)

if defined NODE_EXE if exist "node_modules\vite\bin\vite.js" (
  echo Starting Obsidian Room at http://localhost:5173
  start "" "http://localhost:5173"
  "%NODE_EXE%" node_modules\vite\bin\vite.js --port 5173
  goto :eof
)

rem Without Node, the production build can still be served with Python.
if exist "dist\index.html" (
  where python >nul 2>nul && (
    echo Starting Obsidian Room at http://localhost:4173
    start "" "http://localhost:4173"
    python -m http.server 4173 --directory dist
    goto :eof
  )
)

echo Could not start Obsidian Room.
echo Install Node.js from https://nodejs.org, then run:  npm install  and  npm run dev
pause
