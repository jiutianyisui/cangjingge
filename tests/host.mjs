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
// inject 只能有 webServer：把 systemPrompt 写进来会让整个插件起不来 —— 它是
// Agent scope 的服务（根 ctx 等不到）→ cordis 挂起 → apply() 不执行 → 所有
// /cangjingge/* 路由 404（真实事故）。systemPrompt 走运行时 ctx.get，拿不到就降级。
eq(host.inject, ['webServer'], 'inject 只有 webServer（systemPrompt 必须运行时取）')
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
    get() { return undefined },
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

// 测试隔离：把设置文件重定向到临时目录，避免写进用户真实配置
const settingsFile = join(tmpdir(), 'cjg-settings-' + String(process.pid) + '.json')
process.env.DSH_CANGJINGGE_SETTINGS = settingsFile

const ctx = makeCtx()
host.apply(ctx, { libraryDir: root })

eq(routes.length, 4, '注册了四个路由（settings 的 GET/POST 合成一条）')
eq(routes.map((r) => r.path).sort(), [
  '/cangjingge/candidates',
  '/cangjingge/settings',
  '/cangjingge/shelf',
  '/cangjingge/skill',
], '路由路径正确')
// 【关键回归】同一 path 不许注册两条 exact 路由 —— dsh 的 webServer 会抛
// duplicate exact route，而抛错发生在 ctx.effect 里 -> 整个插件的 effect
// 被回滚 -> 所有路由消失 -> 全站 404（真实事故，症状像"插件没加载"）
{
  const seen = new Set()
  let dup = null
  for (const r of routes) {
    if (seen.has(r.path)) { dup = r.path; break }
    seen.add(r.path)
  }
  eq(dup, null, '没有重复的 exact 路由路径')
}
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
  // 同一路径可能注册了两条（如 settings 的 GET 与 POST）——
  // 这里要找**接受 POST 的那条**，不能无脑取第一条（那样会打进 GET handler）。
  // 每条候选路由用**独立的 res**：复用同一个 res 会让被拒的那次留下脏状态。
  const candidates = routes.filter((r) => r.path === path)
  let last = null
  for (const route of candidates) {
    const res = fakeRes()
    await route.handler(fakeReq(url, 'POST', body), res)
    if (res.state.status !== 405) {
      return { status: res.state.status, json: JSON.parse(res.state.body) }
    }
    last = { status: res.state.status, json: JSON.parse(res.state.body) }
  }
  return last
}

const skillA = join(root, '易经', '乾', 'a.md')
const skillC = join(root, '兵法', '谋', 'c.md')

{
  // shelf 正常工作，且不再带 mode / auto 字段（自动功能已整体移除）
  const r = await callRoute('/cangjingge/shelf', '/cangjingge/shelf?group=' + encodeURIComponent('易经') + '&item=' + encodeURIComponent('乾'))
  const a = r.json.view.skills.find((s) => s.path === skillA)
  ok(a !== undefined, '能找到 a.md')
  eq(a.mode, undefined, 'skill 不再带 mode 字段')
  eq(r.json.auto, undefined, 'shelf 不再回传 auto 清单')
}

// ---- 设置路由（书架目录可改）--------------------------------------------------
{
  const r = await callRoute('/cangjingge/settings', '/cangjingge/settings')
  eq(r.json.ok, true, 'GET settings ok=true')
  eq(r.json.source, 'config', '未保存过时来源是插件配置')
  eq(r.json.effective, root, '生效目录是插件配置的（resolve 后）')
  eq(r.json.libraryDir, null, '界面值为空（从未保存过）')
}

{
  // 存一个新目录 -> rootDir 立即切换
  const newDir = await mkdtemp(join(tmpdir(), 'cjg-new-'))
  await mkdir(join(newDir, '新分组', '新子项'), { recursive: true })
  await writeFile(join(newDir, '新分组', '新子项', 'n.md'), '新正文', 'utf8')

  const r = await callPost('/cangjingge/settings', '/cangjingge/settings', JSON.stringify({ libraryDir: newDir }))
  eq(r.json.ok, true, '保存新目录成功')
  eq(r.json.saved, true, 'saved=true')
  ok(String(r.json.effective).includes('cjg-new-'), '生效目录已切换')

  const s = await callRoute('/cangjingge/shelf', '/cangjingge/shelf')
  eq(s.json.root, r.json.effective, 'shelf 的 root 跟着变')
  eq(s.json.view.groups[0].name, '新分组', '新目录的内容被扫到')

  const g = await callRoute('/cangjingge/settings', '/cangjingge/settings')
  eq(g.json.source, 'settings', '来源变成界面设置')

  await rm(newDir, { recursive: true, force: true })
}

{
  // 传空 -> 清除覆盖，回到插件配置
  const r = await callPost('/cangjingge/settings', '/cangjingge/settings', JSON.stringify({ libraryDir: '' }))
  eq(r.json.ok, true, '清除覆盖成功')
  eq(r.json.saved, false, 'saved=false（回到默认）')

  const g = await callRoute('/cangjingge/settings', '/cangjingge/settings')
  eq(g.json.source, 'config', '来源回到插件配置')
  eq(g.json.effective, root, '生效目录回到插件配置的')
}

{
  // 纯空白 = 清除覆盖（不是错误）
  const r = await callPost('/cangjingge/settings', '/cangjingge/settings', JSON.stringify({ libraryDir: '   ' }))
  eq(r.json.ok, true, '纯空白 = 清除覆盖（不是错误）')
}

{
  // settings 是**一条**路由：GET 走读分支（不是 405），不支持的 method 才 405
  const route = routes.find((x) => x.path === '/cangjingge/settings')
  const resGet = fakeRes()
  await route.handler(fakeReq('/cangjingge/settings', 'GET', ''), resGet)
  eq(resGet.state.status, 200, '同一路由 GET 走读分支返回 200')

  const resPut = fakeRes()
  await route.handler(fakeReq('/cangjingge/settings', 'PUT', ''), resPut)
  eq(resPut.state.status, 405, '不支持的 method 返回 405')
}

{
  // 跨源被拒
  const route = routes.find((x) => x.path === '/cangjingge/settings')
  const res = fakeRes()
  const req = fakeReq('/cangjingge/settings', 'POST', JSON.stringify({ libraryDir: 'E:/x' }))
  req.headers = { origin: 'https://evil.example', host: 'localhost:1' }
  await route.handler(req, res)
  eq(res.state.status, 403, '跨源来源被拒 403')
}

// ---- 空 ctx.get 也不能影响装载 -------------------------------------------------
{
  // 【关键回归】历史上把 systemPrompt 写进 inject 时整个插件起不来（路由全 404）。
  // 现在自动注入已移除，插件更不该依赖 ctx.get 的任何返回值。
  const r2 = []
  const ctx2 = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); return () => {} },
    webServer: { register(spec) { r2.push(spec); return () => {} } },
    get() { return undefined },
  }
  let threw = false
  try { host.apply(ctx2, { libraryDir: root }) } catch { threw = true }
  eq(threw, false, 'ctx.get 拿不到服务时 apply 不抛')
  eq(r2.length, 4, 'ctx.get 拿不到服务时路由照常注册')
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
