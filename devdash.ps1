#requires -Version 7.3

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$PSNativeCommandArgumentPassing = 'Standard'
$cliArguments = $args
$originalPath = $env:PATH
$exitCode = 1

try {
    $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $probe = @'
const { createRequire } = require('node:module');
const { join } = require('node:path');
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('DevDash requires Node.js 22 or newer.');
  process.exit(1);
}
for (const manifest of [
  join(process.argv[1], 'package.json'),
  join(process.argv[1], 'packages', 'cr', 'package.json'),
]) {
  const localRequire = createRequire(manifest);
  for (const dependency of Object.keys(localRequire(manifest).dependencies ?? {})) {
    try { localRequire.resolve(dependency); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      console.error(`DevDash: missing npm dependency ${dependency}; installing from package-lock.json.`);
      process.exit(42);
    }
  }
}
'@
    & $node --eval $probe $PSScriptRoot
    $dependencyStatus = $LASTEXITCODE
    if ($dependencyStatus -eq 42 -or
        ($dependencyStatus -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\.bin\cr.cmd')) -and $IsWindows)) {
        $npmName = if ($IsWindows) { 'npm.cmd' } else { 'npm' }
        $npm = (Get-Command $npmName -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        Push-Location -LiteralPath $PSScriptRoot
        try {
            & $npm ci --no-audit --no-fund | ForEach-Object { [Console]::Error.WriteLine($_) }
            if ($LASTEXITCODE -ne 0) {
                throw "npm ci failed with exit code $LASTEXITCODE; DevDash was not started."
            }
        }
        finally {
            Pop-Location
        }
        & $node --eval $probe $PSScriptRoot
        $dependencyStatus = $LASTEXITCODE
    }
    if ($dependencyStatus -ne 0) {
        throw "DevDash dependency check failed with exit code $dependencyStatus."
    }

    $env:PATH = (Join-Path $PSScriptRoot 'node_modules\.bin') + [IO.Path]::PathSeparator + $originalPath
    $entryPoint = Join-Path $PSScriptRoot 'bin\devdash.js'
    if ($MyInvocation.ExpectingInput) {
        $input | & $node $entryPoint @cliArguments
    }
    else {
        & $node $entryPoint @cliArguments
    }
    $exitCode = $LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
}
finally {
    $env:PATH = $originalPath
}

exit $exitCode
