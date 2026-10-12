# Fuegt Hintergrund und Rahmen (frame.html) in die bestehende Szene "Soul Link" einer
# OBS-Szenensammlung ein: Hintergrund ganz unten, Rahmen ganz oben.
# OBS muss geschlossen sein; vorher Sicherungskopie.
#
#   powershell -ExecutionPolicy Bypass -File add-obs-frame.ps1 -Room <raumcode> -Target "%APPDATA%\obs-studio\basic\scenes\Die_heftige_Szene.json"
param(
  [Parameter(Mandatory = $true)][string]$Room,
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Server = "https://soullink.kf64my4r9w.workers.dev",
  [string]$SceneName = "Soul Link",
  [switch]$DryRunCopy   # only for testing on a copy of the file: skips the "OBS is running" check
)
$ErrorActionPreference = 'Stop'
if (!$DryRunCopy -and (Get-Process obs64 -ErrorAction SilentlyContinue)) { throw "OBS laeuft noch. Bitte erst OBS schliessen." }

$coll = [IO.File]::ReadAllText($Target, [Text.Encoding]::UTF8) | ConvertFrom-Json
$scene = $coll.sources | Where-Object { $_.id -eq 'scene' -and $_.name -eq $SceneName } | Select-Object -First 1
if (!$scene) { throw "Szene '$SceneName' nicht gefunden. Nichts geaendert." }
foreach ($n in 'SL Hintergrund', 'SL Rahmen') {
  if ($coll.sources | Where-Object { $_.name -eq $n }) { throw "Quelle '$n' gibt es schon. Nichts geaendert." }
}

$backup = "$Target.vor-rahmen-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
Copy-Item $Target $backup

function NewBrowser($name, $url) {
  [pscustomobject][ordered]@{
    prev_ver = 536870916; name = $name; uuid = [guid]::NewGuid().ToString(); id = 'browser_source'; versioned_id = 'browser_source'
    settings = [pscustomobject]@{ url = $url; width = 1920; height = 1080; reroute_audio = $false; shutdown = $false; restart_when_active = $false; css = '' }
    mixers = 0; sync = 0; flags = 0; volume = 1.0; balance = 0.5; enabled = $true; muted = $false
    'push-to-mute' = $false; 'push-to-mute-delay' = 0; 'push-to-talk' = $false; 'push-to-talk-delay' = 0
    hotkeys = [pscustomobject]@{}; deinterlace_mode = 0; deinterlace_field_order = 0; monitoring_type = 0; private_settings = [pscustomobject]@{}
  }
}
$counter = [int]$scene.settings.id_counter
function NewItem($src) {
  $script:counter++
  [pscustomobject][ordered]@{
    name = $src.name; source_uuid = $src.uuid; visible = $true; locked = $true; rot = 0.0
    pos = [pscustomobject]@{ x = 0.0; y = 0.0 }; scale = [pscustomobject]@{ x = 1.0; y = 1.0 }; align = 5
    bounds_type = 0; bounds_align = 0; bounds_crop = $false; bounds = [pscustomobject]@{ x = 0.0; y = 0.0 }
    crop_left = 0; crop_top = 0; crop_right = 0; crop_bottom = 0; id = $script:counter; group_item_backup = $false
    scale_filter = 'disable'; blend_method = 'default'; blend_type = 'normal'
    show_transition = [pscustomobject]@{ duration = 0 }; hide_transition = [pscustomobject]@{ duration = 0 }; private_settings = [pscustomobject]@{}
  }
}
$base = "$Server/frame.html?room=$Room"
$bg = NewBrowser 'SL Hintergrund' "$base&layer=bg"
$fr = NewBrowser 'SL Rahmen' "$base&layer=frame"
$bgItem = NewItem $bg
$frItem = NewItem $fr

# items: first = bottom. Frame goes right below the first "SL ..." overlay.
# The frame goes on top of everything: a camera placed above the overlays would
# otherwise cover the facecam frame. The frame itself does not cover any overlay.
$new = @($bgItem) + @($scene.settings.items) + @($frItem)
$scene.settings.items = $new
$scene.settings.id_counter = $counter
$coll.sources = @($coll.sources) + @($bg, $fr)

[IO.File]::WriteAllText($Target, ($coll | ConvertTo-Json -Depth 64), (New-Object Text.UTF8Encoding($false)))
"OK: Hintergrund + Rahmen in '$SceneName' eingefuegt. Reihenfolge (unten -> oben): " + (($new | ForEach-Object { $_.name }) -join ' | ')
"Sicherung: $backup"
