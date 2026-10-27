# Run from an Administrator PowerShell. This script never restarts Windows.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Windows container prerequisites require an Administrator PowerShell. No changes were made.'
}
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'Windows App Installer (winget) is required to install Docker Desktop.'
}
& wsl.exe --install --no-distribution --no-launch
if ($LASTEXITCODE -notin @(0,3010)) { throw 'WSL installation failed. Review its message before continuing.' }
& winget install --id Docker.DockerDesktop --exact --source winget --disable-interactivity --silent --accept-source-agreements --accept-package-agreements
if ($LASTEXITCODE -notin @(0,3010)) { throw 'Docker Desktop installation failed. Review the installer result.' }
Write-Host 'If Windows requests a restart, save your work and restart manually. Start Docker Desktop, select Linux containers, then run Start-LibreSign.ps1.'
