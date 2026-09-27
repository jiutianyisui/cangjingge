# 验证 patch-lib.ps1 的 Remove-CangjinggeBlock 在各种边界下都不破坏别人的条目。
# 用法： powershell -ExecutionPolicy Bypass -File tools\test-patch-lib.ps1

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'patch-lib.ps1')

$failures = New-Object System.Collections.Generic.List[string]
$passed = 0

function Assert-Equal {
  param($Actual, $Expected, [string]$Label)
  if ($Actual -eq $Expected) { $script:passed++; return }
  $script:failures.Add($Label + " —— 实际[" + $Actual + "] 期望[" + $Expected + "]")
}
function Assert-True {
  param($Condition, [string]$Label)
  if ($Condition) { $script:passed++; return }
  $script:failures.Add($Label)
}

# ---- 1) 正常：块在中间，前后都有别人的条目 ----
$t1 = @(
  '# 注释'
  '- id: ui-chat'
  '  name: x'
  '# >>> dsh-cangjingge'
  '- id: dsh-cangjingge'
  '  name: dsh-cangjingge'
  '  config:'
  "    libraryDir: 'E:/a'"
  '# <<< dsh-cangjingge'
  '- id: agent-loop'
  '  name: y'
) -join "`n"
$r1 = Remove-CangjinggeBlock -PatchText $t1 -PatchPath 'test'
Assert-Equal $r1.Found $true '1. 找到块'
Assert-True ($r1.Text -notmatch 'cangjingge') '1. 块被摘干净'
Assert-True ($r1.Text -match 'ui-chat') '1. 前面的条目保留'
Assert-True ($r1.Text -match 'agent-loop') '1. **后面的条目保留**（这正是真实事故的场景）'

# ---- 2) 真实事故复现：块的第一行后面夹着别人的条目 ----
$t2 = @(
  '- id: subagent'
  '# >>> dsh-cangjingge'
  '- id: dsh-cangjingge'
  '  name: dsh-cangjingge'
  '  config:'
  "    libraryDir: 'E:/a'"
  '- id: agent-loop'
  '  name: "@deepseek-ai/dsh-agent-loop"'
  '# <<< dsh-cangjingge'
) -join "`n"
$threw = $false
try { Remove-CangjinggeBlock -PatchText $t2 -PatchPath 'test' | Out-Null } catch { $threw = $true }
Assert-True $threw '2. 块里混进别人的条目 -> 抛错拒绝（不静默吞掉）'

# ---- 3) 只有开头没有结尾 -> 抛错 ----
$t3 = @(
  '- id: ui-chat'
  '# >>> dsh-cangjingge'
  '- id: dsh-cangjingge'
  '  name: dsh-cangjingge'
) -join "`n"
$threw3 = $false
try { Remove-CangjinggeBlock -PatchText $t3 -PatchPath 'test' | Out-Null } catch { $threw3 = $true }
Assert-True $threw3 '3. 块未闭合 -> 抛错（旧正则版会一路吞到文件尾）'

# ---- 4) 没有块 -> Found=false，文本原样 ----
$t4 = @('- id: ui-chat', '  name: x') -join "`n"
$r4 = Remove-CangjinggeBlock -PatchText $t4 -PatchPath 'test'
Assert-Equal $r4.Found $false '4. 无块时 Found=false'
Assert-Equal $r4.Text $t4 '4. 无块时文本原样返回'

# ---- 5) 空文本 ----
$r5 = Remove-CangjinggeBlock -PatchText '' -PatchPath 'test'
Assert-Equal $r5.Found $false '5. 空文本 Found=false'
Assert-Equal $r5.Text '' '5. 空文本返回空'

# ---- 6) 幂等：摘两次结果一致 ----
$r6a = Remove-CangjinggeBlock -PatchText $t1 -PatchPath 'test'
$r6b = Remove-CangjinggeBlock -PatchText $r6a.Text -PatchPath 'test'
Assert-Equal $r6b.Text $r6a.Text '6. 幂等（再摘一次结果不变）'

# ---- 7) Get-PatchEntryId ----
Assert-Equal (Get-PatchEntryId '- id: ui-chat') 'ui-chat' '7. 取条目 id'
Assert-Equal (Get-PatchEntryId '  - id: x') 'x' '7. 带缩进也认'
Assert-Equal (Get-PatchEntryId '- id: "quoted"') 'quoted' '7. 去引号'
Assert-Equal (Get-PatchEntryId '  name: y') $null '7. 非条目行返回 null'
Assert-Equal (Get-PatchEntryId '') $null '7. 空行返回 null'

# ---- 8) CRLF 也要处理 ----
$t8 = "- id: ui-chat`r`n# >>> dsh-cangjingge`r`n- id: dsh-cangjingge`r`n# <<< dsh-cangjingge`r`n- id: z"
$r8 = Remove-CangjinggeBlock -PatchText $t8 -PatchPath 'test'
Assert-True ($r8.Text -match 'ui-chat') '8. CRLF：前面条目保留'
Assert-True ($r8.Text -match 'z') '8. CRLF：后面条目保留'

# ---- 结果 ----
if ($failures.Count -gt 0) {
  Write-Host ('patch-lib 测试失败 ' + $failures.Count + ' 项：')
  foreach ($f in $failures) { Write-Host ('  - ' + $f) }
  exit 1
}
Write-Host ('patch-lib: ' + $passed + ' 项通过')
