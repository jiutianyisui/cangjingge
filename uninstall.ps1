# 把「藏经阁」从 DSH 的某个 profile 卸掉（与 install.ps1 对称，幂等）。
#
# 用法：  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#         powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Profile web
[CmdletBinding()]
param(
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgName = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).name
$profileDir = Join-Path $env:USERPROFILE ('.dsh\profiles\' + $Profile)
if (-not (Test-Path $profileDir)) { throw ('profile 不存在：' + $profileDir) }

# ---- 1) 摘掉 node_modules 链接 -------------------------------------------------
$link = Join-Path (Join-Path $profileDir 'node_modules') $pkgName
if (Test-Path $link) {
  $item = Get-Item $link -Force
  $isLink = ($item.LinkType -eq 'Junction') -or ($item.LinkType -eq 'SymbolicLink') -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  if ($isLink) {
    Remove-Item $link -Force
    Write-Host ('unlinked: ' + $link)
  } else {
    Write-Host ('保留：' + $link + ' 是真实目录（pnpm 装的），本脚本不动它。')
    Write-Host ('  想清掉请在 profile 里跑：pnpm remove ' + $pkgName)
  }
} else {
  Write-Host ('无需处理：' + $link + ' 不存在')
}

# ---- 2) 从 dsh.profile.bundles 摘掉 --------------------------------------------
$profilePkgPath = Join-Path $profileDir 'package.json'
if (Test-Path $profilePkgPath) {
  $profilePkg = Get-Content $profilePkgPath -Raw -Encoding utf8 | ConvertFrom-Json
  if ($null -ne $profilePkg.dsh -and $null -ne $profilePkg.dsh.profile -and $null -ne $profilePkg.dsh.profile.bundles) {
    $bundles = @($profilePkg.dsh.profile.bundles)
    if ($bundles -contains $pkgName) {
      $kept = @($bundles | Where-Object { $_ -ne $pkgName })
      $profilePkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $kept -Force
      $json = $profilePkg | ConvertTo-Json -Depth 12
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [IO.File]::WriteAllText($profilePkgPath, $json + [char]10, $utf8NoBom)
      Write-Host ('unbundled: ' + $pkgName)
    } else {
      Write-Host ('无需处理：dsh.profile.bundles 里没有 ' + $pkgName)
    }
  }
}

# ---- 3) 清掉安装脚本写进 patch 的配置段 ---------------------------------------
# 安装时写的是 `# >>> dsh-cangjingge` / `# <<< dsh-cangjingge` 成对标记块。
# 不清掉的话，卸载后 patch 里会留一段指向本插件的孤儿配置 ——
# 下次装回来时会因为「已有 libraryDir」而沿用旧值，看起来正常但很脏。
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path $patchPath) {
  $patch = Get-Content $patchPath -Raw -Encoding utf8
  $begin = '# >>> dsh-cangjingge'
  $end = '# <<< dsh-cangjingge'
  $own = [regex]::Escape($begin) + '(?s).*?' + [regex]::Escape($end) + '\r?\n?'
  $cleaned = [regex]::Replace($patch, $own, '').TrimEnd() + [char]10
  if ($cleaned -ne $patch) {
    [IO.File]::WriteAllText($patchPath, $cleaned, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host 'cleaned: cordis.patch.yml 里的 dsh-cangjingge 配置段已移除'
  } else {
    Write-Host 'cleaned: cordis.patch.yml 里没有本插件的配置段，跳过'
  }
}

Write-Host ''
Write-Host '卸掉了。重启桌面端后左侧栏的小阁楼图标会消失。'
Write-Host '（藏经阁目录与 skill 文件不会被删除。）'
