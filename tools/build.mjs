// ---------------------------------------------------------------------------
// 装配 dsh-cangjingge 的 lib\ 产物。
//
// 用法：  node tools\build.mjs
//
// 产出两个文件：
//   lib\index.js    —— 宿主半：直接把 src\host.js 拷过去（标准 ESM）
//   lib\library.js  —— 纯函数层（host.js 依赖它）
//   lib\toolkit.js  —— 零依赖配置层（host.js 依赖它）
//   lib\client.js   —— 浏览器半：把 src\library.js + src\@client.js 拼进
//                      window.__ModuleLoader__.load({ id, factory }) 的 factory 里
//                      （CJS closure-factory，不能有 import/export）
//
// 装配模型沿用天枢踩出来的那套：每段各自套一层 IIFE，段间用显式的
// need / carry 名单交接，最后把最后一段的导出作为 factory 返回值。
//
// 源码编码：.js 存成 UTF-8 with BOM 也没关系 —— 这里逐段剥掉各自的 BOM，
// 否则第二段起残留的 \uFEFF 会把注释和代码粘成一行（症状极隐蔽）。
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'src')
const lib = join(root, 'lib')

/**
 * 浏览器半的段定义。
 *
 * library.js 是纯函数层，@client.js 复用它的状态判定与候选构造逻辑。
 * 这里 kernel 交出的是**浏览器安全的纯函数子集** —— library.js 本身不 import
 * 任何 node: 模块，所以整段可以用；toolkit.js 也行（但不必要）。
 */
const PARTS = [
  {
    file: 'library.js',
    need: [],
    carry: [
      'SKILL_EXTENSIONS', 'SKILL_MAX_BYTES', 'MAX_ENTRIES_PER_DIR',
      'isSkillFile', 'visibleEntries', 'shelfView', 'skillInsertText',
      'skillCandidates', 'parseCandidateValue',
      'VISIBLE_FILE_NAME', 'normalizeVisible', 'isVisible', 'withVisible', 'visibleSkills', 'litSkills',
      'filterCandidates',
      'SETTINGS_FILE_NAME', 'normalizeSettings', 'pickLibraryDir', 'validateLibraryDir',
    ],
  },
  {
    file: '@client.js',
    need: [
      'SKILL_EXTENSIONS', 'SKILL_MAX_BYTES', 'MAX_ENTRIES_PER_DIR',
      'isSkillFile', 'visibleEntries', 'shelfView', 'skillInsertText',
      'skillCandidates', 'parseCandidateValue',
      'VISIBLE_FILE_NAME', 'normalizeVisible', 'isVisible', 'withVisible', 'visibleSkills', 'litSkills',
      'filterCandidates',
      'SETTINGS_FILE_NAME', 'normalizeSettings', 'pickLibraryDir', 'validateLibraryDir',
    ],
    carry: [],
  },
]

function fail(message) {
  console.error('装配失败：' + message)
  process.exit(1)
}

/**
 * 把一段 ESM 源码转成可放进 IIFE 的 CJS 风格源码。
 * 只处理本插件实际用到的形态：顶部的 `export function` / `export const`
 * / `export class`，以及行尾的 `export { ... }`。
 * @param body - 源码文本。
 * @param file - 文件名（报错用）。
 * @param carry - 本段声明要交出的名字。
 * @returns 转换后的源码。
 */
function esmToIifeBody(body, file, carry) {
  if (/^\s*import\s/m.test(body)) {
    fail(file + ' 里出现了 import：浏览器半不能用模块语法')
  }

  let out = body
  out = out.replace(/^export\s+function\s+/gm, 'function ')
  out = out.replace(/^export\s+(const|let|var)\s+/gm, '$1 ')
  out = out.replace(/^export\s+class\s+/gm, 'class ')
  out = out.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')

  if (/^export\s/m.test(out)) {
    fail(file + ' 里还有没处理掉的顶层 export（检查是否有 export default 之类）')
  }

  for (const key of carry) {
    const defined = new RegExp('^\\s*(?:function|class)\\s+' + key + '\\b', 'm').test(out)
      || new RegExp('^\\s*(?:const|let|var)\\s+' + key + '\\b', 'm').test(out)
    if (!defined) fail(file + ' 声明要交出 ' + key + '，但没有定义它')
  }

  return out
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
mkdirSync(lib, { recursive: true })

// ---- 宿主半：拷贝 host.js 及其内部依赖模块 ------------------------------------
// host.js 是标准 ESM，内部 import 了 ./library.js 与 ./toolkit.js。
// 这两个也必须一起放进 lib\，否则装进 profile 后运行时会报
// "Cannot find module .../lib/library.js"。
// 注意 library.js 同时被浏览器半使用（那是另一份内联副本），互不影响。
const HOST_MODULES = ['host.js', 'library.js', 'toolkit.js']
for (const file of HOST_MODULES) {
  const from = join(src, file)
  if (!existsSync(from)) fail('缺源码：' + from)
  const target = file === 'host.js' ? 'index.js' : file
  copyFileSync(from, join(lib, target))
}

// ---- 浏览器半：按段装配 -------------------------------------------------------
const bodies = []
const carried = new Set()

PARTS.forEach((part, index) => {
  const path = join(src, part.file)
  if (!existsSync(path)) fail('缺源码：' + path)
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')

  if (/^\s*<\w/m.test(raw)) fail(part.file + ' 里出现了疑似 JSX：React 元素一律 React.createElement')

  const body = esmToIifeBody(raw, part.file, part.carry)

  for (const key of part.need) {
    if (!carried.has(key)) fail(part.file + ' 需要 ' + key + '，但上一段没有提供（检查 PARTS 顺序与 carry 名单）')
  }

  bodies.push('// ==== src/' + part.file + ' ====')
  bodies.push('var __part' + index + ' = (function () {')
  bodies.push('  var module = { exports: {} };')
  bodies.push('  var exports = module.exports;')
  if (part.need.length > 0) {
    bodies.push('  var { ' + part.need.join(', ') + ' } = __part' + (index - 1) + ';')
  }
  for (const line of body.trimEnd().split(/\r?\n/)) bodies.push('  ' + line)
  if (part.carry.length > 0) {
    bodies.push('  Object.assign(module.exports, { ' + part.carry.join(', ') + ' });')
  }
  bodies.push('  return module.exports')
  bodies.push('})();')
  for (const key of part.carry) carried.add(key)
  bodies.push('')
})

const header = [
  '// 本文件由 tools\\build.mjs 生成，请勿直接修改',
  '// 组成：src\\library.js（纯函数书架模型） + src\\@client.js（三栏 UI 与触发 source）',
  'window.__ModuleLoader__.load({',
  '  id: ' + JSON.stringify(pkg.name) + ',',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
]
const footer = ['    return __part' + (PARTS.length - 1) + ';', '  },', '});', '']

const bundle = header.concat(bodies, footer).join('\n')
const outPath = join(lib, 'client.js')
writeFileSync(outPath, bundle, 'utf8')

// ---- 自检 1：语法能不能过（等价于 node --check）--------------------------------
try {
  new vm.Script(bundle, { filename: outPath })
} catch (error) {
  fail('产出的 lib\\client.js 语法不过：' + error.message)
}

// ---- 自检 2：在假环境里真跑一遍，确认 factory 返回了 apply / inject -------------
const registered = { entry: null }
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (value) => [value, () => {}],
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { registered.entry = entry } }, innerWidth: 1280, innerHeight: 800 },
  console,
  require: () => fakeReact,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  document: { visibilityState: 'visible' },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
}
sandbox.globalThis = sandbox
try {
  vm.runInNewContext(bundle, sandbox, { filename: outPath })
} catch (error) {
  fail('产出在加载时报错：' + error.message)
}
if (registered.entry === null) fail('产出没有调用 window.__ModuleLoader__.load')
if (registered.entry.id !== pkg.name) fail('注册的 id 不是 ' + pkg.name + '，实际是 ' + String(registered.entry.id))

let exported = null
try {
  exported = registered.entry.factory(sandbox.require)
} catch (error) {
  fail('factory 执行报错：' + error.message)
}
if (typeof exported.apply !== 'function') fail('factory 没有返回 apply（段间对接错了）')
// inject 必须**同时**含 slots 与 inputTriggers：
//   - slots：侧栏图标与主面板的槽位注册
//   - inputTriggers：`/` 菜单的 source 注册（漏了它打 / 就看不到藏经阁）
{
  const want = ['slots', 'inputTriggers']
  const got = Array.isArray(exported.inject) ? exported.inject.slice() : []
  const missing = want.filter((k) => !got.includes(k))
  if (missing.length > 0) {
    fail('inject 缺少 ' + JSON.stringify(missing) + '，实际是 ' + JSON.stringify(got)
      + '（inputTriggers 漏了会导致 `/` 菜单里没有藏经阁）')
  }
}
for (const key of ['__view', '__const']) {
  if (exported[key] === undefined || exported[key] === null) fail('缺少测试钩子 ' + key)
}
if (exported.__const.PANEL_ID !== 'cangjingge') fail('PANEL_ID 不是 cangjingge')
if (typeof exported.__view.ShelfPanel !== 'function') fail('ShelfPanel 没有正确导出')
if (typeof exported.__view.PanelIcon !== 'function') fail('PanelIcon 没有正确导出')

// library 段的纯函数必须真的能用（不然装上去「书架永远空」，最难查）
{
  const probe = exported
  const entries = probe.__view
  // shelfView / visibleEntries 通过 __const 暴露不了函数，直接测 source 侧
  // 由 tests/library.mjs 覆盖；这里只确认 __view 存在。
  if (entries === undefined) fail('__view 不可用')
}

// ---- 自检 3：槽位注册必须走 ctx.slots.inject(...) 包裹 ------------------------
{
  const clientRaw = readFileSync(join(src, '@client.js'), 'utf8')
  const codeOnly = clientRaw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/[^\n]*/g, ' '))
    .join('\n')
  if (!/ctx\.slots\.inject\s*\(/.test(codeOnly)) {
    fail('@client.js 里没有 ctx.slots.inject( —— 书架图标与主面板就没注册上')
  }
  const lines = codeOnly.split('\n')
  let insideInject = 0
  for (const line of lines) {
    if (/ctx\.slots\.inject\s*\(/.test(line)) insideInject += 1
    if (/ctx\.slots\.register\s*\(/.test(line) && insideInject === 0) {
      fail('@client.js 里有裸的 ctx.slots.register( —— 必须用 '
        + 'ctx.slots.inject(<slot>, () => ctx.slots.register(...)) 包裹')
      break
    }
  }
}

// ---- 自检 4：自由标识符检查（obj.method() 里的 obj 也要查）-------------------
{
  const clientRaw = readFileSync(join(src, '@client.js'), 'utf8')
  const libRaw = readFileSync(join(src, 'library.js'), 'utf8')

  const stripLine = (line) => {
    let out = ''
    let quote = null
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (quote !== null) {
        if (ch === '\\') { i += 1; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '\x60') { quote = ch; out += '""'; continue }
      out += ch
    }
    return out
  }
  const strip = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => stripLine(line.replace(/\/\/[^\n]*/g, ' ')))
    .join('\n')

  const clientCode = strip(clientRaw)
  const libCode = strip(libRaw)

  const defined = new Set()
  const add = (re, text) => { for (const m of text.matchAll(re)) defined.add(m[1]) }
  for (const text of [clientCode, libCode]) {
    add(/\bfunction\s+([A-Za-z_$][\w$]*)/g, text)
    add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, text)
    add(/\bfunction\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g, text)
    for (const m of text.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
      for (const part of m[1].split(',')) {
        const name = part.split('=')[0].trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name)
      }
    }
    for (const m of text.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
      for (const part of m[1].split(',')) {
        const name = part.split(':').pop().trim().replace(/=.*$/, '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name)
      }
    }
    add(/\(([A-Za-z_$][\w$]*)\s*[,)]/g, text)
    for (const m of text.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const part of m[1].split(',')) {
        const name = part.split('=')[0].trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name)
      }
    }
    add(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, text)
    add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g, text)
    add(/[{,]\s*([A-Za-z_$][\w$]*)\s*[:(]/g, text)
  }

  const carriedNames = new Set((PARTS.find((p) => p.file === '@client.js') || { need: [] }).need)
  const globals = new Set(['React', 'require', 'module', 'exports', 'window', 'document', 'localStorage', 'console',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
    'URL', 'Blob', 'Image', 'FileReader', 'fetch', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
    'Date', 'Set', 'Map', 'Promise', 'RegExp', 'Error', 'TypeError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent', 'undefined', 'NaN', 'Infinity', 'Function', 'Symbol', 'WeakMap',
    'WeakSet', 'matchMedia', 'devicePixelRatio', 'navigator', 'performance', 'queueMicrotask',
    'this', 'true', 'false', 'null'])

  const receivers = new Set()
  for (const m of clientCode.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$]/g)) {
    receivers.add(m[1])
  }

  const missing = [...receivers]
    .filter((name) => !defined.has(name) && !carriedNames.has(name) && !globals.has(name))
    .sort()

  if (missing.length > 0) {
    fail('@client.js 里引用了未定义的对象：' + missing.join(', ')
      + '（`xxx.yyy()` 里的 xxx 必须有定义）')
  }
}

// ---- 自检 5：@client.js 用到、但既没定义也没从上一段拿到的名字 ----------------
{
  const clientRaw = readFileSync(join(src, '@client.js'), 'utf8')
  const libRaw = readFileSync(join(src, 'library.js'), 'utf8')

  const stripLine = (line) => {
    let out = ''
    let quote = null
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (quote !== null) {
        if (ch === '\\') { i += 1; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '\x60') { quote = ch; out += '""'; continue }
      out += ch
    }
    return out
  }
  const strip = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => stripLine(line.replace(/\/\/[^\n]*/g, ' ')))
    .join('\n')

  const clientCode = strip(clientRaw)
  const libCode = strip(libRaw)

  const defined = new Set()
  const add = (re, text) => { for (const m of text.matchAll(re)) defined.add(m[1]) }
  for (const text of [clientCode, libCode]) {
    add(/\bfunction\s+([A-Za-z_$][\w$]*)/g, text)
    add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, text)
    add(/\bfunction\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g, text)
    for (const m of text.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
      for (const part of m[1].split(',')) {
        const name = part.split('=')[0].trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name)
      }
    }
    for (const m of text.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
      for (const part of m[1].split(',')) {
        const name = part.split(':').pop().trim().replace(/=.*$/, '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name)
      }
    }
    add(/\(([A-Za-z_$][\w$]*)\s*[,)]/g, text)
    for (const m of text.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const part of m[1].split(',')) {
        const name = part.split('=')[0].trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name)
      }
    }
    add(/([A-Za-z_$][\w$]*)\s*=>/g, text)
    add(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, text)
    add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g, text)
  }

  const carriedNames = new Set((PARTS.find((p) => p.file === '@client.js') || { need: [] }).need)
  const globals = new Set(['React', 'require', 'module', 'exports', 'window', 'document', 'localStorage', 'console',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
    'URL', 'Blob', 'Image', 'FileReader', 'fetch', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
    'Date', 'Set', 'Map', 'Promise', 'RegExp', 'Error', 'TypeError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent', 'undefined', 'NaN', 'Infinity', 'Function', 'Symbol', 'WeakMap',
    'WeakSet', 'matchMedia', 'devicePixelRatio', 'navigator', 'performance', 'queueMicrotask', 'Buffer',
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'delete', 'void',
    'in', 'of', 'do', 'else', 'try', 'finally', 'throw', 'break', 'continue', 'case', 'default', 'yield', 'await'])

  const noise = new Set(['then', 'catch', 'finally', 'map', 'filter', 'forEach', 'reduce', 'some', 'every',
    'find', 'findIndex', 'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'join', 'split', 'replace',
    'replaceAll', 'test', 'exec', 'match', 'matchAll', 'indexOf', 'lastIndexOf', 'includes', 'startsWith',
    'endsWith', 'toFixed', 'toPrecision', 'toString', 'valueOf', 'padStart', 'padEnd', 'trim', 'trimStart',
    'trimEnd', 'toUpperCase', 'toLowerCase', 'round', 'floor', 'ceil', 'trunc', 'sign', 'abs', 'pow', 'sqrt',
    'random', 'sin', 'cos', 'tan', 'atan2', 'hypot', 'keys', 'values', 'entries', 'assign', 'freeze',
    'fromEntries', 'parse', 'stringify', 'resolve', 'reject', 'all', 'allSettled', 'race', 'flat', 'flatMap',
    'sort', 'reverse', 'concat', 'charAt', 'charCodeAt', 'codePointAt', 'substring', 'substr', 'repeat',
    'getItem', 'setItem', 'removeItem', 'clear', 'has', 'get', 'set', 'add', 'delete', 'getTime', 'now',
    'hasOwnProperty', 'propertyIsEnumerable', 'isInteger', 'isArray', 'json', 'text', 'stringify',
    'async', 'await', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete', 'void',
    'insert', 'remove', 'setAttribute', 'querySelector', 'appendChild', 'createElement', 'writeText',
    'execCommand', 'select', 'setProperty',
    // 对象字面量的方法简写键名（candidates() {} / onPick() {} / openReference() {}），
    // 会被"直接调用"的正则当成调用 —— 它们不是自由变量。
    // codec 里的 serialize / clipboardText 同理（ReferenceCodec 要求的方法名）。
    'candidates', 'onPick', 'openReference', 'header', 'serialize', 'clipboardText',
    'in', 'of', 'do', 'else', 'try', 'finally', 'throw', 'case', 'yield', 'super', 'import'])

  const called = new Set()
  for (const m of clientCode.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)) called.add(m[1])

  const missing = [...called]
    .filter((name) => !defined.has(name) && !carriedNames.has(name) && !globals.has(name) && !noise.has(name))
    .sort()

  if (missing.length > 0) {
    fail('@client.js 里调用了未定义/未交过来的名字：' + missing.join(', ')
      + '（检查 library.js 的 export 与 build.mjs 的 need/carry 名单）')
  }
}

console.log('built: ' + join(lib, 'index.js'))
console.log('built: ' + outPath)
console.log('  拼接：' + PARTS.map((p) => p.file).join(' + ') + '  (语法 + 装载 + 导出 + 名字 五项自检通过)')
