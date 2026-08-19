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
        'update' { Invoke-CheddarUpdate }
        'exit' {
            # Just closes this session -- the stored access/refresh tokens
            # are left alone, unlike /logout which revokes them server-side.
            Write-CheddarLog 'bye'
            $Script:ShouldExit = $true
        }
        'help' { Write-CheddarLog 'commands: /login /signup /logout /whoami /friends /requests /add /accept /decline /chats /open /update /exit' }
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
    } elseif ($event.type -eq 'error') {
        Write-CheddarLog "error: $($event.data.message)"
    }
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
}
