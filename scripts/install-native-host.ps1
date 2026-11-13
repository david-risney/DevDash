#requires -Version 7.3
<#
.SYNOPSIS
Compatibility wrapper for devdash native install/uninstall. Registration is owned by the CLI.
#>
[CmdletBinding()]
param(
    [string[]] $ExtensionId = @(),
    [ValidateSet('Chrome', 'Edge', 'Both')] [string] $Browser = 'Both',
    [string] $InstallDirectory,
    [string] $NodePath,
    [Alias('Home')] [string] $DevDashHome,
    [string] $Config,
    [switch] $Uninstall,
    [Alias('DryRun')] [switch] $Preview
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
try {
    if (-not $IsWindows) { throw 'Native host registration requires Windows.' }
    $runner = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\devdash.js'
    $arguments = @($entry, 'native', $(if ($Uninstall) { 'uninstall' } else { 'install' }), '--browser', $Browser.ToLowerInvariant())
    if (-not $Uninstall) {
        if ($NodePath) { $arguments += @('--node-path', $NodePath) }
        if ($ExtensionId.Count) { $arguments += @('--extension-id', ($ExtensionId -join ',')) }
    }
    if ($InstallDirectory) { $arguments += @('--install-directory', $InstallDirectory) }
    if ($DevDashHome) { $arguments += @('--home', $DevDashHome) }
    if ($Config) { $arguments += @('--config', $Config) }
    if ($Preview) { $arguments += '--preview' }
    & $runner @arguments
    exit $LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine("DevDash native host setup failed: $($_.Exception.Message)")
    exit 1
}
