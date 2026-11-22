<#
.SYNOPSIS
  Publish the prebuilt dsh-living 0.3.14 tarball from a folder.

.DESCRIPTION
  The tarball is already packed; workspace:* is replaced with dsh-living-protocol@0.2.0.
  This script never packs. It verifies the file and optionally publishes it.

  Without -Publish it only prints the path; upload it yourself: dsh-living-0.3.14.tgz.

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

$core = Join-Path $PackageDir 'dsh-living-0.3.14.tgz'
if (-not (Test-Path $core)) { throw "Missing: $core" }

Write-Host 'Tarball:'
Write-Host "  $core"

if (-not $Publish) {
  Write-Host ''
  Write-Host 'Upload: dsh-living-0.3.14.tgz.'
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

Write-Host 'Publishing dsh-living 0.3.14...'
& npm @publishArgs $core
if ($LASTEXITCODE -ne 0) { throw 'dsh-living publish failed' }

if ($Staged) {
  Write-Host ''
  Write-Host 'Publish staged. Approve the version with your normal 2FA flow.'
} else {
  Write-Host ''
  npm view dsh-living version
}
