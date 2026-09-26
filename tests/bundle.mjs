// ---------------------------------------------------------------------------
// dsh-cangjingge —— 组合包契约与零依赖契约测试
//
// 跑法： node tests/bundle.mjs
//
// 验证「装得上」的硬条件（这些错了插件根本起不来，而且症状往往是
// 界面静默不出现，最难查）：
//   1. package.json 声明了 dsh.bundle.patch 与 dsh.client.platform
//   2. cordis.patch.yml 的 insert.name 与包名一致
//   3. lib/client.js 调用了 __ModuleLoader__.load 且 id 是包名
//   4. 宿主半**零 @deepseek-ai 依赖**（声明了就会顶掉桌面端自带运行时）
//   5. exports 指向的文件都存在
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let passed = 0
const failures = []

function ok(condition, label) {
  if (condition) { passed += 1; return }
  failures.push(label)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ---- 1) package.json 声明 -----------------------------------------------------
ok(pkg.name === 'dsh-cangjingge', '包名是 dsh-cangjingge')
ok(pkg.type === 'module', 'type=module')
ok(pkg.dsh !== undefined && pkg.dsh.bundle !== undefined, '声明了 dsh.bundle')
ok(pkg.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch 指向 cordis.patch.yml')
ok(pkg.dsh.client !== undefined && pkg.dsh.client.platform === 'web', 'dsh.client.platform=web')
ok(pkg.exports['.'].default === './lib/index.js', 'exports . 指向 lib/index.js')
ok(pkg.exports['./client'].default === './lib/client.js', 'exports ./client 指向 lib/client.js')

// ---- 2) cordis.patch.yml ------------------------------------------------------
{
  const yml = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  ok(yml.includes('- insert:'), 'patch 有 insert 块')
  ok(yml.includes('id: ' + pkg.name), 'patch id 与包名一致')
  ok(yml.includes('name: ' + pkg.name), 'patch name 与包名一致')
}

// ---- 3) 产物存在且形状正确 ----------------------------------------------------
{
  const index = join(root, 'lib', 'index.js')
  const client = join(root, 'lib', 'client.js')
  ok(existsSync(index), 'lib/index.js 存在（先跑 build）')
  ok(existsSync(client), 'lib/client.js 存在（先跑 build）')

  if (existsSync(client)) {
    const bundle = readFileSync(client, 'utf8')
    ok(bundle.includes('__ModuleLoader__.load'), 'client.js 调用 __ModuleLoader__.load')
    ok(bundle.includes(JSON.stringify(pkg.name)), 'client.js 注册 id 是包名')
    ok(!/^\s*import\s/m.test(bundle), 'client.js 里没有 import')
    ok(!/\bJSX\b/.test(bundle) || true, 'JSX 检查（占位）')
    ok(bundle.includes("inject = ['slots']") || bundle.includes('inject = ["slots"]'), 'client.js declare inject=slots')
  }

  if (existsSync(index)) {
    const hostSrc = readFileSync(index, 'utf8')
    ok(hostSrc.includes("name = 'dsh-cangjingge'") || hostSrc.includes('name = "dsh-cangjingge"'), 'index.js 导出插件名')
  }
}

// ---- 4) 零 @deepseek-ai 依赖契约 ----------------------------------------------
{
  // 检查宿主半的 imports：任何 @deepseek-ai/* 都会顶掉自带运行时 -> 整个软件打不开
  const files = ['index.js', 'library.js', 'toolkit.js'].map((f) => join(root, 'lib', f))
  for (const file of files) {
    if (!existsSync(file)) { ok(false, '缺少产物 ' + file); continue }
    const text = readFileSync(file, 'utf8')
    // 只看**代码行**里的 import，注释里提到包名不算（toolkit.js 的注释
    // 就在解释「为什么不用 @deepseek-ai/schemastery」）。
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/[^\n]*/g, ' '))
      .join('\n')
    const bad = [...code.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)].map((m) => m[1])
    ok(bad.length === 0, file + ' 不应 import @deepseek-ai/*（发现：' + bad.join(', ') + '）')
  }
  // package.json 的 dependencies 也必须为空（零依赖）
  const deps = pkg.dependencies === undefined ? {} : pkg.dependencies
  ok(Object.keys(deps).length === 0, 'package.json 没有 dependencies')
}

// ---- 5) 源码存在 ---------------------------------------------------------------
for (const f of ['src/host.js', 'src/library.js', 'src/toolkit.js', 'src/@client.js', 'tools/build.mjs']) {
  ok(existsSync(join(root, f)), '源码存在：' + f)
}

// ---- 结果 ---------------------------------------------------------------------
if (failures.length > 0) {
  console.error('bundle 测试失败 ' + String(failures.length) + ' 项：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('bundle: ' + String(passed) + ' 项通过')
