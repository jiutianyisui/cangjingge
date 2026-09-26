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

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  visibleEntries,
  shelfView,
  SKILL_MAX_BYTES,
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

  // GET /cangjingge/shelf —— 整座书架的树 + 三栏当前视图
  //
  // 一次把树给全（三层，几百个文件也就几十 KB），界面切换分组/子项时
  // 纯本地计算，不用往返。skill 正文**不在**这里，按需走 /cangjingge/skill。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/cangjingge/shelf',
    handler: async (req, res) => {
      try {
        const tree = await scanLibrary(rootDir)
        const group = queryParam(req, 'group')
        const item = queryParam(req, 'item')
        const view = shelfView(tree, { group, item })
        sendJson(res, 200, {
          ok: true,
          root: rootDir,
          groups: tree.groups.map((g) => ({
            name: g.name,
            count: g.items.length,
            items: g.items.map((i) => ({ name: i.name, count: i.skills.length })),
          })),
          view,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: '扫描书架失败：' + String(error) })
      }
    },
  }), 'dsh-cangjingge: shelf route')

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
