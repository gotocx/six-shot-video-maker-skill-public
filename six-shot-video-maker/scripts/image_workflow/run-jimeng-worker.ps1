param(
  [string]$ConversationUrl = "",
  [string]$ConversationId = "",
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [Parameter(Mandatory = $true)][string]$Browser,
  [Parameter(Mandatory = $true)][string]$Manifest,
  [string]$WorkspacePoolFile = "",
  [string]$OutDir = "",
  [string]$LogDir = "",
  [int]$Concurrency = 1,
  [switch]$ScanOnly,
  [switch]$NoStopBrowser
)

$ErrorActionPreference = "Stop"

function Normalize-PathValue {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }
  return [System.IO.Path]::GetFullPath($Value.Trim())
}

function Convert-JimengWorkspaceUrl {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }
  $trimmed = $Value.Trim()
  if ($trimmed -match 'workspace=(\d{1,20})') {
    return "https://jimeng.jianying.com/ai-tool/generate?type=image&workspace=$($Matches[1])"
  }
  if ($trimmed -match '^\d{1,20}$') {
    return "https://jimeng.jianying.com/ai-tool/generate?type=image&workspace=$trimmed"
  }
  return $trimmed
}

function Get-JimengWorkspaceId {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }
  $normalized = Convert-JimengWorkspaceUrl -Value $Value
  if ($normalized -match 'workspace=(\d{1,20})') {
    return $Matches[1]
  }
  return ""
}

function Stop-BrowserProcesses {
  param([Parameter(Mandatory = $true)][string]$BrowserPath)
  $browserName = [System.IO.Path]::GetFileName($BrowserPath)
  if (-not $browserName) {
    return
  }
  $taskKillExe = Join-Path $env:SystemRoot "System32\taskkill.exe"
  if (-not (Test-Path -LiteralPath $taskKillExe)) {
    return
  }
  $existing = Get-Process | Where-Object { $_.ProcessName -ieq [System.IO.Path]::GetFileNameWithoutExtension($browserName) } | Select-Object -First 1
  if ($null -eq $existing) {
    return
  }
  Write-Host "[jimeng] detected running browser process: $browserName"
  Write-Host "[jimeng] stopping browser via taskkill.exe /F /T /IM $browserName"
  & $taskKillExe /F /T /IM $browserName | Out-Host
  Start-Sleep -Seconds 2
}

$workflowRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $workflowRoot "providers\jimeng\scripts\jimengBatchGenerate.mjs"
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Jimeng image script not found: $scriptPath"
}

$resolvedBrowser = Normalize-PathValue -Value $Browser
$resolvedProfileDir = Normalize-PathValue -Value $ProfileDir
$resolvedManifest = Normalize-PathValue -Value $Manifest
$resolvedOutDir = Normalize-PathValue -Value $OutDir
$resolvedLogDir = Normalize-PathValue -Value $LogDir
$resolvedWorkspacePoolFile = Normalize-PathValue -Value $WorkspacePoolFile

if (-not (Test-Path -LiteralPath $resolvedBrowser)) {
  throw "Browser not found: $resolvedBrowser"
}
if (-not (Test-Path -LiteralPath $resolvedProfileDir)) {
  throw "Profile directory not found: $resolvedProfileDir"
}
if (-not (Test-Path -LiteralPath $resolvedManifest)) {
  throw "Manifest not found: $resolvedManifest"
}
if (-not $resolvedOutDir) {
  $resolvedOutDir = Join-Path (Split-Path -Parent $resolvedManifest) "jimeng-output"
}
if (-not $resolvedLogDir) {
  $resolvedLogDir = Join-Path (Split-Path -Parent $resolvedManifest) "jimeng-logs"
}
$workspacePoolDir = ""
if ($resolvedWorkspacePoolFile) {
  $workspacePoolDir = Split-Path -Parent $resolvedWorkspacePoolFile
}
foreach ($dir in @($resolvedOutDir, $resolvedLogDir, $workspacePoolDir)) {
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
}

$resolvedConversationUrl = ""
if ($ConversationId) {
  $resolvedConversationUrl = Convert-JimengWorkspaceUrl -Value $ConversationId
} elseif ($ConversationUrl) {
  $resolvedConversationUrl = Convert-JimengWorkspaceUrl -Value $ConversationUrl
}

$sessionFile = Join-Path $resolvedLogDir ("session-" + [Guid]::NewGuid().ToString("N") + ".json")
$args = @(
  $scriptPath,
  "--manifest", $resolvedManifest,
  "--profile-dir", $resolvedProfileDir,
  "--browser", $resolvedBrowser,
  "--out-dir", $resolvedOutDir,
  "--log-dir", $resolvedLogDir,
  "--session-out", $sessionFile,
  "--concurrency", [string]([Math]::Max(1, $Concurrency))
)

if ($resolvedWorkspacePoolFile) {
  $args += @("--workspace-pool-file", $resolvedWorkspacePoolFile)
}
$workspaceId = Get-JimengWorkspaceId -Value $resolvedConversationUrl
if ($workspaceId) {
  $args += @("--workspace-id", $workspaceId)
}
if ($ScanOnly) {
  $args += "--scan-only"
}

if (-not $NoStopBrowser) {
  Stop-BrowserProcesses -BrowserPath $resolvedBrowser
}

Write-Host "[jimeng] manifest: $resolvedManifest"
Write-Host "[jimeng] output dir: $resolvedOutDir"
Write-Host "[jimeng] log dir: $resolvedLogDir"
node @args
$exitCode = $LASTEXITCODE

if (Test-Path -LiteralPath $sessionFile) {
  Copy-Item -LiteralPath $sessionFile -Destination (Join-Path $resolvedLogDir "last-session.json") -Force
  Remove-Item -LiteralPath $sessionFile -Force -ErrorAction SilentlyContinue
}

exit $exitCode
