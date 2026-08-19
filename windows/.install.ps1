$ErrorActionPreference = 'Stop'

try {
    $sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $installDir = Join-Path $env:USERPROFILE 'cheddar'

    Write-Host "Grinding Cheddar to $installDir ..."
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null

    $scriptDest = Join-Path $installDir '.cheddar.ps1'
    Copy-Item -Path (Join-Path $sourceDir '.cheddar.ps1') -Destination $scriptDest -Force

    # The command that ends up on PATH -- this is the only file meant to be
    # visible. Named .cmd (not .bat) purely for consistency; both are in the
    # default PATHEXT so `cheddar` resolves either way. `if errorlevel 1 pause`
    # only holds the window open on a crash — a clean exit from an interactive
    # terminal shouldn't need an extra keypress.
    $launcherPath = Join-Path $installDir 'cheddar.cmd'
    $launcherContent = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0.cheddar.ps1"
if errorlevel 1 pause
'@
    Set-Content -Path $launcherPath -Value $launcherContent -Encoding ASCII

    # Files copied from a download/zip/email carry a "Mark of the Web" tag that
    # Copy-Item preserves on the copy — left alone, the installed script would
    # still trigger an execution-policy/SmartScreen prompt the first time
    # `cheddar` runs. Strip it so the installed copies just work.
    Unblock-File -Path $scriptDest -ErrorAction SilentlyContinue
    Unblock-File -Path $launcherPath -ErrorAction SilentlyContinue

    # A leading dot doesn't hide a file on Windows the way it does on Unix --
    # actually set the Hidden attribute so it doesn't show up in a normal
    # Explorer/dir listing. cheddar.cmd stays visible; it's the only thing
    # meant to be discovered (by PATH, and by anyone browsing the folder).
    & attrib.exe +h $scriptDest

    # Add installDir to the user's PATH -- read/write ONLY the user-scope value
    # (not the current process's merged system+user PATH) to avoid setx's
    # truncation risk and avoid duplicating system entries into user scope.
    $currentUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $currentUserPath) { $currentUserPath = '' }

    $entries = $currentUserPath -split ';' | Where-Object { $_ -ne '' }
    $alreadyPresent = $entries | Where-Object { $_.TrimEnd('\') -ieq $installDir.TrimEnd('\') }

    if (-not $alreadyPresent) {
        $newPath = if ($currentUserPath) { "$currentUserPath;$installDir" } else { $installDir }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "Cheddar is now hot!"
    } else {
        Write-Host "Cheddar has now become cold!"
    }

    Write-Host ''
    Write-Host 'Done. Open a NEW terminal window and type: cheddar'
} catch {
    # An explicit exit code matters here: run.bat's `if errorlevel 1` gate and
    # get-cheddar.bat's "keep files for troubleshooting on failure" logic both
    # depend on this process actually reporting non-zero, which an uncaught
    # terminating error doesn't reliably do when run via `powershell -File`.
    Write-Host "Cheddar grinding failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
