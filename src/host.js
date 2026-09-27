// ---------------------------------------------------------------------------
// dsh-cangjingge —— 宿主半（Node 侧）
//
// 职责：
//   1. 读取配置里的「藏经阁根目录」（默认 ~/.dsh/cangjingge）
//   2. 扫描磁盘 -> 三栏书架树
//   3. 通过 HTTP 路由把树 / 单个 skill 正文给浏览器半
//
// 本插件**零 @deepseek-ai 依赖**（理由见天枢 src\toolkit.js 头注释：
// 声明 @deepseek-ai/* 会顶掉桌面端自带运行时 -> 整个软件打不开）。
// 所以这里不需要 @deepseek-ai 的 anything：只用 node:fs / node:path。
//
// 【静态组合包拿不到 host.call】浏览器半访问宿主数据只能走宿主自注册的
// HTTP 路由（webServer.register，官方扩展点）。与天枢同一条路。
// ---------------------------------------------------------------------------

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
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
} from './library.js'

import { defineConfig } from './toolkit.js'

/** 本插件的 cordis 插件名（必须与 cordis.patch.yml 里的 id 一致）。 */
export const name = 'dsh-cangjingge'

/**
 * 依赖的服务。
 * - webServer：注册浏览器半读取书架用的 HTTP 路由。
 *
 * 注意这里**没有** tools：藏经阁不注册模型工具（它不是给模型用的，
 * 是给人点着看的）。将来若要让模型也能列书，再加。
 */
export const inject = ['webServer']

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
  const rootDir = resolveLibraryDir(settings.libraryDir)
  ctx.logger?.info?.('dsh-cangjingge: library dir = ' + rootDir)

  /**
   * 把一个对象作为 JSON 写回浏览器。
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
}
