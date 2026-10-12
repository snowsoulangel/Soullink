# Fuegt die Szene "Soul Link" (aus make-obs-scene.ps1) in eine bestehende OBS-Szenensammlung ein.
# OBS muss geschlossen sein. Vorher wird eine Sicherungskopie angelegt.
#
#   powershell -ExecutionPolicy Bypass -File merge-obs-scene.ps1 -Scene Soul_Link_OBS.json -Target "%APPDATA%\obs-studio\basic\scenes\Die_heftige_Szene.json"
param(
  [Parameter(Mandatory = $true)][string]$Scene,
  [Parameter(Mandatory = $true)][string]$Target
)
$ErrorActionPreference = 'Stop'
if (Get-Process obs64 -ErrorAction SilentlyContinue) { throw "OBS laeuft noch. Bitte erst OBS schliessen." }

$backup = "$Target.vor-soullink-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
Copy-Item $Target $backup

# ConvertFrom-Json in PowerShell 5.1 kennt kein -AsHashtable; die Sammlung wird als
# Objekt bearbeitet und mit grosser Tiefe wieder geschrieben.
# (PowerShell variable names ignore case: don't call this $target, that is the path parameter)
$coll = [IO.File]::ReadAllText($Target, [Text.Encoding]::UTF8) | ConvertFrom-Json
$add = [IO.File]::ReadAllText((Resolve-Path $Scene), [Text.Encoding]::UTF8) | ConvertFrom-Json

$newNames = @($add.sources | ForEach-Object { $_.name })
$taken = @($coll.sources | ForEach-Object { $_.name })
$clash = @($newNames | Where-Object { $taken -contains $_ })
if ($clash.Count) { throw "Diese Namen gibt es in der Sammlung schon: $($clash -join ', '). Nichts geaendert." }

$coll.sources = @($coll.sources) + @($add.sources)
$coll.scene_order = @($coll.scene_order) + @([pscustomobject]@{ name = 'Soul Link' })

$json = $coll | ConvertTo-Json -Depth 64
[IO.File]::WriteAllText($Target, $json, (New-Object Text.UTF8Encoding($false)))
"OK: Szene 'Soul Link' eingefuegt. Sicherung: $backup"
