param(
  [ValidateSet('sqlite','duckdb','both')][string]$Engine = 'both',
  [int]$Rows = 250000,
  [int]$Iterations = 3,
  [string]$Output = 'benchmark.json'
)
$ErrorActionPreference = 'Stop'
python (Join-Path $PSScriptRoot 'benchmark_workloads.py') --engine $Engine --rows $Rows --iterations $Iterations --output $Output
