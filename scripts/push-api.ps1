# scripts/push-api.ps1 — push a full tree via Git Data API (workaround for
# rate-limited / blocked git push). Uploads every tracked file as a blob,
# creates a single flat tree, commits on top of origin/main, and force-
# updates the main ref.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\push-api.ps1 -Message "fix: ..."
# Requires: $env:GITHUB_TOKEN (Personal Access Token with `repo` scope).

param(
  [Parameter(Mandatory = $true)][string]$Message,
  [string]$Owner = "hernandez42",
  [string]$Repo = "apex-pi",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

$token = $env:GITHUB_TOKEN
if (-not $token) { throw "GITHUB_TOKEN env var is required" }

$apiBase = "https://api.github.com"
$headers = @{
  "Authorization"        = "token $token"
  "Accept"               = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "apex-pi-push-api"
}

# 1) Find the latest commit on the branch (this is the parent of the new one).
Write-Host "[1/5] Resolving latest commit on $Branch..." -ForegroundColor Cyan
$ref = Invoke-RestMethod -Uri "$apiBase/repos/$Owner/$Repo/git/ref/heads/$Branch" -Headers $headers -Method GET -TimeoutSec 30
$parentSha = $ref.object.sha
Write-Host "      parent = $parentSha"

# 2) Upload every tracked file as a blob.
Write-Host "[2/5] Uploading blobs..." -ForegroundColor Cyan
$files = & git ls-files
Write-Host "      $($files.Count) files to upload"

$blobEntries = New-Object System.Collections.Generic.List[object]
$i = 0
foreach ($rel in $files) {
  $i++
  $abs = Join-Path (Get-Location) $rel
  $bytes = [System.IO.File]::ReadAllBytes($abs)
  $b64 = [Convert]::ToBase64String($bytes)
  $payload = @{ content = $b64; encoding = "base64" } | ConvertTo-Json -Compress
  $blob = Invoke-RestMethod -Uri "$apiBase/repos/$Owner/$Repo/git/blobs" -Headers $headers -Method POST -Body $payload -TimeoutSec 30
  $blobEntries.Add(@{ path = $rel.Replace('\', '/'); mode = "100644"; type = "blob"; sha = $blob.sha }) | Out-Null
  if ($i % 10 -eq 0) { Write-Host "      $i/$($files.Count)..." }
}
Write-Host "      $i/$($files.Count) blobs uploaded"

# 3) Create a new tree from the blob entries (no base_tree — we want a full snapshot).
Write-Host "[3/5] Creating tree..." -ForegroundColor Cyan
$treePayload = @{
  tree = $blobEntries
} | ConvertTo-Json -Depth 10 -Compress
$tree = Invoke-RestMethod -Uri "$apiBase/repos/$Owner/$Repo/git/trees" -Headers $headers -Method POST -Body $treePayload -TimeoutSec 60
$treeSha = $tree.sha
Write-Host "      tree = $treeSha"

# 4) Create a commit on top of the parent.
Write-Host "[4/5] Creating commit..." -ForegroundColor Cyan
$commitPayload = @{
  message = $Message
  parents = @($parentSha)
  tree    = $treeSha
} | ConvertTo-Json -Compress
$commit = Invoke-RestMethod -Uri "$apiBase/repos/$Owner/$Repo/git/commits" -Headers $headers -Method POST -Body $commitPayload -TimeoutSec 30
$commitSha = $commit.sha
Write-Host "      commit = $commitSha"

# 5) Force-update the branch ref to point at the new commit.
Write-Host "[5/5] Updating $Branch ref..." -ForegroundColor Cyan
$refPayload = @{ sha = $commitSha; force = $true } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "$apiBase/repos/$Owner/$Repo/git/refs/heads/$Branch" -Headers $headers -Method PATCH -Body $refPayload -TimeoutSec 30 | Out-Null
Write-Host "      $Branch -> $commitSha" -ForegroundColor Green

Write-Host ""
Write-Host "Pushed: $commitSha" -ForegroundColor Green
Write-Host "View:    https://github.com/$Owner/$Repo/commit/$commitSha"
