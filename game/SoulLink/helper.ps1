# Soul Link Tracker - Hilfsprogramm
# Schickt die Datei state.json (geschrieben von der Mod im Spiel) an den Server.
# Start ueber start.bat - einfach waehrend des Spielens offen lassen.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Host.UI.RawUI.WindowTitle = 'Soul Link Tracker'

$root = $PSScriptRoot
$configPath = Join-Path $root 'config.txt'
$statePath = Join-Path $root 'state.json'
$errorPath = Join-Path $root 'error.log'

function Write-Status($text, $color = 'Gray') {
    Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $text) -ForegroundColor $color
}

function Read-Config {
    $cfg = @{}
    if (-not (Test-Path $configPath)) { return $cfg }
    foreach ($line in [IO.File]::ReadAllLines($configPath, [Text.Encoding]::UTF8)) {
        $line = $line.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $i = $line.IndexOf('=')
        if ($i -lt 1) { continue }
        $cfg[$line.Substring(0, $i).Trim().ToUpper()] = $line.Substring($i + 1).Trim()
    }
    return $cfg
}

$cfg = Read-Config
foreach ($k in 'SERVER', 'ROOM', 'PLAYER', 'KEY') {
    if (-not $cfg[$k] -or $cfg[$k] -like '*HIER*') {
        Write-Status "config.txt ist unvollstaendig: $k fehlt." 'Red'
        Write-Status 'Kopiere deinen Block von der Run-Seite in config.txt und starte neu.' 'Yellow'
        exit 1
    }
}

$server = $cfg['SERVER'].TrimEnd('/')
$base = "$server/api/rooms/$($cfg['ROOM'])"
$headers = @{ 'X-Player' = $cfg['PLAYER']; 'X-Key' = $cfg['KEY'] }

Write-Host ''
Write-Host '  Soul Link Tracker' -ForegroundColor Magenta
Write-Host "  Server:  $server"
Write-Host "  Run:     $($cfg['ROOM'])   Spieler: $($cfg['PLAYER'])"
Write-Host "  Run-Seite: $server/?room=$($cfg['ROOM'])"
Write-Host '  Fenster offen lassen, solange ihr spielt. Beenden mit Strg+C.'
Write-Host ''

$spriteDir = Join-Path $root 'sprites'
$uploaded = @{}
$spritesChecked = $false
$spriteWarned = $false

# Laedt neue Sprite-Bilder (von der Mod in SoulLink\sprites gespeichert) hoch.
# Fehler hier halten das Senden des Spielstands nicht auf.
function Send-Sprites {
    try { Send-SpritesCore } catch {
        if (-not $script:spriteWarned) {
            Write-Status "Sprites konnten nicht hochgeladen werden: $($_.Exception.Message)" 'Yellow'
            $script:spriteWarned = $true
        }
    }
}

function Send-SpritesCore {
    if (-not (Test-Path $spriteDir)) { return }
    if (-not $script:spritesChecked) {
        $known = Invoke-RestMethod -Uri "$base/sprites" -Method Get -TimeoutSec 20
        foreach ($k in @($known.keys)) { $script:uploaded[$k] = $true }
        $script:spritesChecked = $true
    }
    foreach ($file in Get-ChildItem $spriteDir -Filter '*.png') {
        $key = $file.BaseName
        if ($key -notmatch '^[A-Za-z0-9-]{1,80}$' -or $script:uploaded[$key]) { continue }
        $bytes = [IO.File]::ReadAllBytes($file.FullName)
        Invoke-RestMethod -Uri "$base/sprite?key=$key" -Method Post -Headers $headers -Body $bytes `
            -ContentType 'image/png' -TimeoutSec 20 | Out-Null
        $script:uploaded[$key] = $true
        Write-Status "Sprite hochgeladen: $key" 'DarkGray'
    }
}

$lastSent = $null
$lastWrite = [DateTime]::MinValue
$lastPing = [DateTime]::MinValue
$waitingShown = $false
$errorShown = $false
$failures = 0

while ($true) {
    try {
        if (Test-Path $errorPath) {
            if (-not $errorShown) {
                Write-Status 'Die Mod hat einen Fehler gemeldet (SoulLink\error.log). Bitte die Datei weitergeben.' 'Yellow'
                $errorShown = $true
            }
        }
        if (Test-Path $statePath) {
            $waitingShown = $false
            $info = Get-Item $statePath
            if ($info.LastWriteTimeUtc -ne $lastWrite) {
                $text = [IO.File]::ReadAllText($statePath, [Text.Encoding]::UTF8)
                if ($text -ne $lastSent) {
                    Send-Sprites
                    $body = [Text.Encoding]::UTF8.GetBytes($text)
                    Invoke-RestMethod -Uri "$base/update" -Method Post -Headers $headers -Body $body `
                        -ContentType 'application/json; charset=utf-8' -TimeoutSec 20 | Out-Null
                    $state = $text | ConvertFrom-Json
                    $party = @($state.party).Count
                    $boxes = @($state.boxes).Count
                    $color = 'Green'
                    if ($state.in_battle) { $color = 'Cyan' }
                    Write-Status ("gesendet: {0} im Team, {1} im PC, {2}" -f $party, $boxes, $state.map) $color
                    $lastSent = $text
                    $lastPing = Get-Date
                }
                $lastWrite = $info.LastWriteTimeUtc
            }
        } elseif (-not $waitingShown) {
            Write-Status 'Warte auf das Spiel ... (Spielstand laden, dann erscheint state.json)' 'Yellow'
            $waitingShown = $true
        }
        if (((Get-Date) - $lastPing).TotalSeconds -ge 60) {
            Invoke-RestMethod -Uri "$base/ping" -Method Post -Headers $headers -Body '{}' `
                -ContentType 'application/json' -TimeoutSec 20 | Out-Null
            $lastPing = Get-Date
        }
        if ($failures -gt 0) { Write-Status 'Verbindung wieder da.' 'Green' }
        $failures = 0
        Start-Sleep -Milliseconds 700
    } catch [System.IO.IOException] {
        Start-Sleep -Milliseconds 200   # Datei wird gerade geschrieben
    } catch {
        $failures++
        $msg = $_.Exception.Message
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 403) {
            Write-Status 'Server sagt: falscher Schluessel oder Spieler. Bitte config.txt pruefen.' 'Red'
        } else {
            Write-Status "Fehler: $msg" 'Red'
        }
        $lastWrite = [DateTime]::MinValue
        Start-Sleep -Seconds ([Math]::Min(30, 2 * $failures))
    }
}
