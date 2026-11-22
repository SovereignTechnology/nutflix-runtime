# The Windows tripwire (scripts/pear-ci/tripwire.ts): an outbound Block rule over a few addresses,
# with blocked packets logged. Run by the install job on its throwaway runner, elevated.
#
#   tripwire.ps1 -Action arm    -Addresses a,b,c            prints LOG=<file> and OFFSET=<bytes>
#   tripwire.ps1 -Action read   -Addresses a,b,c -Log f -Offset n     prints the DROP lines for them
#   tripwire.ps1 -Action disarm
param(
  [Parameter(Mandatory = $true)][ValidateSet('arm', 'read', 'disarm')][string]$Action,
  [string]$Addresses = '',
  [string]$Log = '',
  [string]$Offset = '0'
)
$ErrorActionPreference = 'Stop'
$RuleName = 'nutflix-ci-tripwire'
$StateFile = Join-Path $env:RUNNER_TEMP 'nutflix-ci-tripwire-profiles.json'

switch ($Action) {
  'arm' {
    # The firewall service has to be running for any rule to count.
    $svc = Get-Service -Name mpssvc
    if ($svc.Status -ne 'Running') { Start-Service -Name mpssvc }
    Write-Output ('FIREWALL_SERVICE=' + (Get-Service -Name mpssvc).Status)
    # What the profiles were, to put back at the end (the runner is thrown away anyway).
    $before = Get-NetFirewallProfile | Select-Object Name, Enabled, LogBlocked
    $before | ConvertTo-Json -Compress | Set-Content -Path $StateFile
    Write-Output ('PROFILES_BEFORE=' + ($before | ConvertTo-Json -Compress))
    # A rule in a profile that is off blocks nothing: switch every profile on, and log what it drops.
    Set-NetFirewallProfile -Profile Domain, Private, Public -Enabled True -LogBlocked True -LogMaxSizeKilobytes 32767
    Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -Name $RuleName -DisplayName $RuleName -Direction Outbound -Action Block `
      -RemoteAddress ($Addresses -split ',') -Profile Any -Enabled True | Out-Null
    $log = [Environment]::ExpandEnvironmentVariables((Get-NetFirewallProfile -Name Public).LogFileName)
    $offset = 0
    if (Test-Path -LiteralPath $log) { $offset = (Get-Item -LiteralPath $log).Length }
    Write-Output ('LOG=' + $log)
    Write-Output ('OFFSET=' + $offset)
    Write-Output ('RULE=' + ((Get-NetFirewallRule -Name $RuleName | Get-NetFirewallAddressFilter).RemoteAddress -join ','))
  }
  'read' {
    if (-not (Test-Path -LiteralPath $Log)) { exit 0 }
    $addrs = $Addresses -split ','
    $fs = [System.IO.File]::Open($Log, 'Open', 'Read', 'ReadWrite,Delete')
    try {
      [void]$fs.Seek([int64]$Offset, 'Begin')
      $sr = New-Object System.IO.StreamReader($fs)
      $text = $sr.ReadToEnd()
    } finally { $fs.Dispose() }
    foreach ($line in ($text -split "`r?`n")) {
      if ($line -match ' DROP ') {
        foreach ($a in $addrs) { if ($line.Contains(" $a ")) { Write-Output $line; break } }
      }
    }
  }
  'disarm' {
    Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    if (Test-Path -LiteralPath $StateFile) {
      foreach ($p in (Get-Content -Raw $StateFile | ConvertFrom-Json)) {
        $enabled = if ($p.Enabled -eq 1 -or $p.Enabled -eq 'True') { 'True' } else { 'False' }
        $logb = if ($p.LogBlocked -eq 1 -or $p.LogBlocked -eq 'True') { 'True' } else { 'False' }
        Set-NetFirewallProfile -Name $p.Name -Enabled $enabled -LogBlocked $logb
      }
    }
  }
}
