// ---------------------------------------------------------------------------
// dsh-cangjingge —— 宿主半（Node 侧）
//
// 职责：
//   1. 读取配置里的「藏经阁根目录」（默认 ~/.dsh/cangjingge）
//   2. 扫描磁盘 -> 三栏书架树
//   3. 通过 HTTP 路由把树 / 单个 skill 正文给浏览器半
//   4. 读写界面设置（书架目录，`/cangjingge/settings`）
//
// 本插件**零 @deepseek-ai 依赖**（理由见天枢 src\toolkit.js 头注释：
// 声明 @deepseek-ai/* 会顶掉桌面端自带运行时 -> 整个软件打不开）。
// 所以这里不需要 @deepseek-ai 的 anything：只用 node:fs / node:path。
//
// 【静态组合包拿不到 host.call】浏览器半访问宿主数据只能走宿主自注册的
// HTTP 路由（webServer.register，官方扩展点）。与天枢同一条路。
//
// 【历史】早期版本还有一个「自动」开关：把标记为自动的 skill 正文通过
//   systemPrompt.section 注入系统提示。该功能已**整体移除**（含客户端开关、
//   _state.json、/cangjingge/mode 与 /cangjingge/auto 路由）——它每轮都占
//   token，且实测无法可靠驱动模型服从。藏经阁现在只做书架浏览与 `/` 插入。
// ---------------------------------------------------------------------------

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
// 同步读用于设置（/settings 的处理是同步就绪的，见下方注释）
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { join, resolve, sep } from 'node:path'
import {
  visibleEntries,
  shelfView,
  SKILL_MAX_BYTES,
  SETTINGS_FILE_NAME,
  VISIBLE_FILE_NAME,
  normalizeVisible,
  isVisible,
  withVisible,
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
 *
 * 【为什么没有 systemPrompt —— 真实事故】
 *   早先这里写过 inject = ['webServer', 'systemPrompt']，结果**整个插件起不来**：
 *   /cangjingge/* 的所有路由全 404，而同一 profile 里别的插件（如天枢）正常。
 *   原因：systemPrompt 是 **Agent scope** 的服务（由 dsh-base 的 preset 层挂在
 *   agent 作用域），根 ctx 永远等不到它 —— 声明成插件依赖 = cordis 无限期等待
 *   = apply() 一次都没跑。
 *
 *   「自动注入系统提示」功能已于后续版本**整体移除**（连同 auto/manual 开关、
 *   _state.json 与 /cangjingge/mode、/cangjingge/auto 两条路由）。藏经阁现在
 *   只做：书架浏览 + `/` 菜单插入。这条依赖一并去掉，插件对 DSH 的依赖面更小。
 *
 * 注意这里**没有** tools：藏经阁不注册模型工具。
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
 * 读 `/` 菜单可见性状态（根目录下的 _visible.json）。
 * 文件不存在或损坏都返回空状态 —— 默认「全不显示」，状态可再生产，不值得报错。
 * @param rootDir - 藏经阁根目录。
 * @returns 规格化后的状态。
 */
export async function readVisible(rootDir) {
  try {
    const text = await readFile(join(rootDir, VISIBLE_FILE_NAME), 'utf8')
    return normalizeVisible(JSON.parse(text))
  } catch {
    return normalizeVisible(null)
  }
}

/**
 * 写 `/` 菜单可见性状态。
 * @param rootDir - 藏经阁根目录。
 * @param state - 规格化后的状态。
 * @returns 是否写成功。
 */
export async function writeVisible(rootDir, state) {
  try {
    await writeFile(
      join(rootDir, VISIBLE_FILE_NAME),
      JSON.stringify(normalizeVisible(state), null, 2) + '\n',
      'utf8',
    )
    return true
  } catch {
    return false
  }
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
  ctx.logger?.info?.('dsh-cangjingge: library dir = ' + rootDir)

  /**
   * 重算 rootDir（界面保存了新目录后调用）。
   * @returns 新的绝对路径。
   */
  function refreshRootDir() {
    rootDir = resolveLibraryDir(currentLibraryDir().value)
    ctx.logger?.info?.('dsh-cangjingge: library dir -> ' + rootDir)
    return rootDir
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
   * /cangjingge/settings 会写设置文件，而页面里加载的任何第三方内容（壁纸 URL、
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
        const state = await readVisible(rootDir)
        const tree = await scanLibrary(rootDir)
        const group = queryParam(req, 'group')
        const item = queryParam(req, 'item')
        const view = shelfView(tree, { group, item })
        // 给每个 skill 附上「是否在 `/` 菜单显示」；并给出整棵树的勾选统计，
        // 供界面显示「本组有几个可插入」以及 /candidates 的第一屏用。
        const skills = Array.isArray(view.skills)
          ? view.skills.map((s) => ({ ...s, visible: isVisible(state, s.path) }))
          : []
        const groupStats = tree.groups.map((g) => {
          let total = 0
          let visibleCount = 0
          for (const i of g.items) {
            for (const s of i.skills) {
              total += 1
              if (isVisible(state, s.path)) visibleCount += 1
            }
          }
          return { name: g.name, count: g.items.length, total, visibleCount }
        })
        sendJson(res, 200, {
          ok: true,
          root: rootDir,
          groups: groupStats,
          view: { ...view, skills },
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '扫描书架失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: shelf route')

  // POST /cangjingge/visible —— 设置某个 skill 是否在 `/` 菜单显示
  //
  // 【这是写操作】所以要做来源校验（与 settings 同一策略）。
  // 语义：只改 _visible.json 里的一条记录。绝对不动 skill 文件本身。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/cangjingge/visible',
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

        // 批量设置：paths 数组 + visible 布尔（「全选 / 全不选」走这条）。
        if (Array.isArray(body.paths)) {
          const root = resolve(rootDir)
          let state = await readVisible(rootDir)
          for (const p of body.paths) {
            if (typeof p !== 'string') continue
            const full = resolve(p)
            if (full !== root && !full.startsWith(root + sep)) continue
            state = withVisible(state, full, body.visible === true)
          }
          const saved = await writeVisible(rootDir, state)
          if (!saved) {
            sendJson(res, 200, { ok: false, message: '可见性文件写入失败。' })
            return
          }
          sendJson(res, 200, { ok: true, visible: true })
          return
        }

        const target = typeof body.path === 'string' ? body.path : ''
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
        const state = await readVisible(rootDir)
        const next = withVisible(state, full, body.visible === true)
        const saved = await writeVisible(rootDir, next)
        if (!saved) {
          sendJson(res, 200, { ok: false, message: '可见性文件写入失败。' })
          return
        }
        sendJson(res, 200, { ok: true, path: full, visible: body.visible === true })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '切换失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: visible route')

  // /cangjingge/settings —— GET 读设置 / POST 保存书架目录
  //
  // 【必须是**一条**路由，靠 req.method 分支 —— 真实事故】
  //   dsh 的 webServer **不允许同一 path 注册两条 exact 路由**：
  //   第二条会抛 `webserver: duplicate exact route "..."`。
  //   而抛错发生在 ctx.effect 里 → **整个插件的 effect 被回滚** →
  //   前面已注册的路由也一起消失 → 全站 404。
  //   （症状极具误导性：看起来像"插件没加载"，其实是"注册到一半炸了"。）
  //   天枢的 /tianshu/thread/bind 也是这么写的：一条路由处理多个 method。
  //
  // GET  ：读当前生效的设置（界面显示"现在扫的是哪"）。
  // POST ：保存书架目录（界面「设置」按钮走这里）。
  //        【写哪】~/.dsh/cangjingge-settings.json，**不是** profile patch ——
  //        插件不该也不能改自己的 profile 配置（那是宿主/插件管理器的地盘）。
  //        【传空值】= 清除覆盖，回到插件配置 / 默认。必要：否则用户填过就
  //        再也回不到默认，只能去手改文件。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/cangjingge/settings',
    handler: async (req, res) => {
      // ---- GET：读设置 ----
      if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') {
        try {
          const settings = readSettingsSync()
          const effective = currentLibraryDir()
          sendJson(res, 200, {
            ok: true,
            // 界面输入框该显示的值 = 用户显式保存过的那个（可能是 null）
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
        return
      }

      // ---- POST：保存设置 ----
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, message: '请用 GET 或 POST。' })
        return
      }
      try {
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
          // 目录不存在就建出来 —— 用户填了新路径却忘了建目录是最常见的情况，
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
  }), 'dsh-cangjingge: settings route')

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
        const state = await readVisible(rootDir)
        const tree = await scanLibrary(rootDir)
        const group = queryParam(req, 'group')
        const item = queryParam(req, 'item')
        const view = shelfView(tree, { group, item })
        // 只给「已在 `/` 菜单显示」的 skill；每个对象都带上 visible 字段，
        // 客户端 / 菜单据此渲染（不另加请求 —— mode 本来就已经在数据里）。
        const skills = Array.isArray(view.skills)
          ? view.skills
            .filter((s) => isVisible(state, s.path))
            .map((s) => ({ ...s, visible: true }))
          : []
        // 第一屏（空 query）用：每个分组里有多少个 skill 已勾选显示。
        const groups = tree.groups.map((g) => {
          let visibleCount = 0
          for (const i of g.items) {
            for (const s of i.skills) {
              if (isVisible(state, s.path)) visibleCount += 1
            }
          }
          return { name: g.name, visibleCount }
        })
        sendJson(res, 200, { ok: true, view: { ...view, skills }, groups })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '列出候选失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: candidates route')
}
