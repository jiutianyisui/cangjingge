# 藏经阁安装/卸载脚本共用的「patch 安全编辑」库。
#
# 【为什么需要它 —— 真实事故】
#   早先 install.ps1 用一行正则替换标记块：
#     $own = [regex]::Escape($begin) + '(?s).*?' + [regex]::Escape($end)
#   `(?s)` 让 `.` 匹配换行，`.*?` 又只要求"到第一个 <<< 为止"。于是：
#     * 若块只剩开头没结尾，它会一路吞到文件尾；
#     * 若块后面紧跟别的条目，被夹进去的内容会**一起被删掉**。
#   实测把用户 patch 里的 `agent-loop` 条目夹进了块内，写坏整个 profile ——
#   表现是**所有插件配置失效、藏经阁加载失败**，最难查的一类故障。
#
# 【现在的做法：逐行扫描 + 只删自己认得的行】
#   删除时逐行读，只把「标记块内、且是我们已知的那几行」丢掉；
#   一旦在块内遇到不认识的条目就**报错退出**，绝不静默吞掉任何东西。
#   宁可拒绝执行，也不能破坏用户的配置。
#
# 本文件不导出函数（PowerShell 的 dot-source 语义就够了）：调用方用
#   . (Join-Path $PSScriptRoot 'patch-lib.ps1')
# 引入后直接用下面这些函数。

# 本插件在 patch 里的标记块注释。
$script:CjgBegin = '# >>> dsh-cangjingge'
$script:CjgEnd = '# <<< dsh-cangjingge'

<#
.SYNOPSIS
  从一行文本里取出它的「归属条目 id」（形如 `- id: xxx` 的顶层行）。
.DESCRIPTION
  用于判断块内是否混进了别人的条目。非条目行返回 $null。
#>
function Get-PatchEntryId {
  param([string]$Line)
  if ($null -eq $Line) { return $null }
  $m = [regex]::Match($Line, '^\s*-\s+id:\s*(.+?)\s*$')
  if (-not $m.Success) { return $null }
  return $m.Groups[1].Value.Trim().Trim('"').Trim("'")
}

<#
.SYNOPSIS
  把 patch 文本里本插件的标记块安全地摘掉。
.DESCRIPTION
  逐行扫描。遇到 `# >>> dsh-cangjingge` 进入块内，直到 `# <<< dsh-cangjingge`。
  块内**只允许**出现本插件自己的行（标记、`- id: dsh-cangjingge`、`name:`、
  `config:`、`libraryDir:`、以及空行/缩进行）。出现任何别人的条目 -> 抛错。

  返回摘掉块之后的文本（保留其余内容原样，只 trim 末尾空白）。
#>
function Remove-CangjinggeBlock {
  param(
    [string]$PatchText,
    [string]$PatchPath
  )
  $lines = @()
  if (-not [string]::IsNullOrEmpty($PatchText)) {
    $lines = $PatchText -split "`r?`n"
  }

  $out = New-Object System.Collections.Generic.List[string]
  $inside = $false
  $found = $false

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    $trimmed = $line.Trim()

    if (-not $inside) {
      if ($trimmed -eq $script:CjgBegin) { $inside = $true; $found = $true; continue }
      $out.Add($line)
      continue
    }

    # ---- 块内 ----
    if ($trimmed -eq $script:CjgEnd) { $inside = $false; continue }

    # 块内出现「另一个条目」= 块被写坏了，拒绝继续
    $entryId = Get-PatchEntryId $line
    if ($null -ne $entryId -and $entryId -ne 'dsh-cangjingge') {
      throw ('patch 的 ' + $script:CjgBegin + ' 块里混进了别的条目（' + $entryId + '），位置：' + $PatchPath + ' 第 ' + ($i + 1) + ' 行。' + [char]10 +
             '这通常说明上一次写入被中断了。请先手工修复该块再重试 —— 脚本不会替你猜测。')
    }

    # 其余块内行一律丢弃（都是我们自己的）
  }

  if ($inside) {
    throw ('patch 里的 ' + $script:CjgBegin + ' 没有对应的 ' + $script:CjgEnd + '，位置：' + $PatchPath + '。' + [char]10 +
           '请先手工补齐结尾标记再重试。')
  }

  return @{ Text = ($out -join [char]10).TrimEnd(); Found = $found }
}

<#
.SYNOPSIS
  给 patch 文件做一次带时间戳的备份。
.DESCRIPTION
  写之前一定要备份 —— 万一逻辑仍有缺陷，用户至少能恢复。
  返回备份路径（文件不存在时返回 $null）。
#>
function Backup-PatchFile {
  param([string]$PatchPath)
  if (-not (Test-Path $PatchPath)) { return $null }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bak = $PatchPath + '.bak-' + $stamp
  Copy-Item $PatchPath $bak -Force
  return $bak
}
