<#
.SYNOPSIS
  Pack (and optionally publish) dsh-living 0.3.10.

.DESCRIPTION
  Run this on the machine where npm 2FA is available.

  Default: build the tarball in %TEMP%\dsh-living-release and print its path.
  Upload it yourself: dsh-living-0.3.10.tgz.

  -Publish: publish the tarball with npm publish; the 2FA prompt appears here.
  -Staged:  add --staged to npm publish (only if your npm CLI supports staged publishing).

  pnpm pack replaces workspace:* dependencies with the published protocol version (0.2.0),
  so the tarball is self-contained and does not need a workspace on the publishing machine.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publish-npm.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publish-npm.ps1 -Publish
#>
param(
  [switch]$Publish,
  [switch]$Staged
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js >= 22 is required.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm is required.'
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
    throw 'pnpm is required. Install Node >= 22 with corepack, or run: npm install -g pnpm@12.21.0'
  }
  Write-Host 'pnpm not found; activating pnpm@12.21.0 through corepack...'
  corepack enable
  corepack prepare pnpm@12.21.0 --activate
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw 'pnpm is still not available after corepack. Run: npm install -g pnpm@12.21.0'
  }
}

Write-Host "Repository: $root"
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }

$out = Join-Path $env:TEMP 'dsh-living-release'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

function Invoke-Pack([string]$packageDir, [string]$name) {
  Push-Location (Join-Path $root $packageDir)
  try {
    pnpm pack --pack-destination $out
    if ($LASTEXITCODE -ne 0) { throw "pnpm pack failed for $name" }
  } finally {
    Pop-Location
  }
}

Invoke-Pack 'packages/core' 'dsh-living'

$core = Join-Path $out 'dsh-living-0.3.10.tgz'
if (-not (Test-Path $core)) {
  throw "Expected tarball not found in $out"
}

Write-Host ''
Write-Host 'Tarball:'
Write-Host "  $core"

if (-not $Publish) {
  Write-Host ''
  Write-Host 'Pack-only mode. Upload this tarball with your normal npm 2FA flow.'
  Write-Host 'To publish from this machine: rerun with -Publish (add -Staged if supported).'
  exit 0
}

npm whoami
if ($LASTEXITCODE -ne 0) {
  throw 'npm is not authenticated. Run "npm login" on this machine, then rerun with -Publish.'
}

$publishArgs = @('publish', '--access', 'public')
if ($Staged) { $publishArgs += '--staged' }

Write-Host ''
Write-Host 'Publishing dsh-living 0.3.10...'
& npm @publishArgs $core
if ($LASTEXITCODE -ne 0) { throw 'dsh-living publish failed' }

if ($Staged) {
  Write-Host ''
  Write-Host 'Publish staged. Approve the version with your normal 2FA flow (npm stage approve or the npm website).'
} else {
  Write-Host ''
  npm view dsh-living version
}
