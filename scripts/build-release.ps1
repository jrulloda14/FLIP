# Builds the release app and NSIS installer with local build paths removed from the binary.
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

Push-Location $repo
try {
  npx tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }

  # Fail loudly if anything personal survived.
  $exe = Join-Path $repo 'src-tauri\target\release\flip.exe'
  $bytes = [IO.File]::ReadAllBytes($exe)
  $text = [Text.Encoding]::ASCII.GetString($bytes)
  foreach ($needle in @($env:USERPROFILE, $env:USERNAME, $repo)) {
    if ($needle -and $text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      throw "Build output still contains '$needle'. Do not publish it."
    }
  }
  Write-Host "OK: no user profile, user name or project path found in flip.exe"
  Get-ChildItem (Join-Path $repo 'src-tauri\target\release\bundle\nsis\*.exe') | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    Write-Host "$($_.Name)  SHA256 $hash"
  }
} finally {
  Pop-Location
}
