param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if ([IO.Path]::GetExtension($installer) -ne '.exe') { throw "Expected a Windows installer: $installer" }
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "Invalid expected version: $ExpectedVersion"
}

$processes = @(Get-Process -Name 'Codex Web GPT' -ErrorAction SilentlyContinue)
if ($processes.Count -gt 0) {
  $mainWindows = @($processes | Where-Object { $_.MainWindowHandle -ne 0 })
  foreach ($process in $mainWindows) {
    [void]$process.CloseMainWindow()
  }
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    $processes = @(Get-Process -Name 'Codex Web GPT' -ErrorAction SilentlyContinue)
  } while ($processes.Count -gt 0 -and (Get-Date) -lt $deadline)
  if ($processes.Count -gt 0) {
    throw 'Codex Web GPT did not exit gracefully within 30 seconds. Refusing force termination or installation.'
  }
}

$registryPath = 'HKCU:\Software\d1a6026a-6210-588e-9a2b-da3936f94e02'
$installLocation = $null
if (Test-Path -LiteralPath $registryPath) {
  $installLocation = [string](Get-ItemPropertyValue -LiteralPath $registryPath -Name 'InstallLocation' -ErrorAction SilentlyContinue)
}

$backupBase = Join-Path $env:LOCALAPPDATA 'CodexWebGPT\cicd-backups'
$backup = Join-Path $backupBase ([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$backupInstall = Join-Path $backup 'application'

if ($installLocation) {
  $resolved = [IO.Path]::GetFullPath($installLocation)
  $localPrograms = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
  if (-not $resolved.StartsWith($localPrograms, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to manage an unexpected launcher install path: $resolved"
  }
  if (Test-Path -LiteralPath $resolved) {
    Copy-Item -LiteralPath $resolved -Destination $backupInstall -Recurse -Force
  }
}

function Restore-PreviousInstall {
  if (-not $installLocation -or -not (Test-Path -LiteralPath $backupInstall)) { return }
  $resolved = [IO.Path]::GetFullPath($installLocation)
  if (Test-Path -LiteralPath $resolved) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  Copy-Item -LiteralPath $backupInstall -Destination $resolved -Recurse -Force
}

try {
  $process = Start-Process -FilePath $installer -ArgumentList '/S', '/currentuser' -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)" }

  if (-not (Test-Path -LiteralPath $registryPath)) { throw 'Launcher install registry key is missing after install' }
  $newLocation = [string](Get-ItemPropertyValue -LiteralPath $registryPath -Name 'InstallLocation')
  if (-not [IO.Path]::IsPathFullyQualified($newLocation)) { throw "Launcher recorded an invalid path: $newLocation" }
  $executable = Join-Path $newLocation 'Codex Web GPT.exe'
  if (-not (Test-Path -LiteralPath $executable)) { throw "Installed launcher is missing: $executable" }

  $productVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
  if ($productVersion -and -not $productVersion.StartsWith($ExpectedVersion, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Installed launcher version mismatch: expected $ExpectedVersion, got $productVersion"
  }

  Write-Host "Installed Codex Web GPT $ExpectedVersion from validated CI artifact."
  Start-Process -FilePath $executable | Out-Null
} catch {
  Write-Warning 'WebGPT deployment failed; restoring the previous launcher files.'
  Restore-PreviousInstall
  if ($installLocation) {
    $oldExecutable = Join-Path $installLocation 'Codex Web GPT.exe'
    if (Test-Path -LiteralPath $oldExecutable) { Start-Process -FilePath $oldExecutable | Out-Null }
  }
  throw
}
