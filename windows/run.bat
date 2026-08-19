@echo off
attrib +h "%~dp0.cheddar.ps1" >nul 2>&1
attrib +h "%~dp0.install.ps1" >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0.install.ps1"
pause
