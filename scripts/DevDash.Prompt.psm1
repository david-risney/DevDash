#requires -Version 7.3

$script:DevDashPromptState = $null

function Update-DevDashRepositoryPrompt {
    param($State)

    if ($State.Busy) { return }
    $location = Get-Location
    if ($location.Provider.Name -ne 'FileSystem') {
        $State.LastDirectory = $null
        $State.LastRoot = $null
        return
    }
    $directory = $location.ProviderPath
    if ($directory -ceq $State.LastDirectory) { return }
    $State.LastDirectory = $directory
    $State.Busy = $true
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        $gitOutput = @(& $State.Git -C $directory rev-parse --show-toplevel 2>&1)
        if ($LASTEXITCODE -ne 0) {
            $State.LastRoot = $null
            if ($LASTEXITCODE -ne 128 -or ($gitOutput -join "`n") -notmatch 'not a git repository') {
                Write-Warning 'DevDash could not inspect this Git directory. Check Git safe-directory settings.'
            }
            return
        }
        $root = ($gitOutput -join "`n").Trim()
        $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
        if ([string]::Equals($root, $State.LastRoot, $comparison)) { return }
        $State.LastRoot = $root
        $commandArguments = @('repo') + $State.Arguments
        & $State.Command @commandArguments | Out-Host
    }
    finally {
        $State.Busy = $false
    }
}

function Enable-DevDashPrompt {
    [CmdletBinding()]
    param(
        [string]$Command = 'devdash',
        [string[]]$ArgumentList = @()
    )

    if ($script:DevDashPromptState) { return }
    $null = Get-Command $Command -ErrorAction Stop
    $git = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $original = (Get-Command prompt -CommandType Function -ErrorAction Stop).ScriptBlock
    $update = ${function:Update-DevDashRepositoryPrompt}
    $state = @{
        Command = $Command
        Arguments = $ArgumentList
        Git = $git
        Original = $original
        LastDirectory = $null
        LastRoot = $null
        Busy = $false
    }
    $wrapper = {
        $lastSuccess = $?
        $lastExitCode = $global:LASTEXITCODE
        try {
            & $update $state
        }
        catch {
            Write-Warning 'DevDash prompt integration failed. Run devdash repo directly for diagnostics.'
        }
        finally {
            $global:LASTEXITCODE = $lastExitCode
        }
        if (-not $lastSuccess) {
            # The automatic $? variable is read-only; restore failure before calling the original prompt.
            Write-Error 'Previous command failed.' -ErrorAction Ignore
        }
        & $original
    }.GetNewClosure()
    $state.Wrapper = $wrapper
    $script:DevDashPromptState = $state
    Set-Item -Path Function:\global:prompt -Value $wrapper
}

function Disable-DevDashPrompt {
    [CmdletBinding()]
    param()

    if (-not $script:DevDashPromptState) { return }
    if ((Get-Command prompt -CommandType Function).ScriptBlock -eq $script:DevDashPromptState.Wrapper) {
        Set-Item -Path Function:\global:prompt -Value $script:DevDashPromptState.Original
    }
    $script:DevDashPromptState = $null
}

Export-ModuleMember -Function Enable-DevDashPrompt, Disable-DevDashPrompt
