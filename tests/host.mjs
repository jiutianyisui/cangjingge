// ---------------------------------------------------------------------------
// dsh-cangjingge —— 宿主半装载与路由测试
//
// 跑法： node tests/host.mjs
//
// 用一个假 ctx 装载 host.js，验证：
//   - 形状（name / inject / Config 的 ~standard）
//   - 三个路由都注册了
//   - 扫描真实临时目录 -> 三栏树正确
//   - 路径安全：拒绝读根目录之外的文件
// ---------------------------------------------------------------------------

import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
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
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) { passed += 1; return }
  failures.push(label + ' —— 实际 ' + a + '，期望 ' + b)
}

// ---- 形状 ---------------------------------------------------------------------
eq(host.name, 'dsh-cangjingge', '插件名与 patch id 一致')
eq(host.inject, ['webServer', 'systemPrompt'], 'inject 含 webServer 与 systemPrompt')
ok(host.Config !== undefined && host.Config['~standard'] !== undefined, 'Config 有 ~standard')
eq(typeof host.Config['~standard'].validate, 'function', 'Config 可 validate')

{
  const value = host.Config['~standard'].validate({}).value
  ok(typeof value.libraryDir === 'string' && value.libraryDir.length > 0, '默认 libraryDir 非空')
  const custom = host.Config['~standard'].validate({ libraryDir: 'E:/x/my/藏经阁' }).value
  eq(custom.libraryDir, 'E:/x/my/藏经阁', 'libraryDir 可覆盖')
}

// 默认目录必须是**任何机器上都成立**的位置：不能硬编码作者本机的路径，
// 否则别人装上去会指向不存在的目录 —— 书架永远空，而且不报错。
{
  const def = host.defaultLibraryDir()
  eq(def.includes('E:\\xiangmu'), false, '默认目录不含作者本机路径')
  eq(def.includes('xiangmu'), false, '默认目录不含项目专有名')
  ok(def.endsWith(join('.dsh', 'cangjingge')), '默认目录是 ~/.dsh/cangjingge')
}

// ---- 装载：路由注册 -----------------------------------------------------------
const routes = []
/** 收集注册进来的 systemPrompt section（验证「自动」注入）。 */
const sections = []
function makeCtx() {
  return {
    logger: { info() {}, warn() {} },
    effect(fn, label) { fn() ; return () => {} },
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {}
      },
    },
  }
}

// 准备一个真实临时书架
const root = await mkdtemp(join(tmpdir(), 'cjg-'))
await mkdir(join(root, '易经', '乾'), { recursive: true })
await mkdir(join(root, '易经', '坤'), { recursive: true })
await mkdir(join(root, '兵法', '谋'), { recursive: true })
await mkdir(join(root, '.git'), { recursive: true })
await writeFile(join(root, '易经', '乾', 'a.md'), '# a 正文\n', 'utf8')
await writeFile(join(root, '易经', '坤', 'b.txt'), 'b 正文\n', 'utf8')
await writeFile(join(root, '兵法', '谋', 'c.md'), '# c 正文\n', 'utf8')
await writeFile(join(root, '易经', '乾', 'noise.png'), 'x', 'utf8')
// 根目录外的一个"机密"文件，用来验证路径安全
const secret = join(tmpdir(), 'cjg-secret-' + String(process.pid) + '.txt')
await writeFile(secret, 'SECRET', 'utf8')

const ctx = makeCtx()
host.apply(ctx, { libraryDir: root })

eq(routes.length, 5, '注册了五个路由')
eq(routes.map((r) => r.path).sort(), [
  '/cangjingge/auto',
  '/cangjingge/candidates',
  '/cangjingge/mode',
  '/cangjingge/shelf',
  '/cangjingge/skill',
], '路由路径正确')
for (const r of routes) ok(r.kind === 'exact', '路由 ' + r.path + ' kind=exact')

// ---- 扫描 ---------------------------------------------------------------------
{
  const tree = await host.scanLibrary(root)
  const names = tree.groups.map((g) => g.name)
  // localeCompare('zh-Hans-CN') 走拼音：兵法(bing) 在 易经(yi) 之前
  eq(names, ['兵法', '易经'], '分组按拼音排序')
  const yi = tree.groups.find((g) => g.name === '易经')
  // 坤(kun) 在 乾(qian) 之前
  eq(yi.items.map((i) => i.name), ['坤', '乾'], '子项按拼音排序')
  const qian = yi.items.find((i) => i.name === '乾')
  eq(qian.skills.map((s) => s.name), ['a.md'], '只列 skill 文件（png 被剔除）')
  ok(qian.skills[0].path.endsWith('a.md'), 'skill path 是绝对文件路径')
}

// ---- 路径安全 -----------------------------------------------------------------
{
  const bad = await host.readSkill(root, secret)
  eq(bad.ok, false, '拒绝读根目录之外的文件')
  ok(String(bad.message).includes('藏经阁之外'), '拒绝原因可读')

  const traversal = await host.readSkill(root, join(root, '..', '..', 'whatever.md'))
  eq(traversal.ok, false, '拒绝 .. 路径穿越')
}

// ---- 读 skill -----------------------------------------------------------------
{
  const good = await host.readSkill(root, join(root, '易经', '乾', 'a.md'))
  eq(good.ok, true, '能读根内文件')
  ok(good.text.includes('a 正文'), '正文内容正确')
  eq(good.truncated, false, '小文件不截断')
}

// ---- 路由实际响应（用假 req/res）-----------------------------------------------
function fakeRes() {
  const state = { status: 0, body: '', headers: null }
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers },
    end(body) { state.body = body },
  }
}

async function callRoute(path, url) {
  const route = routes.find((r) => r.path === path)
  const req = { url, method: 'GET', headers: {} }
  const res = fakeRes()
  await route.handler(req, res)
  return { status: res.state.status, json: JSON.parse(res.state.body) }
}

{
  const r = await callRoute('/cangjingge/shelf', '/cangjingge/shelf')
  eq(r.status, 200, 'shelf 返回 200')
  eq(r.json.ok, true, 'shelf ok=true')
  eq(r.json.view.active_group, '兵法', 'shelf 默认第一个分组（拼音序）')
  eq(r.json.view.active_item, '谋', 'shelf 默认第一个子项')
}

{
  const r = await callRoute('/cangjingge/shelf', '/cangjingge/shelf?group=' + encodeURIComponent('易经'))
  eq(r.json.view.active_group, '易经', 'shelf 接受 group 参数')
  eq(r.json.view.active_item, '坤', 'group 切换后子项跟着切')
}

{
  const r = await callRoute('/cangjingge/skill', '/cangjingge/skill')
  eq(r.json.ok, false, 'skill 缺 path 返回 ok=false')
}

{
  const r = await callRoute('/cangjingge/skill', '/cangjingge/skill?path=' + encodeURIComponent(join(root, '兵法', '谋', 'c.md')))
  eq(r.json.ok, true, 'skill 正常读取')
  ok(r.json.text.includes('c 正文'), 'skill 正文正确')
}

{
  const r = await callRoute('/cangjingge/candidates', '/cangjingge/candidates')
  eq(r.json.ok, true, 'candidates ok=true')
}

// ---- 自动/手动开关（路由）------------------------------------------------------
// 需要能发 POST 的假 req（带 body 流）
function fakeReq(url, method, body) {
  const text = typeof body === 'string' ? body : ''
  const chunks = text.length > 0 ? [Buffer.from(text, 'utf8')] : []
  return {
    url, method, headers: {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}
async function callPost(path, url, body) {
  const route = routes.find((r) => r.path === path)
  const res = fakeRes()
  await route.handler(fakeReq(url, 'POST', body), res)
  return { status: res.state.status, json: JSON.parse(res.state.body) }
}

const skillA = join(root, '易经', '乾', 'a.md')
const skillC = join(root, '兵法', '谋', 'c.md')

{
  // 初始：全是手动。注意「易经」下按拼音第一个子项是「坤」（含 b.txt），
  // 要看「乾」里的 a.md 得显式指定 item。
  const r = await callRoute('/cangjingge/shelf', '/cangjingge/shelf?group=' + encodeURIComponent('易经') + '&item=' + encodeURIComponent('乾'))
  const a = r.json.view.skills.find((s) => s.path === skillA)
  ok(a !== undefined, '能找到 a.md')
  eq(a.mode, 'manual', '默认是手动')
  eq(r.json.auto, [], '初始自动清单为空')
}

{
  const r = await callPost('/cangjingge/mode', '/cangjingge/mode', JSON.stringify({ path: skillA, mode: 'auto' }))
  eq(r.json.ok, true, '设为自动成功')
  eq(r.json.mode, 'auto', '回传 auto')
  eq(r.json.auto, [skillA], '自动清单含该文件')
}

{
  // shelf 上要能看到新状态
  const r = await callRoute('/cangjingge/shelf', '/cangjingge/shelf?group=' + encodeURIComponent('易经') + '&item=' + encodeURIComponent('乾'))
  const a = r.json.view.skills.find((s) => s.path === skillA)
  eq(a.mode, 'auto', 'shelf 反映 auto')
  eq(r.json.auto, [skillA], 'shelf 回传 auto 清单')
}

{
  // 状态文件确实落盘，且不含 manual 记录
  const raw = JSON.parse(await readFile(join(root, '_state.json'), 'utf8'))
  eq(raw.skills[skillA], 'auto', '状态文件记录了 auto')
}

{
  const r = await callRoute('/cangjingge/auto', '/cangjingge/auto')
  eq(r.json.auto, [skillA], '/auto 路由返回自动清单')
}

{
  // 设回手动 -> 从清单消失
  const r = await callPost('/cangjingge/mode', '/cangjingge/mode', JSON.stringify({ path: skillA, mode: 'manual' }))
  eq(r.json.ok, true, '设回手动成功')
  eq(r.json.mode, 'manual', '回传 manual')
  eq(r.json.auto, [], '自动清单变空')
}

{
  // 写操作必须挡住根目录之外的路径
  const r = await callPost('/cangjingge/mode', '/cangjingge/mode', JSON.stringify({ path: secret, mode: 'auto' }))
  eq(r.json.ok, false, '拒绝把藏经阁之外的文件设为自动')
}

{
  // GET 打写路由 -> 405
  const route = routes.find((r) => r.path === '/cangjingge/mode')
  const res = fakeRes()
  await route.handler(fakeReq('/cangjingge/mode', 'GET', ''), res)
  eq(res.state.status, 405, 'GET 打 mode 路由返回 405')
}

{
  // 跨源来源被拒（带 Origin 且与 Host 不同）
  const route = routes.find((r) => r.path === '/cangjingge/mode')
  const res = fakeRes()
  const req = fakeReq('/cangjingge/mode', 'POST', JSON.stringify({ path: skillC, mode: 'auto' }))
  req.headers = { origin: 'https://evil.example', host: 'localhost:1234' }
  await route.handler(req, res)
  eq(res.state.status, 403, '跨源来源被拒 403')
}

{
  // 缺 path -> ok:false
  const r = await callPost('/cangjingge/mode', '/cangjingge/mode', JSON.stringify({ mode: 'auto' }))
  eq(r.json.ok, false, '缺 path 返回 ok=false')
}

// ---- 自动注入（systemPrompt.section）------------------------------------------
{
  // 装载时应当注册了一个 section
  eq(sections.length, 1, '注册了一个 systemPrompt section')
  const s = sections[0]
  eq(s.name, 'cangjingge:auto', 'section 名正确')
  eq(typeof s.order, 'number', 'section order 是数字')
  ok(s.order > 600 && s.order < 800, 'order 落在 TEAM_POLICY(600) 与 PTC_ONLY(800) 之间')
  eq(typeof s.text, 'function', 'text 是函数（动态注入的关键）')
  // text() 必须是同步的：返回 Promise 会被渲染成 "[object Promise]"
  eq(typeof s.text().then, 'undefined', 'text() 返回非 Promise（必须同步）')
}

// 注入内容的**正确性**用独立的 ctx 单独装一次来验（不受前面 TTL 缓存干扰）。
// 注意 mode 测试结尾把 skillA 设回了 manual，所以这里重新设为 auto。
{
  await callPost('/cangjingge/mode', '/cangjingge/mode', JSON.stringify({ path: skillA, mode: 'auto' }))
  const s2 = []
  const ctx2 = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); return () => {} },
    webServer: { register() { return () => {} } },
    systemPrompt: { section(spec) { s2.push(spec); return () => {} } },
  }
  host.apply(ctx2, { libraryDir: root })
  eq(s2.length, 1, '第二次装载也注册 section')
  // TTL 缓存是 per-apply 的，新 ctx 是新的闭包 —— 立刻就能拿到最新状态
  const text = s2[0].text()
  ok(text.includes('a.md'), '注入文本含自动 skill 的文件名')
  ok(text.includes('a 正文'), '注入文本含自动 skill 的正文')
  ok(text.includes('自动'), '注入文本带说明标记')
}

{
  // 全部取消自动 -> 注入文本变回空串（新 ctx 绕开缓存）
  await callPost('/cangjingge/mode', '/cangjingge/mode', JSON.stringify({ path: skillA, mode: 'manual' }))
  const s3 = []
  const ctx3 = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); return () => {} },
    webServer: { register() { return () => {} } },
    systemPrompt: { section(spec) { s3.push(spec); return () => {} } },
  }
  host.apply(ctx3, { libraryDir: root })
  eq(s3[0].text(), '', '取消自动后注入文本为空串')
}

// ---- 清理 ---------------------------------------------------------------------
await rm(root, { recursive: true, force: true })
await rm(secret, { force: true })

// ---- 结果 ---------------------------------------------------------------------
if (failures.length > 0) {
  console.error('host 测试失败 ' + String(failures.length) + ' 项：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('host: ' + String(passed) + ' 项通过')
