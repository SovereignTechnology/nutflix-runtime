# An ephemeral self-signed code-signing certificate for the TEST .msix, made in the install job
# and trusted only on that runner (the machine's Trusted People store, so that Add-AppxPackage
# accepts the signature). The key is not exportable and is never written to a file; only the
# public certificate is, and the job removes both at the end.
#
#   test-cert.ps1 -Action new    -Subject 'CN=...' -CerPath f.cer     prints THUMBPRINT=... SUBJECT=...
#   test-cert.ps1 -Action remove -Thumbprint t
param(
  [Parameter(Mandatory = $true)][ValidateSet('new', 'remove')][string]$Action,
  [string]$Subject = '',
  [string]$CerPath = '',
  [string]$Thumbprint = ''
)
$ErrorActionPreference = 'Stop'
switch ($Action) {
  'new' {
    $cert = New-SelfSignedCertificate -Type Custom -Subject $Subject -KeyUsage DigitalSignature `
      -KeyExportPolicy NonExportable -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
      -FriendlyName 'nutflix-ci-ephemeral-test' -NotAfter (Get-Date).AddDays(2) `
      -CertStoreLocation 'Cert:\CurrentUser\My' `
      -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    Export-Certificate -Cert $cert -FilePath $CerPath | Out-Null
    Import-Certificate -FilePath $CerPath -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
    Write-Output ('THUMBPRINT=' + $cert.Thumbprint)
    Write-Output ('SUBJECT=' + $cert.Subject)
  }
  'remove' {
    foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\TrustedPeople') {
      Get-ChildItem $store | Where-Object { $_.Thumbprint -eq $Thumbprint } | Remove-Item -Force
    }
  }
}
