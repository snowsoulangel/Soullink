# Erzeugt eine OBS-Szenensammlung "Soul Link" (1920x1080) mit allen Overlays an den
# richtigen Positionen und Platzhaltern fuer Gameplay und Facecams.
# Import in OBS: Szenensammlung -> Importieren -> Datei waehlen.
#
#   powershell -ExecutionPolicy Bypass -File make-obs-scene.ps1 -Room <raumcode> [-Out Soul_Link_OBS.json]
param(
  [Parameter(Mandatory = $true)][string]$Room,
  [string]$Server = "https://soullink.kf64my4r9w.workers.dev",
  [string]$Out = "Soul_Link_OBS.json"
)
$ErrorActionPreference = 'Stop'
$base = "$Server/overlay.html?room=$Room"
$canvas = "6c69626f-6273-4c00-9d88-c5136d61696e"   # OBS main canvas

function NewSource($name, $id, $settings) {
  [ordered]@{
    prev_ver = 536870916; name = $name; uuid = [guid]::NewGuid().ToString(); id = $id; versioned_id = $id
    settings = $settings; mixers = 0; sync = 0; flags = 0; volume = 1.0; balance = 0.5; enabled = $true; muted = $false
    'push-to-mute' = $false; 'push-to-mute-delay' = 0; 'push-to-talk' = $false; 'push-to-talk-delay' = 0
    hotkeys = @{}; deinterlace_mode = 0; deinterlace_field_order = 0; monitoring_type = 0; private_settings = @{}
  }
}
function Browser($name, $url, $w, $h) {
  NewSource $name 'browser_source' ([ordered]@{ url = $url; width = $w; height = $h; reroute_audio = $false; shutdown = $false; restart_when_active = $false; css = '' })
}
# semi-transparent box (ABGR) as a placeholder to be replaced by the real capture
function Placeholder($name, $w, $h, $color) {
  NewSource $name 'color_source_v3' ([ordered]@{ color = $color; width = $w; height = $h })
}

# order = drawing order (first is at the bottom)
$frame = "$Server/frame.html?room=$Room"
$layout = @(
  @{ src = (Browser 'SL Hintergrund' "$frame&layer=bg" 1920 1080); x = 0; y = 0 },
  @{ src = (Placeholder 'Platzhalter Gameplay Tim'   800 600 2150640160); x = 16;   y = 16 },
  @{ src = (Placeholder 'Platzhalter Gameplay Artur' 800 600 2150640160); x = 1104; y = 16 },
  @{ src = (Placeholder 'Platzhalter Facecam Tim'    256 192 2152741440); x = 832;  y = 16 },
  @{ src = (Placeholder 'Platzhalter Facecam Artur'  256 192 2152741440); x = 832;  y = 220 },
  @{ src = (Browser 'SL Kill-Counter' "$base&view=deaths&stack=1&scale=0.95" 250 205); x = 840; y = 420 },
  @{ src = (Browser 'SL Team Tim'   "$base&player=1&layout=strip&scale=0.9" 950 235); x = 8;   y = 628 },
  @{ src = (Browser 'SL Team Artur' "$base&player=2&layout=strip&scale=0.9" 950 235); x = 962; y = 628 },
  @{ src = (Browser 'SL Friedhof'   "$base&view=grave&compact=1" 950 200); x = 8;   y = 872 },
  @{ src = (Browser 'SL Box'        "$base&view=box&compact=1"   950 200); x = 962; y = 872 },
  @{ src = (Browser 'SL Rahmen' "$frame&layer=frame" 1920 1080); x = 0; y = 0 }   # on top: cams must not cover it
)

$items = @(); $i = 0
foreach ($l in $layout) {
  $i++
  $items += [ordered]@{
    name = $l.src.name; source_uuid = $l.src.uuid; visible = $true; locked = $false; rot = 0.0
    pos = @{ x = [double]$l.x; y = [double]$l.y }; scale = @{ x = 1.0; y = 1.0 }; align = 5
    bounds_type = 0; bounds_align = 0; bounds_crop = $false; bounds = @{ x = 0.0; y = 0.0 }
    crop_left = 0; crop_top = 0; crop_right = 0; crop_bottom = 0; id = $i; group_item_backup = $false
    scale_filter = 'disable'; blend_method = 'default'; blend_type = 'normal'
    show_transition = @{ duration = 0 }; hide_transition = @{ duration = 0 }; private_settings = @{}
  }
}
$scene = NewSource 'Soul Link' 'scene' ([ordered]@{ id_counter = $i; custom_size = $false; items = $items })
$scene.canvas_uuid = $canvas
$scene.hotkeys = @{ 'OBSBasic.SelectScene' = @() }

$collection = [ordered]@{
  current_scene = 'Soul Link'; current_program_scene = 'Soul Link'
  scene_order = @(@{ name = 'Soul Link' }); name = 'Soul Link'
  sources = @($scene) + @($layout | ForEach-Object { $_.src })
  groups = @(); quick_transitions = @(); transitions = @(); saved_projectors = @(); canvases = @()
  current_transition = 'Schnitt'; transition_duration = 300; preview_locked = $false
  scaling_enabled = $false; scaling_level = 0; scaling_off_x = 0.0; scaling_off_y = 0.0
  modules = @{}; version = 2
}
$json = $collection | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText((Join-Path (Get-Location) $Out), $json, (New-Object Text.UTF8Encoding($false)))
"OK: $Out (Raum $Room)"
