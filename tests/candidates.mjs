// ---------------------------------------------------------------------------
// dsh-cangjingge —— 浏览器半候选过滤测试
//
// 跑法： node tests/candidates.mjs
//
// 【为什么单独一个文件】`/` 菜单的候选由浏览器半算出，验证它必须真跑那段代码。
//   这里把构建产物 lib/client.js（拼装好的 factory）装进 vm，喂假 fetch + 假
//   React，抓住注册到 inputTriggers 的 source，调它的 candidates()。
//
// 【钉住的那个坑】曾以为宿主侧 /cangjingge/candidates 会过滤，但客户端实际调的是
//   /cangjingge/shelf（返回全部 skill + visible 字段）。客户端不自己过滤的话，
//   菜单会把整座书架都列出来 —— 实测踩过，症状是「勾选了却全都显示」。
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let passed = 0
const failures = []

function ok(condition, label) {
  if (condition) { passed += 1; return }
  failures.push(label)
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) { passed += 1; return }
  failures.push(label + ' —— 实际 ' + a + '，期望 ' + b)
}

const clientPath = join(root, 'lib', 'client.js')
if (!existsSync(clientPath)) {
  console.log('candidates: 跳过（还没有 lib/client.js，先跑 node tools/build.mjs）')
  process.exit(0)
}

// ---- 假的宿主数据 --------------------------------------------------------------
const SHELF_TOP = {
  ok: true,
  groups: [
    { name: '团队', items: [{ name: '编制', count: 2 }] },
    { name: '兵法', items: [{ name: '谋', count: 1 }] },
  ],
  view: { groups: [], items: [], skills: [] },
}
const SHELF_BY_ITEM = {
  '团队/编制': {
    ok: true,
    view: {
      skills: [
        { name: '规程.md', path: '/x/团队/编制/规程.md', visible: true },
        { name: '其他.md', path: '/x/团队/编制/其他.md', visible: false },
      ],
    },
  },
  '兵法/谋': {
    ok: true,
    view: { skills: [{ name: '孙子.md', path: '/x/兵法/谋/孙子.md', visible: false }] },
  },
}

// ---- 装载构建产物 --------------------------------------------------------------
let intercepted = null
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  JSON,
  Math,
  Date,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Error,
  Promise,
  URLSearchParams,
  AbortController,
  fetch: async (url) => {
    let body = SHELF_TOP
    const q = url.indexOf('?')
    if (q >= 0) {
      const params = new URLSearchParams(url.slice(q + 1))
      body = SHELF_BY_ITEM[String(params.get('group')) + '/' + String(params.get('item'))]
        || { ok: true, view: { skills: [] } }
    }
    return { ok: true, status: 200, async json() { return body } }
  },
  navigator: { clipboard: { writeText: async () => {} } },
  document: {
    createElement: () => ({ style: {}, setAttribute() {}, select() {}, value: '', appendChild() {}, removeChild() {} }),
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild() {}, removeChild() {} },
    body: { appendChild() {}, removeChild() {} },
    documentElement: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  },
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.__ModuleLoader__ = {
  load(spec) {
    intercepted = spec
  },
}

const context = vm.createContext(sandbox)
new vm.Script(readFileSync(clientPath, 'utf8').replace(/^\uFEFF/, '')).runInContext(context)

ok(intercepted !== null, '客户端调用了 __ModuleLoader__.load')
if (intercepted === null) {
  console.error('candidates 测试失败：客户端没有向 __ModuleLoader__ 注册')
  process.exit(1)
}
eq(intercepted.id, 'dsh-cangjingge', '注册 id 是包名')

// ---- 执行 factory，抓注册的 source --------------------------------------------
const fakeReact = {
  createElement: (...args) => ({ args }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Fragment: 'Fragment',
}
const requireStub = (name) => {
  if (name === 'react') return fakeReact
  throw new Error('未预期的 require: ' + name)
}

let exportsObj = null
let registered = null
const fakeInputTriggers = { registerSource(src) { registered = src; return () => {} } }
const fakeCtx = {
  inputTriggers: fakeInputTriggers,
  slots: { render() {}, inject() {}, register() { return () => {} } },
  effect(fn) { fn(); return () => {} },
  logger: { info() {}, warn() {}, error() {} },
  // 客户端是用 ctx.get('inputTriggers') 取服务的（不是直接读 ctx.inputTriggers）
  get(name) { return name === 'inputTriggers' ? fakeInputTriggers : undefined },
  on() {},
  provide() {},
  inject() {},
}
exportsObj = intercepted.factory(requireStub)
ok(exportsObj !== null && exportsObj !== undefined, 'factory 返回 exports')

if (typeof exportsObj.apply === 'function') {
  exportsObj.apply(fakeCtx)
}

ok(registered !== null, '注册了 `/` 触发 source')

// ---- 核心断言：只列 visible=true ----------------------------------------------
if (registered !== null) {
  eq(registered.trigger, '/', 'trigger 是 /')
  const rows = await registered.candidates(
    { sessionId: 's1' },
    { query: '', position: 'leading', signal: new AbortController().signal },
  )
  const names = rows.map((r) => r.name)
  eq(names.length, 1, '只返回 visible=true 的 skill')
  eq(names[0], '团队 / 编制 / 规程.md', '返回的是勾选过的那个')
  eq(rows.some((r) => r.name.includes('其他.md')), false, '未勾选的 其他.md 不出现')
  eq(rows.some((r) => r.name.includes('孙子.md')), false, '未勾选的 孙子.md 不出现')
}

// ---- 结果 ---------------------------------------------------------------------
if (failures.length > 0) {
  console.error('candidates 测试失败 ' + String(failures.length) + ' 项：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('candidates: ' + String(passed) + ' 项通过')
