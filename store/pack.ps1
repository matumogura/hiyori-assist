# Chrome ウェブストアに上げる zip を作る
#   使い方: PowerShell で  .\store\pack.ps1
#   できるもの: store\dist\hiyori-assist-<版>.zip
#
# ・manifest.json の "key" はストアでは使えない（ストアが自分のIDを付ける）ので、zip の中だけ外す
# ・README などの説明や store フォルダは拡張機能に要らないので入れない
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $PSScriptRoot 'dist'
$work = Join-Path $dist 'work'

$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null

$files = @('availability.js', 'background.js', 'content.js', 'create.js', 'hiyori.js', 'ics.js', 'options.html', 'options.js')
foreach ($f in $files) { Copy-Item (Join-Path $root $f) $work }
Copy-Item (Join-Path $root 'icons') (Join-Path $work 'icons') -Recurse

# key の行だけを外した manifest を書く（並びや書き方はそのまま。BOM なしの UTF-8）
$raw = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8
$json = [regex]::Replace($raw, '(?m)^\s*"key"\s*:\s*"[^"]*",\r?\n', '')
if ($json -match '"key"') { throw 'manifest.json の key を外せませんでした' }
[System.IO.File]::WriteAllText((Join-Path $work 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding $false))

$zip = Join-Path $dist "hiyori-assist-$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip
Remove-Item $work -Recurse -Force
Write-Host "できました: $zip"
