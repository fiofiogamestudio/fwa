@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20.10 or newer is required. Install Node.js and try again.
  if not defined FW_START_NO_PAUSE pause
  exit /b 1
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major<20 || (major===20 && minor<10) ? 1 : 0)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 20.10 or newer is required. Update Node.js and try again.
  if not defined FW_START_NO_PAUSE pause
  exit /b 1
)
node "%~dp0tools\start-editor.mjs" %*
set "FWA_START_EXIT=%ERRORLEVEL%"
if not "%FWA_START_EXIT%"=="0" if not defined FW_START_NO_PAUSE pause
exit /b %FWA_START_EXIT%
