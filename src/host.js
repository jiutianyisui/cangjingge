// ---------------------------------------------------------------------------
// dsh-cangjingge —— 宿主半（Node 侧）
//
// 职责：
//   1. 读取配置里的「藏经阁根目录」（默认 ~/.dsh/cangjingge）
//   2. 扫描磁盘 -> 三栏书架树
//   3. 通过 HTTP 路由把树 / 单个 skill 正文给浏览器半
//   4. **把标记为「自动」的 skill 正文注入系统提示**（systemPrompt.section）
//
// 本插件**零 @deepseek-ai 依赖**（理由见天枢 src\toolkit.js 头注释：
// 声明 @deepseek-ai/* 会顶掉桌面端自带运行时 -> 整个软件打不开）。
// 所以这里不需要 @deepseek-ai 的 anything：只用 node:fs / node:path。
//
// 【静态组合包拿不到 host.call】浏览器半访问宿主数据只能走宿主自注册的
// HTTP 路由（webServer.register，官方扩展点）。与天枢同一条路。
//
// 【「自动」是怎么做到"一直遵守"的】
//   不是发便条，而是注册一个**动态的**系统提示 section：
//     ctx.systemPrompt.section({ name, order, text: () => 现读清单 })
//   已对 0.1.7-rc.2 的 dsh-system-prompt 核实：它会做
//     text: typeof section.text === "function" ? section.text(context) : section.text
//   也就是**每次组装系统提示时都调用那个函数**。所以：
//     * 用户改开关 -> 下一次组装自然读到新状态，不需要重建 section
//     * 每轮都在（这就是"一直遵守"）
//   注册在**根作用域**，对所有会话可见（section() 的文档：注册到调用上下文的作用域）。
// ---------------------------------------------------------------------------

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
// 同步读只在「自动注入」那条路上用（systemPrompt 的组装是同步的，见下方注释）
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  visibleEntries,
  shelfView,
  SKILL_MAX_BYTES,
  STATE_FILE_NAME,
  MODE_AUTO,
  MODE_MANUAL,
  normalizeState,
  modeOf,
  withMode,
  autoSkills,
  buildAutoSectionText,
  SETTINGS_FILE_NAME,
  normalizeSettings,
  pickLibraryDir,
  validateLibraryDir,
} from './library.js'

import { defineConfig } from './toolkit.js'

/** 本插件的 cordis 插件名（必须与 cordis.patch.yml 里的 id 一致）。 */
export const name = 'dsh-cangjingge'

/**
 * 依赖的服务。
 * - webServer：注册浏览器半读取书架用的 HTTP 路由。
 * - systemPrompt：「自动」skill 的常驻注入（动态 section）。
 *
 * 【必须声明 systemPrompt】cordis 是依赖注入框架：不声明依赖，apply 可能在
 * 服务就绪前跑完，那时 ctx.systemPrompt 是 undefined，注入静默失败。
 * （藏经阁踩过一次同类坑：客户端 inject 漏了 inputTriggers，`/` 菜单不出现。）
 *
 * 注意这里**没有** tools：藏经阁不注册模型工具。
 */
export const inject = ['webServer', 'systemPrompt']

/** 默认藏经阁根目录（用户可在设置或 patch 里覆盖）。 */
export function defaultLibraryDir() {
  // 用用户主目录下的 ~/.dsh/cangjingge —— 这是**任何机器上都成立**的位置。
  // 早期版本曾硬编码作者本机的 E:\xiangmu\...，那对别人是死路径：
  // 装上去会指向一个不存在的目录，书架永远是空的，而且不报错。
  return join(homedir(), '.dsh', 'cangjingge')
}

/**
 * 展开配置里的目录：支持 ~ 前缀与相对路径。
 * @param configured - 配置值。
 * @returns 绝对路径。
 */
export function resolveLibraryDir(configured) {
  const raw = typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : defaultLibraryDir()
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return resolve(raw)
}

/**
 * 配置声明。必须是带 `~standard` 的 schema（cordis 调 validate），
 * 不能是普通 JSON Schema 对象 —— 详见 toolkit.js。
 */
export const Config = defineConfig({
  libraryDir: {
    type: 'string',
    default: defaultLibraryDir(),
    description: '藏经阁根目录：左栏是它的顶层文件夹，中栏是子文件夹，右栏是里面的 skill 文件。',
  },
  insertMode: {
    type: 'string',
    default: 'quote',
    description: '从书架插入聊天框时的形式：quote=路径+正文，path=只插路径，body=只插正文。',
  },
})

/**
 * 列一层目录：返回 [{ name, kind }]，已过滤隐藏项与内部项。
 * 目录读不出来（不存在 / 无权限）时返回空数组，而不是抛 —— 空书架是可展示状态。
 * @param dir - 绝对路径。
 * @returns 条目数组。
 */
async function listDir(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const raw = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      raw.push({ name: entry.name, kind: 'dir' })
      continue
    }
    // 软链与普通文件都当文件处理；软链指到目录的情况这里不展开（避免环）
    if (entry.isFile() || entry.isSymbolicLink()) {
      raw.push({ name: entry.name, kind: 'file' })
    }
  }
  return visibleEntries(raw)
}

/**
 * 扫描整座书架：根 / 分组 / 子项 / skill 三层。
 *
 * 深度固定为三层（根 -> 分组 -> 子项 -> skill 文件）：
 * 再深就是「把 skill 库当文件夹树用」，那是资源管理器的活，不是书架。
 * @param rootDir - 藏经阁根目录。
 * @returns { root, groups, truncated }。
 */
export async function scanLibrary(rootDir) {
  const groups = []
  const top = await listDir(rootDir)
  for (const group of top) {
    if (group.kind !== 'dir') continue
    const groupDir = join(rootDir, group.name)
    const items = []
    for (const item of await listDir(groupDir)) {
      if (item.kind !== 'dir') continue
      const itemDir = join(groupDir, item.name)
      const skills = []
      for (const file of await listDir(itemDir)) {
        if (file.kind !== 'file') continue
        skills.push({ name: file.name, path: join(itemDir, file.name) })
      }
      items.push({ name: item.name, skills })
    }
    groups.push({ name: group.name, items })
  }
  return { root: rootDir, groups }
}

/**
 * 读取一个 skill 文件的正文（按字节上限截断）。
 *
 * 【路径安全】只允许读根目录内的文件：把目标路径 normalize 后必须仍在根下。
 * 否则客户端传 `../../../.credentials.yaml` 就能把凭据读出来 —— 这是
 * 必须挡在入口的，不能靠界面不构造这种请求。
 *
 * @param rootDir - 藏经阁根目录。
 * @param targetPath - 客户端传来的路径。
 * @returns { ok, text?, truncated?, message? }。
 */
export async function readSkill(rootDir, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return { ok: false, message: '路径为空。' }
  }
  const root = resolve(rootDir)
  const full = resolve(targetPath)
  // 必须在根目录之内（相等或以其 + 分隔符开头）
  if (full !== root && !full.startsWith(root + sep)) {
    return { ok: false, message: '拒绝读取藏经阁之外的路径。' }
  }
  let info
  try {
    info = await stat(full)
  } catch {
    return { ok: false, message: '文件不存在：' + full }
  }
  if (!info.isFile()) return { ok: false, message: '不是一个文件：' + full }

  let buffer
  try {
    buffer = await readFile(full)
  } catch (error) {
    return { ok: false, message: '读取失败：' + String(error && error.message ? error.message : error) }
  }
  const truncated = buffer.length > SKILL_MAX_BYTES
  const slice = truncated ? buffer.slice(0, SKILL_MAX_BYTES) : buffer
  return { ok: true, text: slice.toString('utf8'), truncated, size: buffer.length }
}

/**
 * 读开关状态（根目录下的 _state.json）。
 * 文件不存在或损坏都返回空状态 —— 状态是可再生的，不值得为它报错。
 * @param rootDir - 藏经阁根目录。
 * @returns 规格化后的状态。
 */
export async function readState(rootDir) {
  try {
    const text = await readFile(join(rootDir, STATE_FILE_NAME), 'utf8')
    return normalizeState(JSON.parse(text))
  } catch {
    return normalizeState(null)
  }
}

/**
 * 写开关状态。
 * @param rootDir - 藏经阁根目录。
 * @param state - 规格化后的状态。
 * @returns 是否写成功。
 */
export async function writeState(rootDir, state) {
  try {
    await writeFile(
      join(rootDir, STATE_FILE_NAME),
      JSON.stringify(normalizeState(state), null, 2) + '\n',
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/**
 * 给书架视图里的每个 skill 附上它的模式，并把「自动」的清单一起给出去。
 *
 * 自动清单是给 Lead 看的：会话开头读这些文件。插件自己不读、不注入 ——
 * 它只负责把「哪些该读」这件事说清楚。
 * @param rootDir - 藏经阁根目录。
 * @param tree - scanLibrary 的产物。
 * @param view - shelfView 的产物。
 * @returns { view, auto } —— 附带 mode 的视图 + 自动清单。
 */
export async function decorateWithModes(rootDir, tree, view) {
  const state = await readState(rootDir)
  const skills = Array.isArray(view.skills)
    ? view.skills.map((s) => ({ ...s, mode: modeOf(state, s.path) }))
    : []
  return { view: { ...view, skills }, auto: autoSkills(state) }
}

/**
 * 插件主体。
 * @param ctx - 宿主侧根上下文。
 * @param config - 已解析的配置。
 */
export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const configDir = settings.libraryDir
  const fallbackDir = defaultLibraryDir()

  // 设置文件路径：固定放在 ~/.dsh/ 下，**与书架目录解耦** ——
  // 放书架目录里的话，一改目录就找不到上次的设置，等于改不了。
  //
  // 【测试隔离】环境变量 DSH_CANGJINGGE_SETTINGS 可覆盖这个路径。
  //   没有它的话，跑测试会写进用户真实的配置文件（测试必须能隔离副作用）。
  const settingsPath = typeof process.env.DSH_CANGJINGGE_SETTINGS === 'string'
    && process.env.DSH_CANGJINGGE_SETTINGS.length > 0
    ? process.env.DSH_CANGJINGGE_SETTINGS
    : join(homedir(), '.dsh', SETTINGS_FILE_NAME)

  /**
   * 读界面里保存的设置（同步；注入路径也要用）。
   * 文件不存在 / 损坏都返回空设置 —— 设置是可再生的，不值得报错。
   * @returns normalizeSettings 的产物。
   */
  function readSettingsSync() {
    try {
      return normalizeSettings(JSON.parse(readFileSync(settingsPath, 'utf8')))
    } catch {
      return normalizeSettings(null)
    }
  }

  /**
   * 算出当前生效的书架目录。
   *
   * 优先级：界面保存的值 > 插件配置 > 内置默认。
   * @returns { value, source }。
   */
  function currentLibraryDir() {
    return pickLibraryDir(readSettingsSync().libraryDir, configDir, fallbackDir)
  }

  /** 当前生效的书架目录（界面改了设置后由 refreshRootDir() 重算）。 */
  let rootDir = resolveLibraryDir(currentLibraryDir().value)
  /** 自动注入的短 TTL 缓存（目录或开关变化时要作废）。 */
  let autoCache = { at: 0, text: '' }
  ctx.logger?.info?.('dsh-cangjingge: library dir = ' + rootDir)

  /**
   * 重算 rootDir（界面保存了新目录后调用）。
   * @returns 新的绝对路径。
   */
  function refreshRootDir() {
    rootDir = resolveLibraryDir(currentLibraryDir().value)
    // 目录变了，自动注入的缓存必须作废 —— 否则最长 5 秒内还注入旧目录的内容
    autoCache = { at: 0, text: '' }
    ctx.logger?.info?.('dsh-cangjingge: library dir -> ' + rootDir)
    return rootDir
  }

  // -------------------------------------------------------------------------
  // 「自动」skill 的常驻注入（动态 systemPrompt section）
  //
  // 【必须是同步的】dsh-system-prompt 的组装是**同步**过程：
  //     text: typeof section.text === "function" ? section.text(context) : section.text
  //   —— 直接取返回值，不 await。传 async 函数会得到一个 Promise 被当成
  //   文本渲染（变成 "[object Promise]"），或者干脆报错。
  //   所以这一路**用同步 fs**（readFileSync / readdirSync），不用 promise 版。
  //
  // 【为什么缓存】系统提示每轮都组装，而读状态 + N 个文件是同步 IO，
  //   会阻塞。用户开关一小时才改一次，却要为每轮付一次读盘。所以加短 TTL
  //   缓存（默认 5 秒）：开关改动能很快生效，又不至于每轮打盘。
  // -------------------------------------------------------------------------
  const AUTO_CACHE_MS = 5000
  // autoCache 已在上方（refreshRootDir 之前）声明 —— 那里有为何必须前置的说明。

  /**
   * 同步读 skill 正文（注入路径专用）。
   * 与异步 readSkill 有同样的根目录内校验 —— 自动清单里的路径也可能被
   * 手工改坏，不能因为"是内部的"就跳过检查。
   * @param targetPath - 待读路径。
   * @returns 文本或 null（读不到）。
   */
  function readSkillSync(targetPath) {
    try {
      const root = resolve(rootDir)
      const full = resolve(String(targetPath))
      if (full !== root && !full.startsWith(root + sep)) return null
      const buffer = readFileSync(full)
      const truncated = buffer.length > SKILL_MAX_BYTES
      return (truncated ? buffer.slice(0, SKILL_MAX_BYTES) : buffer).toString('utf8')
    } catch {
      return null
    }
  }

  /**
   * 构建「自动」skill 的注入文本（同步 + 短 TTL 缓存）。
   *
   * 空清单返回空串 —— renderPrompt 会把空 section 过滤掉，等于这一节不存在。
   * 所以"取消全部自动"就是这一节自然消失，不需要注销注册。
   *
   * @returns 注入文本（可能为空串）。
   */
  function autoSectionText() {
    const now = Date.now()
    if (now - autoCache.at < AUTO_CACHE_MS) return autoCache.text

    let text = ''
    try {
      const raw = readFileSync(join(rootDir, STATE_FILE_NAME), 'utf8')
      const state = normalizeState(JSON.parse(raw))
      const items = []
      for (const path of autoSkills(state)) {
        const body = readSkillSync(path)
        if (body === null) {
          // 读不到（文件被删/改名）就跳过并留一条日志 —— 静默消失最难查
          ctx.logger?.warn?.('dsh-cangjingge: 自动 skill 读取失败（已跳过）：' + path)
          continue
        }
        const name = String(path).split(/[\\/]/).pop() || '(未命名)'
        items.push({ name, path, text: body })
      }
      text = buildAutoSectionText(items)
    } catch (error) {
      // 状态文件不存在（还没点过自动）会走到这里 —— 那是**正常**情况，不是错误。
      // 真正异常也只记日志：这个函数每轮都被调用，抛出去会把会话卡死。
      const code = error !== null && error !== undefined ? error.code : undefined
      if (code !== 'ENOENT') {
        ctx.logger?.warn?.('dsh-cangjingge: 自动注入构建失败：' + String(error && error.message ? error.message : error))
      }
      text = ''
    }
    autoCache = { at: now, text }
    return text
  }

  /**
   * 把对象作为 JSON 写回浏览器（HTTP 路由用）。
   * @param res - HTTP 响应。
   * @param status - 状态码。
   * @param value - 待序列化值。
   */
  function sendJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /**
   * 取查询参数。
   * @param req - HTTP 请求。
   * @param key - 参数名。
   * @returns 值或 null。
   */
  function queryParam(req, key) {
    try {
      const url = new URL(req.url, 'http://localhost')
      const value = url.searchParams.get(key)
      return value === null || value.length === 0 ? null : value
    } catch {
      return null
    }
  }

  /**
   * 判定请求是不是来自本应用自己的页面。
   *
   * /cangjingge/mode 会写状态文件，而页面里加载的任何第三方内容（壁纸 URL、
   * 外链图片、dataUrl）都能对 localhost:<port> 发 POST —— 端口每次启动都变，
   * 但同源脚本不需要知道端口就能打中。所以对写操作做一次来源检查。
   *
   * 判据取保守的一条：带了 Origin 就必须与 Host 同源；没带 Origin 的
   * （同源 fetch 常不带）放行，因为拦掉它会让正常按钮失效。
   * @param req - HTTP 请求。
   * @returns 是否允许。
   */
  function isTrustedOrigin(req) {
    const origin = req.headers !== null && req.headers !== undefined ? req.headers.origin : undefined
    if (origin === undefined || origin === null || origin === '') return true
    const host = req.headers.host
    if (host === undefined || host === null || host === '') return false
    try {
      const parsed = new URL(origin)
      if (parsed.host !== host) return false
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  }

  /**
   * 读请求体并解析成 JSON（有大小上限）。
   *
   * 超限时必须**把流收干净再返回**：直接 return 会让 for-await 悄悄销毁 req，
   * 在 keep-alive 下可能留下一个半读的请求体，让后续请求错位。
   * @param req - HTTP 请求。
   * @returns 解析后的对象，失败为 {}。
   */
  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    let overflow = false
    const LIMIT = 64 * 1024
    for await (const chunk of req) {
      if (overflow) continue
      size += chunk.length
      if (size > LIMIT) {
        overflow = true
        chunks.length = 0
        continue
      }
      chunks.push(chunk)
    }
    if (overflow || chunks.length === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  // GET /cangjingge/shelf —— 整座书架的树 + 三栏当前视图
  //
  // 一次把树给全（三层，几百个文件也就几十 KB），界面切换分组/子项时
  // 纯本地计算，不用往返。skill 正文**不在**这里，按需走 /cangjingge/skill。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/cangjingge/shelf',
    handler: async (req, res) => {
      try {
        const state = await readState(rootDir)
        const tree = await scanLibrary(rootDir)
        const group = queryParam(req, 'group')
        const item = queryParam(req, 'item')
        const view = shelfView(tree, { group, item })
        // 给每个 skill 附上它的模式（auto / manual），并把自动清单一起给出去
        const skills = Array.isArray(view.skills)
          ? view.skills.map((s) => ({ ...s, mode: modeOf(state, s.path) }))
          : []
        sendJson(res, 200, {
          ok: true,
          root: rootDir,
          groups: tree.groups.map((g) => ({
            name: g.name,
            count: g.items.length,
            items: g.items.map((i) => ({ name: i.name, count: i.skills.length })),
          })),
          view: { ...view, skills },
          // 「自动」清单：Lead 会话开头该读这些。插件自己不读、不注入。
          auto: autoSkills(state),
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '扫描书架失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: shelf route')

  // POST /cangjingge/mode —— 切换某个 skill 的「自动 / 手动」
  //
  // 【这是写操作】所以要做来源校验（与天枢的 rollback 路由同一策略）。
  // 语义：只改 _state.json 里的一条记录。绝对不动 skill 文件本身。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/cangjingge/mode',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, message: '请用 POST。' })
          return
        }
        if (!isTrustedOrigin(req)) {
          sendJson(res, 403, { ok: false, message: '来源不被信任，拒绝修改。' })
          return
        }
        const body = await readJsonBody(req)
        const target = typeof body.path === 'string' ? body.path : ''
        const mode = body.mode === MODE_AUTO ? MODE_AUTO : MODE_MANUAL
        if (target.length === 0) {
          sendJson(res, 200, { ok: false, message: '缺少 path。' })
          return
        }
        // 与读 skill 同一条路径校验：只能在根目录之内
        const root = resolve(rootDir)
        const full = resolve(target)
        if (full !== root && !full.startsWith(root + sep)) {
          sendJson(res, 200, { ok: false, message: '拒绝修改藏经阁之外的路径。' })
          return
        }
        const current = await readState(rootDir)
        const next = withMode(current, full, mode)
        const saved = await writeState(rootDir, next)
        if (!saved) {
          sendJson(res, 200, { ok: false, message: '状态文件写入失败。' })
          return
        }
        sendJson(res, 200, { ok: true, path: full, mode, auto: autoSkills(next) })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '切换失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: mode route')

  // GET /cangjingge/auto —— 只取「自动」清单（给 Lead 用的轻量入口）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/cangjingge/auto',
    handler: async (_req, res) => {
      try {
        const state = await readState(rootDir)
        sendJson(res, 200, { ok: true, auto: autoSkills(state) })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '读取失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: auto route')

  // GET /cangjingge/settings —— 读当前生效的设置（给界面显示"现在扫的是哪"）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/cangjingge/settings',
    handler: async (req, res) => {
      try {
        // 同一路径还注册了一个 POST（保存）。不检查 method 的话，
        // POST 请求会打进这里并拿到一份"读结果"，静默地什么都没保存 ——
        // 调用方以为保存成功，实际上没有任何改变。这类静默失败最难查。
        if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, message: '请用 GET。' })
          return
        }
        const settings = readSettingsSync()
        const effective = currentLibraryDir()
        sendJson(res, 200, {
          ok: true,
          // 界面输入框里该显示的值 = 用户显式保存的那个（可能是空）
          libraryDir: settings.libraryDir === undefined ? null : settings.libraryDir,
          // 当前实际生效的目录与它的来源，让用户知道"没填时用的是哪个"
          effective: rootDir,
          source: effective.source,
          config_dir: typeof configDir === 'string' && configDir.length > 0 ? configDir : null,
          default_dir: fallbackDir,
          settings_path: settingsPath,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '读取设置失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: settings route')

  // POST /cangjingge/settings —— 保存书架目录（界面「设置」按钮走这里）
  //
  // 【写操作】来源校验同 mode 路由。
  // 【写哪】~/.dsh/cangjingge-settings.json，**不是** profile patch ——
  //   插件不该也不能改自己的 profile 配置（那是宿主/插件管理器的地盘）。
  //
  // 【传空值】表示"清除覆盖，回到插件配置/默认"。这是必要的：否则用户
  //   一旦填过就再也回不到默认，只能去手改文件。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/cangjingge/settings',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, message: '请用 POST。' })
          return
        }
        if (!isTrustedOrigin(req)) {
          sendJson(res, 403, { ok: false, message: '来源不被信任，拒绝修改。' })
          return
        }
        const body = await readJsonBody(req)
        const raw = typeof body.libraryDir === 'string' ? body.libraryDir : ''

        // 空串 = 清除覆盖（回到插件配置/默认），不是错误
        let next
        if (raw.trim().length === 0) {
          next = normalizeSettings(null)
        } else {
          const checked = validateLibraryDir(raw)
          if (checked.ok !== true) {
            sendJson(res, 200, { ok: false, message: checked.message })
            return
          }
          next = normalizeSettings({ libraryDir: checked.value })
          // 目录不存在就建出来 —— 用户填了个新路径却忘了建目录是最常见的情况，
          // 而"扫描一个不存在的目录"会静默得到空书架，很难归因。
          try {
            await mkdir(resolveLibraryDir(checked.value), { recursive: true })
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              message: '目录不可用（无法创建）：' + String(error && error.message ? error.message : error),
            })
            return
          }
        }

        try {
          await writeFile(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            message: '设置写入失败：' + String(error && error.message ? error.message : error),
          })
          return
        }

        const newRoot = refreshRootDir()
        ctx.emit?.('cangjingge/changed', { libraryDir: newRoot })
        sendJson(res, 200, {
          ok: true,
          effective: newRoot,
          libraryDir: next.libraryDir,
          saved: next.libraryDir !== null,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '保存设置失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: settings save route')

  // GET /cangjingge/skill?path=... —— 读一个 skill 的正文
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/cangjingge/skill',
    handler: async (req, res) => {
      try {
        const target = queryParam(req, 'path')
        if (target === null) {
          sendJson(res, 200, { ok: false, message: '缺少 path 参数。' })
          return
        }
        const result = await readSkill(rootDir, target)
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '读取 skill 失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: skill route')

  // GET /cangjingge/candidates?group=&item= —— 喂给输入触发菜单的候选行
  //
  // 【为什么要有这个路由】
  //   输入触发 source 的 candidates() 是**浏览器半**在 composer 里同步/异步拉的，
  //   它不能在客户端直接读磁盘 —— 所以候选由宿主算好，客户端 fetch 回来。
  //   返回的就是 ui-reference 那套 { name, description, icon, section, value }。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/cangjingge/candidates',
    handler: async (req, res) => {
      try {
        const tree = await scanLibrary(rootDir)
        const group = queryParam(req, 'group')
        const item = queryParam(req, 'item')
        const view = shelfView(tree, { group, item })
        sendJson(res, 200, { ok: true, view })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '列出候选失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: candidates route')

  // -------------------------------------------------------------------------
  // 「自动」清单 -> 常驻系统提示
  //
  // 【这是「自动」开关真正生效的地方】
  //   text 传**函数**，dsh-system-prompt 每次组装提示时都会调用它
  //   （已核实：text: typeof section.text === "function" ? section.text(context) : section.text）。
  //   所以用户点开关后，**下一次组装**就反映新状态，不需要重建 section。
  //
  // 【order 取 700】SECTION_ORDERS 里 TEAM_POLICY = 600、PTC_ONLY = 800。
  //   我们的工作区规则应排在团队策略之后、其余工具说明之前 —— 700 正好。
  //
  // 【空文本】返回空串会被 renderPrompt 的 filter 掉，等于没有这一节。
  //   所以"取消全部自动"= 这一节自然消失，不需要注销注册。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'cangjingge:auto',
    order: 700,
    text: () => autoSectionText(),
  }), 'dsh-cangjingge: auto sections')
}
