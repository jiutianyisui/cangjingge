// 给已装插件的 lib/index.js 埋诊断：记录执行到哪一步 + 捕获异常。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-cangjingge', 'lib')
const file = join(dir, 'index.js')

// 从备份恢复干净的完整版
copyFileSync(join(dir, 'index.js.bak-cjg'), file)
let text = readFileSync(file, 'utf8')

const anchor = 'export function apply(ctx, config) {'
const i = text.indexOf(anchor)
if (i < 0) { console.error('找不到 apply'); process.exit(1) }

const probe = [
  '',
  "  ctx.effect(() => ctx.webServer.register({",
  "    kind: 'exact',",
  "    path: '/cangjingge/diag',",
  "    handler: async (req, res) => {",
  "      const payload = { ok: true, stage: globalThis.__cjgStage || 'none', error: globalThis.__cjgDiag || null }",
  "      const b = JSON.stringify(payload)",
  "      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) })",
  "      res.end(b)",
  "    },",
  "  }), 'cjg: diag')",
  "  const __mark = (s) => { globalThis.__cjgStage = s }",
  "  __mark('apply-start')",
  "  try {",
  '',
].join('\n')

text = text.slice(0, i + anchor.length) + probe + text.slice(i + anchor.length)

// 在每个路由注册前埋标记：插到 `ctx.effect(` 那一行**之前**（不是 path: 之前 ——
// path 是 register({...}) 的参数，插进去会破坏对象字面量）
const marks = [
  ["'/cangjingge/shelf'", 'before-shelf'],
  ["'/cangjingge/skill'", 'before-skill'],
  ["'/cangjingge/candidates'", 'before-candidates'],
  ["'/cangjingge/auto'", 'before-auto'],
  ["'/cangjingge/mode'", 'before-mode'],
]
for (const [needle, stage] of marks) {
  const at = text.indexOf('path: ' + needle)
  if (at < 0) { console.error('找不到 ' + needle); continue }
  // 往上找到最近的 ctx.effect( 行首，插在它前面
  const eff = text.lastIndexOf('ctx.effect(', at)
  if (eff < 0) { console.error('找不到 ctx.effect for ' + needle); continue }
  const lineStart = text.lastIndexOf('\n', eff) + 1
  text = text.slice(0, lineStart) + "  __mark('" + stage + "')\n" + text.slice(lineStart)
}

// apply 末尾闭合 try/catch
const last = text.lastIndexOf('}')
if (last < 0) { console.error('找不到结尾'); process.exit(1) }
text = text.slice(0, last)
  + "  } catch (e) {\n    globalThis.__cjgDiag = String(e && e.stack ? e.stack : e)\n  }\n}"
  + text.slice(last + 1)

writeFileSync(file, text, 'utf8')
console.log('已埋入诊断')
