// ---------------------------------------------------------------------------
// dsh-cangjingge —— 端到端冒烟测试（真实 HTTP）
//
// 跑法： node tests/e2e.mjs
//
// 这台机器跑 node 时带 stdio 管道的子进程会 EPERM，所以**不用子进程**：
// 在同一个进程里起一个 node:http 服务，把宿主半 register 的路由 handler
// 接到真实请求上，再用 fetch 打过去。这样验证的是「路由真能返回 JSON」，
// 而不是「handler 函数单独调用能返回」。
// ---------------------------------------------------------------------------

import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as host from '../src/host.js'

let passed = 0
const failures = []
function ok(condition, label) {
  if (condition) { passed += 1; return }
  failures.push(label)
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected)
  if (a === b) { passed += 1; return }
  failures.push(label + ' —— 实际 ' + a + '，期望 ' + b)
}

// 准备书架
const root = await mkdtemp(join(tmpdir(), 'cjg-e2e-'))
await mkdir(join(root, '经部', '易'), { recursive: true })
await writeFile(join(root, '经部', '易', '系辞.md'), '# 系辞\n原文……\n', 'utf8')

// 【测试隔离】把设置文件重定向到临时路径（必须在 host.apply **之前**设）——
// 否则会读到用户真实的 ~/.dsh/cangjingge-settings.json，它的优先级**高于**
// 下面传的 libraryDir 参数，会让本测试扫到真实书架而不是这里造的临时书架。
const settingsFile = join(tmpdir(), 'cjg-e2e-settings-' + String(process.pid) + '.json')
process.env.DSH_CANGJINGGE_SETTINGS = settingsFile
await rm(settingsFile, { force: true })

// 装载宿主半，收集路由
const routes = []
const ctx = {
  logger: { info() {}, warn() {} },
  effect(fn) { fn(); return () => {} },
  webServer: { register(spec) { routes.push(spec); return () => {} } },
  // systemPrompt 走运行时 ctx.get（不是 inject）——见 host.js 的说明
  get(name) { return name === 'systemPrompt' ? { section() { return () => {} } } : undefined },
}
host.apply(ctx, { libraryDir: root })

// 起真实 HTTP 服务，把请求分发到注册的路由
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = routes.find((r) => r.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'no route' }))
    return
  }
  try {
    await route.handler(req, res)
  } catch (error) {
    res.writeHead(500)
    res.end(JSON.stringify({ error: String(error) }))
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = 'http://127.0.0.1:' + String(port)

async function get(path) {
  const response = await fetch(base + path)
  const text = await response.text()
  return { status: response.status, json: JSON.parse(text) }
}

// ---- 真实请求 -----------------------------------------------------------------
{
  const r = await get('/cangjingge/shelf')
  eq(r.status, 200, 'GET /shelf 返回 200')
  eq(r.json.ok, true, 'shelf ok=true')
  eq(r.json.view.active_group, '经部', 'shelf 识别到分组')
  eq(r.json.view.active_item, '易', 'shelf 识别到子项')
  eq(r.json.view.skills.map((s) => s.name), ['系辞.md'], 'shelf 列出 skill')
}

{
  const skillPath = join(root, '经部', '易', '系辞.md')
  const r = await get('/cangjingge/skill?path=' + encodeURIComponent(skillPath))
  eq(r.json.ok, true, 'GET /skill 成功')
  ok(r.json.text.includes('系辞'), '正文含标题')
  ok(r.json.text.includes('原文'), '正文含内容')
}

{
  // 路径安全问题：真实 HTTP 上也必须挡住
  const outside = join(tmpdir(), 'cjg-outside-' + String(process.pid) + '.txt')
  await writeFile(outside, 'NOPE', 'utf8')
  const r = await get('/cangjingge/skill?path=' + encodeURIComponent(outside))
  eq(r.json.ok, false, 'HTTP 上拒绝根目录之外的文件')
  await rm(outside, { force: true })
}

{
  const r = await get('/cangjingge/candidates')
  eq(r.status, 200, 'GET /candidates 返回 200')
  eq(r.json.ok, true, 'candidates ok=true')
}

{
  const r = await get('/cangjingge/nope')
  eq(r.status, 404, '未注册路径 404')
}

// ---- 清理 ---------------------------------------------------------------------
await new Promise((resolve) => server.close(resolve))
await rm(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('e2e 测试失败 ' + String(failures.length) + ' 项：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('e2e: ' + String(passed) + ' 项通过')
