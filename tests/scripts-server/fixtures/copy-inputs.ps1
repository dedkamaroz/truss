$ErrorActionPreference = 'Stop'
Write-Output "run $env:TRUSS_RUN_ID starting"
$items = Get-Content -Raw -LiteralPath $env:TRUSS_INPUTS_FILE | ConvertFrom-Json
foreach ($i in @($items)) {
  Copy-Item -LiteralPath $i.path -Destination (Join-Path $env:TRUSS_OUTPUT_DIR $i.filename)
  Write-Output "copied $($i.id)"
}
Set-Content -LiteralPath (Join-Path $env:TRUSS_OUTPUT_DIR 'result.txt') -Value 'powershell ok' -NoNewline
Write-Output 'powershell done'
exit 0
