# Clears the whole console buffer, not just this process's own output -- a
# console window's screen buffer is shared by everything that's run in it,
# so this wipes out whatever cmd.exe or a parent PowerShell already printed
# before invoking cheddar.cmd, regardless of which shell launched it. Wrapped
# in try/catch since Clear-Host throws if output isn't an actual console
# (e.g. redirected to a file) -- not a normal way to run this, but harmless
# to guard against.
try { Clear-Host } catch {}

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Windows PowerShell'

# Add-Type -AssemblyName System.Net.WebSockets.Client fails on many Windows
# PowerShell 5.1 installs with "assembly could not be found" even though the
# DLL is physically present in the GAC — powershell.exe's own .config doesn't
# carry a binding redirect for this facade assembly, so a short-name load
# fails. Loading by full strong name (or, as a last resort, straight off disk
# from the GAC) works around it.
function Import-CheddarAssembly {
    param([string]$ShortName, [string[]]$Versions)

    try {
        Add-Type -AssemblyName $ShortName -ErrorAction Stop
        return $true
    } catch {}

    foreach ($version in $Versions) {
        try {
            Add-Type -AssemblyName "$ShortName, Version=$version, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a" -ErrorAction Stop
            return $true
        } catch {}
    }

    $gacRoot = Join-Path $env:WINDIR "Microsoft.NET\assembly\GAC_MSIL\$ShortName"
    if (Test-Path $gacRoot) {
        $dll = Get-ChildItem -Path $gacRoot -Filter "$ShortName.dll" -Recurse | Select-Object -First 1
        if ($dll) {
            try {
                Add-Type -Path $dll.FullName -ErrorAction Stop
                return $true
            } catch {}
        }
    }

    return $false
}

if (-not (Import-CheddarAssembly -ShortName 'System.Net.WebSockets.Client' -Versions @('4.0.0.0', '4.1.0.0', '4.1.1.0', '4.2.0.0'))) {
    Write-Host 'fatal: could not load System.Net.WebSockets.Client -- this requires Windows 8 / Server 2012 or later with .NET Framework 4.5+.' -ForegroundColor Red
    exit 1
}
if (-not (Import-CheddarAssembly -ShortName 'System.Security' -Versions @('4.0.0.0'))) {
    Write-Host 'fatal: could not load System.Security (needed for encrypted session storage).' -ForegroundColor Red
    exit 1
}

# -----------------------------
# Config
# -----------------------------
function Read-CheddarEncoded {
    param([string]$Encoded)
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Encoded))
}
$Script:q7f3k = Read-CheddarEncoded 'aHR0cDovLzEwOS4xMjMuMjM0LjY5L2FwaS9jaGVkZGFy'
$Script:m2xq9 = Read-CheddarEncoded 'aHR0cDovLzEwOS4xMjMuMjM0LjY5L2NoZWRkYXItY2xp'
$Script:z8n4t = 'ched_zM73h-48GJBIP1B6P7I6oXZvw_qyb3SjTWVNRKimBoA'
$Script:v5h8r = Read-CheddarEncoded 'aHR0cDovLzEwOS4xMjMuMjM0LjY5L2FwaS9rYXJpcnM='

$Script:SessionDir = Join-Path $env:LOCALAPPDATA 'Cheddar'
$Script:SessionFile = Join-Path $Script:SessionDir 'session.dat'

# -----------------------------
# Session state
# -----------------------------
$Script:AccessToken = $null
$Script:RefreshToken = $null
$Script:Username = $null
$Script:DisplayName = $null
$Script:UserId = $null
$Script:ActiveConversationId = $null
$Script:ConversationCache = @()
$Script:RequestCache = @()
$Script:ParticipantNames = @{}

$Script:WsClient = $null
$Script:WsReceiveTask = $null
$Script:WsReceiveAccum = $null
$Script:WsReceiveBuffer = New-Object byte[] 8192

$Script:InputBuffer = ''
$Script:LogCallCount = 0
$Script:ShouldExit = $false

# -----------------------------
# Games/lobby state — mirrors the web app's useGames/vscode extension's
# currentLobby: exactly one lobby is "focused" at a time, tracked here and
# kept live by lobby.updated/game.started over the same cheddar socket
# everything else uses. Karirs additionally gets its own race socket (see
# below), same as web/vscode do, since race steps are a separate service.
# -----------------------------
$Script:GameCatalogCache = @()
$Script:LobbyListCache = @()
$Script:CurrentLobby = $null

$Script:KarirsWsClient = $null
$Script:KarirsWsReceiveTask = $null
$Script:KarirsWsReceiveAccum = $null
$Script:KarirsWsReceiveBuffer = New-Object byte[] 8192
$Script:KarirsRaceId = $null

$Script:KarirsRace = $null
$Script:KarirsWallet = $null
$Script:KarirsPool = $null
$Script:KarirsMyBet = $null
$Script:KarirsFinishNotified = $false
# Which racers have already had their signature-move shout logged this race
# — a step's "shouting" list stays true for several consecutive steps (see
# race.py's PEAK_SPEED_THRESHOLD), and without this every one of those steps
# would re-log the same shout.
$Script:KarirsAnnouncedShouts = @{}
# Elapsed-time playback needs no interpolation here (nothing is being drawn)
# — just "which step, if any, just became current" so a shout logs once, at
# roughly the right moment, instead of all at once when the race resolves.
$Script:KarirsLastStepIndex = -1

# -----------------------------
# Output — everything rendered goes through here (timestamp + text), and
# redraws whatever the user has half-typed so an async incoming message
# doesn't clobber their in-progress input line. LogCallCount lets the REPL
# loop tell whether a command already redrew the prompt itself (so it
# doesn't print a second one) versus stayed silent (so it needs to).
# -----------------------------
function Write-CheddarLog {
    param([string]$Text)
    $Script:LogCallCount++
    $timestamp = (Get-Date).ToString('HH:mm:ss')
    $line = "$timestamp  $Text"

    $promptLen = 2 + $Script:InputBuffer.Length
    Write-Host ("`r" + (' ' * $promptLen) + "`r") -NoNewline
    Write-Host $line
    Write-Host ("$ " + $Script:InputBuffer) -NoNewline
}

function Write-CheddarMessage {
    param($Message)
    $senderId = [int64]$Message.sender_id
    $who = 'me'
    if ($senderId -ne [int64]$Script:UserId) {
        if ($Script:ParticipantNames.ContainsKey($senderId)) {
            $who = $Script:ParticipantNames[$senderId]
        } else {
            $who = "user#$senderId"
        }
    }
    $body = ''
    if ($Message.content) {
        $body = $Message.content
    } elseif ($Message.metadata) {
        $body = "[attachment] $($Message.metadata.filename)"
    }
    # No buttons in a terminal -- the web/vscode clients render this as a
    # clickable "Claim 250 coins" button, so this just tells the player
    # what to type instead.
    if ($Message.metadata -and $Message.metadata.action -eq 'karirs_daily_bonus') {
        $body = "$body -- /claim to redeem"
    }
    Write-CheddarLog "$who» $body"
}

# -----------------------------
# REST helpers
# -----------------------------
function Invoke-CheddarApi {
    param(
        [string]$Method = 'GET',
        [string]$Path,
        $Body = $null,
        [switch]$Authorized,
        [bool]$AllowRetry = $true
    )

    $headers = @{ 'X-API-Key' = $Script:z8n4t }
    if ($Authorized -and $Script:AccessToken) {
        $headers['Authorization'] = "Bearer $($Script:AccessToken)"
    }

    $params = @{
        Method      = $Method
        Uri         = "$($Script:q7f3k)$Path"
        Headers     = $headers
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $params['Body'] = ($Body | ConvertTo-Json -Depth 10 -Compress)
        $params['ContentType'] = 'application/json'
    }

    try {
        $data = Invoke-RestMethod @params
        return @{ Ok = $true; Data = $data }
    } catch {
        $resp = $_.Exception.Response
        $status = 0
        if ($resp) { $status = [int]$resp.StatusCode }

        if ($status -eq 401 -and $Authorized -and $AllowRetry -and $Script:RefreshToken) {
            if (Invoke-CheddarRefresh) {
                return Invoke-CheddarApi -Method $Method -Path $Path -Body $Body -Authorized:$Authorized -AllowRetry:$false
            }
        }

        $detail = $null
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            try { $detail = ($_.ErrorDetails.Message | ConvertFrom-Json).detail } catch {}
        } elseif ($resp) {
            try {
                $stream = $resp.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $detail = ($reader.ReadToEnd() | ConvertFrom-Json).detail
            } catch {}
        }
        return @{ Ok = $false; Status = $status; Detail = $detail }
    }
}

# FastAPI's plain HTTPException errors put a string in .detail (e.g. "Username
# or email already in use"), but Pydantic validation errors (422s, e.g. a
# too-short password) put a LIST of {loc, msg, type} objects there instead --
# without this, that list would print as a useless ".NET object" dump.
function Format-CheddarApiError {
    param($Result)
    if ($Result.Detail) {
        if ($Result.Detail -is [System.Array]) {
            return ($Result.Detail | ForEach-Object { $_.msg }) -join '; '
        }
        return $Result.Detail
    }
    return "http $($Result.Status)"
}

# Karirs is its own service with its own database — it trusts the same
# Cheddar-issued bearer token (verified with Cheddar's own JWT secret) and
# needs no API key of its own, unlike Invoke-CheddarApi above.
function Invoke-KarirsApi {
    param(
        [string]$Method = 'GET',
        [string]$Path,
        $Body = $null
    )

    $headers = @{}
    if ($Script:AccessToken) { $headers['Authorization'] = "Bearer $($Script:AccessToken)" }

    $params = @{
        Method      = $Method
        Uri         = "$($Script:v5h8r)$Path"
        Headers     = $headers
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $params['Body'] = ($Body | ConvertTo-Json -Depth 10 -Compress)
        $params['ContentType'] = 'application/json'
    }

    try {
        $data = Invoke-RestMethod @params
        return @{ Ok = $true; Data = $data }
    } catch {
        $resp = $_.Exception.Response
        $status = 0
        if ($resp) { $status = [int]$resp.StatusCode }
        $detail = $null
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            try { $detail = ($_.ErrorDetails.Message | ConvertFrom-Json).detail } catch {}
        }
        return @{ Ok = $false; Status = $status; Detail = $detail }
    }
}

function Invoke-CheddarRefresh {
    if (-not $Script:RefreshToken) { return $false }
    $result = Invoke-CheddarApi -Method POST -Path '/api/v1/auth/refresh' -Body @{ refresh_token = $Script:RefreshToken } -AllowRetry:$false
    if (-not $result.Ok) { return $false }
    $Script:AccessToken = $result.Data.access_token
    $Script:RefreshToken = $result.Data.refresh_token
    Save-CheddarSession
    return $true
}

# -----------------------------
# Session persistence — DPAPI-encrypted (tied to the current Windows user
# account), not plaintext, since this file holds real auth tokens.
# -----------------------------
function Save-CheddarSession {
    if (-not $Script:AccessToken) { return }
    $obj = @{
        access_token  = $Script:AccessToken
        refresh_token = $Script:RefreshToken
        username      = $Script:Username
        display_name  = $Script:DisplayName
        user_id       = $Script:UserId
    }
    $json = $obj | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    New-Item -ItemType Directory -Path $Script:SessionDir -Force | Out-Null
    [System.IO.File]::WriteAllBytes($Script:SessionFile, $protected)
}

function Clear-CheddarSession {
    $Script:AccessToken = $null
    $Script:RefreshToken = $null
    $Script:Username = $null
    $Script:DisplayName = $null
    $Script:UserId = $null
    $Script:ActiveConversationId = $null
    $Script:ConversationCache = @()
    $Script:RequestCache = @()
    if (Test-Path $Script:SessionFile) { Remove-Item $Script:SessionFile -Force }
}

function Restore-CheddarSession {
    if (-not (Test-Path $Script:SessionFile)) {
        Write-CheddarLog 'idle -- no active session. /login <username>'
        return
    }

    try {
        $protected = [System.IO.File]::ReadAllBytes($Script:SessionFile)
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $obj = [System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json

        $Script:AccessToken = $obj.access_token
        $Script:RefreshToken = $obj.refresh_token
        $Script:Username = $obj.username
        $Script:DisplayName = $obj.display_name
        $Script:UserId = $obj.user_id

        $me = Invoke-CheddarApi -Method GET -Path '/api/v1/auth/me' -Authorized
        if (-not $me.Ok) { throw 'invalid session' }

        Write-CheddarLog "session restored as $($Script:DisplayName) (@$($Script:Username))"
        Connect-CheddarSocket
    } catch {
        Clear-CheddarSession
        Write-CheddarLog 'idle -- session expired. /login <username>'
    }
}

# -----------------------------
# Input handling — every submitted line lands here. A leading "/" is a
# command; anything else goes to whichever conversation is open via /open.
# -----------------------------
function Invoke-CheddarInput {
    param([string]$Text)
    $Text = $Text.Trim()
    if (-not $Text) { return }

    if ($Text.StartsWith('/')) {
        Invoke-CheddarCommand -Cmd $Text.Substring(1).Trim()
        return
    }

    if (-not $Script:AccessToken) {
        Write-CheddarLog 'not logged in -- /login <username>'
        return
    }
    if (-not $Script:ActiveConversationId) {
        Write-CheddarLog 'no chat open -- /chats then /open <n>'
        return
    }

    Send-CheddarWsEvent -Type 'message.send' -Data @{ conversation_id = $Script:ActiveConversationId; content = $Text }
}

# Detailed usage for /help <command> -- one array entry per printed line.
# Keep this in sync with the switch below and with vscode's COMMAND_HELP
# (src/extension.ts) where a command exists on both clients.
$Script:CommandHelp = [ordered]@{
    login    = @('/login <username> -- log in (password is prompted, not typed inline)')
    signup   = @('/signup -- create an account (display name, username, email, password are all prompted one at a time)')
    logout   = @('/logout -- log out and revoke the saved session')
    whoami   = @('/whoami -- show who you''re currently logged in as')
    friends  = @('/friends -- list your friends and their online status')
    requests = @('/requests -- list incoming friend requests')
    add      = @('/add <username> -- send a friend request')
    accept   = @('/accept <n> -- accept a pending request from /requests, by its number')
    decline  = @('/decline <n> -- decline a pending request from /requests, by its number')
    chats    = @('/chats -- list your conversations')
    open     = @('/open <n> -- open a conversation from /chats, by its number')
    games    = @('/games -- browse the game catalog, numbered for /lobby create')
    lobby    = @(
        '/lobby -- show your current lobby''s status'
        '/lobby create <n> -- create a lobby for a game from /games, by its number'
        '/lobby invite <username> -- invite a friend directly into your current lobby'
        '/lobby kick <username> -- remove a player from your lobby (leader only)'
        '/lobby leader <username> -- hand lobby leadership to another player (leader only)'
        '/lobby list -- list every lobby you''re currently in'
        '/lobby resume <n> -- switch focus to a lobby from /lobby list, by its number'
        '/lobby code -- get (or create) a shareable code for your current lobby'
        '/lobby join <code> -- join a lobby using a code from /lobby code'
        '/lobby ready -- toggle your ready state (run it again to un-ready)'
        '/lobby start -- deal the game once everyone is ready (leader only)'
        '/lobby restart -- back to the lobby after a finished game so everyone can ready up again (leader only)'
        '/lobby leave -- leave your current lobby'
    )
    race     = @('/race -- show the current Karirs race: each racer''s payout multiplier and pool, your bet if you placed one, and betting/racing status')
    bet      = @('/bet <racer #> <wager> -- bet coins on a racer from /race, by its number -- only while betting is open, one bet per race')
    claim    = @('/claim -- redeem your daily 250-coin bonus (once every 24 hours) -- watch the game chat for the reminder')
    hof      = @('/hof -- show the 10 biggest bets that ever actually won, ranked by wager size')
    update   = @('/update -- check for, and install, a Cheddar client update')
    exit     = @('/exit -- close this session (does not log you out -- your saved session is still there next time)')
    help     = @('/help -- list every command', '/help <command> -- show detailed usage for one command')
}

function Invoke-CheddarCommand {
    param([string]$Cmd)
    $parts = @($Cmd -split '\s+' | Where-Object { $_ -ne '' })
    if ($parts.Count -eq 0) { return }
    $name = $parts[0]
    $rest = @()
    if ($parts.Count -gt 1) { $rest = $parts[1..($parts.Count - 1)] }
    $arg = $rest -join ' '

    switch ($name.ToLower()) {
        'login' {
            if ($rest.Count -ne 1) { Write-CheddarLog 'usage: /login <username>'; return }
            Invoke-CheddarLoginPrompt -Identifier $rest[0]
        }
        'signup' {
            if ($rest.Count -ne 0) { Write-CheddarLog 'usage: /signup  (fields are prompted one at a time)'; return }
            Invoke-CheddarSignupPrompt
        }
        'logout' { Invoke-CheddarLogout }
        'whoami' {
            if ($Script:Username) { Write-CheddarLog "$($Script:DisplayName) (@$($Script:Username))" }
            else { Write-CheddarLog 'not logged in' }
        }
        'friends' { Invoke-CheddarListFriends }
        'requests' { Invoke-CheddarListRequests }
        'add' {
            if (-not $arg) { Write-CheddarLog 'usage: /add <username>'; return }
            Invoke-CheddarAddFriend -Username $arg
        }
        'accept' { Invoke-CheddarRespondRequest -IndexArg $rest[0] -Action 'accept' }
        'decline' { Invoke-CheddarRespondRequest -IndexArg $rest[0] -Action 'decline' }
        'chats' { Invoke-CheddarListChats }
        'open' { Invoke-CheddarOpenChat -IndexArg $rest[0] }
        'games' { Invoke-CheddarListGames }
        'lobby' { Invoke-CheddarLobbyCommand -Rest $rest }
        'race' { Invoke-CheddarShowRace }
        'bet' {
            if ($rest.Count -ne 2) { Write-CheddarLog 'usage: /bet <racer #> <wager>'; return }
            Invoke-CheddarPlaceBet -IndexArg $rest[0] -WagerArg $rest[1]
        }
        'claim' { Invoke-CheddarClaimDailyBonus }
        'hof' { Invoke-CheddarHallOfFame }
        'update' { Invoke-CheddarUpdate }
        'exit' {
            # Just closes this session -- the stored access/refresh tokens
            # are left alone, unlike /logout which revokes them server-side.
            Write-CheddarLog 'bye'
            $Script:ShouldExit = $true
        }
        'help' {
            if ($arg) {
                $lines = $Script:CommandHelp[$arg.ToLower()]
                if ($lines) { $lines | ForEach-Object { Write-CheddarLog $_ } }
                else { Write-CheddarLog "no help for /$arg -- /help with no arguments lists every command" }
                return
            }
            Write-CheddarLog 'commands: /login /signup /logout /whoami /friends /requests /add /accept /decline /chats /open /games /lobby /race /bet /claim /hof /update /exit -- /help <command> for details'
        }
        default { Write-CheddarLog "unknown command: /$name" }
    }
}

function Invoke-CheddarLoginPrompt {
    param([string]$Identifier)
    # Read-Host -AsSecureString masks each typed character with an asterisk
    # natively in the console host -- no manual key-by-key handling needed.
    # It blocks until Enter, so WS polling pauses for however long the user
    # takes to type; nothing is lost, the socket just isn't read from until
    # right after, and TCP holds whatever arrived in the meantime.
    $securePassword = Read-Host -Prompt 'password' -AsSecureString
    $plainPassword = [System.Net.NetworkCredential]::new('', $securePassword).Password
    Invoke-CheddarLogin -Identifier $Identifier -Password $plainPassword
}

function Invoke-CheddarSignupPrompt {
    $displayName = Read-Host -Prompt 'display name'
    if (-not $displayName) { Write-CheddarLog 'signup cancelled -- display name required'; return }

    $username = Read-Host -Prompt 'username'
    if (-not $username) { Write-CheddarLog 'signup cancelled -- username required'; return }

    $email = Read-Host -Prompt 'email'
    if (-not $email) { Write-CheddarLog 'signup cancelled -- email required'; return }

    $securePassword1 = Read-Host -Prompt 'password' -AsSecureString
    $securePassword2 = Read-Host -Prompt 'confirm password' -AsSecureString
    $password1 = [System.Net.NetworkCredential]::new('', $securePassword1).Password
    $password2 = [System.Net.NetworkCredential]::new('', $securePassword2).Password

    if (-not $password1) { Write-CheddarLog 'signup cancelled -- password required'; return }
    if ($password1 -ne $password2) { Write-CheddarLog 'passwords did not match -- /signup to try again'; return }

    Invoke-CheddarSignup -Username $username -Email $email -Password $password1 -DisplayName $displayName
}

function Invoke-CheddarSignup {
    param([string]$Username, [string]$Email, [string]$Password, [string]$DisplayName)

    $res = Invoke-CheddarApi -Method POST -Path '/api/v1/auth/register' -Body @{
        username     = $Username
        email        = $Email
        password     = $Password
        display_name = $DisplayName
    }

    if (-not $res.Ok) {
        Write-CheddarLog "signup failed: $(Format-CheddarApiError -Result $res)"
        return
    }

    Write-CheddarLog "account created for @$Username -- logging in..."
    Invoke-CheddarLogin -Identifier $Username -Password $Password
}

function Invoke-CheddarLogin {
    param([string]$Identifier, [string]$Password)
    $res = Invoke-CheddarApi -Method POST -Path '/api/v1/auth/login' -Body @{ identifier = $Identifier; password = $Password }
    if (-not $res.Ok) { Write-CheddarLog 'login failed -- check credentials'; return }

    $Script:AccessToken = $res.Data.access_token
    $Script:RefreshToken = $res.Data.refresh_token

    $me = Invoke-CheddarApi -Method GET -Path '/api/v1/auth/me' -Authorized
    if (-not $me.Ok) { Write-CheddarLog 'login succeeded but profile fetch failed -- try again'; return }

    $Script:UserId = $me.Data.id
    $Script:Username = $me.Data.username
    $Script:DisplayName = $me.Data.display_name

    Save-CheddarSession
    Write-CheddarLog "logged in as $($Script:DisplayName) (@$($Script:Username))"
    Connect-CheddarSocket
}

function Invoke-CheddarLogout {
    if ($Script:RefreshToken) {
        Invoke-CheddarApi -Method POST -Path '/api/v1/auth/logout' -Body @{ refresh_token = $Script:RefreshToken } -AllowRetry:$false | Out-Null
    }
    Disconnect-CheddarSocket
    Clear-CheddarSession
    Write-CheddarLog 'logged out'
}

# Shared by /update and the silent startup check below. Update detection is
# plain content comparison against the copy this script was installed from,
# not a version number -- there's nothing else to drift out of sync (run.bat
# / install.ps1 only ever run once, at install time, so only this file's own
# content can go stale). Line endings are normalized before comparing so a
# CRLF/LF difference alone doesn't look like a change.
#
# -OutFile streams the response straight to disk as raw bytes. Reading via
# the .Content property instead is what broke this before: when the server
# doesn't send a recognized text Content-Type (nginx has no MIME mapping for
# .ps1, so it served this as binary), Windows PowerShell 5.1 hands back
# .Content as a byte[] rather than a string. -replace on an array runs
# element-wise, so it silently turned every byte into its own "32", "125",
# "10", ... line, and Set-Content wrote each one as a separate line -- the
# file became a list of byte values instead of the actual script. -OutFile
# never goes through that property, so it can't happen here regardless of
# what Content-Type the server sends.
function Get-CheddarUpdateStatus {
    $selfPath = $PSCommandPath
    if (-not $selfPath -or -not (Test-Path $selfPath)) {
        return @{ Ok = $false; Error = 'could not locate the installed script file' }
    }

    $tempPath = [System.IO.Path]::GetTempFileName()
    try {
        Invoke-WebRequest -Uri "$($Script:m2xq9)/.cheddar.ps1" -OutFile $tempPath -UseBasicParsing -ErrorAction Stop
    } catch {
        Remove-Item -Path $tempPath -ErrorAction SilentlyContinue
        return @{ Ok = $false; Error = $_.Exception.Message }
    }

    $remoteText = [System.IO.File]::ReadAllText($tempPath) -replace "`r`n", "`n"
    $localText = [System.IO.File]::ReadAllText($selfPath) -replace "`r`n", "`n"
    $upToDate = $remoteText -eq $localText

    return @{ Ok = $true; UpToDate = $upToDate; SelfPath = $selfPath; TempPath = $tempPath }
}

function Invoke-CheddarUpdate {
    Write-CheddarLog 'checking for updates...'
    $status = Get-CheddarUpdateStatus
    if (-not $status.Ok) {
        Write-CheddarLog "update check failed: $($status.Error)"
        return
    }

    if ($status.UpToDate) {
        Write-CheddarLog 'already up to date'
        Remove-Item -Path $status.TempPath -ErrorAction SilentlyContinue
        return
    }

    try {
        Copy-Item -Path $status.TempPath -Destination $status.SelfPath -Force
        Unblock-File -Path $status.SelfPath -ErrorAction SilentlyContinue
    } catch {
        Write-CheddarLog "update download succeeded but writing it failed: $($_.Exception.Message)"
        Remove-Item -Path $status.TempPath -ErrorAction SilentlyContinue
        return
    }

    Remove-Item -Path $status.TempPath -ErrorAction SilentlyContinue
    Write-CheddarLog 'updated -- close this window and run cheddar again to use the new version'
}

# Runs once at launch. Deliberately silent on failure (offline, server
# hiccup) -- a startup check nagging with errors every time you open the app
# would be worse than just staying quiet and letting /update surface it if
# the user asks. Never writes anything to disk itself, only /update does.
function Test-CheddarStartupUpdate {
    $status = Get-CheddarUpdateStatus
    if ($status.Ok -and -not $status.UpToDate) {
        Write-CheddarLog 'a newer version of cheddar is available -- run /update to install it'
    }
    if ($status.TempPath) {
        Remove-Item -Path $status.TempPath -ErrorAction SilentlyContinue
    }
}

function Invoke-CheddarListFriends {
    $res = Invoke-CheddarApi -Method GET -Path '/api/v1/friends' -Authorized
    if (-not $res.Ok) { Write-CheddarLog 'not logged in'; return }
    $friends = @($res.Data)
    if ($friends.Count -eq 0) { Write-CheddarLog 'no friends yet -- /add <username>'; return }
    for ($i = 0; $i -lt $friends.Count; $i++) {
        $f = $friends[$i]
        Write-CheddarLog "$($i + 1)) $($f.display_name) (@$($f.username)) [$($f.status)]"
    }
}

function Invoke-CheddarListRequests {
    $res = Invoke-CheddarApi -Method GET -Path '/api/v1/friends/requests?direction=incoming' -Authorized
    if (-not $res.Ok) { Write-CheddarLog 'not logged in'; return }
    $requests = @($res.Data)
    $Script:RequestCache = @()
    foreach ($r in $requests) {
        $label = "$($r.user.display_name) (@$($r.user.username))"
        $Script:RequestCache += [PSCustomObject]@{ Id = $r.id; Label = $label }
    }
    if ($Script:RequestCache.Count -eq 0) { Write-CheddarLog 'no pending requests'; return }
    for ($i = 0; $i -lt $Script:RequestCache.Count; $i++) {
        Write-CheddarLog "$($i + 1)) $($Script:RequestCache[$i].Label)"
    }
}

function Invoke-CheddarAddFriend {
    param([string]$Username)
    $res = Invoke-CheddarApi -Method GET -Path "/api/v1/users/search?q=$([uri]::EscapeDataString($Username))" -Authorized
    if (-not $res.Ok) { Write-CheddarLog 'not logged in'; return }
    $users = @($res.Data)
    $match = $users | Where-Object { $_.username.ToLower() -eq $Username.ToLower() } | Select-Object -First 1
    if (-not $match) { $match = $users | Select-Object -First 1 }
    if (-not $match) { Write-CheddarLog "no user found matching `"$Username`""; return }

    $reqRes = Invoke-CheddarApi -Method POST -Path '/api/v1/friends/requests' -Body @{ user_id = $match.id } -Authorized
    if ($reqRes.Ok) {
        Write-CheddarLog "friend request sent to @$($match.username)"
    } else {
        Write-CheddarLog "could not send request: $(Format-CheddarApiError -Result $reqRes)"
    }
}

function Invoke-CheddarRespondRequest {
    param([string]$IndexArg, [string]$Action)
    if (-not $IndexArg -or $IndexArg -notmatch '^\d+$') { Write-CheddarLog "usage: /$Action <n>"; return }
    $idx = [int]$IndexArg - 1
    if ($idx -lt 0 -or $idx -ge $Script:RequestCache.Count) {
        Write-CheddarLog 'run /requests first, then /accept <n>'
        return
    }
    $req = $Script:RequestCache[$idx]
    $res = Invoke-CheddarApi -Method POST -Path "/api/v1/friends/requests/$($req.Id)/$Action" -Authorized
    if ($res.Ok) { Write-CheddarLog "$($Action)ed request from $($req.Label)" }
    else { Write-CheddarLog "failed to $Action request" }
}

function Invoke-CheddarListChats {
    $res = Invoke-CheddarApi -Method GET -Path '/api/v1/conversations' -Authorized
    if (-not $res.Ok) { Write-CheddarLog 'not logged in'; return }
    $conversations = @($res.Data)
    $Script:ConversationCache = @()
    foreach ($c in $conversations) {
        $peer = $c.participants | Where-Object { [int64]$_.id -ne [int64]$Script:UserId } | Select-Object -First 1
        $label = "conversation #$($c.id)"
        if ($c.name) { $label = $c.name }
        elseif ($peer) { $label = $peer.display_name }
        $unread = ($null -ne $c.last_message_id) -and ($c.last_message_id -ne $c.last_read_message_id)
        foreach ($p in $c.participants) { $Script:ParticipantNames[[int64]$p.id] = $p.display_name }
        $Script:ConversationCache += [PSCustomObject]@{ Id = $c.id; Label = $label; Unread = $unread }
    }
    if ($Script:ConversationCache.Count -eq 0) {
        Write-CheddarLog 'no chats yet -- message a friend from the Cheddar web app to start one'
        return
    }
    for ($i = 0; $i -lt $Script:ConversationCache.Count; $i++) {
        $c = $Script:ConversationCache[$i]
        $marker = ''
        if ($c.Unread) { $marker = '  *' }
        Write-CheddarLog "$($i + 1)) $($c.Label)$marker"
    }
}

function Invoke-CheddarOpenChat {
    param([string]$IndexArg)
    if (-not $IndexArg -or $IndexArg -notmatch '^\d+$') { Write-CheddarLog 'usage: /open <n>'; return }
    $idx = [int]$IndexArg - 1
    if ($idx -lt 0 -or $idx -ge $Script:ConversationCache.Count) {
        Write-CheddarLog 'run /chats first, then /open <n>'
        return
    }
    $convo = $Script:ConversationCache[$idx]
    $Script:ActiveConversationId = $convo.Id
    Write-CheddarLog "-- opened $($convo.Label) --"

    $res = Invoke-CheddarApi -Method GET -Path "/api/v1/conversations/$($convo.Id)/messages" -Authorized
    if (-not $res.Ok) { return }
    $messages = @($res.Data)
    $tail = $messages | Select-Object -Last 10
    foreach ($m in $tail) { Write-CheddarMessage -Message $m }

    if ($messages.Count -gt 0) {
        $last = $messages[$messages.Count - 1]
        Send-CheddarWsEvent -Type 'message.read' -Data @{ conversation_id = $convo.Id; message_id = $last.id }
    }
}

# -----------------------------
# Games / lobbies — a lobby reuses one of the user's own group chats as its
# own conversation (so /open still works on it, same as the web app), and
# exactly one lobby is "focused" here at a time via $Script:CurrentLobby,
# same shape as the web app's useGames/vscode extension's currentLobby.
# Resolving a username to a user id (for invite/kick/leader) reuses the same
# /users/search endpoint Invoke-CheddarAddFriend already does.
# -----------------------------
# The API's timestamp fields (e.g. betting_closes_at) are naive UTC — no
# offset in the string. Web/vscode handle that by appending "Z" themselves
# before parsing, but PowerShell's own JSON deserializer (Invoke-RestMethod
# -> ConvertFrom-Json, backed by System.Text.Json here) already auto-parses
# an ISO-8601-shaped string into a real [DateTime] before this code ever
# sees it — with Kind left as Unspecified, since the source string carried
# no offset. Calling .ToUniversalTime() on that would silently (mis)treat
# it as local time and shift it; SpecifyKind just relabels the same
# clock-time numbers as UTC, which is what they actually are.
function ConvertTo-CheddarUtc {
    param($Value)
    if ($Value -is [DateTime]) {
        return [DateTime]::SpecifyKind($Value, [DateTimeKind]::Utc)
    }
    return [DateTime]::SpecifyKind([DateTime]::Parse([string]$Value), [DateTimeKind]::Utc)
}

function Resolve-CheddarUserId {
    param([string]$Username)
    $res = Invoke-CheddarApi -Method GET -Path "/api/v1/users/search?q=$([uri]::EscapeDataString($Username))" -Authorized
    if (-not $res.Ok) { return $null }
    $users = @($res.Data)
    $match = $users | Where-Object { $_.username.ToLower() -eq $Username.ToLower() } | Select-Object -First 1
    if (-not $match) { $match = $users | Select-Object -First 1 }
    return $match
}

function Invoke-CheddarListGames {
    $res = Invoke-CheddarApi -Method GET -Path '/api/v1/games/catalog' -Authorized
    if (-not $res.Ok) { Write-CheddarLog 'not logged in'; return }
    $Script:GameCatalogCache = @($res.Data)
    if ($Script:GameCatalogCache.Count -eq 0) { Write-CheddarLog 'no games available'; return }
    for ($i = 0; $i -lt $Script:GameCatalogCache.Count; $i++) {
        $g = $Script:GameCatalogCache[$i]
        Write-CheddarLog "$($i + 1)) $($g.name) ($($g.min_players)-$($g.max_players)) -- /lobby create $($i + 1)"
    }
}

# Applies a (fresh or updated) lobby as the focused one, including the side
# effects other clients handle in their own equivalents of this: connecting
# the Karirs race socket once a karirs lobby is live, and tearing it down
# once it isn't. Called after every lobby REST response and off
# lobby.updated/game.started broadcasts alike, so all of those paths behave
# the same regardless of which one happened to be the one to notice.
function Set-CheddarCurrentLobby {
    param($Lobby)
    $Script:CurrentLobby = $Lobby
    # Only "in_progress" means an actual live race to (re)connect to --
    # "waiting" has no race yet, and "finished" has one that's already
    # over and shouldn't be replaced by dealing a fresh one just because
    # this lobby got resumed/refocused (create_race would otherwise reuse
    # nothing, since the only race on file is resolved, and deal a whole
    # new one nobody asked for).
    if (-not $Lobby -or $Lobby.status -ne 'in_progress' -or $Lobby.game_key -ne 'karirs') {
        Disconnect-KarirsRaceSocket
        return
    }
    if (-not $Script:KarirsRace -or [int64]$Script:KarirsRace.lobby_id -ne [int64]$Lobby.id) {
        Enter-CheddarKarirsGame -LobbyId $Lobby.id
    }
}

function Format-CheddarLobbyLine {
    param($Lobby)
    $lines = @("$($Lobby.game_name) lobby #$($Lobby.id) -- $($Lobby.status)")
    foreach ($p in $Lobby.participants) {
        $crown = if ($p.is_leader) { '(leader) ' } else { '' }
        $ready = if ($p.is_ready) { 'ready' } else { 'not ready' }
        $lines += "  $crown$($p.user.display_name) (@$($p.user.username)) -- $ready"
    }
    return $lines -join "`n"
}

function Invoke-CheddarLobbyStatus {
    if (-not $Script:CurrentLobby) {
        Write-CheddarLog 'no lobby focused -- /games then /lobby create <n>, or /lobby list'
        return
    }
    Write-CheddarLog (Format-CheddarLobbyLine -Lobby $Script:CurrentLobby)
}

function Invoke-CheddarLobbyCreate {
    param([string]$IndexArg)
    if (-not $IndexArg -or $IndexArg -notmatch '^\d+$') { Write-CheddarLog 'usage: /lobby create <n>  (from /games)'; return }
    $idx = [int]$IndexArg - 1
    if ($idx -lt 0 -or $idx -ge $Script:GameCatalogCache.Count) { Write-CheddarLog 'run /games first, then /lobby create <n>'; return }
    $game = $Script:GameCatalogCache[$idx]
    $res = Invoke-CheddarApi -Method POST -Path '/api/v1/games/lobbies' -Body @{ game_key = $game.key } -Authorized
    if (-not $res.Ok) { Write-CheddarLog "could not create lobby: $(Format-CheddarApiError -Result $res)"; return }
    Set-CheddarCurrentLobby -Lobby $res.Data
    Write-CheddarLog (Format-CheddarLobbyLine -Lobby $res.Data)
}

function Invoke-CheddarLobbyInvite {
    param([string]$Username)
    if (-not $Script:CurrentLobby) { Write-CheddarLog 'no lobby focused'; return }
    if (-not $Username) { Write-CheddarLog 'usage: /lobby invite <username>'; return }
    $user = Resolve-CheddarUserId -Username $Username
    if (-not $user) { Write-CheddarLog "no user found matching `"$Username`""; return }
    $res = Invoke-CheddarApi -Method POST -Path "/api/v1/games/lobbies/$($Script:CurrentLobby.id)/invite" -Body @{ user_id = $user.id } -Authorized
    if ($res.Ok) { Set-CheddarCurrentLobby -Lobby $res.Data; Write-CheddarLog "invited @$($user.username)" }
    else { Write-CheddarLog "could not invite: $(Format-CheddarApiError -Result $res)" }
}

function Invoke-CheddarLobbyKick {
    param([string]$Username)
    if (-not $Script:CurrentLobby) { Write-CheddarLog 'no lobby focused'; return }
    if (-not $Username) { Write-CheddarLog 'usage: /lobby kick <username>'; return }
    $target = $Script:CurrentLobby.participants | Where-Object { $_.user.username.ToLower() -eq $Username.ToLower() } | Select-Object -First 1
    if (-not $target) { Write-CheddarLog "@$Username isn't in this lobby"; return }
    $res = Invoke-CheddarApi -Method POST -Path "/api/v1/games/lobbies/$($Script:CurrentLobby.id)/kick" -Body @{ user_id = $target.user.id } -Authorized
    if ($res.Ok) { Set-CheddarCurrentLobby -Lobby $res.Data; Write-CheddarLog "kicked @$Username" }
    else { Write-CheddarLog "could not kick: $(Format-CheddarApiError -Result $res)" }
}

function Invoke-CheddarLobbyLeader {
    param([string]$Username)
    if (-not $Script:CurrentLobby) { Write-CheddarLog 'no lobby focused'; return }
    if (-not $Username) { Write-CheddarLog 'usage: /lobby leader <username>'; return }
    $target = $Script:CurrentLobby.participants | Where-Object { $_.user.username.ToLower() -eq $Username.ToLower() } | Select-Object -First 1
    if (-not $target) { Write-CheddarLog "@$Username isn't in this lobby"; return }
    $res = Invoke-CheddarApi -Method POST -Path "/api/v1/games/lobbies/$($Script:CurrentLobby.id)/leader" -Body @{ user_id = $target.user.id } -Authorized
    if ($res.Ok) { Set-CheddarCurrentLobby -Lobby $res.Data; Write-CheddarLog "@$Username is now the leader" }
    else { Write-CheddarLog "could not transfer leadership: $(Format-CheddarApiError -Result $res)" }
}

function Invoke-CheddarLobbyList {
    $res = Invoke-CheddarApi -Method GET -Path '/api/v1/games/lobbies' -Authorized
    if (-not $res.Ok) { Write-CheddarLog 'not logged in'; return }
    $Script:LobbyListCache = @($res.Data)
    if ($Script:LobbyListCache.Count -eq 0) { Write-CheddarLog 'no lobbies -- /games then /lobby create <n>'; return }
    for ($i = 0; $i -lt $Script:LobbyListCache.Count; $i++) {
        $l = $Script:LobbyListCache[$i]
        Write-CheddarLog "$($i + 1)) $($l.game_name) -- $($l.status) ($($l.participants.Count) player$(if ($l.participants.Count -ne 1) { 's' }))"
    }
}

function Invoke-CheddarLobbyResume {
    param([string]$IndexArg)
    if (-not $IndexArg -or $IndexArg -notmatch '^\d+$') { Write-CheddarLog 'usage: /lobby resume <n>  (from /lobby list)'; return }
    $idx = [int]$IndexArg - 1
    if ($idx -lt 0 -or $idx -ge $Script:LobbyListCache.Count) { Write-CheddarLog 'run /lobby list first, then /lobby resume <n>'; return }
    $summary = $Script:LobbyListCache[$idx]
    $res = Invoke-CheddarApi -Method GET -Path "/api/v1/games/lobbies/$($summary.id)" -Authorized
    if (-not $res.Ok) { Write-CheddarLog 'could not open that lobby -- it may have ended'; return }
    Set-CheddarCurrentLobby -Lobby $res.Data
    Write-CheddarLog (Format-CheddarLobbyLine -Lobby $res.Data)
}

function Invoke-CheddarLobbyCode {
    if (-not $Script:CurrentLobby) { Write-CheddarLog 'no lobby focused'; return }
    if ($Script:CurrentLobby.invite_code) {
        Write-CheddarLog "invite code: $($Script:CurrentLobby.invite_code)"
        return
    }
    $res = Invoke-CheddarApi -Method POST -Path "/api/v1/games/lobbies/$($Script:CurrentLobby.id)/invite-code" -Authorized
    if ($res.Ok) { Set-CheddarCurrentLobby -Lobby $res.Data; Write-CheddarLog "invite code: $($res.Data.invite_code)" }
    else { Write-CheddarLog "could not generate a code: $(Format-CheddarApiError -Result $res)" }
}

function Invoke-CheddarLobbyJoin {
    param([string]$Code)
    if (-not $Code) { Write-CheddarLog 'usage: /lobby join <code>'; return }
    $res = Invoke-CheddarApi -Method POST -Path '/api/v1/games/lobbies/join' -Body @{ invite_code = $Code } -Authorized
    if (-not $res.Ok) { Write-CheddarLog "could not join: $(Format-CheddarApiError -Result $res)"; return }
    Set-CheddarCurrentLobby -Lobby $res.Data
    Write-CheddarLog (Format-CheddarLobbyLine -Lobby $res.Data)
}

function Invoke-CheddarLobbyReady {
    if (-not $Script:CurrentLobby) { Write-CheddarLog 'no lobby focused'; return }
    $me = $Script:CurrentLobby.participants | Where-Object { [int64]$_.user.id -eq [int64]$Script:UserId } | Select-Object -First 1
    $res = Invoke-CheddarApi -Method POST -Path "/api/v1/games/lobbies/$($Script:CurrentLobby.id)/ready" -Body @{ is_ready = -not ($me -and $me.is_ready) } -Authorized
    if ($res.Ok) { Set-CheddarCurrentLobby -Lobby $res.Data; Write-CheddarLog (Format-CheddarLobbyLine -Lobby $res.Data) }
    else { Write-CheddarLog "could not ready up: $(Format-CheddarApiError -Result $res)" }
}

function Invoke-CheddarLobbyStart {
    if (-not $Script:CurrentLobby) { Write-CheddarLog 'no lobby focused'; return }
    $res = Invoke-CheddarApi -Method POST -Path "/api/v1/games/lobbies/$($Script:CurrentLobby.id)/start" -Authorized
    if (-not $res.Ok) { Write-CheddarLog "could not start: $(Format-CheddarApiError -Result $res)"; return }
    # game.started (not this response) is what other clients treat as the
    # authoritative "it's live" signal -- it'll arrive over the socket in a
    # moment and is what actually mounts the game. This response is enough
    # to update the ready/leader display in the meantime.
    Set-CheddarCurrentLobby -Lobby $res.Data
}

function Invoke-CheddarLobbyRestart {
    if (-not $Script:CurrentLobby) { Write-CheddarLog 'no lobby focused'; return }
    $res = Invoke-CheddarApi -Method POST -Path "/api/v1/games/lobbies/$($Script:CurrentLobby.id)/restart" -Authorized
    if ($res.Ok) { Set-CheddarCurrentLobby -Lobby $res.Data; Write-CheddarLog 'back to the lobby -- /lobby ready when you are' }
    else { Write-CheddarLog "could not restart: $(Format-CheddarApiError -Result $res)" }
}

function Invoke-CheddarLobbyLeave {
    if (-not $Script:CurrentLobby) { Write-CheddarLog 'no lobby focused'; return }
    $res = Invoke-CheddarApi -Method POST -Path "/api/v1/games/lobbies/$($Script:CurrentLobby.id)/leave" -Authorized
    if (-not $res.Ok) { Write-CheddarLog "could not leave: $(Format-CheddarApiError -Result $res)"; return }
    Set-CheddarCurrentLobby -Lobby $null
    Write-CheddarLog '-- left the lobby --'
}

function Invoke-CheddarLobbyCommand {
    param([string[]]$Rest)
    if ($Rest.Count -eq 0) { Invoke-CheddarLobbyStatus; return }
    $sub = $Rest[0].ToLower()
    $subArg = if ($Rest.Count -gt 1) { ($Rest[1..($Rest.Count - 1)] -join ' ') } else { '' }
    switch ($sub) {
        'create' { Invoke-CheddarLobbyCreate -IndexArg $subArg }
        'invite' { Invoke-CheddarLobbyInvite -Username $subArg }
        'kick' { Invoke-CheddarLobbyKick -Username $subArg }
        'leader' { Invoke-CheddarLobbyLeader -Username $subArg }
        'list' { Invoke-CheddarLobbyList }
        'resume' { Invoke-CheddarLobbyResume -IndexArg $subArg }
        'code' { Invoke-CheddarLobbyCode }
        'join' { Invoke-CheddarLobbyJoin -Code $subArg }
        'ready' { Invoke-CheddarLobbyReady }
        'start' { Invoke-CheddarLobbyStart }
        'restart' { Invoke-CheddarLobbyRestart }
        'leave' { Invoke-CheddarLobbyLeave }
        default { Write-CheddarLog "unknown /lobby subcommand: $sub" }
    }
}

# -----------------------------
# Karirs — a Philippine "karera" (video horse-racing betting) style game.
# Racers are a fixed roster the Karirs API deals out itself (not the
# lobby's players), betting is anonymous (only aggregate pool totals are
# visible), and once the 30s betting window closes the server computes the
# *entire* race in one shot and ships it over Karirs' own websocket -- this
# client, like web and vscode, doesn't animate it (there's nowhere to draw
# a track in a plain REPL), it just logs the milestones: betting closes,
# racers' signature-move shouts as their speed peaks, and the result.
# -----------------------------
function Enter-CheddarKarirsGame {
    param([int64]$LobbyId)
    $Script:KarirsRace = $null
    $Script:KarirsPool = $null
    $Script:KarirsMyBet = $null
    $Script:KarirsFinishNotified = $false
    $Script:KarirsAnnouncedShouts = @{}
    $Script:KarirsLastStepIndex = -1

    $walletRes = Invoke-KarirsApi -Method GET -Path '/wallet'
    if ($walletRes.Ok) { $Script:KarirsWallet = $walletRes.Data }

    $raceRes = Invoke-KarirsApi -Method POST -Path '/races' -Body @{ lobby_id = $LobbyId }
    if (-not $raceRes.Ok) { Write-CheddarLog "could not load the race: $(Format-CheddarApiError -Result $raceRes)"; return }
    $Script:KarirsRace = $raceRes.Data
    Connect-KarirsRaceSocket -RaceId $raceRes.Data.id

    if ($raceRes.Data.status -eq 'betting_open') {
        $closesAt = ConvertTo-CheddarUtc -Value $raceRes.Data.betting_closes_at
        $secs = [Math]::Max(0, [Math]::Round(($closesAt - [DateTime]::UtcNow).TotalSeconds))
        Write-CheddarLog "🏇 Karirs -- betting closes in ${secs}s -- /race to see racers, /bet <#> <wager> to place one"
    } else {
        Write-CheddarLog '🏇 Karirs -- race already in progress, /race for status'
    }
}

function Invoke-CheddarShowRace {
    if (-not $Script:KarirsRace) { Write-CheddarLog 'no race in progress -- /lobby start once everyone is ready'; return }
    $race = $Script:KarirsRace
    $poolRes = Invoke-KarirsApi -Method GET -Path "/races/$($race.id)/pool"
    if ($poolRes.Ok) { $Script:KarirsPool = $poolRes.Data }

    if ($race.status -eq 'betting_open') {
        $closesAt = ConvertTo-CheddarUtc -Value $race.betting_closes_at
        $secs = [Math]::Max(0, [Math]::Round(($closesAt - [DateTime]::UtcNow).TotalSeconds))
        Write-CheddarLog "betting closes in ${secs}s"
    } elseif ($race.status -eq 'racing') {
        Write-CheddarLog 'racing...'
    } else {
        Write-CheddarLog "🏁 $($race.winning_name) wins!"
    }
    for ($i = 0; $i -lt $race.racer_names.Count; $i++) {
        $name = $race.racer_names[$i]
        $pool = if ($Script:KarirsPool -and $Script:KarirsPool.PSObject.Properties[$name]) { $Script:KarirsPool.$name } else { 0 }
        # Frozen the moment betting opened (see karirs' roster.compute_payout_multipliers)
        # -- a racer with a stronger overall win/loss record pays less, a longshot pays more.
        $multiplier = if ($race.payout_multipliers -and $race.payout_multipliers.PSObject.Properties[$name]) { $race.payout_multipliers.$name } else { $null }
        $odds = if ($null -ne $multiplier) { " -- {0:0.00}x payout" -f [double]$multiplier } else { '' }
        $mine = if ($Script:KarirsMyBet -and $Script:KarirsMyBet.racer_name -eq $name) { ' (your bet)' } else { '' }
        $won = if ($race.status -eq 'resolved' -and $name -eq $race.winning_name) { ' 🏆' } else { '' }
        Write-CheddarLog "$($i + 1)) $name$odds -- pool: $pool$mine$won"
    }
    if ($Script:KarirsWallet) { Write-CheddarLog "wallet: $($Script:KarirsWallet.coins) coins" }
}

function Invoke-CheddarPlaceBet {
    param([string]$IndexArg, [string]$WagerArg)
    if (-not $Script:KarirsRace) { Write-CheddarLog 'no race in progress'; return }
    if ($Script:KarirsRace.status -ne 'betting_open') { Write-CheddarLog 'betting is closed for this race'; return }
    if ($IndexArg -notmatch '^\d+$' -or $WagerArg -notmatch '^\d+$') { Write-CheddarLog 'usage: /bet <racer #> <wager>'; return }
    $idx = [int]$IndexArg - 1
    if ($idx -lt 0 -or $idx -ge $Script:KarirsRace.racer_names.Count) { Write-CheddarLog 'run /race first, then /bet <#> <wager>'; return }
    $racerName = $Script:KarirsRace.racer_names[$idx]
    $wager = [int]$WagerArg

    $res = Invoke-KarirsApi -Method POST -Path "/races/$($Script:KarirsRace.id)/bets" -Body @{ racer_name = $racerName; wager = $wager }
    if (-not $res.Ok) { Write-CheddarLog "could not place bet: $(Format-CheddarApiError -Result $res)"; return }
    $Script:KarirsMyBet = $res.Data
    Write-CheddarLog "bet placed -- check the game chat for the announcement"

    $walletRes = Invoke-KarirsApi -Method GET -Path '/wallet'
    if ($walletRes.Ok) { $Script:KarirsWallet = $walletRes.Data }
}

function Invoke-CheddarClaimDailyBonus {
    # No lobby/race context needed -- the daily bonus is per-user, not
    # per-game-session. Works whether or not a race is currently in
    # progress, reachable straight off the "/claim to redeem" chat hint.
    $res = Invoke-KarirsApi -Method POST -Path '/wallet/claim-daily'
    if (-not $res.Ok) { Write-CheddarLog "could not claim: $(Format-CheddarApiError -Result $res)"; return }
    $Script:KarirsWallet = $res.Data
    Write-CheddarLog "claimed 250 coins -- wallet: $($res.Data.coins) coins"
}

function Invoke-CheddarHallOfFame {
    # The 10 biggest wagers that ever actually won, ranked by wager size
    # (not payout) -- queryable on demand, not tied to any specific race or
    # lobby.
    $res = Invoke-KarirsApi -Method GET -Path '/hall-of-fame'
    if (-not $res.Ok) { Write-CheddarLog "could not load hall of fame: $(Format-CheddarApiError -Result $res)"; return }
    if ($res.Data.Count -eq 0) { Write-CheddarLog 'no winning bets yet'; return }
    Write-CheddarLog '🏆 Hall of Fame -- the biggest bets that ever actually won:'
    for ($i = 0; $i -lt $res.Data.Count; $i++) {
        $entry = $res.Data[$i]
        Write-CheddarLog "  #$($i + 1) $($entry.display_name) bet $($entry.wager) on $($entry.racer_name) -- +$($entry.payout)"
    }
}

# -----------------------------
# Cheddar WebSocket — single-threaded, non-blocking poll (started/consumed
# from Receive-CheddarWsEvents each REPL tick) so it can share the socket
# with synchronous sends from the same thread without any runspace/job.
# -----------------------------
function Connect-CheddarSocket {
    if (-not $Script:AccessToken) { return }
    Disconnect-CheddarSocket

    $wsBase = $Script:q7f3k -replace '^http', 'ws'
    $url = "$wsBase/api/v1/ws?token=$([uri]::EscapeDataString($Script:AccessToken))&api_key=$([uri]::EscapeDataString($Script:z8n4t))"

    $Script:WsClient = New-Object System.Net.WebSockets.ClientWebSocket
    try {
        $Script:WsClient.ConnectAsync([uri]$url, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
    } catch {
        $Script:WsClient = $null
    }
}

function Disconnect-CheddarSocket {
    if ($Script:WsClient) {
        try {
            if ($Script:WsClient.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
                $Script:WsClient.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, '', [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
            }
        } catch {}
        $Script:WsClient.Dispose()
    }
    $Script:WsClient = $null
    $Script:WsReceiveTask = $null
    $Script:WsReceiveAccum = $null
}

function Send-CheddarWsEvent {
    param([string]$Type, $Data)
    if (-not $Script:WsClient -or $Script:WsClient.State -ne [System.Net.WebSockets.WebSocketState]::Open) { return }
    $payload = @{ type = $Type; data = $Data } | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $segment = New-Object System.ArraySegment[byte] (, $bytes)
    $Script:WsClient.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
}

function Receive-CheddarWsEvents {
    if (-not $Script:WsClient -or $Script:WsClient.State -ne [System.Net.WebSockets.WebSocketState]::Open) { return }

    if (-not $Script:WsReceiveTask) {
        $segment = New-Object System.ArraySegment[byte] (, $Script:WsReceiveBuffer)
        $Script:WsReceiveTask = $Script:WsClient.ReceiveAsync($segment, [System.Threading.CancellationToken]::None)
        $Script:WsReceiveAccum = New-Object System.Text.StringBuilder
    }

    if (-not $Script:WsReceiveTask.IsCompleted) { return }

    try {
        $result = $Script:WsReceiveTask.GetAwaiter().GetResult()
    } catch {
        Disconnect-CheddarSocket
        return
    }

    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
        Disconnect-CheddarSocket
        return
    }

    [void]$Script:WsReceiveAccum.Append([System.Text.Encoding]::UTF8.GetString($Script:WsReceiveBuffer, 0, $result.Count))

    if ($result.EndOfMessage) {
        $text = $Script:WsReceiveAccum.ToString()
        $Script:WsReceiveAccum = $null
        $Script:WsReceiveTask = $null
        Handle-CheddarWsMessage -Text $text
    } else {
        $segment = New-Object System.ArraySegment[byte] (, $Script:WsReceiveBuffer)
        $Script:WsReceiveTask = $Script:WsClient.ReceiveAsync($segment, [System.Threading.CancellationToken]::None)
    }
}

function Handle-CheddarWsMessage {
    param([string]$Text)
    try { $event = $Text | ConvertFrom-Json } catch { return }

    if ($event.type -eq 'message.new') {
        $m = $event.data
        $senderId = [int64]$m.sender_id
        if ($Script:ActiveConversationId -and ([int64]$m.conversation_id -eq [int64]$Script:ActiveConversationId)) {
            Write-CheddarMessage -Message $m
            if ($senderId -ne [int64]$Script:UserId) {
                Send-CheddarWsEvent -Type 'message.read' -Data @{ conversation_id = $m.conversation_id; message_id = $m.id }
            }
        } elseif ($senderId -ne [int64]$Script:UserId) {
            Write-CheddarLog '-- new message, /chats to see --'
        }
    } elseif ($event.type -eq 'lobby.updated') {
        $lobby = $event.data
        $wasMine = $Script:CurrentLobby -and ([int64]$Script:CurrentLobby.id -eq [int64]$lobby.id)
        $amStillIn = @($lobby.participants | Where-Object { [int64]$_.user.id -eq [int64]$Script:UserId }).Count -gt 0
        if ($wasMine -or $amStillIn) {
            Set-CheddarCurrentLobby -Lobby $(if ($amStillIn) { $lobby } else { $null })
        }
    } elseif ($event.type -eq 'lobby.invited') {
        Write-CheddarLog "-- invited to a $($event.data.game_name) lobby -- /lobby list to see it --"
    } elseif ($event.type -eq 'lobby.kicked') {
        if ($Script:CurrentLobby -and ([int64]$Script:CurrentLobby.id -eq [int64]$event.data.lobby_id)) {
            Set-CheddarCurrentLobby -Lobby $null
            Write-CheddarLog '-- you were removed from the lobby --'
        }
    } elseif ($event.type -eq 'game.started') {
        # start_lobby only broadcasts message.new/game.started, not
        # lobby.updated -- reflect the status change locally, same as
        # web/vscode have to.
        if ($Script:CurrentLobby -and ([int64]$Script:CurrentLobby.id -eq [int64]$event.data.lobby_id)) {
            $Script:CurrentLobby.status = 'in_progress'
            Write-CheddarLog "🎮 $($event.data.game_name) has started!"
            if ($event.data.game_key -eq 'karirs') {
                Enter-CheddarKarirsGame -LobbyId $event.data.lobby_id
            }
        }
    } elseif ($event.type -eq 'error') {
        Write-CheddarLog "error: $($event.data.message)"
    }
}

# -----------------------------
# Karirs race socket — separate from the Cheddar chat socket above (it's a
# different service), polled the same non-blocking way from the same REPL
# loop. Carries at most two messages over a race's life: the whole
# precomputed "steps" payload the instant betting closes, then the final
# "resolved" result.
# -----------------------------
function Connect-KarirsRaceSocket {
    param([int64]$RaceId)
    if ($Script:KarirsRaceId -eq $RaceId -and $Script:KarirsWsClient) { return }
    Disconnect-KarirsRaceSocket

    $wsBase = $Script:v5h8r -replace '^http', 'ws'
    $url = "$wsBase/races/$RaceId/ws?token=$([uri]::EscapeDataString($Script:AccessToken))"

    $Script:KarirsWsClient = New-Object System.Net.WebSockets.ClientWebSocket
    try {
        $Script:KarirsWsClient.ConnectAsync([uri]$url, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
        $Script:KarirsRaceId = $RaceId
    } catch {
        $Script:KarirsWsClient = $null
        $Script:KarirsRaceId = $null
    }
}

function Disconnect-KarirsRaceSocket {
    if ($Script:KarirsWsClient) {
        try {
            if ($Script:KarirsWsClient.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
                $Script:KarirsWsClient.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, '', [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
            }
        } catch {}
        $Script:KarirsWsClient.Dispose()
    }
    $Script:KarirsWsClient = $null
    $Script:KarirsWsReceiveTask = $null
    $Script:KarirsWsReceiveAccum = $null
    $Script:KarirsRaceId = $null
}

function Receive-KarirsWsEvents {
    if (-not $Script:KarirsWsClient -or $Script:KarirsWsClient.State -ne [System.Net.WebSockets.WebSocketState]::Open) { return }

    if (-not $Script:KarirsWsReceiveTask) {
        $segment = New-Object System.ArraySegment[byte] (, $Script:KarirsWsReceiveBuffer)
        $Script:KarirsWsReceiveTask = $Script:KarirsWsClient.ReceiveAsync($segment, [System.Threading.CancellationToken]::None)
        $Script:KarirsWsReceiveAccum = New-Object System.Text.StringBuilder
    }

    if (-not $Script:KarirsWsReceiveTask.IsCompleted) { return }

    try {
        $result = $Script:KarirsWsReceiveTask.GetAwaiter().GetResult()
    } catch {
        Disconnect-KarirsRaceSocket
        return
    }

    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
        Disconnect-KarirsRaceSocket
        return
    }

    [void]$Script:KarirsWsReceiveAccum.Append([System.Text.Encoding]::UTF8.GetString($Script:KarirsWsReceiveBuffer, 0, $result.Count))

    if ($result.EndOfMessage) {
        $text = $Script:KarirsWsReceiveAccum.ToString()
        $Script:KarirsWsReceiveAccum = $null
        $Script:KarirsWsReceiveTask = $null
        Handle-KarirsWsMessage -Text $text
    } else {
        $segment = New-Object System.ArraySegment[byte] (, $Script:KarirsWsReceiveBuffer)
        $Script:KarirsWsReceiveTask = $Script:KarirsWsClient.ReceiveAsync($segment, [System.Threading.CancellationToken]::None)
    }
}

function Handle-KarirsWsMessage {
    param([string]$Text)
    try { $event = $Text | ConvertFrom-Json } catch { return }

    if ($event.type -eq 'steps') {
        if ($Script:KarirsRace) {
            $Script:KarirsRace.status = 'racing'
            $Script:KarirsRace | Add-Member -MemberType NoteProperty -Name 'steps' -Value $event.steps -Force
        }
        Write-CheddarLog "they're off! (/race for status)"
    } elseif ($event.type -eq 'resolved') {
        $Script:KarirsRace = $event.race
        $Script:KarirsPool = $event.pool
        # Fetched directly here (not left to any poll-based heuristic) --
        # this message is the one signal guaranteed to fire exactly once,
        # right when the race resolves. See the payout-refetch fix applied
        # to web/vscode for exactly why a status-transition heuristic isn't
        # reliable here.
        $betRes = Invoke-KarirsApi -Method GET -Path "/races/$($event.race.id)/bets"
        if ($betRes.Ok -and @($betRes.Data).Count -gt 0) { $Script:KarirsMyBet = @($betRes.Data)[0] }
        $walletRes = Invoke-KarirsApi -Method GET -Path '/wallet'
        if ($walletRes.Ok) { $Script:KarirsWallet = $walletRes.Data }

        Write-CheddarLog "🏁 $($event.race.winning_name) wins!"
        if ($Script:KarirsMyBet) {
            if ($Script:KarirsMyBet.payout -and $Script:KarirsMyBet.payout -gt 0) {
                Write-CheddarLog "you bet on $($Script:KarirsMyBet.racer_name) and won $($Script:KarirsMyBet.payout) coins!"
            } else {
                Write-CheddarLog "you bet $($Script:KarirsMyBet.wager) on $($Script:KarirsMyBet.racer_name) -- no payout this time."
            }
        }
        if (-not $Script:KarirsFinishNotified) {
            $Script:KarirsFinishNotified = $true
            if ($Script:CurrentLobby) {
                Invoke-CheddarApi -Method POST -Path "/api/v1/games/lobbies/$($Script:CurrentLobby.id)/finish" -Authorized | Out-Null
            }
        }
    }
}

# Checks whether elapsed real time has crossed into a step whose
# "shouting" list contains a racer we haven't already announced this race
# -- same idea as web/vscode's computePlayback, but there's nothing to draw
# here, only a line to log once per racer per race.
function Test-KarirsShoutTick {
    if (-not $Script:KarirsRace -or $Script:KarirsRace.status -ne 'racing' -or -not $Script:KarirsRace.steps) { return }
    $anchor = ConvertTo-CheddarUtc -Value $Script:KarirsRace.betting_closes_at
    $elapsedMs = ([DateTime]::UtcNow - $anchor).TotalMilliseconds
    if ($elapsedMs -lt 0) { return }
    $idx = [Math]::Min([int][Math]::Floor($elapsedMs / 300), $Script:KarirsRace.steps.Count - 1)
    if ($idx -le $Script:KarirsLastStepIndex) { return }

    for ($i = $Script:KarirsLastStepIndex + 1; $i -le $idx; $i++) {
        $step = $Script:KarirsRace.steps[$i]
        foreach ($name in @($step.shouting)) {
            if (-not $Script:KarirsAnnouncedShouts.ContainsKey($name)) {
                $Script:KarirsAnnouncedShouts[$name] = $true
                $move = if ($Script:KarirsRace.signature_moves.PSObject.Properties[$name]) { $Script:KarirsRace.signature_moves.$name } else { "$name's Signature Move!" }
                Write-CheddarLog "💬 $name shouts: $move"
            }
        }
    }
    $Script:KarirsLastStepIndex = $idx
}

# -----------------------------
# REPL — a single-threaded loop polling both the WebSocket and the keyboard,
# so nothing blocks either side. This is a plain console app, no extra
# terminal chrome, on purpose.
# -----------------------------
function Start-CheddarRepl {
    # Only draw the initial prompt if nothing has logged yet. Startup always
    # calls Write-CheddarLog at least once (the startup update check or the
    # session-restore status) before this runs, and that call already redraws
    # its own trailing "$ " -- printing another one here unconditionally is
    # what produced "$ $ " on first launch.
    if ($Script:LogCallCount -eq 0) {
        Write-Host "$ " -NoNewline
    }
    while (-not $Script:ShouldExit) {
        Receive-CheddarWsEvents
        Receive-KarirsWsEvents
        Test-KarirsShoutTick

        if ([Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            if ($key.Key -eq 'Enter') {
                Write-Host ''
                $line = $Script:InputBuffer
                $Script:InputBuffer = ''
                $countBefore = $Script:LogCallCount
                Invoke-CheddarInput -Text $line
                # Write-CheddarLog already redraws the prompt itself, and it
                # may fire more than once (or asynchronously, mid-command) —
                # only draw one here if nothing else did, to avoid "$ $ ".
                if ($Script:LogCallCount -eq $countBefore) {
                    Write-Host "$ " -NoNewline
                }
            } elseif ($key.Key -eq 'Backspace') {
                if ($Script:InputBuffer.Length -gt 0) {
                    $Script:InputBuffer = $Script:InputBuffer.Substring(0, $Script:InputBuffer.Length - 1)
                    Write-Host "`b `b" -NoNewline
                }
            } elseif ($key.KeyChar -and -not [char]::IsControl($key.KeyChar)) {
                $Script:InputBuffer += $key.KeyChar
                Write-Host $key.KeyChar -NoNewline
            }
        } else {
            Start-Sleep -Milliseconds 30
        }
    }
}

try {
    Test-CheddarStartupUpdate
    Restore-CheddarSession
    Start-CheddarRepl
} catch {
    Write-Host ''
    Write-Host "fatal: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Disconnect-CheddarSocket
    Disconnect-KarirsRaceSocket
}
