# What Windows says about an installed package, and whether a running process belongs to it.
#
#   package-info.ps1 -Name SovereignTechnology.Nutflix                 prints PACKAGE=<json> or PACKAGE=NONE
#   package-info.ps1 -Name ... -ProcessId n                            also PROCESS_PACKAGE=<full name> | NONE
#   package-info.ps1 -Name ... -Remove                                 removes the package
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$ProcessId = 0,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$pkg = Get-AppxPackage -Name $Name
if ($Remove) {
  if ($pkg) { $pkg | Remove-AppxPackage }
  exit 0
}
if (-not $pkg) { Write-Output 'PACKAGE=NONE' } else {
  $o = $pkg | Select-Object -First 1 Name, Version, Publisher, PackageFamilyName, PackageFullName, `
    SignatureKind, Status, InstallLocation, IsDevelopmentMode, Architecture
  Write-Output ('PACKAGE=' + ($o | ConvertTo-Json -Compress))
}
if ($ProcessId -gt 0) {
  Add-Type -Namespace Nutflix -Name Appmodel -MemberDefinition @'
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int GetPackageFullName(System.IntPtr hProcess, ref int length, System.Text.StringBuilder name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern System.IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(System.IntPtr handle);
'@
  # PROCESS_QUERY_LIMITED_INFORMATION
  $h = [Nutflix.Appmodel]::OpenProcess(0x1000, $false, $ProcessId)
  if ($h -eq [System.IntPtr]::Zero) { Write-Output 'PROCESS_PACKAGE=UNREADABLE' } else {
    $len = 0
    $rc = [Nutflix.Appmodel]::GetPackageFullName($h, [ref]$len, $null)
    if ($rc -eq 15700) { Write-Output 'PROCESS_PACKAGE=NONE' }
    elseif ($rc -eq 122) {
      $sb = New-Object System.Text.StringBuilder $len
      $rc = [Nutflix.Appmodel]::GetPackageFullName($h, [ref]$len, $sb)
      if ($rc -eq 0) { Write-Output ('PROCESS_PACKAGE=' + $sb.ToString()) } else { Write-Output ('PROCESS_PACKAGE=ERROR' + $rc) }
    } else { Write-Output ('PROCESS_PACKAGE=ERROR' + $rc) }
    [void][Nutflix.Appmodel]::CloseHandle($h)
  }
}
