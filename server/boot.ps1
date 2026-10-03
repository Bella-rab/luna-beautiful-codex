$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot "index.mjs"
$node = Get-ChildItem "$HOME\.cache\codex-runtimes\*\dependencies\node\bin\node.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) {
  [Console]::Error.WriteLine("luna-beautiful-codex: Node.js not found.")
  exit 1
}
& $node.FullName $script
exit $LASTEXITCODE
