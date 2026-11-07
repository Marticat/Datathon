param([string]$Python = 'python', [ValidateSet('base','small')][string]$Model = 'small')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
& $Python -m pip install --target .local/audio-python -r scripts/requirements-audio.txt
if ($LASTEXITCODE -ne 0) { throw 'Audio dependencies were not installed.' }
$env:PYTHONPATH = Join-Path $projectRoot '.local/audio-python'
& $Python scripts/setup_audio.py --asr $Model
if ($LASTEXITCODE -ne 0) { throw 'Audio models were not installed. Rerun setup to resume.' }
Write-Host 'Audio is ready at http://127.0.0.1:3000/audio. Set CQA_PYTHON in .env if this Python is not the default.'
