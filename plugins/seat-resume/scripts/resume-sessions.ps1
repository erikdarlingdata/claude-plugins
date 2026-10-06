# Lists the interactive Claude Code sessions that died or were interrupted, and reopens them on request.
# The seat-resume plugin writes <registry>\<session id>.json for every interactive session.
# A session counts as running when Claude Code's own <sessions>\<pid>.json names it and that pid is a live
# process that started when the file says. One that exited on purpose (/exit, ctrl+c, /clear) is skipped.
#
#   pwsh -File resume-sessions.ps1                         # list them, newest first
#   pwsh -File resume-sessions.ps1 -Launch                 # reopen each in a WezTerm tab
#   pwsh -File resume-sessions.ps1 -Launch -Terminal windows-terminal
#
# Windows only: it reads the process start time as a Windows FILETIME to tell a live session from a reused pid.
param(
    [switch]$Launch,
    [int]$MaxAgeHours = 72,
    [int]$PruneDays = 14,
    [string]$Registry,
    [string]$Sessions,
    [ValidateSet('wezterm', 'windows-terminal')]
    [string]$Terminal = 'wezterm'
)

$ErrorActionPreference = 'Stop'
$now = [DateTime]::UtcNow

# Same defaults as the plugin: the Claude config folder, CLAUDE_CONFIG_DIR when set.
$config = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
if (-not $Registry) { $Registry = Join-Path $config 'session-registry' }
if (-not $Sessions) { $Sessions = Join-Path $config 'sessions' }

function Test-LivePid([int]$ProcessId, $ProcStart) {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    if (-not $ProcStart) { return $true }
    try {
        # procStart is the process's start as a Windows FILETIME; a reused pid after a reboot starts at another time.
        return [Math]::Abs($p.StartTime.ToFileTimeUtc() - [int64]$ProcStart) -lt 20000000
    } catch {
        return $true
    }
}

$live = @{}
if (Test-Path -LiteralPath $Sessions) {
    foreach ($f in Get-ChildItem -LiteralPath $Sessions -Filter '*.json' -File) {
        try { $s = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json } catch { continue }
        if ($s.sessionId -and $s.pid -and (Test-LivePid $s.pid $s.procStart)) { $live[[string]$s.sessionId] = $true }
    }
}

$found = @()
if (Test-Path -LiteralPath $Registry) {
    foreach ($f in Get-ChildItem -LiteralPath $Registry -Filter '*.json' -File) {
        if ($f.LastWriteTimeUtc -lt $now.AddDays(-$PruneDays)) { Remove-Item -LiteralPath $f.FullName -Confirm:$false; continue }
        try { $e = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json } catch { continue }
        if (-not $e.sessionId -or $e.ended -eq 'exited' -or $live.ContainsKey([string]$e.sessionId)) { continue }
        # ConvertFrom-Json already turns an ISO string into a DateTime; a string is parsed as UTC.
        $last = if ($e.lastActive -is [DateTime]) { $e.lastActive } else {
            [DateTime]::Parse([string]$e.lastActive, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        }
        $last = if ($last.Kind -eq [DateTimeKind]::Unspecified) { [DateTime]::SpecifyKind($last, [DateTimeKind]::Utc) } else { $last.ToUniversalTime() }
        if ($last -lt $now.AddHours(-$MaxAgeHours)) { continue }
        $found += [pscustomobject]@{ Entry = $e; Last = $last }
    }
}

if ($found.Count -eq 0) {
    'No interrupted sessions in the last {0} hours.' -f $MaxAgeHours
    return
}

$found = $found | Sort-Object Last -Descending
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { $claude = 'claude' }

function Get-ResumeArgs($e) {
    $a = @('--resume', [string]$e.sessionId)
    if ($e.permissionMode -and $e.permissionMode -ne 'default') { $a += @('--permission-mode', [string]$e.permissionMode) }
    return $a
}

'{0} interrupted session(s), newest first:' -f $found.Count
foreach ($one in $found) {
    $e = $one.Entry
    $state = if ($e.ended -eq 'interrupted') { 'interrupted' } else { 'died' }
    $label = if ($e.name) { $e.name } else { '(no name)' }
    '{0:yyyy-MM-dd HH:mm}Z  {1,-11}  {2}  {3}' -f $one.Last, $state, $label, $e.cwd
    '    cd "{0}"; claude {1}' -f $e.cwd, ((Get-ResumeArgs $e) -join ' ')
}

if (-not $Launch) {
    $name = if ($Terminal -eq 'wezterm') { 'WezTerm' } else { 'Windows Terminal' }
    'Reopen them all in {0} tabs: pwsh -File "{1}" -Launch -Terminal {2}' -f $name, $PSCommandPath, $Terminal
    return
}

if ($Terminal -eq 'wezterm') {
    $wez = (Get-Command wezterm -ErrorAction SilentlyContinue).Source
    if (-not $wez) { throw 'wezterm is not on PATH; reopen each session with its line above.' }
} else {
    $wt = (Get-Command wt -ErrorAction SilentlyContinue).Source
    if (-not $wt) { throw 'wt (Windows Terminal) is not on PATH; reopen each session with its line above.' }
}
foreach ($one in $found) {
    $e = $one.Entry
    $cmd = @($claude) + (Get-ResumeArgs $e)
    if ($Terminal -eq 'wezterm') {
        if ($env:WEZTERM_PANE) {
            & $wez cli spawn --cwd $e.cwd -- @cmd | Out-Null
        } else {
            Start-Process -FilePath $wez -ArgumentList (@('start', '--cwd', $e.cwd, '--') + $cmd)
        }
    } else {
        # -w 0 opens a tab in the newest Windows Terminal window; Start-Process quotes each argument for us.
        Start-Process -FilePath $wt -ArgumentList (@('-w', '0', 'new-tab', '-d', $e.cwd, '--') + $cmd)
    }
    'Reopened {0} in {1}' -f $(if ($e.name) { $e.name } else { $e.sessionId }), $e.cwd
}
