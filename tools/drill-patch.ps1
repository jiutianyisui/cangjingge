# 用临时目录完整演练 install.ps1 / uninstall.ps1 的 patch 编辑行为。
# 不进真实 profile。用法： powershell -ExecutionPolicy Bypass -File tools\drill-patch.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'patch-lib.ps1')

$failures = New-Object System.Collections.Generic.List[string]
$passed = 0
function Assert-True { param($c, [string]$l) if ($c) { $script:passed++ } else { $script:failures.Add($l) } }

$tmp = Join-Path $env:TEMP ('cjg-drill-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Write-Block {
  param([string]$Path, [string]$Dir)
  $block = @(
    $CjgBegin
    '- id: dsh-cangjingge'
    '  name: dsh-cangjingge'
    '  config:'
    ("    libraryDir: '" + $Dir + "'")
    $CjgEnd
  ) -join [char]10
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $block + [char]10, $utf8NoBom)
}

# ---- 场景 1：空 patch -> 写入块 ----
$p1 = Join-Path $tmp 's1.yml'
Write-Block -Path $p1 -Dir 'E:/a'
$txt = Get-Content $p1 -Raw -Encoding utf8
Assert-True ($txt -match 'libraryDir: ''E:/a''') '1. 空 patch 写入块'
$r = Remove-CangjinggeBlock -PatchText $txt -PatchPath $p1
Assert-True ($r.Found) '1. 写完后能摘掉'
Assert-True ([string]::IsNullOrWhiteSpace($r.Text)) '1. 摘完为空'

# ---- 场景 2：已有别人的条目 + 我的块 -> 追加后别人的条目还在 ----
$p2 = Join-Path $tmp 's2.yml'
$base = @('- id: ui-chat', '  name: x', '', '- id: subagent', '  name: y') -join [char]10
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($p2, $base + [char]10, $utf8NoBom)

$patchText = Get-Content $p2 -Raw -Encoding utf8
$rm = Remove-CangjinggeBlock -PatchText $patchText -PatchPath $p2
$block = @($CjgBegin, '- id: dsh-cangjingge', '  name: dsh-cangjingge', '  config:', "    libraryDir: 'E:/b'", $CjgEnd) -join [char]10
$final = if ([string]::IsNullOrWhiteSpace($rm.Text)) { $block } else { $rm.Text + [char]10 + [char]10 + $block }
[IO.File]::WriteAllText($p2, $final + [char]10, $utf8NoBom)

$after = Get-Content $p2 -Raw -Encoding utf8
Assert-True ($after -match 'ui-chat') '2. 原有条目 ui-chat 保留'
Assert-True ($after -match 'subagent') '2. 原有条目 subagent 保留'
Assert-True ($after -match "libraryDir: 'E:/b'") '2. 新块写入'
$idCount = ([regex]::Matches($after, '- id: dsh-cangjingge')).Count
Assert-True ($idCount -eq 1) '2. 只有一份本插件条目'

# ---- 场景 3：再跑一次（幂等）----
$patchText3 = Get-Content $p2 -Raw -Encoding utf8
$rm3 = Remove-CangjinggeBlock -PatchText $patchText3 -PatchPath $p2
$final3 = if ([string]::IsNullOrWhiteSpace($rm3.Text)) { $block } else { $rm3.Text + [char]10 + [char]10 + $block }
[IO.File]::WriteAllText($p2, $final3 + [char]10, $utf8NoBom)
$after3 = Get-Content $p2 -Raw -Encoding utf8
Assert-True (([regex]::Matches($after3, '- id: dsh-cangjingge')).Count -eq 1) '3. 幂等：仍只有一份'
Assert-True ($after3 -match 'ui-chat') '3. 幂等：别人的条目仍在'

# ---- 场景 4：块被写坏（夹了别人的条目）-> 拒绝执行 ----
$p4 = Join-Path $tmp 's4.yml'
$broken = @(
  '- id: ui-chat'
  $CjgBegin
  '- id: dsh-cangjingge'
  '  name: dsh-cangjingge'
  '- id: agent-loop'
  $CjgEnd
) -join [char]10
[IO.File]::WriteAllText($p4, $broken + [char]10, $utf8NoBom)
$threw = $false
try { Remove-CangjinggeBlock -PatchText (Get-Content $p4 -Raw -Encoding utf8) -PatchPath $p4 | Out-Null } catch { $threw = $true }
Assert-True $threw '4. 坏块被拒绝（不破坏 agent-loop）'

# ---- 场景 5：备份函数 ----
$bak = Backup-PatchFile -PatchPath $p2
Assert-True ($null -ne $bak -and (Test-Path $bak)) '5. 备份文件生成'
Assert-True ((Get-Content $bak -Raw -Encoding utf8) -eq (Get-Content $p2 -Raw -Encoding utf8)) '5. 备份内容一致'

# ---- 清理 ----
Remove-Item $tmp -Recurse -Force

if ($failures.Count -gt 0) {
  Write-Host ('演练失败 ' + $failures.Count + ' 项：')
  foreach ($f in $failures) { Write-Host ('  - ' + $f) }
  exit 1
}
Write-Host ('演练: ' + $passed + ' 项通过（含真实事故场景）')
