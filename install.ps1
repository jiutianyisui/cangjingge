# 把「藏经阁」装进 DSH 的某个 profile（幂等，可反复运行）。
#
# 本插件**零依赖**（宿主半不 import 任何 @deepseek-ai/*），所以本地挂载
# （junction）是安全的，不需要打 tarball。
#
# 用法：  powershell -ExecutionPolicy Bypass -File .\install.ps1
#         powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web
# 回滚：  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#
# 【重要】不要再往 profile 的 cordis.patch.yml 里插自己的 - insert 块。
#   本包已经在 package.json 里声明了 dsh.bundle.patch，宿主 / 插件管理器会
#   据此把插件行插进来。脚本再插一份会导致重复加载。
#
# 本文件存为 UTF-8 with BOM。Windows PowerShell 5.1 对无 BOM 的 UTF-8 会按
# GBK 解码，中文注释乱码后会把引号配对打乱、直接语法报错。
[CmdletBinding()]
param(
  # 目标 profile 名（desktop = 桌面端当前用的那个；web = dsh web 用的那个）
  [string]$Profile = 'desktop',
  # 书架根目录。不填则沿用 patch 里已有的 libraryDir；都没有就落到
  # ~/.dsh/cangjingge（与原 defaultLibraryDir() 一致）。
  [string]$LibraryDir = '',
  # 即使那个位置是 pnpm 装的真实目录，也强行改成 junction（危险，一般不填）
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# 引入共享的 patch 安全编辑库（逐行扫描，拒绝静默破坏）
. (Join-Path $root 'patch-lib.ps1')
$pkgName = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).name
$profileDir = Join-Path $env:USERPROFILE ('.dsh\profiles\' + $Profile)
if (-not (Test-Path $profileDir)) { throw ('profile 不存在：' + $profileDir) }

$clientBundle = Join-Path $root 'lib\client.js'
if (-not (Test-Path $clientBundle)) { throw 'lib\client.js 不存在：先跑 node tools\build.mjs' }

# ---- 1) node_modules 链接 ------------------------------------------------------
$modules = Join-Path $profileDir 'node_modules'
New-Item -ItemType Directory -Force -Path $modules | Out-Null
$link = Join-Path $modules $pkgName

Get-ChildItem $modules -Force -Filter ($pkgName + '_tmp_*') -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ('cleaned: ' + $_.FullName + '  (pnpm 残留的临时目录)')
}

if (Test-Path $link) {
  $item = Get-Item $link -Force
  $isLink = ($item.LinkType -eq 'Junction') -or ($item.LinkType -eq 'SymbolicLink') -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)

  if (-not $isLink) {
    if (-not $Force) {
      Write-Host ''
      Write-Host ('注意：' + $link + ' 是一个真实目录（由 pnpm / 插件列表安装）。')
      Write-Host 'GitHub 安装与本地挂载是两条互斥的路，不能同时用。'
      Write-Host '已退出，没有改动任何东西。'
      exit 0
    }
    Write-Host ('warn: ' + $link + ' 是真实目录，但指定了 -Force，改为 junction')
    Remove-Item $link -Recurse -Force
  } else {
    $current = @($item.Target)[0]
    if ($current -eq $root) {
      Write-Host ('linked: ' + $link + '  ->  ' + $root + '  (已是最新，跳过)')
    } else {
      $temp = $link + '.new'
      if (Test-Path $temp) { Remove-Item $temp -Force -Recurse }
      New-Item -ItemType Junction -Path $temp -Target $root | Out-Null
      Remove-Item $link -Force -Recurse
      Move-Item $temp $link
      Write-Host ('relinked: ' + $link + '  ->  ' + $root)
    }
  }
}

if (-not (Test-Path $link)) {
  New-Item -ItemType Junction -Path $link -Target $root | Out-Null
  Write-Host ('linked: ' + $link + '  ->  ' + $root)
}

# ---- 2) profile package.json：登记进 dsh.profile.bundles ----------------------
$profilePkgPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path $profilePkgPath)) { throw ('profile 缺 package.json：' + $profilePkgPath) }
$profilePkg = Get-Content $profilePkgPath -Raw -Encoding utf8 | ConvertFrom-Json

if ($null -eq $profilePkg.dsh) { $profilePkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if ($null -eq $profilePkg.dsh.profile) { $profilePkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }

$bundles = @()
if ($null -ne $profilePkg.dsh.profile.bundles) { $bundles = @($profilePkg.dsh.profile.bundles) }
if ($bundles -contains $pkgName) {
  Write-Host ('bundled: ' + $pkgName + '  (已在 dsh.profile.bundles 里，跳过)')
} else {
  $bundles = $bundles + $pkgName
  $profilePkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
  $json = $profilePkg | ConvertTo-Json -Depth 12
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($profilePkgPath, $json + [char]10, $utf8NoBom)
  Write-Host ('bundled: ' + $pkgName + '  ->  dsh.profile.bundles')
}

# ---- 3) 书架目录 + 把 libraryDir 写进 profile patch ---------------------------
#
# 【配置的真实优先级 —— 与插件内部一致】
#   界面设置(settings 文件) > 插件配置(patch 里的 libraryDir) > 内置默认
#
#   所以：**用户若已在界面里设过目录，就不该再往 patch 写** ——
#   写了也永远被界面值盖住，只会变成一条看不懂的"僵尸配置"，
#   下次有人手改它却毫无效果，更难查。
#
# 本脚本取值顺序：
#   1) -LibraryDir 参数（显式指定）
#   2) settings 文件里已有的值（界面设过的）→ **不写 patch**
#   3) patch 里已有的 libraryDir（沿用）
#   4) ~/.dsh/cangjingge（与插件内置默认一致）
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$patchText = ''
if (Test-Path $patchPath) { $patchText = Get-Content $patchPath -Raw -Encoding utf8 }

# 界面设置文件（插件读的那个）
$settingsPath = Join-Path $env:USERPROFILE '.dsh\cangjingge-settings.json'
$settingsDir = $null
if (Test-Path $settingsPath) {
  try {
    $parsed = Get-Content $settingsPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($null -ne $parsed.libraryDir -and -not [string]::IsNullOrWhiteSpace($parsed.libraryDir)) {
      $settingsDir = $parsed.libraryDir
    }
  } catch { Write-Host ('warn: 设置文件解析失败，忽略：' + $settingsPath) }
}

$libDir = $LibraryDir
$skipPatchWrite = $false

if ([string]::IsNullOrWhiteSpace($libDir) -and $null -ne $settingsDir) {
  # 界面已经设过了：沿用，且不写 patch
  $libDir = $settingsDir
  $skipPatchWrite = $true
  Write-Host ('libraryDir: 界面设置已指定 ' + $libDir + '（不改 patch）')
} elseif ([string]::IsNullOrWhiteSpace($libDir)) {
  # 没有显式参数、界面也没设：看 patch 里有没有
  $existing = [regex]::Match($patchText, "(?m)^\s*libraryDir:\s*'?([^'\r\n]+)'?\s*$")
  if ($existing.Success) {
    $libDir = $existing.Groups[1].Value.Trim()
    Write-Host ('libraryDir: 沿用 patch 里已有的配置 ' + $libDir)
  } else {
    $libDir = Join-Path $env:USERPROFILE '.dsh\cangjingge'
  }
}
$libDir = $libDir.Replace('\', '/')

if (-not (Test-Path $libDir)) {
  New-Item -ItemType Directory -Force -Path $libDir | Out-Null
  Write-Host ('created: ' + $libDir)
}

# 写/更新 patch 里的本插件行。
#
# 【为什么先摘后追加，而不用正则跨行替换 —— 真实事故】
#   早先用 `(?s)` + `.*?` 的正则删块，会把夹在块里的、**别人的条目**一起吞掉，
#   写坏整个 profile（所有插件配置失效，藏经阁加载失败）。
#   现在改成 Remove-CangjinggeBlock：逐行扫描，只删自己认得的行，
#   遇到不认识的条目就**抛错拒绝执行**，绝不静默破坏。见 patch-lib.ps1。
# （$patchPath / $patchText 已在上面的「读已有 libraryDir」那段取好，这里不重复取）

if ($skipPatchWrite) {
  # 界面设置已指定目录（优先级更高）：
  #   * 若 patch 里有旧块，清掉它（避免"僵尸配置"误导后来人）
  #   * 然后**不写新块**
  if (Test-Path $patchPath) {
    $bak = Backup-PatchFile -PatchPath $patchPath
    if ($null -ne $bak) { Write-Host ('backup: ' + $bak) }
    $rm = Remove-CangjinggeBlock -PatchText $patchText -PatchPath $patchPath
    if ($rm.Found) {
      [IO.File]::WriteAllText($patchPath, $rm.Text + [char]10, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host 'cleaned: 已移除 patch 里的旧 dsh-cangjingge 块（目录改由界面设置管理）'
    } else {
      Write-Host 'patch: 无本插件配置块，保持不动'
    }
  }
  Write-Host ('书架目录（界面设置）：' + $libDir)
  Write-Host '  想改：在藏经阁面板右上角点「设置」'
} else {
  if (Test-Path $patchPath) {
    $bak = Backup-PatchFile -PatchPath $patchPath
    if ($null -ne $bak) { Write-Host ('backup: ' + $bak) }
  }

  $removed = Remove-CangjinggeBlock -PatchText $patchText -PatchPath $patchPath
  $cleaned = $removed.Text
  if ($removed.Found) { Write-Host 'cleaned: 已摘掉旧的 dsh-cangjingge 块' }

  $block = @(
    $CjgBegin
    '- id: dsh-cangjingge'
    '  name: dsh-cangjingge'
    '  config:'
    ("    libraryDir: '" + $libDir + "'")
    $CjgEnd
  ) -join [char]10

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $finalText = if ([string]::IsNullOrWhiteSpace($cleaned)) { $block } else { $cleaned + [char]10 + [char]10 + $block }
  [IO.File]::WriteAllText($patchPath, $finalText + [char]10, $utf8NoBom)
  Write-Host ('configured: libraryDir = ' + $libDir + '  ->  cordis.patch.yml')
  Write-Host ('书架目录：' + $libDir)
  Write-Host '  结构：分组文件夹 / 子文件夹 / skill 文件(.md/.markdown/.txt)'
  Write-Host '  想改：在藏经阁面板点「设置」（会优先于本配置）'
}

Write-Host ''
Write-Host '装好了。现在：'
Write-Host '  1) 重启桌面端（dsh web 则重启 dsh web 再硬刷新页面）'
Write-Host '  2) 左侧栏出现「小阁楼」图标，点开是三栏书架'
Write-Host '  3) 聊天输入框里打 “/” 打开菜单，选「藏经阁」，即可插入 skill'
Write-Host '  4) 想彻底卸：跑 uninstall.ps1'
Write-Host ''
Write-Host '若要指向别的书架目录（重装时一步到位）：'
Write-Host ("  powershell -ExecutionPolicy Bypass -File .\install.ps1 -LibraryDir 'E:\my\skills'")
