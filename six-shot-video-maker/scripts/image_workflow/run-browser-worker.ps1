param(
  [string]$ConversationUrl = "",
  [string]$ConversationId = "",
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [Parameter(Mandatory = $true)][string]$Browser,
  [string]$QueueFile = "",
  [string]$OutDir = "",
  [string]$LogDir = "",
  [int]$Limit = 0,
  [switch]$LoginOnly,
  [switch]$ProbeOnly,
  [switch]$Force,
  [switch]$AllowNetworkFallback
)

$ErrorActionPreference = "Stop"

function Resolve-ProjectRoot {
  param(
    [Parameter(Mandatory = $true)][string]$StartPath
  )

  $explicitRoot = [string]$env:AUTO_IMAGE_PROJECT_ROOT
  if ([string]::IsNullOrWhiteSpace($explicitRoot)) {
    $explicitRoot = [string]$env:WORKSPACE_ROOT
  }
  if (-not [string]::IsNullOrWhiteSpace($explicitRoot)) {
    return [System.IO.Path]::GetFullPath($explicitRoot.Trim())
  }

  $cursor = [System.IO.Path]::GetFullPath($StartPath)
  while ($true) {
    $marker = Join-Path $cursor ".trae"
    if (Test-Path -LiteralPath $marker) {
      return $cursor
    }

    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent -eq $cursor) {
      return [System.IO.Path]::GetFullPath((Get-Location).Path)
    }
    $cursor = $parent
  }
}

function Normalize-PathValue {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }
  return [System.IO.Path]::GetFullPath($Value.Trim())
}

function Convert-ConversationIdToUrl {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }
  $trimmed = $Value.Trim()
  if ($trimmed -match '^https://browser\.com/c/[^/\s]+$') {
    return $trimmed
  }
  return "https://browser.com/c/$trimmed"
}

if ($ConversationUrl -and $ConversationId) {
  throw "Provide either -ConversationId or -ConversationUrl, but not both."
}

$workflowRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-ProjectRoot -StartPath $workflowRoot
$env:AUTO_IMAGE_PROJECT_ROOT = $projectRoot

$workRoot = Join-Path $projectRoot ".auto-image-workflow-data"
$defaultQueueFile = Join-Path $workRoot "queues\image-manifest.json"
$defaultOutDir = Join-Path $workRoot "output\browser"
$defaultLogDir = Join-Path $workRoot "logs\browser"
$providerScript = Join-Path $workflowRoot "providers\browser\scripts\browserConversationGenerate.mjs"

if (-not (Test-Path -LiteralPath $providerScript)) {
  throw "Browser image script not found: $providerScript"
}

if (-not $QueueFile) {
  $QueueFile = $defaultQueueFile
}
if (-not $OutDir) {
  $OutDir = $defaultOutDir
}
if (-not $LogDir) {
  $LogDir = $defaultLogDir
}

$resolvedProfileDir = Normalize-PathValue -Value $ProfileDir
$resolvedBrowser = Normalize-PathValue -Value $Browser
$resolvedQueueFile = Normalize-PathValue -Value $QueueFile
$resolvedOutDir = Normalize-PathValue -Value $OutDir
$resolvedLogDir = Normalize-PathValue -Value $LogDir

foreach ($dir in @($workRoot, (Split-Path -Parent $resolvedQueueFile), $resolvedOutDir, $resolvedLogDir)) {
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
}

$resolvedConversationUrl = ""
if ($ConversationId) {
  $resolvedConversationUrl = Convert-ConversationIdToUrl -Value $ConversationId
} elseif ($ConversationUrl) {
  $resolvedConversationUrl = Convert-ConversationIdToUrl -Value $ConversationUrl
}

$sessionFile = Join-Path $resolvedLogDir ("session-" + [Guid]::NewGuid().ToString("N") + ".json")
$args = @(
  $providerScript,
  "--profile-dir", $resolvedProfileDir,
  "--browser", $resolvedBrowser,
  "--out-dir", $resolvedOutDir,
  "--log-dir", $resolvedLogDir,
  "--session-out", $sessionFile
)

if ($resolvedConversationUrl) {
  $args += @("--conversation-url", $resolvedConversationUrl)
}
if ($LoginOnly) {
  $args += "--login-only"
} elseif ($ProbeOnly) {
  $args += "--probe-only"
} else {
  $args += @("--queue-file", $resolvedQueueFile)
}
if ($Force) {
  $args += "--force"
}
if ($Limit -gt 0) {
  $args += @("--limit", [string]$Limit)
}
if ($AllowNetworkFallback) {
  $args += "--allow-network-fallback"
}

Write-Host "[browser] project root: $projectRoot"
Write-Host "[browser] queue file: $resolvedQueueFile"
Write-Host "[browser] output dir: $resolvedOutDir"
Write-Host "[browser] log dir: $resolvedLogDir"
Write-Host "[browser] open the sandbox/VM real browser profile; close all running browser windows before this command."

node @args
$exitCode = $LASTEXITCODE

if (Test-Path -LiteralPath $sessionFile) {
  Write-Host "[browser] session metadata: $sessionFile"
}

exit $exitCode
