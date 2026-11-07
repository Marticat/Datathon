param([string]$Version = '0.40.15')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$localDir = Join-Path $projectRoot '.local'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$archive = Join-Path $localDir "ollama-$Version.zip"
$exe = Join-Path $localDir 'ollama/ollama.exe'
if (Test-Path -LiteralPath $exe) { Write-Host 'Portable Ollama already exists. Run scripts/start-local.ps1.'; exit 0 }
$base = "https://github.com/ollama/ollama/releases/download/v$Version"
Write-Host 'Downloading the official Windows runtime. Downloads can be large; restart this script to resume.'
& curl.exe -L --fail --retry 4 -C - --output $archive "$base/ollama-windows-amd64.zip"
if ($LASTEXITCODE -ne 0) { throw 'Download incomplete. Run setup again to resume.' }
$checksums = (Invoke-WebRequest "$base/sha256sum.txt").Content
$expected = ($checksums -split "`n" | Where-Object { $_ -match '\s+\*?ollama-windows-amd64\.zip\s*$' }) -split '\s+' | Select-Object -First 1
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if (!$expected -or $actual -ne $expected) { throw 'Checksum verification failed; archive will not be executed.' }
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $localDir 'ollama') -Force
Write-Host 'Ollama verified and extracted. Run scripts/start-local.ps1 to download the model and launch CQA.'
