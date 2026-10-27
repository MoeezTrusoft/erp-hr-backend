[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$deploymentRoot = $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is not installed. Run Install-ContainerRuntime.ps1 from an Administrator PowerShell, complete any requested Windows restart, and rerun this script.'
}
& docker info --format '{{.OSType}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop with Linux containers, then rerun.' }
$secretRoot = Join-Path $deploymentRoot '.secrets'
$runtimeRoot = Join-Path $deploymentRoot '.runtime'
New-Item -ItemType Directory -Force -Path $secretRoot,$runtimeRoot | Out-Null
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($privatePath in @($secretRoot,$runtimeRoot)) {
  $accessRule = $account + ':(OI)(CI)F'
  & icacls $privatePath /inheritance:r /grant:r $accessRule 'SYSTEM:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict local credential directory permissions.' }
}
foreach ($secretName in @('database_password','admin_password','integration_password')) {
  $secretPath = Join-Path $secretRoot $secretName
  if (-not (Test-Path -LiteralPath $secretPath)) {
    $bytes = New-Object byte[] 48
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [IO.File]::WriteAllText($secretPath,[Convert]::ToBase64String($bytes))
  }
}
Push-Location $deploymentRoot
try {
  & docker compose up -d --build --wait --wait-timeout 900
  if ($LASTEXITCODE -ne 0) { throw 'LibreSign containers did not become healthy. Inspect docker compose logs.' }
  & docker compose exec -T --user www-data app /opt/recruitment/bootstrap.sh
  if ($LASTEXITCODE -ne 0) { throw 'LibreSign configuration failed. Inspect the preceding check result.' }
  $appPasswordPath = Join-Path $secretRoot 'integration_app_password'
  if (-not (Test-Path -LiteralPath $appPasswordPath)) {
    # No secret is put into the host command line or printed to the transcript.
    $tokenOutput = & docker compose exec -T --user www-data app sh -c 'export OC_PASS=$(cat /run/secrets/integration_password); php occ --no-interaction user:auth-tokens:add erp-recruitment --password-from-env --name=erp-recruitment'
    if ($LASTEXITCODE -ne 0) { throw 'Could not provision the integration app password.' }
    $tokenLines = @($tokenOutput | Where-Object { $_ -match '^[A-Za-z0-9]{72}$' })
    if ($tokenLines.Count -ne 1) { throw 'Unexpected app-password response; no credential saved.' }
    [IO.File]::WriteAllText($appPasswordPath,$tokenLines[0])
  }
  Write-Host 'LibreSign: http://127.0.0.1:5398'
  Write-Host 'Local test mail inbox: http://127.0.0.1:5399'
  Write-Host 'Admin login: recruitment-admin. Password is in .secrets/admin_password.'
  Write-Host 'Integration login: erp-recruitment. App password is in .secrets/integration_app_password.'
  Write-Host 'Offers remain disabled until the ERP tenant binding and a synthetic signing test pass.'
} finally { Pop-Location }
