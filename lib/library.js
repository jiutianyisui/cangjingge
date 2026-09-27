// ---------------------------------------------------------------------------
// dsh-cangjingge —— 藏经阁书架的纯函数层
//
// 【职责】把「藏经阁根目录的磁盘结构」机械地映射成三栏书架：
//
//   左栏 = 顶层文件夹（分组，用户可自己建、自己命名）
//   中栏 = 该分组下的子文件夹（子项）
//   右栏 = 该子项里的 skill 文件（.md / .txt / 其他文本）
//
// 【为什么单独拆一个纯函数文件】
//   1. 目录扫描是唯一容易出错的地方（编码、排序、隐藏文件、软链、超深目录），
//      把它抽成不碰 IO 的纯函数，就能用测试钉死行为，而不是"装上去才知道"。
//   2. 宿主半的 host.js 只负责「读磁盘 → 调本文件 → 回 JSON」，不做判断。
//
// 【铁律】本文件不 import 任何 node: 模块（除了类型上的空引用），
//   这样它既能被宿主半用（Node），也能被浏览器半内联复用（构建脚本会把它
//   和 @client.js 一起装配进 client.js）。
// ---------------------------------------------------------------------------

/** skill 文件之后允许的扩展名（小写，含点）。 */
export const SKILL_EXTENSIONS = ['.md', '.markdown', '.txt']

/** 单个 skill 文件读入时的字节上限：超过就截断并在结果里标记。 */
export const SKILL_MAX_BYTES = 256 * 1024

/** 一层目录里最多列多少个条目（防止一个疯子目录把界面拖死）。 */
export const MAX_ENTRIES_PER_DIR = 500

/**
 * 判定一个文件名是不是 skill 文件（按扩展名）。
 * @param name - 文件名。
 * @returns 是否算 skill。
 */
export function isSkillFile(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  const lower = name.toLowerCase()
  for (const ext of SKILL_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

/**
 * 目录内排序：文件夹在前，文件在后；同类按 localeCompare（中文按拼音）。
 *
 * 不排序的话 readdir 的顺序在不同文件系统上都不一样，界面每次刷新顺序都在跳。
 * @param a - 左条目 { name, kind }。
 * @param b - 右条目 { name, kind }。
 * @returns 比较值。
 */
export function compareEntries(a, b) {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')
}

/**
 * 把一层目录的原始条目筛成「可展示的条目」。
 *
 * 过滤规则：
 *   - 跳过以 `.` 开头的隐藏项（.git、.DS_Store…）
 *   - 跳过 `_` 开头的内部项（本插件自己将来要放缓存可以用这个前缀）
 *   - 只保留目录与 skill 文件；其他扩展名的文件忽略
 *
 * @param raw - [{ name, kind: 'dir'|'file' }]。
 * @returns 过滤并排序后的条目。
 */
export function visibleEntries(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const name = typeof item.name === 'string' ? item.name : ''
    if (name.length === 0) continue
    if (name.startsWith('.') || name.startsWith('_')) continue
    if (item.kind === 'dir') {
      out.push({ name, kind: 'dir' })
      continue
    }
    if (item.kind === 'file' && isSkillFile(name)) {
      out.push({ name, kind: 'file' })
    }
  }
  out.sort(compareEntries)
  return out.slice(0, MAX_ENTRIES_PER_DIR)
}

/**
 * 由「左栏选中名 / 中栏选中名」+ 目录树，算出三栏当前的展示内容。
 *
 * 这是书架的核心：**导航状态是纯数据**（选中的分组 / 子项名），
 * 界面只负责把名字换掉，不负责解析路径 —— 路径拼接集中在 node 侧一处，
 * 避免客户端自己拼出 `..` 之类的东西。
 *
 * @param tree - 树：{ groups: [{ name, items: [{ name, skills: [{ name, path }] }] }] }。
 * @param selection - { group: string|null, item: string|null }。
 * @returns { groups, items, skills } —— 三栏的当前条目。
 */
export function shelfView(tree, selection) {
  const groups = tree !== null && Array.isArray(tree.groups) ? tree.groups : []
  const pick = selection !== null && typeof selection === 'object' ? selection : {}

  const groupList = groups.map((g) => ({ name: g.name, count: Array.isArray(g.items) ? g.items.length : 0 }))

  const activeGroup = groupList.some((g) => g.name === pick.group)
    ? groups.find((g) => g.name === pick.group)
    : groups[0]

  const items = activeGroup === undefined || !Array.isArray(activeGroup.items)
    ? []
    : activeGroup.items.map((i) => ({
      name: i.name,
      count: Array.isArray(i.skills) ? i.skills.length : 0,
    }))

  const activeItem = items.length === 0
    ? undefined
    : (items.some((i) => i.name === pick.item)
      ? activeGroup.items.find((i) => i.name === pick.item)
      : activeGroup.items[0])

  const skills = activeItem === undefined || !Array.isArray(activeItem.skills)
    ? []
    : activeItem.skills.map((s) => ({ name: s.name, path: s.path }))

  return {
    groups: groupList,
    items,
    skills,
    active_group: activeGroup === undefined ? null : activeGroup.name,
    active_item: activeItem === undefined ? null : activeItem.name,
  }
}

/**
 * 把一片 skill 文本转成「可插入聊天框」的形式。
 *
 * 【为什么不是直接插全文】
 *   聊天框的输入是有长度代价的：把一个 200KB 的 skill 全文塞进 composer，
 *   用户每次编辑都要重排那一整坨。所以默认插入的是**引用形式**：
 *   一段说明 + 文件路径 + 正文。调用方（客户端）可以按需选择只插路径。
 *
 * @param skill - { name, path, text }。
 * @param mode - 'quote'（路径 + 正文）| 'path'（只路径）| 'body'（只正文）。
 * @returns 待插入的字符串。
 */
export function skillInsertText(skill, mode) {
  if (skill === null || typeof skill !== 'object') return ''
  const name = typeof skill.name === 'string' ? skill.name : '(未命名)'
  const path = typeof skill.path === 'string' ? skill.path : ''
  const text = typeof skill.text === 'string' ? skill.text : ''
  if (mode === 'path') return path
  if (mode === 'body') return text
  return '【skill：' + name + '】\n路径：' + path + '\n\n' + text
}

/**
 * 由「分组名 / 子项名 / 文件名」拼出给输入触发菜单用的候选行。
 *
 * 候选行的形状取自 ui-reference 的实测：{ name, description?, icon?, section?, value, drill? }。
 * value 是我们自己的字符串，onPick 再解析回来 —— 所以这里用 JSON 保证可逆。
 *
 * @param entries - shelfView 的结果。
 * @returns 候选行数组。
 */
export function skillCandidates(entries) {
  const skills = entries !== null && Array.isArray(entries.skills) ? entries.skills : []
  return skills.map((s) => ({
    name: String(s.name),
    description: String(s.path),
    icon: 'file',
    section: entries.active_item === null || entries.active_item === undefined
      ? 'skill'
      : String(entries.active_item),
    value: JSON.stringify({ kind: 'skill', name: String(s.name), path: String(s.path) }),
  }))
}

/**
 * 解析候选行回传的 value。解析不出来时返回 null（宁可什么都不做，也别插垃圾）。
 * @param value - 候选行的 value 字段。
 * @returns { kind, name, path } 或 null。
 */
export function parseCandidateValue(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object') return null
    if (parsed.kind !== 'skill') return null
    return {
      kind: 'skill',
      name: typeof parsed.name === 'string' ? parsed.name : '',
      path: typeof parsed.path === 'string' ? parsed.path : '',
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 界面里可改的设置（_settings.json）
//
// 【为什么另起一个文件，而不是写插件的 profile 配置】
//   DSH 没有给插件「改自己配置」的接口：profile 的 cordis.patch.yml 由
//   宿主/插件管理器拥有，插件既不知道 profile 目录在哪，也不该去写它。
//   所以界面里改的配置落在**插件自己的**一个 json 里，读的时候按优先级合并。
//
// 【放哪】~/.dsh/cangjingge-settings.json —— 固定的用户目录。
//   **不能**放在书架目录里：那样一改目录就找不到上次的设置，等于无法更改。
//
// 【优先级】_settings.json（界面改的） > 插件配置（libraryDir） > 内置默认
// ---------------------------------------------------------------------------

/** 设置文件名（放在用户主目录的 .dsh/ 下，与书架目录解耦）。 */
export const SETTINGS_FILE_NAME = 'cangjingge-settings.json'

/**
 * 规格化设置对象。只认我们知道的键；坏值一律丢掉（回落由调用方处理）。
 * @param raw - 磁盘读到的原始值。
 * @returns { libraryDir: string|null }。
 */
export function normalizeSettings(raw) {
  const out = { libraryDir: null }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const dir = raw.libraryDir
  if (typeof dir === 'string' && dir.trim().length > 0) out.libraryDir = dir.trim()
  return out
}

/**
 * 按优先级挑出最终生效的书架目录。
 *
 * @param override - 界面里保存的值（_settings.json）。
 * @param configured - 插件配置的值（cordis.patch.yml 的 libraryDir）。
 * @param fallback - 内置默认值。
 * @returns { value, source } —— 生效值与它的来源（给界面显示用）。
 */
export function pickLibraryDir(override, configured, fallback) {
  const clean = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null)
  const o = clean(override)
  if (o !== null) return { value: o, source: 'settings' }
  const c = clean(configured)
  if (c !== null) return { value: c, source: 'config' }
  return { value: String(fallback === undefined || fallback === null ? '' : fallback), source: 'default' }
}

/**
 * 校验一个「书架目录」字符串是否可用。
 *
 * 只做格式检查，不碰磁盘（那是调用方的事）：空串 / 含 NUL 一律拒。
 * 允许不存在的目录 —— 界面首次配置时它常常还没建，宿主会替它建。
 *
 * @param value - 用户输入。
 * @returns { ok, value?, message? }。
 */
export function validateLibraryDir(value) {
  if (typeof value !== 'string') return { ok: false, message: '路径必须是字符串。' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, message: '路径不能为空。' }
  if (trimmed.includes('\u0000')) return { ok: false, message: '路径含非法字符。' }
  if (trimmed.length > 512) return { ok: false, message: '路径过长（上限 512 字符）。' }
  return { ok: true, value: trimmed }
}
