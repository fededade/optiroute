@echo off
setlocal
cd /d "%~dp0"
set "PY="
py -3 -c "import sys" >nul 2>&1 && set "PY=py -3"
if not defined PY (python -c "import sys" >nul 2>&1 && set "PY=python")
if not defined PY (
  echo Python non e' installato su questo PC.
  echo Installalo da https://www.python.org/downloads/ spuntando "Add python.exe to PATH", poi riprova.
  pause
  exit /b 1
)
%PY% installa_bridge.py %*
pause
