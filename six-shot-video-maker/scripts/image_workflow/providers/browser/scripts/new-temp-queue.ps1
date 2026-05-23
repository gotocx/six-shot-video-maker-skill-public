param(
  [Parameter(Mandatory = $true)][string]$Prompt,
  [string]$Id,
  [string]$ProviderPrompt = "",
  [string[]]$ReferenceImagePaths = @(),
  [string[]]$StyleHints = @(),
  [string[]]$BackgroundHints = @(),
  [string[]]$EffectHints = @(),
  [string]$Size = "",
  [string]$SizeRequirement = "",
  [ValidateSet("solid_background_high_contrast")][string]$CutoutPolicy = "",
  [int]$OutputWidth = 0,
  [int]$OutputHeight = 0,
  [double]$SubjectWidthRatio = 0,
  [double]$SubjectHeightRatio = 0,
  [string]$QueueFile = "",
  [switch]$Force
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

function Get-RelativePathCompat {
  param(
    [Parameter(Mandatory = $true)][string]$BasePath,
    [Parameter(Mandatory = $true)][string]$TargetPath
  )

  try {
    return [System.IO.Path]::GetRelativePath($BasePath, $TargetPath)
  } catch {
    $baseFull = [System.IO.Path]::GetFullPath($BasePath)
    $targetFull = [System.IO.Path]::GetFullPath($TargetPath)

    if (-not $baseFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
      $baseFull += [System.IO.Path]::DirectorySeparatorChar
    }

    $baseUri = [System.Uri]::new($baseFull)
    $targetUri = [System.Uri]::new($targetFull)
    $relative = $baseUri.MakeRelativeUri($targetUri).ToString()
    return [System.Uri]::UnescapeDataString($relative)
  }
}

function Get-Slug {
  param(
    [Parameter(Mandatory = $true)][string]$Value
  )

  $slug = $Value.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $slug = $slug.Trim('-')
  if (-not $slug) {
    $slug = "job"
  }
  return $slug
}

function Normalize-StringList {
  param(
    [string[]]$Values
  )

  $normalized = @()
  foreach ($value in $Values) {
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      $normalized += $value.Trim()
    }
  }
  return $normalized
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-ProjectRoot -StartPath $scriptRoot
$workRoot = Join-Path $projectRoot ".auto-image-workflow-data"
$queueRoot = Join-Path $workRoot "queues"

foreach ($dir in @($workRoot, $queueRoot)) {
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
}

if (-not $Id) {
  $Id = Get-Slug -Value $Prompt
}

if (-not $QueueFile) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $baseName = "{0}-{1}.local.json" -f $timestamp, $Id
  $QueueFile = Join-Path $queueRoot $baseName
}

$resolvedQueueFile = [System.IO.Path]::GetFullPath($QueueFile)
$queueDir = Split-Path -Parent $resolvedQueueFile
if (-not (Test-Path -LiteralPath $queueDir)) {
  New-Item -ItemType Directory -Path $queueDir -Force | Out-Null
}

if ((Test-Path -LiteralPath $resolvedQueueFile) -and -not $Force) {
  throw "Queue file already exists: $resolvedQueueFile . Use -Force to overwrite."
}

$queueDirResolved = [System.IO.Path]::GetFullPath($queueDir)
$normalizedReferenceImages = @()
foreach ($pathItem in $ReferenceImagePaths) {
  if (-not $pathItem) {
    continue
  }

  $fullImagePath = [System.IO.Path]::GetFullPath($pathItem)
  $relativeImagePath = Get-RelativePathCompat -BasePath $queueDirResolved -TargetPath $fullImagePath
  $normalizedReferenceImages += [ordered]@{
    path = ($relativeImagePath -replace '/', '\')
  }
}

$queueItem = [ordered]@{
  id = $Id
  prompt = $Prompt
}

if (-not [string]::IsNullOrWhiteSpace($ProviderPrompt)) {
  $queueItem.providerPrompt = $ProviderPrompt.Trim()
}

if ($normalizedReferenceImages.Count -gt 0) {
  $queueItem.referenceImages = $normalizedReferenceImages
}

$normalizedStyleHints = Normalize-StringList -Values $StyleHints
if ($normalizedStyleHints.Count -gt 0) {
  $queueItem.styleHints = $normalizedStyleHints
}

$normalizedBackgroundHints = Normalize-StringList -Values $BackgroundHints
if ($normalizedBackgroundHints.Count -gt 0) {
  $queueItem.backgroundHints = $normalizedBackgroundHints
}

$normalizedEffectHints = Normalize-StringList -Values $EffectHints
if ($normalizedEffectHints.Count -gt 0) {
  $queueItem.effectHints = $normalizedEffectHints
}

if (-not [string]::IsNullOrWhiteSpace($Size)) {
  $queueItem.size = $Size.Trim()
}

if (-not [string]::IsNullOrWhiteSpace($SizeRequirement)) {
  $queueItem.sizeRequirement = $SizeRequirement.Trim()
}

if (-not [string]::IsNullOrWhiteSpace($CutoutPolicy)) {
  $queueItem.cutoutPolicy = $CutoutPolicy
}

if ($OutputWidth -gt 0) {
  $queueItem.outputWidth = $OutputWidth
}

if ($OutputHeight -gt 0) {
  $queueItem.outputHeight = $OutputHeight
}

if ($SubjectWidthRatio -gt 0) {
  $queueItem.subjectWidthRatio = $SubjectWidthRatio
}

if ($SubjectHeightRatio -gt 0) {
  $queueItem.subjectHeightRatio = $SubjectHeightRatio
}

$queueJson = ConvertTo-Json @($queueItem) -Depth 5

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($resolvedQueueFile, $queueJson + [Environment]::NewLine, $utf8NoBom)

Write-Host ('browser temp queue created: ' + $resolvedQueueFile)
Write-Output $resolvedQueueFile
exit $LASTEXITCODE
