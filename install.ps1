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
# 【为什么必须写进 patch】
#   插件默认扫 ~/.dsh/cangjingge。如果用户的书架空在别处（很常见），
#   不写这条配置，界面就是**空的而且不报错** —— 这类"静默为空"最难查。
#   所以安装脚本负责把配置一并落位，而不是留给用户手改。
#
# 目录优先级：
#   1) -LibraryDir 参数（显式指定）
#   2) 已存在于 patch 里的 libraryDir（不覆盖用户已有的设置）
#   3) ~/.dsh/cangjingge（与原 defaultLibraryDir() 一致，通用位置）
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$patchText = ''
if (Test-Path $patchPath) { $patchText = Get-Content $patchPath -Raw -Encoding utf8 }

$libDir = $LibraryDir
if ([string]::IsNullOrWhiteSpace($libDir)) {
  # 已有配置就沿用，不覆盖
  $existing = [regex]::Match($patchText, "(?m)^\s*libraryDir:\s*'?([^'\r\n]+)'?\s*$")
  if ($existing.Success) {
    $libDir = $existing.Groups[1].Value.Trim()
    Write-Host ('libraryDir: 沿用已有配置 ' + $libDir)
  } else {
    $libDir = Join-Path $env:USERPROFILE '.dsh\cangjingge'
  }
}
$libDir = $libDir.Replace('\', '/')

if (-not (Test-Path $libDir)) {
  New-Item -ItemType Directory -Force -Path $libDir | Out-Null
  Write-Host ('created: ' + $libDir)
}

# 写/更新 patch 里的本插件行（先删旧段再追加，保证幂等且不重复）
$begin = '# >>> dsh-cangjingge'
$end = '# <<< dsh-cangjingge'
$own = [regex]::Escape($begin) + '(?s).*?' + [regex]::Escape($end) + '\r?\n?'
$cleaned = [regex]::Replace($patchText, $own, '').TrimEnd()
$block = @(
  $begin
  '- id: dsh-cangjingge'
  '  name: dsh-cangjingge'
  '  config:'
  ("    libraryDir: '" + $libDir + "'")
  $end
) -join [char]10
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($patchPath, $cleaned + [char]10 + [char]10 + $block + [char]10, $utf8NoBom)
Write-Host ('configured: libraryDir = ' + $libDir)
Write-Host ('书架目录：' + $libDir)
Write-Host '  结构：分组文件夹 / 子文件夹 / skill 文件(.md/.markdown/.txt)'

Write-Host ''
Write-Host '装好了。现在：'
Write-Host '  1) 重启桌面端（dsh web 则重启 dsh web 再硬刷新页面）'
Write-Host '  2) 左侧栏出现「小阁楼」图标，点开是三栏书架'
Write-Host '  3) 聊天输入框里打 “/” 打开菜单，选「藏经阁」，即可插入 skill'
Write-Host '  4) 想彻底卸：跑 uninstall.ps1'
Write-Host ''
Write-Host '若要指向别的书架目录（重装时一步到位）：'
Write-Host ("  powershell -ExecutionPolicy Bypass -File .\install.ps1 -LibraryDir 'E:\my\skills'")
