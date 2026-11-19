<#
.SYNOPSIS
  Publish the prebuilt dsh-living 0.3.4 / dsh-gem-petkit 0.1.0 tarballs from a folder.

.DESCRIPTION
  The tarballs are already packed; workspace:* is replaced with dsh-living-protocol@0.2.0.
  This script never packs. It verifies the two files and optionally publishes them.

  Without -Publish it only prints the paths; upload them yourself in this order:
    1. dsh-gem-petkit-0.1.0.tgz
    2. dsh-living-0.3.4.tgz

  With -Publish it runs npm publish; the 2FA prompt appears on this machine.
  -Staged adds --staged if your npm CLI supports staged publishing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File publish-from-nas.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File publish-from-nas.ps1 -Publish
#>
param(
  [string]$PackageDir,
  [switch]$Publish,
  [switch]$Staged
)

$ErrorActionPreference = 'Stop'
if (-not $PackageDir) { $PackageDir = $PSScriptRoot }

$gem = Join-Path $PackageDir 'dsh-gem-petkit-0.1.0.tgz'
$core = Join-Path $PackageDir 'dsh-living-0.3.4.tgz'
if (-not (Test-Path $gem)) { throw "Missing: $gem" }
if (-not (Test-Path $core)) { throw "Missing: $core" }

Write-Host 'Tarballs:'
Write-Host "  $gem"
Write-Host "  $core"

if (-not $Publish) {
  Write-Host ''
  Write-Host 'Upload order: dsh-gem-petkit-0.1.0.tgz first, then dsh-living-0.3.4.tgz.'
  Write-Host 'To publish from this machine: rerun with -Publish (add -Staged if supported).'
  exit 0
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm is required.'
}
npm whoami
if ($LASTEXITCODE -ne 0) {
  throw 'npm is not authenticated. Run "npm login" on this machine first.'
}

$publishArgs = @('publish', '--access', 'public')
if ($Staged) { $publishArgs += '--staged' }

Write-Host 'Publishing dsh-gem-petkit 0.1.0...'
& npm @publishArgs $gem
if ($LASTEXITCODE -ne 0) { throw 'dsh-gem-petkit publish failed' }

Write-Host 'Publishing dsh-living 0.3.4...'
& npm @publishArgs $core
if ($LASTEXITCODE -ne 0) { throw 'dsh-living publish failed' }

if ($Staged) {
  Write-Host ''
  Write-Host 'Publish staged. Approve both versions with your normal 2FA flow.'
} else {
  Write-Host ''
  npm view dsh-gem-petkit version
  npm view dsh-living version
}
