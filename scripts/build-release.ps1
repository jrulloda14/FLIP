# Builds the release app and both Windows installers with local build paths removed:
#   dist-release\FLIP_<version>_x64-setup.exe          small; downloads WebView2 only if missing
#   dist-release\FLIP_<version>_x64-offline-setup.exe  bundles Microsoft's WebView2 installer
#
# Rust embeds absolute source paths (including the Cargo registry under your user profile) in
# panic-location strings. Remapping them keeps your Windows username and folder layout out of
# anything you publish. Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$rustupHome = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { Join-Path $env:USERPROFILE '.rustup' }

# CARGO_ENCODED_RUSTFLAGS separates flags with 0x1F, so paths containing spaces stay intact.
$flags = @(
  "--remap-path-prefix=$cargoHome=/cargo",
  "--remap-path-prefix=$rustupHome=/rustup",
  "--remap-path-prefix=$repo=/flip"
)
$env:CARGO_ENCODED_RUSTFLAGS = $flags -join [char]0x1F
Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue

$version = (Get-Content (Join-Path $repo 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
$bundleDir = Join-Path $repo 'src-tauri\target\release\bundle\nsis'
$out = Join-Path $repo 'dist-release'
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out -Filter '*.exe' -ErrorAction SilentlyContinue | Remove-Item

function Assert-Clean([string]$file) {
  $text = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($file))
  $wide = [Text.Encoding]::Unicode.GetString([IO.File]::ReadAllBytes($file))
  foreach ($needle in @($env:USERPROFILE, $env:USERNAME, $repo)) {
    if ($needle -and ($text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                      $wide.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0)) {
      throw "$(Split-Path $file -Leaf) still contains '$needle'. Do not publish it."
    }
  }
}

Push-Location $repo
try {
  # 1. Standard installer (downloads WebView2 only on PCs that lack it).
  npx tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
  Assert-Clean (Join-Path $repo 'src-tauri\target\release\flip.exe')
  Move-Item (Join-Path $bundleDir "FLIP_${version}_x64-setup.exe") (Join-Path $out "FLIP_${version}_x64-setup.exe") -Force

  # 2. Offline installer: same binary, plus Microsoft's WebView2 standalone installer.
  $offline = '{"bundle":{"windows":{"webviewInstallMode":{"type":"offlineInstaller","silent":true}}}}'
  $cfg = Join-Path $env:TEMP 'flip-offline-config.json'
  Set-Content -Path $cfg -Value $offline -Encoding ascii
  npx tauri build --config $cfg
  if ($LASTEXITCODE -ne 0) { throw "offline tauri build failed ($LASTEXITCODE)" }
  Move-Item (Join-Path $bundleDir "FLIP_${version}_x64-setup.exe") (Join-Path $out "FLIP_${version}_x64-offline-setup.exe") -Force

  Write-Host "OK: no user profile, user name or project path found in flip.exe"
  Get-ChildItem $out -Filter '*.exe' | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    Write-Host ("{0}  {1:N1} MB  SHA256 {2}" -f $_.Name, ($_.Length / 1MB), $hash)
  }
} finally {
  Pop-Location
}
