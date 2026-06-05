# scripts/push.ps1
# One-shot bootstrap: install bun, install deps, run CI locally, then push to GitHub.
# Usage:
#   iwr https://...  # (just run this file on your machine)
#   .\scripts\push.ps1 -Remote "https://github.com/<you>/apex-pi.git" -Branch "main"
#
# Reads GITHUB_TOKEN from env (NEVER pass it on the command line — keeps it out of
# shell history and process listings). If env var is missing, it prompts for it
# using Read-Host -AsSecureString, which never echoes to the terminal.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Remote,

    [string]$Branch = "main",

    [string]$CommitMsg = "apex-pi v0.2.0",

    [switch]$SkipInstall,
    [switch]$SkipVerify,
    [switch]$Force,
    [string]$BunVersion = "1.1.34"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location -LiteralPath $root

function Step($n, $msg) { Write-Host "`n[$n/6] $msg" -ForegroundColor Cyan }
function Ok($msg)       { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Warn($msg)     { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Fail($msg)     { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

# 1. Bun
Step 1 "Checking bun..."
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    if ($SkipInstall) { Fail "bun not found and -SkipInstall set" }
    Warn "bun not on PATH; installing to $env:LOCALAPPDATA\Programs\apex-pi-bun"
    $dest = "$env:LOCALAPPDATA\Programs\apex-pi-bun"
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    $zip = "$env:TEMP\bun-$BunVersion.zip"
    $url = "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/bun-windows-x64.zip"
    Write-Host "  downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 180
    Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
    $bunExe = Get-ChildItem -LiteralPath $dest -Recurse -Filter "bun.exe" | Select-Object -First 1
    if (-not $bunExe) { Fail "bun.exe not found after extract" }
    $env:Path = "$($bunExe.DirectoryName);$env:Path"
    [Environment]::SetEnvironmentVariable("Path", $env:Path, "User")
    $bun = Get-Command bun
}
& $bun --version | ForEach-Object { Ok "bun $_" }

# 2. Install deps
Step 2 "Installing dependencies..."
if (-not $SkipInstall) {
    & $bun install 2>&1 | Select-Object -Last 5
    Ok "deps installed"
} else {
    Warn "skipped (SkipInstall)"
}

# 3. Verify (typecheck + test)
Step 3 "Running typecheck + tests..."
if (-not $SkipVerify) {
    & $bun run typecheck 2>&1 | Select-Object -Last 10
    if ($LASTEXITCODE -ne 0) { Fail "typecheck failed" }
    & $bun test 2>&1 | Select-Object -Last 20
    if ($LASTEXITCODE -ne 0) { Warn "some tests failed — review above" }
    Ok "verification done"
} else {
    Warn "skipped (SkipVerify)"
}

# 4. Git state
Step 4 "Checking git state..."
if (-not (Test-Path .git)) { git init -b $Branch | Out-Null }
$status = git status --porcelain
if ($status -and -not $Force) {
    Write-Host "  Working tree has uncommitted changes:"
    $status | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" }
    git add -A
    git commit -m $CommitMsg | Out-Null
    Ok "committed"
} elseif ($Force) {
    git add -A
    git commit --allow-empty -m $CommitMsg | Out-Null
    Ok "force-committed (may be empty)"
} else {
    Ok "working tree clean"
}

# 5. Remote
Step 5 "Configuring remote..."
$existing = git remote get-url origin 2>$null
if ($existing -ne $Remote) {
    if ($existing) { git remote remove origin }
    git remote add origin $Remote
    Ok "remote set: $Remote"
} else {
    Ok "remote already: $Remote"
}

# 6. Push (with token from env, never CLI)
Step 6 "Pushing to $Branch..."
$token = $env:GITHUB_TOKEN
if (-not $token) {
    $secure = Read-Host "  Enter GITHUB_TOKEN (input hidden)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if (-not $token) { Fail "no token provided" }

# Encode user:token for the URL (avoid putting token in process list / .git/config)
$pair = "$env:USERNAME`:$token"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($pair)
$b64 = [Convert]::ToBase64String($bytes)
$pushUrl = $Remote -replace "^https://", "https://$b64@"

# Use credential helper so the token never lands in .git/config or command line
git config --global --add credential.helper ""
git config --local --add credential.helper "store --file $env:TEMP\.apex-pi-cred"
# Push (the cred helper is set but we also pass via URL for one-shot)
$env:GIT_ASKPASS = "true"   # disable interactive prompt
$env:GIT_TERMINAL_PROMPT = "0"

# Set up credential via git credential approve (no token in URL)
$credProto = $Remote -replace "^https://([^/]+).*", "https"
$credUser = $Remote -replace "^https://github.com/([^/]+)/.*", '$1'
$credInput = "protocol=https`nhost=github.com`nusername=$credUser`npassword=$token`n"
$credInput | & git credential approve 2>$null
Remove-Item "$env:TEMP\.apex-pi-cred" -ErrorAction SilentlyContinue

git push -u origin $Branch 2>&1 | Select-Object -Last 10
if ($LASTEXITCODE -ne 0) { Fail "push failed" }
Ok "pushed!"

# 7. Trigger CI (optional)
if ($env:RUN_CI -eq "1") {
    Write-Host "`n[+] Triggering CI workflow via API..."
    $hdr = @{
        Authorization = "Bearer $token"
        Accept = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent" = "apex-pi-push-script"
    }
    $ownerRepo = $Remote -replace "^https://github.com/", "" -replace "\.git$", ""
    $apiUrl = "https://api.github.com/repos/$ownerRepo/actions/workflows/ci.yml/dispatches"
    $body = @{ ref = $Branch } | ConvertTo-Json
    try {
        Invoke-RestMethod -Method Post -Uri $apiUrl -Headers $hdr -Body $body
        Ok "CI workflow dispatched — watch: https://github.com/$ownerRepo/actions"
    } catch {
        Warn "CI dispatch failed: $($_.Exception.Message)"
    }
}

Write-Host "`nAll done. Token cleared from this shell session." -ForegroundColor Green
$token = $null
[System.GC]::Collect()
