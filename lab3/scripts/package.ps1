param(
    [string]$StudentId = '学号',
    [string]$StudentName = '姓名',
    [string]$ReportPath = ''
)
$ErrorActionPreference = 'Stop'
$labRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $labRoot '../..'))
if ($StudentId -match '[<>:"/\\|?*]' -or $StudentName -match '[<>:"/\\|?*]') {
    throw '学号或姓名含文件名不支持的字符'
}
$hasReport = -not [string]::IsNullOrWhiteSpace($ReportPath)
if ($hasReport) {
    $resolvedReport = (Resolve-Path -LiteralPath $ReportPath).Path
    if ([IO.Path]::GetExtension($resolvedReport) -ne '.pdf') { throw '报告须为 PDF' }
}
$outputRoot = Join-Path $workspaceRoot '交付'
$runRoot = Join-Path $outputRoot (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
$folderName = "实验3_${StudentId}_${StudentName}"
$submission = Join-Path $runRoot $folderName
$codeRoot = Join-Path $submission 'code'
New-Item -ItemType Directory -Path $codeRoot -Force | Out-Null
foreach ($name in @('src','public','scripts','tests','docs','evidence','package.json','package-lock.json','eslint.config.mjs','.prettierrc.json','.prettierignore','README.md','启动系统.cmd')) {
    Copy-Item -LiteralPath (Join-Path $labRoot $name) -Destination $codeRoot -Recurse
}
Copy-Item -LiteralPath (Join-Path $labRoot 'UML') -Destination $submission -Recurse
if ($hasReport) {
    Copy-Item -LiteralPath $resolvedReport -Destination (Join-Path $submission '实验报告.pdf')
    $zipName = "$folderName.zip"
} else {
    '请独立撰写实验报告.pdf，并填写真实学号姓名后重新打包。当前为待补报告材料包。' |
        Set-Content -LiteralPath (Join-Path $submission '待补报告.txt') -Encoding UTF8
    $zipName = "${folderName}_待补报告.zip"
}
$zipPath = Join-Path $runRoot $zipName
Compress-Archive -LiteralPath $submission -DestinationPath $zipPath
Write-Output "Package: $zipPath"
