param([string]$OutputDirectory, [string]$PreviewLabel = ('本地预览-' + (Get-Date -Format 'yyyyMMdd') + '-通用浏览器兼容'), [switch]$Release)
$ErrorActionPreference = 'Stop'
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskWorkspace = Split-Path -Parent $taskSource
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $taskWorkspace 'outputs' }
$taskOutputs = [IO.Path]::GetFullPath($OutputDirectory)
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$taskStage = [IO.Path]::GetFullPath((Join-Path $taskWorkspace ('work/package-' + $taskStamp)))
if (-not $taskStage.StartsWith($taskWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Staging path escaped workspace' }
$taskInstall = Join-Path $taskStage 'install/sillytavern_dom_window'
$taskSourcePackage = Join-Path $taskStage 'source/dom-window-compat'
New-Item -ItemType Directory -Force -Path $taskOutputs,$taskInstall,$taskSourcePackage | Out-Null
$taskManifest = Get-Content -LiteralPath (Join-Path $taskSource 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskVersion = $taskManifest.version
$taskRuntimeFiles = @('index.js','render-queue.js','moving-window.js','helper-lifecycle.js','helper-setup.js','runtime-support.js','manifest.json','settings.html','style.css','LICENSE','README.md','CHANGELOG.md')
foreach ($taskFile in $taskRuntimeFiles) {
    Copy-Item -LiteralPath (Join-Path $taskSource $taskFile) -Destination (Join-Path $taskInstall $taskFile)
}
Copy-Item -LiteralPath (Join-Path $taskSource 'docs') -Destination (Join-Path $taskInstall 'docs') -Recurse
$taskFiles = @(git -C $taskSource -c "safe.directory=$($taskSource.Replace('\','/'))" -c core.quotepath=false ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw 'Unable to enumerate repository sources' }
foreach ($taskFile in $taskFiles) {
    $taskInput = [IO.Path]::GetFullPath((Join-Path $taskSource $taskFile))
    $taskDestination = [IO.Path]::GetFullPath((Join-Path $taskSourcePackage $taskFile))
    if (-not $taskInput.StartsWith($taskSource + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source path escaped repository' }
    if (-not $taskDestination.StartsWith($taskSourcePackage + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination path escaped staging' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskDestination) | Out-Null
    Copy-Item -LiteralPath $taskInput -Destination $taskDestination
}
if ($Release) { $taskPackageLabel = $taskVersion }
else {
    if ($PreviewLabel -notmatch '^本地预览-[\p{L}\p{N}-]+$') { throw 'Preview label must be a safe local preview name' }
    $taskPackageLabel = $PreviewLabel
}
$taskInstallZip = Join-Path $taskOutputs ('DOM-Window-' + $taskPackageLabel + '.zip')
$taskSourceZip = Join-Path $taskOutputs ('DOM-Window-完整源码-' + $taskPackageLabel + '.zip')
Compress-Archive -LiteralPath $taskInstall -DestinationPath $taskInstallZip -Force
Compress-Archive -LiteralPath $taskSourcePackage -DestinationPath $taskSourceZip -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Test-TaskZip([string]$ZipPath,[string]$Prefix,[string]$SourcePath,[string[]]$RequiredFiles) {
    $taskArchive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($taskRequired in $RequiredFiles) {
            $taskEntry = $taskArchive.GetEntry($Prefix + '/' + $taskRequired)
            if (-not $taskEntry) { throw ('Missing ZIP entry: ' + $taskRequired) }
            $taskStream = $taskEntry.Open()
            $taskMemory = [IO.MemoryStream]::new()
            try { $taskStream.CopyTo($taskMemory); $taskEntryHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskMemory.ToArray())) }
            finally { $taskStream.Dispose(); $taskMemory.Dispose() }
            $taskFileHash = (Get-FileHash -LiteralPath (Join-Path $SourcePath $taskRequired) -Algorithm SHA256).Hash
            if ($taskEntryHash -ne $taskFileHash) { throw ('ZIP content differs: ' + $taskRequired) }
        }
        return [pscustomobject]@{Name=(Split-Path -Leaf $ZipPath);Entries=$taskArchive.Entries.Count;Bytes=(Get-Item -LiteralPath $ZipPath).Length;SHA256=(Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash}
    } finally { $taskArchive.Dispose() }
}
$taskChecks = @(
    Test-TaskZip $taskInstallZip 'sillytavern_dom_window' $taskSource $taskRuntimeFiles
    Test-TaskZip $taskSourceZip 'dom-window-compat' $taskSource @('index.js','render-queue.js','moving-window.js','helper-lifecycle.js','helper-setup.js','LICENSE','tests/browser.mjs','tests/helper-setup.test.mjs','tests/vendor/jquery.min.js','scripts/package.ps1')
)
$taskChecks | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskOutputs '打包校验.json') -Encoding UTF8
@($taskChecks | ForEach-Object { $_.SHA256 + '  ' + $_.Name }) | Set-Content -LiteralPath (Join-Path $taskOutputs 'SHA256SUMS.txt') -Encoding UTF8
$taskChecks | ConvertTo-Json -Depth 5
