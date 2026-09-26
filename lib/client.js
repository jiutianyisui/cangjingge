// 本文件由 tools\build.mjs 生成，请勿直接修改
// 组成：src\library.js（纯函数书架模型） + src\@client.js（三栏 UI 与触发 source）
window.__ModuleLoader__.load({
  id: "dsh-cangjingge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
// ==== src/library.js ====
var __part0 = (function () {
  var module = { exports: {} };
  var exports = module.exports;
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
  const SKILL_EXTENSIONS = ['.md', '.markdown', '.txt']
  
  /** 单个 skill 文件读入时的字节上限：超过就截断并在结果里标记。 */
  const SKILL_MAX_BYTES = 256 * 1024
  
  /** 一层目录里最多列多少个条目（防止一个疯子目录把界面拖死）。 */
  const MAX_ENTRIES_PER_DIR = 500
  
  /**
   * 判定一个文件名是不是 skill 文件（按扩展名）。
   * @param name - 文件名。
   * @returns 是否算 skill。
   */
  function isSkillFile(name) {
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
  function compareEntries(a, b) {
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
  function visibleEntries(raw) {
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
  function shelfView(tree, selection) {
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
  function skillInsertText(skill, mode) {
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
  function skillCandidates(entries) {
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
  function parseCandidateValue(value) {
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
  Object.assign(module.exports, { SKILL_EXTENSIONS, SKILL_MAX_BYTES, MAX_ENTRIES_PER_DIR, isSkillFile, visibleEntries, shelfView, skillInsertText, skillCandidates, parseCandidateValue });
  return module.exports
})();

// ==== src/@client.js ====
var __part1 = (function () {
  var module = { exports: {} };
  var exports = module.exports;
  var { SKILL_EXTENSIONS, SKILL_MAX_BYTES, MAX_ENTRIES_PER_DIR, isSkillFile, visibleEntries, shelfView, skillInsertText, skillCandidates, parseCandidateValue } = __part0;
  // ---------------------------------------------------------------------------
  // dsh-cangjingge —— 浏览器半（页面里真正跑的那一段）
  //
  // 由 tools/build.mjs 拼进
  //   window.__ModuleLoader__.load({ id: 'dsh-cangjingge', factory: (require) => { ... } })
  // 的 factory 里，所以：
  //   * 只能 require() 模块表里已有的条目（这里只用 react）；
  //   * 不能写 import / export（文件末尾统一 exports.xxx = ...），不能写 JSX。
  //
  // 【落点】
  //   sidebar.panellist —— 左栏小阁楼图标（点开书架）
  //   main              —— 三栏书架主面板
  //   conversation.input.overlay 侧的输入触发 source（`/` 菜单）由 input-trigger 流水线提供，
  //                      我们只 registerSource，不占槽位。
  //
  // 【插入聊天框为什么走 `/` 菜单】
  //   DSH 的 composer 对外**没有**「直接写文本」的接口：唯一的插入路径是
  //   input-trigger 的 pick 流程（insertText(text, span)），而 span 只能由
  //   pick 现场提供。侧栏/main 面板的按钮拿不到 span。
  //   所以书架负责「浏览与挑选」，真正插入由 `/` 触发菜单完成 —— 这是官方
  //   唯一支持且版本稳定的路。
  // ---------------------------------------------------------------------------
  
  const React = require('react')
  
  // ===========================================================================
  // 常量
  // ===========================================================================
  
  /** 侧栏面板 id —— 同时也是 main 面板的 key。 */
  const PANEL_ID = 'cangjingge'
  /** 侧栏图标位注册 id。 */
  const ICON_SLOT = 'sidebar.panellist'
  /** 主面板位（keyed）。 */
  const MAIN_SLOT = 'main'
  /** 书架数据路由。 */
  const SHELF_URL = '/cangjingge/shelf'
  /** 单个 skill 正文路由。 */
  const SKILL_URL = '/cangjingge/skill'
  /** 输入触发菜单的 source 名（与 `/` 组合成 /藏经阁）。 */
  const SOURCE_TRIGGER = '/'
  const SOURCE_NAME = 'cangjingge'
  
  /** 样式表锚点属性。 */
  const CSS_ATTR = 'data-dsh-cangjingge-css'
  
  // ===========================================================================
  // 样式（类名统一 dsh-cjg-* 前缀，避免撞上 DSH 自己的类）
  // ===========================================================================
  
  const CSS = [
    '.dsh-cjg-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}',
    '.dsh-cjg-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
    '.dsh-cjg-title{font-weight:600;font-size:13px}',
    '.dsh-cjg-sub{color:var(--dsw-alias-label-tertiary);font-size:11px}',
    '.dsh-cjg-spacer{flex:1 1 auto}',
    '.dsh-cjg-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer;font-family:inherit}',
    '.dsh-cjg-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
    '.dsh-cjg-btn:disabled{opacity:.5;cursor:default}',
    '.dsh-cjg-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
    // 三栏：左(分组) / 中(子项) / 右(skill)
    '.dsh-cjg-cols{flex:1 1 auto;display:flex;min-height:0;min-width:0}',
    '.dsh-cjg-col{display:flex;flex-direction:column;min-height:0;min-width:0}',
    '.dsh-cjg-col-l{flex:0 0 168px}',
    '.dsh-cjg-col-m{flex:0 0 168px;border-left:1px solid var(--dsw-alias-border-l1)}',
    '.dsh-cjg-col-r{flex:1 1 auto;border-left:1px solid var(--dsw-alias-border-l1)}',
    '.dsh-cjg-col-head{flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:7px 9px 5px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}',
    '.dsh-cjg-list{flex:1 1 auto;overflow-y:auto;padding:0 6px 10px;min-height:0}',
    '.dsh-cjg-row{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:inherit;border-radius:7px;padding:4px 7px;margin-bottom:2px;cursor:pointer;font-family:inherit;font-size:12px;line-height:1.4}',
    '.dsh-cjg-row:hover{background:var(--dsw-alias-bg-layer-1)}',
    '.dsh-cjg-row-on{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-brand-primary)}',
    '.dsh-cjg-row-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-cjg-row-count{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
    '.dsh-cjg-dot{flex:0 0 auto;width:6px;height:6px;border-radius:2px;background:var(--dsw-alias-brand-primary);opacity:.7}',
    '.dsh-cjg-body{flex:1 1 auto;overflow:auto;padding:8px 10px 20px;min-height:0}',
    '.dsh-cjg-empty{padding:24px 14px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7}',
    '.dsh-cjg-err{margin:8px 2px;padding:8px 10px;border-radius:7px;font-size:11px;color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-word}',
    '.dsh-cjg-note{margin:8px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word}',
    '.dsh-cjg-skill-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:7px}',
    '.dsh-cjg-skill-name{font-weight:600;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-cjg-path{font-family:var(--dsw-specific-font-family-code),monospace;font-size:10px;color:var(--dsw-alias-label-tertiary);word-break:break-all;margin-bottom:8px}',
    '.dsh-cjg-pre{margin:0;padding:8px 10px;border-radius:6px;overflow:auto;background:var(--dsw-alias-bg-layer-2);font-family:var(--dsw-specific-font-family-code),monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:52vh}',
    '.dsh-cjg-actions{margin-top:9px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
    '.dsh-cjg-hint{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.6}',
    '.dsh-cjg-icon{display:inline-flex;align-items:center;justify-content:center}',
    '.dsh-cjg-icon-active{color:var(--dsw-alias-brand-primary)}',
    '.dsh-cjg-modal-mask{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}',
    '.dsh-cjg-modal{width:min(380px,88vw);padding:14px 16px;border-radius:10px;background:var(--dsw-alias-bg-overlay,#1c1c1f);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 12px 32px rgba(0,0,0,.35)}',
    '.dsh-cjg-modal-title{font-weight:600;font-size:13px;margin-bottom:8px}',
    '.dsh-cjg-input{display:block;width:100%;box-sizing:border-box;padding:5px 8px;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;outline:none;margin-bottom:10px}',
    '.dsh-cjg-input:focus{border-color:var(--dsw-alias-brand-primary)}',
    '.dsh-cjg-modal-actions{display:flex;gap:6px;margin-top:4px}',
  ].join('')
  
  /**
   * 样式安装器：把 CSS 挂进 <head>，返回卸载函数。
   * 用稳定 data 属性做锚点，避免重复装载时 <style> 越挂越多。
   */
  const styles = {
    /**
     * 插入（或复用）本插件的样式表。
     * @param css - CSS 文本。
     * @returns 卸载函数。
     */
    insert(css) {
      const doc = document
      const existing = doc.querySelector('style[' + CSS_ATTR + ']')
      const tag = existing === null ? doc.createElement('style') : existing
      if (existing === null) {
        tag.setAttribute(CSS_ATTR, '')
        doc.head.appendChild(tag)
      }
      tag.textContent = css
      return () => {
        if (tag.parentNode !== null && tag.parentNode !== undefined) tag.parentNode.removeChild(tag)
      }
    },
  }
  
  // ===========================================================================
  // 宿主数据访问（相对路径 fetch，自带页面 origin）
  // ===========================================================================
  
  /**
   * 拉书架数据。
   * @param group - 选中的分组名（可空）。
   * @param item - 选中的子项名（可空）。
   * @returns { ok, root, groups, view } 或 { ok:false, message }。
   */
  async function fetchShelf(group, item) {
    const params = []
    if (typeof group === 'string' && group.length > 0) params.push('group=' + encodeURIComponent(group))
    if (typeof item === 'string' && item.length > 0) params.push('item=' + encodeURIComponent(item))
    const url = SHELF_URL + (params.length > 0 ? '?' + params.join('&') : '')
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) return { ok: false, message: '宿主返回 HTTP ' + String(response.status) }
      const data = await response.json()
      if (data === null || typeof data !== 'object') return { ok: false, message: '宿主返回的不是 JSON 对象' }
      return data
    } catch (error) {
      return { ok: false, message: '读取书架失败：' + String(error && error.message ? error.message : error) }
    }
  }
  
  /**
   * 读一个 skill 的正文。
   * @param path - skill 文件绝对路径。
   * @returns { ok, text, truncated, message }。
   */
  async function fetchSkill(path) {
    try {
      const response = await fetch(SKILL_URL + '?path=' + encodeURIComponent(path), {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return { ok: false, message: '宿主返回 HTTP ' + String(response.status) }
      const data = await response.json()
      if (data === null || typeof data !== 'object') return { ok: false, message: '宿主返回的不是 JSON 对象' }
      return data
    } catch (error) {
      return { ok: false, message: '读取 skill 失败：' + String(error && error.message ? error.message : error) }
    }
  }
  
  /**
   * 判断当前宿主是否已打开某个会话（决定 `/` 菜单能不能用）。
   * 不做探测：input-trigger 的 source 只在 composer 里被调用，天然有会话。
   */
  
  // ===========================================================================
  // 小组件
  // ===========================================================================
  
  /**
   * 侧栏图标（sidebar.panellist）：画一个「小阁楼」。
   *
   * 尺寸跟随 owner 传入的 size（与右侧字体同档），纯内联 SVG，不引外部资源。
   * 阁楼 = 一个带尖顶的小屋：屋顶三角 + 屋身 + 一扇窗。
   * @param props - { size, active }。
   * @returns React 元素。
   */
  function PanelIcon(props) {
    const size = typeof props.size === 'number' ? props.size : 16
    return React.createElement('span', {
      className: 'dsh-cjg-icon' + (props.active === true ? ' dsh-cjg-icon-active' : ''),
      style: { width: size, height: size },
    }, React.createElement('svg', {
      viewBox: '0 0 20 20', width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
    }, [
      // 屋顶（尖顶）
      React.createElement('path', {
        key: 'roof',
        d: 'M10 2.1 L18.2 8.6 L16.9 10.2 L10 4.8 L3.1 10.2 L1.8 8.6 Z',
        fill: 'currentColor',
      }),
      // 屋身
      React.createElement('path', {
        key: 'body',
        d: 'M4 10.6 L16 10.6 L16 18 L4 18 Z',
        fill: 'currentColor',
        opacity: 0.55,
      }),
      // 窗
      React.createElement('rect', {
        key: 'win',
        x: 8.4, y: 12.6, width: 3.2, height: 3.6, rx: 0.4,
        fill: 'var(--dsw-alias-bg-base)',
      }),
    ]))
  }
  
  /**
   * 一栏的列表。
   * @param props - { title, entries, active, onPick, emptyText }。
   * @returns React 元素。
   */
  function Column(props) {
    const entries = Array.isArray(props.entries) ? props.entries : []
    const children = []
    children.push(React.createElement('div', { key: 'h', className: 'dsh-cjg-col-head' },
      React.createElement('span', null, props.title),
      React.createElement('span', { className: 'dsh-cjg-spacer' }),
      React.createElement('span', null, entries.length > 0 ? String(entries.length) : '')))
  
    if (entries.length === 0) {
      children.push(React.createElement('div', { key: 'e', className: 'dsh-cjg-empty' }, props.emptyText))
    } else {
      for (const entry of entries) {
        const on = props.active === entry.name
        children.push(React.createElement('button', {
          key: entry.name,
          type: 'button',
          className: 'dsh-cjg-row' + (on ? ' dsh-cjg-row-on' : ''),
          title: entry.name,
          onClick: () => props.onPick(entry.name),
        },
        React.createElement('span', { className: 'dsh-cjg-dot' }),
        React.createElement('span', { className: 'dsh-cjg-row-name' }, entry.name),
        entry.count === undefined ? null : React.createElement('span', { className: 'dsh-cjg-row-count' }, String(entry.count))))
      }
    }
    return React.createElement('div', { className: 'dsh-cjg-col ' + props.className },
      React.createElement('div', { className: 'dsh-cjg-list' }, children))
  }
  
  /**
   * 右侧：skill 详情 + 操作。
   *
   * 【操作里为什么是「复制」+「在输入框打 / 插入」两种】
   *   宿主没有从面板直接写 composer 的接口（见文件头注释），所以：
   *     - 「复制路径」把路径塞进剪贴板，用户可以自己粘贴；
   *     - 真正的插入引导用户去 composer 打 `/藏经阁`，那边是官方支持的正路。
   * @param props - { skill, text, loading, error, truncated, onCopy }。
   * @returns React 元素。
   */
  function SkillDetail(props) {
    if (props.skill === null || props.skill === undefined) {
      return React.createElement('div', { className: 'dsh-cjg-empty' },
        '左栏选中一个分组、中栏选中一个子项，这里会列出里面的 skill。')
    }
    if (props.loading === true) {
      return React.createElement('div', { className: 'dsh-cjg-empty' }, '读取中……')
    }
    if (typeof props.error === 'string' && props.error.length > 0) {
      return React.createElement('div', { className: 'dsh-cjg-err' }, props.error)
    }
    return React.createElement('div', null,
      React.createElement('div', { className: 'dsh-cjg-skill-head' },
        React.createElement('span', { className: 'dsh-cjg-skill-name' }, props.skill.name)),
      React.createElement('div', { className: 'dsh-cjg-path' }, props.skill.path),
      React.createElement('div', { className: 'dsh-cjg-actions' },
        React.createElement('button', {
          type: 'button',
          className: 'dsh-cjg-btn',
          onClick: () => props.onCopy(props.skill.path),
        }, '复制路径'),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-cjg-btn',
          onClick: () => props.onCopy(String(props.text === undefined || props.text === null ? '' : props.text)),
        }, '复制全文')),
      React.createElement('div', { className: 'dsh-cjg-hint' },
        '在聊天输入框里打 “/” 打开菜单，选「藏经阁」，即可把 skill 插入当前对话框。'),
      props.truncated === true
        ? React.createElement('div', { className: 'dsh-cjg-note' }, '（文件较大，正文已截断显示）')
        : null,
      React.createElement('pre', { className: 'dsh-cjg-pre' },
        String(props.text === undefined || props.text === null || props.text === '' ? '(空文件)' : props.text)))
  }
  
  /**
   * 主面板：三栏书架。
   * @returns React 元素。
   */
  function ShelfPanel() {
    const [state, setState] = React.useState({ loading: true, data: null, error: null })
    const [selection, setSelection] = React.useState({ group: null, item: null })
    const [detail, setDetail] = React.useState({ skill: null, text: '', loading: false, error: null, truncated: false })
    const [flash, setFlash] = React.useState(null)
    const alive = React.useRef(true)
    /** selection 的镜像：给事件回调读最新值（避免闭包捕获旧 state）。 */
    const selectionRef = React.useRef({ group: null, item: null })
  
    React.useEffect(() => () => { alive.current = false }, [])
  
    const load = React.useCallback(async (group, item) => {
      const data = await fetchShelf(group, item)
      if (!alive.current) return
      if (data !== null && data.ok === true) {
        const view = data.view !== null && data.view !== undefined ? data.view : null
        setState({ loading: false, data, error: null })
        // 宿主会回填「实际生效」的分组/子项（第一个），同步回本地选择，
        // 否则用户看到的是高亮 A、内容却是 B。
        if (view !== null) {
          const next = { group: view.active_group, item: view.active_item }
          selectionRef.current = next
          setSelection(next)
        }
      } else {
        setState({
          loading: false,
          data: null,
          error: data !== null && typeof data.message === 'string' ? data.message : '读取书架失败。',
        })
      }
    }, [])
  
    React.useEffect(() => { void load(null, null) }, [load])
  
    const view = state.data !== null && state.data.view !== undefined ? state.data.view : null
    const groups = view !== null && Array.isArray(view.groups) ? view.groups : []
    const items = view !== null && Array.isArray(view.items) ? view.items : []
    const skills = view !== null && Array.isArray(view.skills) ? view.skills : []
  
    // 选中 skill -> 拉正文
    const openSkill = React.useCallback(async (skill) => {
      setDetail({ skill, text: '', loading: true, error: null, truncated: false })
      setFlash(null)
      const result = await fetchSkill(skill.path)
      if (!alive.current) return
      if (result !== null && result.ok === true) {
        setDetail({
          skill, text: String(result.text === undefined ? '' : result.text),
          loading: false, error: null, truncated: result.truncated === true,
        })
      } else {
        setDetail({
          skill, text: '', loading: false,
          error: result !== null && typeof result.message === 'string' ? result.message : '读取失败。',
          truncated: false,
        })
      }
    }, [])
  
    // 切换分组/子项时清掉右侧详情（它属于上一个子项）
    const pickGroup = React.useCallback((name) => {
      selectionRef.current = { group: name, item: null }
      setSelection(selectionRef.current)
      setDetail({ skill: null, text: '', loading: false, error: null, truncated: false })
      void load(name, null)
    }, [load])
  
    const pickItem = React.useCallback((name) => {
      const group = selectionRef.current.group
      selectionRef.current = { group, item: name }
      setSelection(selectionRef.current)
      setDetail({ skill: null, text: '', loading: false, error: null, truncated: false })
      void load(group, name)
    }, [load])
  
    /**
     * 复制到剪贴板。优先用 navigator.clipboard，失败时退回一个隐藏 textarea +
     * document.execCommand('copy')（老环境兜底）。
     * 失败时给出提示而不是静默 —— 用户会以为"复制成功"然后粘贴出旧内容。
     * @param text - 待复制文本。
     */
    const copy = React.useCallback(async (text) => {
      setFlash(null)
      try {
        if (navigator !== undefined && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          setFlash({ kind: 'ok', text: '已复制到剪贴板。' })
          return
        }
        throw new Error('no clipboard api')
      } catch {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(area)
          setFlash({ kind: ok ? 'ok' : 'error', text: ok ? '已复制到剪贴板。' : '复制失败，请手动选择文本。' })
        } catch {
          setFlash({ kind: 'error', text: '复制失败，请手动选择文本。' })
        }
      }
    }, [])
  
    const rootText = state.data !== null && typeof state.data.root === 'string' ? state.data.root : ''
  
    return React.createElement('div', { className: 'dsh-cjg-root' },
      React.createElement('div', { className: 'dsh-cjg-head' },
        React.createElement('span', { className: 'dsh-cjg-title' }, '藏经阁 · skill 书架'),
        React.createElement('span', { className: 'dsh-cjg-sub' }, rootText),
        React.createElement('span', { className: 'dsh-cjg-spacer' }),
        React.createElement('button', {
          type: 'button', className: 'dsh-cjg-btn',
          onClick: () => { void load(selectionRef.current.group, selectionRef.current.item) },
        }, '重新扫描')),
  
      state.loading
        ? React.createElement('div', { className: 'dsh-cjg-empty' }, '扫描书架中……')
        : state.error !== null
          ? React.createElement('div', { className: 'dsh-cjg-err' }, state.error)
          : React.createElement('div', { className: 'dsh-cjg-cols' },
            React.createElement(Column, {
              title: '分组', className: 'dsh-cjg-col-l',
              entries: groups, active: selection.group,
              onPick: pickGroup,
              emptyText: '藏经阁里还没有分组文件夹。在根目录下建一个文件夹，里面再建子文件夹放 skill。',
            }),
            React.createElement(Column, {
              title: '子项', className: 'dsh-cjg-col-m',
              entries: items, active: selection.item,
              onPick: pickItem,
              emptyText: '这个分组下还没有子文件夹。',
            }),
            React.createElement('div', { className: 'dsh-cjg-col dsh-cjg-col-r' },
              React.createElement('div', { className: 'dsh-cjg-col-head' },
                React.createElement('span', null, 'skill'),
                React.createElement('span', { className: 'dsh-cjg-spacer' }),
                React.createElement('span', null, skills.length > 0 ? String(skills.length) : '')),
              React.createElement('div', { className: 'dsh-cjg-list' },
                skills.length === 0
                  ? React.createElement('div', { className: 'dsh-cjg-empty' }, '这个子项下还没有 skill 文件（支持 .md / .markdown / .txt）。')
                  : skills.map((skill) => React.createElement('button', {
                    key: skill.path,
                    type: 'button',
                    className: 'dsh-cjg-row' + (detail.skill !== null && detail.skill !== undefined && detail.skill.path === skill.path ? ' dsh-cjg-row-on' : ''),
                    title: skill.name,
                    onClick: () => { void openSkill(skill) },
                  },
                  React.createElement('span', { className: 'dsh-cjg-row-name' }, skill.name)))),
              React.createElement('div', { className: 'dsh-cjg-body' },
                flash === null ? null : React.createElement('div', {
                  className: flash.kind === 'error' ? 'dsh-cjg-err' : 'dsh-cjg-note',
                }, flash.text),
                React.createElement(SkillDetail, {
                  skill: detail.skill, text: detail.text, loading: detail.loading,
                  error: detail.error, truncated: detail.truncated, onCopy: copy,
                })))))
  }
  
  // ===========================================================================
  // 输入触发 source（把 skill 插进聊天框的唯一正路）
  // ===========================================================================
  
  /**
   * 构造 `/藏经阁` 的触发 source。
   *
   * 【形状取自 ui-reference 的实测】
   *   { trigger: '/', name: 'cangjingge',
   *     async candidates(session, { query, signal }) -> [{ name, description, icon, section, value }],
   *     onPick({ candidate, action }) -> { insert: { source, ref, label, appearance, clipboardText } } }
   *
   * `onPick` 返回的 `insert` 会被 composer 的输入状态机接住，插成原子引用；
   * 这是我们能拿到的唯一「往聊天框写东西」的受支持出口。
   *
   * 【候选从哪来】浏览器半读不到磁盘，所以 fetch 宿主的 /cangjingge/candidates。
   * 【插什么】默认按配置的 insertMode 插「路径 + 正文」，主路径。
   *   但这里拿不到配置（客户端半没有 config），所以插入形式固定在宿主侧
   *   由 /cangjingge/skill 决定不了 —— 因此这里统一插「路径」引用，
   *   正文由用户在书架里预览/复制。这样插入轻、对话历史也干净。
   *
   * @param rootCtx - 客户端根上下文。
   * @returns source 对象。
   */
  function makeSource(rootCtx) {
    return {
      trigger: SOURCE_TRIGGER,
      name: SOURCE_NAME,
      showGroupTitle: true,
      /**
       * 列出候选。
       *
       * 不带 query 时列出**全部**分组/子项下的 skill（面包屑形式的名字），
       * 让用户打 `/` 就能直接翻整座书架；带 query 时按名字过滤。
       * @param session - { sessionId }。
       * @param req - { query, signal }。
       * @returns 候选行数组。
       */
      async candidates(session, req) {
        const query = req !== null && typeof req.query === 'string' ? req.query : ''
        const data = await fetchShelf(null, null)
        if (data === null || data.ok !== true) return []
        const groups = data.groups !== undefined && Array.isArray(data.groups) ? data.groups : []
        const rows = []
        for (const group of groups) {
          const items = Array.isArray(group.items) ? group.items : []
          for (const item of items) {
            // 只有名字不够：候选行需要 path，所以逐子项拉一次候选。
            // 这是 O(分组×子项) 次请求 —— 书架规模小（几十个子项）时可接受，
            // 且 candidates 只在用户真的打了 `/` 时触发。
            const one = await fetchShelf(group.name, item.name)
            if (one === null || one.ok !== true) continue
            const view = one.view !== null && one.view !== undefined ? one.view : null
            const skills = view !== null && Array.isArray(view.skills) ? view.skills : []
            for (const skill of skills) {
              const label = group.name + ' / ' + item.name + ' / ' + skill.name
              rows.push({
                name: label,
                description: skill.path,
                icon: 'file',
                section: group.name,
                value: JSON.stringify({ kind: 'skill', name: skill.name, path: skill.path }),
              })
            }
          }
        }
        const lowered = query.toLowerCase()
        const filtered = lowered.length === 0
          ? rows
          : rows.filter((row) => row.name.toLowerCase().includes(lowered))
        // 上限：菜单是给人挑的，几百行没意义
        return filtered.slice(0, 200)
      },
      /**
       * pick 回调：返回插入指令。
       * @param req - { candidate, action }。
       * @returns { insert } 或 undefined（表示不处理）。
       */
      onPick(req) {
        const candidate = req !== null && req !== undefined ? req.candidate : null
        if (candidate === null || candidate === undefined) return undefined
        let parsed = null
        try {
          parsed = JSON.parse(candidate.value)
        } catch {
          return undefined
        }
        if (parsed === null || typeof parsed !== 'object' || parsed.kind !== 'skill') return undefined
        const path = typeof parsed.path === 'string' ? parsed.path : ''
        if (path.length === 0) return undefined
        return {
          insert: {
            source: SOURCE_NAME,
            ref: path,
            label: typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : path,
            appearance: 'file',
            clipboardText: path,
          },
        }
      },
      /**
       * 点击已插入的引用时的行为：交还宿主处理（返回 false = 不接管）。
       * @returns false。
       */
      openReference() {
        return false
      },
    }
  }
  
  // ===========================================================================
  // 装载
  // ===========================================================================
  
  /**
   * 客户端插件体。
   * @param ctx - 客户端根上下文。
   */
  function apply(ctx) {
    ctx.effect(() => styles.insert(CSS), 'dsh-cangjingge: styles')
  
    // 【必须用 ctx.slots.inject(...) 包裹，不能直接 ctx.slots.register(...)】
    // register() 第一件事是查槽位声明表，没声明就抛
    // `slot "<name>" is not declared`；而本插件的 apply 可能比声明那些槽位的
    // 插件先跑（加载顺序不保证）。inject 会等到声明出现再注册。
    ctx.slots.inject(ICON_SLOT, () => ctx.slots.register(
      { name: ICON_SLOT, id: PANEL_ID, order: 45, label: '藏经阁' },
      PanelIcon,
    ))
  
    ctx.slots.inject(MAIN_SLOT, () => ctx.slots.register(
      { name: MAIN_SLOT, key: PANEL_ID },
      ShelfPanel,
    ))
  
    // 输入触发 source：拿不到 inputTriggers 服务时**不要抛** ——
    // 那会让整个插件 boot 失败（连带侧栏图标也没了）。只记一条日志。
    try {
      const inputTriggers = ctx.get('inputTriggers')
      if (inputTriggers !== undefined && inputTriggers !== null && typeof inputTriggers.registerSource === 'function') {
        ctx.effect(() => inputTriggers.registerSource(makeSource(ctx)), 'dsh-cangjingge: / source')
      } else {
        console.warn('dsh-cangjingge: inputTriggers 服务不可用，/ 插入菜单未注册（书架界面仍可用）')
      }
    } catch (error) {
      console.warn('dsh-cangjingge: 注册 / source 失败：' + String(error && error.message ? error.message : error))
    }
  }
  
  exports.apply = apply
  exports.inject = ['slots']
  exports.__view = { ShelfPanel, PanelIcon, Column, SkillDetail }
  exports.__const = {
    CSS, ICON_SLOT, MAIN_SLOT, PANEL_ID, SOURCE_TRIGGER, SOURCE_NAME,
    SHELF_URL, SKILL_URL,
  }
  return module.exports
})();

    return __part1;
  },
});
