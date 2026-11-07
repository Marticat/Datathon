param([string]$Model = 'qwen3.5:9b', [switch]$SkipModel)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$localDir = Join-Path $projectRoot '.local'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$ollamaExe = Join-Path $localDir 'ollama/ollama.exe'
if (!(Test-Path -LiteralPath $ollamaExe)) {
  $installed = Get-Command ollama -ErrorAction SilentlyContinue
  if ($installed) { $ollamaExe = $installed.Source }
  else { throw 'Ollama is missing. Run scripts/setup-local.ps1 first.' }
}
$env:OLLAMA_MODELS = Join-Path $localDir 'models'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_CONTEXT_LENGTH = '16384'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
# Portable installation can use Vulkan instead of downloading both CUDA distributions.
if (!(Test-Path -LiteralPath (Join-Path $localDir 'ollama/lib/ollama/cuda_v12'))) { $env:OLLAMA_VULKAN = '1' }
$running = $false
try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2; $running = $true } catch {}
if (!$running) {
  $process = Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $localDir 'ollama-out.log') -RedirectStandardError (Join-Path $localDir 'ollama-error.log')
  $process.Id | Set-Content -LiteralPath (Join-Path $localDir 'ollama.pid')
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 500
    try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2; $running = $true; break } catch {}
  }
  if (!$running) { throw 'Ollama did not start. See .local/ollama-error.log.' }
}
if (!$SkipModel) {
  & $ollamaExe pull $Model
  if ($LASTEXITCODE -ne 0) { throw 'Model download failed. Run this command again to resume.' }
}
if (!(Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
Write-Host 'CQA will open at http://127.0.0.1:3000'
$existingApp = $null
try { $existingApp = Invoke-RestMethod 'http://127.0.0.1:3000/api/health' -TimeoutSec 5 } catch {}
if ($existingApp.ok -and $null -ne $existingApp.ollama) {
  Write-Host 'CQA is already running. Refresh the page to connect the local model.'
  return
}
npm start
