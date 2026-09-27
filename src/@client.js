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
/** 设置读写路由（书架目录）。 */
const SETTINGS_URL = '/cangjingge/settings'
/** `/` 菜单可见性开关路由。 */
const VISIBLE_URL = '/cangjingge/visible'
/** 输入触发菜单的 source 名（与 `/` 组合成 /藏经阁）。 */
const SOURCE_TRIGGER = '/'
const SOURCE_NAME = 'cangjingge'

/** 样式表锚点属性。 */
const CSS_ATTR = 'data-dsh-cangjingge-css'

// ===========================================================================
// 样式（类名统一 dsh-cjg-* 前缀，避免撞上 DSH 自己的类）
//
// 【视觉取向：暗金古卷】
//   书架不是表单，第一眼要「像个有分量的东西」。所以：
//   - 底：比 bg-base 再深一档的墨色，叠一层极淡的暖金径向光
//   - 强调：暖金（--dsh-cjg-gold），只用在选中态、标题点、图标
//   - 行：卡片化（圆角 + 透明边框），悬停浮起，选中带左侧竖条与光晕
//   - 全部颜色走 CSS 变量，跟随 DSH 主题令牌，亮/暗主题都能用
//
// 为什么不用固定色值：DSH 有亮/暗两套主题，写死 #1a1a1a 在亮色主题上
// 就是一块脏斑。变量一律取 --dsw-alias-*，只把「金色」这一个自有强调色
// 写死（它在两套主题里都成立，且是本插件的识别色）。
// ===========================================================================

const CSS = [
  // ── 调色板与基础 ────────────────────────────────────────────────────────
  ':root{--dsh-cjg-gold:#c9a227;--dsh-cjg-gold-soft:rgba(201,162,39,.14);--dsh-cjg-gold-line:rgba(201,162,39,.42)}',
  '.dsh-cjg-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;overflow:hidden}',
  // 顶部一层暖金径向光：极淡，只为打破纯色底，不抢内容
  '.dsh-cjg-root::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 62% at 50% -14%,var(--dsh-cjg-gold-soft),transparent 62%)}',

  // ── 顶栏 ────────────────────────────────────────────────────────────────
  '.dsh-cjg-head{position:relative;z-index:1;display:flex;align-items:center;gap:9px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
  '.dsh-cjg-brand{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:0 0 auto;border-radius:7px;background:linear-gradient(160deg,var(--dsh-cjg-gold-line),transparent 70%);color:var(--dsh-cjg-gold)}',
  '.dsh-cjg-title{font-weight:600;font-size:13px;letter-spacing:.02em}',
  '.dsh-cjg-sub{color:var(--dsw-alias-label-tertiary);font-size:10.5px;max-width:38vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}',
  '.dsh-cjg-spacer{flex:1 1 auto}',

  // ── 按钮 ────────────────────────────────────────────────────────────────
  '.dsh-cjg-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;transition:background .14s,border-color .14s,transform .08s,color .14s}',
  '.dsh-cjg-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsh-cjg-gold-line)}',
  '.dsh-cjg-btn:active{transform:translateY(1px)}',
  '.dsh-cjg-btn:disabled{opacity:.45;cursor:default}',
  // 主按钮：暖底 + 金边，文字仍用主标签色（对比度安全）
  '.dsh-cjg-btn-primary{border-color:var(--dsh-cjg-gold-line);background:var(--dsh-cjg-gold-soft)}',
  '.dsh-cjg-btn-primary:hover{background:var(--dsh-cjg-gold-soft);border-color:var(--dsh-cjg-gold)}',

  // ── 三栏骨架 ────────────────────────────────────────────────────────────
  '.dsh-cjg-cols{position:relative;z-index:1;flex:1 1 auto;display:flex;min-height:0;min-width:0;gap:0}',
  '.dsh-cjg-col{display:flex;flex-direction:column;min-height:0;min-width:0}',
  // 栏宽用 clamp：窄窗口不至于挤成一条缝，宽窗口也不会空得发慌
  '.dsh-cjg-col-l{flex:0 0 clamp(132px,17vw,178px)}',
  // 分栏用「发丝线 + 微光」而不是整块边框：更像纸页折痕
  '.dsh-cjg-col-m,.dsh-cjg-col-r{border-left:1px solid var(--dsw-alias-border-l1)}',
  '.dsh-cjg-col-m{flex:0 0 clamp(132px,17vw,178px)}',
  '.dsh-cjg-col-r{flex:1 1 auto}',
  // 右栏的 skill 列表**不**占满剩余高度：它按内容自然高，上限为栏高的一半。
  // 否则一两个 skill 时列表会把下面撑出一大段空白（详情被推到很下面）。
  '.dsh-cjg-list-top{flex:0 1 auto;max-height:42%;min-height:0;overflow-y:auto;padding:0 8px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',

  // ── 栏头 ────────────────────────────────────────────────────────────────
  // 中文不做 uppercase（text-transform 对汉字无效，但会把英文栏名拉成
  // 全大写 + 大字距，中文栏名旁边就显得突兀）。统一按小号粗体处理。
  '.dsh-cjg-col-head{flex:0 0 auto;display:flex;align-items:center;gap:5px;padding:9px 12px 6px;font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-cjg-count{font-weight:400;letter-spacing:0;opacity:.75}',

  // ── 列表与行（卡片化）──────────────────────────────────────────────────
  '.dsh-cjg-list{flex:1 1 auto;overflow-y:auto;padding:0 8px 12px;min-height:0}',
  '.dsh-cjg-row{position:relative;display:flex;align-items:center;gap:7px;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:inherit;border-radius:9px;padding:6px 9px;margin-bottom:3px;cursor:pointer;font-family:inherit;font-size:12px;line-height:1.4;transition:background .14s,border-color .14s,transform .1s,box-shadow .14s}',
  '.dsh-cjg-row:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);transform:translateX(2px)}',
  // 选中：左侧金色竖条 + 暖底 + 微光晕
  '.dsh-cjg-row-on{background:linear-gradient(90deg,var(--dsh-cjg-gold-soft),transparent 86%);border-color:var(--dsh-cjg-gold-line);box-shadow:inset 0 0 0 1px rgba(201,162,39,.06)}',
  '.dsh-cjg-row-on::before{content:"";position:absolute;left:0;top:20%;bottom:20%;width:2px;border-radius:2px;background:var(--dsh-cjg-gold);box-shadow:0 0 6px var(--dsh-cjg-gold-line)}',
  // 选中行的名字**不加金色**：金色在亮色主题下对浅底对比度不足。
  // 选中感由竖条 + 暖底 + 加粗承担，这在亮/暗两套主题里都稳。
  // 图标才上金色 —— 它是图形，对比度容忍度高得多。
  '.dsh-cjg-row-on .dsh-cjg-ico{color:var(--dsh-cjg-gold);opacity:1}',
  '.dsh-cjg-row-on .dsh-cjg-row-name{font-weight:600}',
  // 文件夹/文件图标
  '.dsh-cjg-ico{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;opacity:.62;transition:opacity .14s}',
  '.dsh-cjg-row:hover .dsh-cjg-ico,.dsh-cjg-row-on .dsh-cjg-ico{opacity:1}',
  '.dsh-cjg-row-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-cjg-count-chip{flex:0 0 auto;font-size:9.5px;min-width:15px;text-align:center;padding:1px 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}',
  '.dsh-cjg-row-on .dsh-cjg-count-chip{background:var(--dsh-cjg-gold-soft);color:var(--dsh-cjg-gold)}',

  // ── 右栏正文区 ──────────────────────────────────────────────────────────
  '.dsh-cjg-body{flex:1 1 auto;overflow:auto;padding:10px 14px 22px;min-height:0}',
  '.dsh-cjg-empty{padding:26px 18px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.85}',
  '.dsh-cjg-empty-mark{display:block;font-size:22px;line-height:1;margin-bottom:8px;opacity:.35}',
  '.dsh-cjg-err{margin:8px 2px;padding:9px 11px;border-radius:9px;font-size:11px;color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);white-space:pre-wrap;word-break:break-word}',
  '.dsh-cjg-note{margin:8px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word}',

  // ── skill 详情 ──────────────────────────────────────────────────────────
  '.dsh-cjg-skill-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}',
  '.dsh-cjg-skill-name{font-weight:600;font-size:14px;letter-spacing:.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-cjg-path{font-family:var(--dsw-specific-font-family-code),monospace;font-size:10px;color:var(--dsw-alias-label-tertiary);word-break:break-all;margin-bottom:10px;opacity:.85}',
  // 正文用「纸」的观感：微内阴影 + 稍暖的底，跟前后的 UI 拉开层次
  '.dsh-cjg-paper{position:relative;margin-top:10px;padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}',
  '.dsh-cjg-paper::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:2px;border-radius:2px;background:var(--dsh-cjg-gold-line);opacity:.5}',
  '.dsh-cjg-pre{margin:0;overflow:auto;background:transparent;font-family:var(--dsw-specific-font-family-code),monospace;font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:52vh}',
  '.dsh-cjg-actions{margin-top:11px;display:flex;gap:7px;flex-wrap:wrap;align-items:center}',
  '.dsh-cjg-hint{margin-top:11px;padding:8px 11px;border-radius:9px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px dashed var(--dsh-cjg-gold-line);line-height:1.65}',
  '.dsh-cjg-kbd{display:inline-block;padding:0 5px;border-radius:5px;font-family:var(--dsw-specific-font-family-code),monospace;font-size:10.5px;color:var(--dsh-cjg-gold);border:1px solid var(--dsh-cjg-gold-line);background:var(--dsh-cjg-gold-soft)}',

  // ── 「在 / 菜单显示」开关 ─────────────────────────────────────────────────
  // 一对分段按钮（不是 checkbox）：两个状态都可见、可直选。
  '.dsh-cjg-switch{display:inline-flex;align-items:center;gap:0;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden;flex:0 0 auto}',
  '.dsh-cjg-switch-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;padding:4px 11px;cursor:pointer;transition:background .14s,color .14s}',
  '.dsh-cjg-switch-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
  '.dsh-cjg-switch-btn:disabled{opacity:.5;cursor:default}',
  '.dsh-cjg-switch-on{background:var(--dsh-cjg-gold-soft);color:var(--dsw-alias-label-primary);font-weight:600}',
  '.dsh-cjg-switch-btn + .dsh-cjg-switch-btn{border-left:1px solid var(--dsw-alias-border-l2)}',
  // 列表里「已显示在 / 菜单」的小点
  '.dsh-cjg-auto-dot{flex:0 0 auto;width:5px;height:5px;border-radius:50%;background:var(--dsh-cjg-gold);box-shadow:0 0 5px var(--dsh-cjg-gold-line)}',
  '.dsh-cjg-mode-row{display:flex;align-items:center;gap:9px;margin-top:11px;flex-wrap:wrap}',
  '.dsh-cjg-mode-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
  // 头部右侧的小按钮（全选 / 全不选）
  '.dsh-cjg-mini{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:10px;padding:2px 7px;border-radius:6px;cursor:pointer;transition:background .14s,color .14s}',
  '.dsh-cjg-mini:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
  '.dsh-cjg-mini:disabled{opacity:.45;cursor:default}',

  // ── 图标 ────────────────────────────────────────────────────────────────
  '.dsh-cjg-icon{display:inline-flex;align-items:center;justify-content:center;transition:transform .16s}',
  '.dsh-cjg-icon-active{color:var(--dsh-cjg-gold)}',

  // ── 浮层（保留）─────────────────────────────────────────────────────────
  '.dsh-cjg-modal-mask{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42)}',
  '.dsh-cjg-modal{width:min(380px,88vw);padding:14px 16px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#1c1c1f);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 18px 44px rgba(0,0,0,.42)}',
  '.dsh-cjg-modal-title{font-weight:600;font-size:13px;margin-bottom:8px}',
  '.dsh-cjg-input{display:block;width:100%;box-sizing:border-box;padding:5px 8px;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;margin-bottom:10px}',
  '.dsh-cjg-input:focus{border-color:var(--dsh-cjg-gold-line)}',
  '.dsh-cjg-modal-actions{display:flex;gap:6px;margin-top:4px}',
  '.dsh-cjg-modal .dsh-cjg-input{margin-bottom:6px}',
  '.dsh-cjg-field-hint{display:block;font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:1.6;margin-bottom:10px}',
  '.dsh-cjg-effective{padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:1.7;margin-bottom:10px;word-break:break-all}',
  '.dsh-cjg-effective-k{color:var(--dsw-alias-label-tertiary);margin-right:5px}',
  '.dsh-cjg-effective-v{font-family:var(--dsw-specific-font-family-code),monospace;color:var(--dsw-alias-label-primary)}',
  '.dsh-cjg-badge{display:inline-block;padding:0 6px;border-radius:999px;font-size:10px;border:1px solid var(--dsh-cjg-gold-line);color:var(--dsh-cjg-gold);background:var(--dsh-cjg-gold-soft)}',

  // ── 滚动条：细、暗、悬停才显眼 ──────────────────────────────────────────
  '.dsh-cjg-list::-webkit-scrollbar,.dsh-cjg-list-top::-webkit-scrollbar,.dsh-cjg-body::-webkit-scrollbar,.dsh-cjg-pre::-webkit-scrollbar{width:7px;height:7px}',
  '.dsh-cjg-list::-webkit-scrollbar-thumb,.dsh-cjg-list-top::-webkit-scrollbar-thumb,.dsh-cjg-body::-webkit-scrollbar-thumb,.dsh-cjg-pre::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px}',
  '.dsh-cjg-list::-webkit-scrollbar-thumb:hover,.dsh-cjg-list-top::-webkit-scrollbar-thumb:hover,.dsh-cjg-body::-webkit-scrollbar-thumb:hover,.dsh-cjg-pre::-webkit-scrollbar-thumb:hover{background:var(--dsh-cjg-gold-line)}',
  '.dsh-cjg-list::-webkit-scrollbar-track,.dsh-cjg-list-top::-webkit-scrollbar-track,.dsh-cjg-body::-webkit-scrollbar-track,.dsh-cjg-pre::-webkit-scrollbar-track{background:transparent}',
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
 * 设置 skill 是否在 `/` 菜单显示（单个或批量）。
 *
 * 【为什么不乐观更新】界面显示的必须与 _visible.json 一致：乐观更新在写
 * 失败时会显示一个**假**的「已显示」—— 而用户会据此以为 `/` 里真能搜到。
 * @param payload - { path, visible } 或 { paths, visible }。
 * @returns { ok, visible, message }。
 */
async function postVisible(payload) {
  try {
    const response = await fetch(VISIBLE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (response.status === 403) return { ok: false, message: '宿主拒绝了这次修改（来源不被信任）。' }
    if (!response.ok) return { ok: false, message: '宿主返回 HTTP ' + String(response.status) }
    const data = await response.json()
    if (data === null || typeof data !== 'object') return { ok: false, message: '宿主返回的不是 JSON 对象' }
    return data
  } catch (error) {
    return { ok: false, message: String(error && error.message ? error.message : error) }
  }
}

/**
 * 读当前设置（现在扫的是哪个目录、来源是什么）。
 * @returns { ok, libraryDir, effective, source, default_dir, settings_path, message }。
 */
async function fetchSettings() {
  try {
    const response = await fetch(SETTINGS_URL, { headers: { accept: 'application/json' } })
    if (!response.ok) return { ok: false, message: '宿主返回 HTTP ' + String(response.status) }
    const data = await response.json()
    if (data === null || typeof data !== 'object') return { ok: false, message: '宿主返回的不是 JSON 对象' }
    return data
  } catch (error) {
    return { ok: false, message: '读取设置失败：' + String(error && error.message ? error.message : error) }
  }
}

/**
 * 保存书架目录。传空串表示「清除覆盖，回到默认」。
 * @param libraryDir - 新目录（空串 = 清除）。
 * @returns { ok, effective, saved, message }。
 */
async function postSettings(libraryDir) {
  try {
    const response = await fetch(SETTINGS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ libraryDir }),
    })
    if (response.status === 403) return { ok: false, message: '宿主拒绝了这次修改（来源不被信任）。' }
    if (!response.ok) return { ok: false, message: '宿主返回 HTTP ' + String(response.status) }
    const data = await response.json()
    if (data === null || typeof data !== 'object') return { ok: false, message: '宿主返回的不是 JSON 对象' }
    return data
  } catch (error) {
    return { ok: false, message: String(error && error.message ? error.message : error) }
  }
}

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
 * 行内小图标：文件夹（线框）。
 *
 * 用 stroke 而非 fill：在 13px 这个尺寸上，填充的文件夹会糊成一团。
 * 颜色交给 CSS（currentColor + opacity），这样悬停/选中态能一起变。
 * @param props - { size }。
 * @returns React 元素。
 */
function FolderGlyph(props) {
  const size = typeof props.size === 'number' ? props.size : 13
  return React.createElement('svg', {
    viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
    strokeLinejoin: 'round', strokeLinecap: 'round',
  }, React.createElement('path', {
    d: 'M1.6 3.6 h4.2 l1.3 1.7 h7.3 v6.9 a.8.8 0 0 1 -.8.8 h-11.2 a.8.8 0 0 1 -.8-.8 z',
  }))
}

/**
 * 行内小图标：skill 文件（线框，带折角）。
 * @param props - { size }。
 * @returns React 元素。
 */
function FileGlyph(props) {
  const size = typeof props.size === 'number' ? props.size : 13
  return React.createElement('svg', {
    viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
    strokeLinejoin: 'round', strokeLinecap: 'round',
  }, [
    React.createElement('path', { key: 'p', d: 'M3.4 1.9 h5.6 l3.6 3.6 v8.6 a.8.8 0 0 1 -.8.8 h-8.4 a.8.8 0 0 1 -.8-.8 z' }),
    React.createElement('path', { key: 'f', d: 'M9 1.9 v3.6 h3.6' }),
  ])
}

/**
 * 一栏的列表。
 * @param props - { title, kind, entries, active, onPick, emptyText }。
 * @returns React 元素。
 */
function Column(props) {
  const entries = Array.isArray(props.entries) ? props.entries : []
  const Glyph = props.kind === 'skill' ? FileGlyph : FolderGlyph
  const children = []
  children.push(React.createElement('div', { key: 'h', className: 'dsh-cjg-col-head' },
    React.createElement('span', null, props.title),
    React.createElement('span', { className: 'dsh-cjg-spacer' }),
    entries.length > 0
      ? React.createElement('span', { className: 'dsh-cjg-count' }, String(entries.length))
      : null))

  if (entries.length === 0) {
    children.push(React.createElement('div', { key: 'e', className: 'dsh-cjg-empty' },
      React.createElement('span', { className: 'dsh-cjg-empty-mark' }, '∘'),
      props.emptyText))
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
      React.createElement('span', { className: 'dsh-cjg-ico' }, React.createElement(Glyph, null)),
      React.createElement('span', { className: 'dsh-cjg-row-name' }, entry.name),
      entry.count === undefined
        ? null
        : React.createElement('span', { className: 'dsh-cjg-count-chip' }, String(entry.count))))
    }
  }
  return React.createElement('div', { className: 'dsh-cjg-col ' + props.className },
    React.createElement('div', { className: 'dsh-cjg-list' }, children))
}

/**
 * 设置弹窗：改书架根目录。
 *
 * 【为什么需要它】DSH 没有给插件"自动生成设置表单"的机制 —— 插件配置页
 * 要插件自己写 UI（已对 ui-settings-plugin-inventory / ui-settings-plugins
 * 的 README 核实：前者明确是只读清单，后者的配置页由各插件自己的伴生包提供）。
 * 所以这里自带一个输入框，改完写进插件自己的 settings 文件。
 *
 * @param props - { info, busy, onClose, onSubmit }。
 * @returns React 元素。
 */
function SettingsDialog(props) {
  const info = props.info !== null && props.info !== undefined ? props.info : {}
  // 输入框初值 = 用户显式保存过的值；没保存过就留空（占位符显示当前生效值）
  const [value, setValue] = React.useState(
    typeof info.libraryDir === 'string' ? info.libraryDir : '',
  )
  const busy = props.busy === true
  const effective = typeof info.effective === 'string' ? info.effective : ''
  const source = typeof info.source === 'string' ? info.source : ''
  const sourceLabel = source === 'settings' ? '界面设置' : source === 'config' ? '插件配置' : '内置默认'

  return React.createElement('div', { className: 'dsh-cjg-modal-mask' },
    React.createElement('div', { className: 'dsh-cjg-modal' },
      React.createElement('div', { className: 'dsh-cjg-modal-title' }, '藏经阁 · 设置'),
      React.createElement('div', { className: 'dsh-cjg-effective' },
        React.createElement('div', null,
          React.createElement('span', { className: 'dsh-cjg-effective-k' }, '当前扫描'),
          React.createElement('span', { className: 'dsh-cjg-badge' }, sourceLabel)),
        React.createElement('div', { className: 'dsh-cjg-effective-v' }, effective)),

      React.createElement('label', null,
        React.createElement('span', { className: 'dsh-cjg-field-hint' }, '书架根目录'),
        React.createElement('input', {
          type: 'text',
          className: 'dsh-cjg-input',
          value,
          placeholder: effective,
          disabled: busy,
          onChange: (event) => setValue(event.target.value),
        })),
      React.createElement('span', { className: 'dsh-cjg-field-hint' },
        '留空 = 用当前生效值（不覆盖）。目录不存在会自动创建。',
        React.createElement('br'),
        '保存后立即重扫，不需要重启。'),

      React.createElement('div', { className: 'dsh-cjg-modal-actions' },
        React.createElement('span', { className: 'dsh-cjg-spacer' }),
        React.createElement('button', {
          type: 'button', className: 'dsh-cjg-btn', disabled: busy,
          onClick: props.onClose,
        }, '取消'),
        React.createElement('button', {
          type: 'button', className: 'dsh-cjg-btn', disabled: busy,
          title: '清除界面里保存的目录，回到插件配置或内置默认',
          onClick: () => props.onSubmit(''),
        }, '恢复默认'),
        React.createElement('button', {
          type: 'button', className: 'dsh-cjg-btn dsh-cjg-btn-primary', disabled: busy,
          onClick: () => props.onSubmit(value),
        }, busy ? '保存中…' : '保存'))))
}

/**
 * 右侧：skill 详情 + 操作。
 *
 * 【操作里为什么是「复制」+「在输入框打 / 插入」两种】
 *   宿主没有从面板直接写 composer 的接口（见文件头注释），所以：
 *     - 「复制路径」把路径塞进剪贴板，用户可以自己粘贴；
 *     - 真正的插入引导用户去 composer 打 `/藏经阁`，那边是官方支持的正路。
 * @param props - { skill, text, loading, error, truncated, onCopy, onVisible }。
 * @returns React 元素。
 */
function SkillDetail(props) {
  if (props.skill === null || props.skill === undefined) {
    return React.createElement('div', { className: 'dsh-cjg-empty' },
      React.createElement('span', { className: 'dsh-cjg-empty-mark' }, '藏'),
      '从左栏选一个分组、中栏选一个子项，',
      React.createElement('br'),
      '这里会列出里面的 skill。')
  }
  if (props.loading === true) {
    return React.createElement('div', { className: 'dsh-cjg-empty' }, '读取中……')
  }
  if (typeof props.error === 'string' && props.error.length > 0) {
    return React.createElement('div', { className: 'dsh-cjg-err' }, props.error)
  }
  return React.createElement('div', null,
    React.createElement('div', { className: 'dsh-cjg-skill-head' },
      React.createElement('span', { className: 'dsh-cjg-ico', style: { opacity: 1, color: 'var(--dsh-cjg-gold)' } },
        React.createElement(FileGlyph, { size: 15 })),
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
        className: 'dsh-cjg-btn dsh-cjg-btn-primary',
        onClick: () => props.onCopy(String(props.text === undefined || props.text === null ? '' : props.text)),
      }, '复制全文')),
    // 「在 / 菜单显示」开关：书架永远显示全部，这个只决定能否从 `/` 搜到。
    // 放在详情里（而不是列表行上）：一次只改一个文件，语义更清楚。
    React.createElement('div', { className: 'dsh-cjg-mode-row' },
      React.createElement('span', { className: 'dsh-cjg-mode-label' }, '/ 菜单'),
      React.createElement('span', { className: 'dsh-cjg-switch' },
        React.createElement('button', {
          type: 'button',
          className: 'dsh-cjg-switch-btn' + (props.visible !== true ? ' dsh-cjg-switch-on' : ''),
          disabled: props.switching === true,
          title: '打 / 时搜不到这个文件（书架里照常可见）',
          onClick: () => props.onVisible(false),
        }, '不显示'),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-cjg-switch-btn' + (props.visible === true ? ' dsh-cjg-switch-on' : ''),
          disabled: props.switching === true,
          title: '打 / 时能搜到这个文件',
          onClick: () => props.onVisible(true),
        }, '显示')),
      React.createElement('span', { className: 'dsh-cjg-mode-label' },
        props.visible === true
          ? '打 / 时能搜到'
          : '打 / 时搜不到（书架里仍在）')),
    React.createElement('div', { className: 'dsh-cjg-hint' },
      '在聊天输入框里打 ',
      React.createElement('span', { className: 'dsh-cjg-kbd' }, '/'),
      '　打开菜单 → 选「藏经阁」→ 挑这个 skill，即可插入当前对话。'),
    props.truncated === true
      ? React.createElement('div', { className: 'dsh-cjg-note' }, '（文件较大，正文已截断显示）')
      : null,
    React.createElement('div', { className: 'dsh-cjg-paper' },
      React.createElement('pre', { className: 'dsh-cjg-pre' },
        String(props.text === undefined || props.text === null || props.text === '' ? '(空文件)' : props.text))))
}

/**
 * 主面板：三栏书架。
 * @returns React 元素。
 */
function ShelfPanel() {
  const [state, setState] = React.useState({ loading: true, data: null, error: null })
  const [selection, setSelection] = React.useState({ group: null, item: null })
  const [detail, setDetail] = React.useState({
    skill: null, text: '', loading: false, error: null, truncated: false,
    visible: false, switching: false,
  })
  const [flash, setFlash] = React.useState(null)
  /** 批量勾选（全选/全不选）进行中。 */
  const [bulkBusy, setBulkBusy] = React.useState(false)
  /** 设置弹窗：null = 关闭；否则是当前设置信息。 */
  const [settingsOpen, setSettingsOpen] = React.useState(null)
  const [savingSettings, setSavingSettings] = React.useState(false)
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
    const visible = skill !== null && skill !== undefined && skill.visible === true
    setDetail({ skill, text: '', loading: true, error: null, truncated: false, visible, switching: false })
    setFlash(null)
    const result = await fetchSkill(skill.path)
    if (!alive.current) return
    if (result !== null && result.ok === true) {
      setDetail({
        skill, text: String(result.text === undefined ? '' : result.text),
        loading: false, error: null, truncated: result.truncated === true,
        visible, switching: false,
      })
    } else {
      setDetail({
        skill, text: '', loading: false,
        error: result !== null && typeof result.message === 'string' ? result.message : '读取失败。',
        truncated: false, visible, switching: false,
      })
    }
  }, [])

  // 切换分组/子项时清掉右侧详情（它属于上一个子项）
  const pickGroup = React.useCallback((name) => {
    selectionRef.current = { group: name, item: null }
    setSelection(selectionRef.current)
    setDetail({ skill: null, text: '', loading: false, error: null, truncated: false, visible: false, switching: false })
    void load(name, null)
  }, [load])

  const pickItem = React.useCallback((name) => {
    const group = selectionRef.current.group
    selectionRef.current = { group, item: name }
    setSelection(selectionRef.current)
    setDetail({ skill: null, text: '', loading: false, error: null, truncated: false, visible: false, switching: false })
    void load(group, name)
  }, [load])

  /**
   * 切换当前 skill 是否在 `/` 菜单显示。
   *
   * 【不乐观更新】见 postVisible 的说明：写失败时显示假状态最误导人。
   * 写成功后重扫一次，让列表里的小圆点与头部统计跟上。
   */
  const switchVisible = React.useCallback(async (next) => {
    const skill = detail.skill
    if (skill === null || skill === undefined) return
    setDetail((prev) => ({ ...prev, switching: true }))
    setFlash(null)
    const result = await postVisible({ path: skill.path, visible: next })
    if (!alive.current) return
    if (result !== null && result.ok === true) {
      setDetail((prev) => ({ ...prev, visible: result.visible === true, switching: false }))
      setFlash({
        kind: 'ok',
        text: result.visible === true
          ? '已显示：打 / 时能搜到这个文件。'
          : '已隐藏：打 / 时搜不到它（书架里仍在）。',
      })
      void load(selectionRef.current.group, selectionRef.current.item)
    } else {
      setDetail((prev) => ({ ...prev, switching: false }))
      setFlash({ kind: 'error', text: '切换失败：' + String(result === null ? '宿主无响应' : result.message) })
    }
  }, [detail.skill, load])

  /**
   * 全选 / 全不选：把整棵书架（或只当前子项）的所有 skill 一次设成同一个可见性。
   *
   * 【为什么需要】默认是「全不显示」，第一次用要逐个勾几十次 —— 这一步是
   * 让新用户能一分钟内把常用项放出来，而不是先跟界面搏斗。
   * @param visible - true = 全部显示，false = 全部隐藏。
   * @param scope - 'item' = 只当前子项；'all' = 整座书架。
   */
  const bulkVisible = React.useCallback(async (visible, scope) => {
    setBulkBusy(true)
    setFlash(null)
    let paths = []
    if (scope === 'item') {
      const view = state.data !== null && state.data.view !== undefined ? state.data.view : null
      const skills = view !== null && Array.isArray(view.skills) ? view.skills : []
      paths = skills.map((s) => s.path)
    } else {
      // 整座书架：需要逐子项拉一次（与 `/` 菜单的遍历同一代价，且只在这一下发生）
      const data = state.data !== null && state.data !== undefined ? state.data : null
      const groups = data !== null && Array.isArray(data.groups) ? data.groups : []
      for (const group of groups) {
        const items = Array.isArray(group.items) ? group.items : []
        for (const item of items) {
          const one = await fetchShelf(group.name, item.name)
          if (one === null || one.ok !== true) continue
          const view = one.view !== null && one.view !== undefined ? one.view : null
          const skills = view !== null && Array.isArray(view.skills) ? view.skills : []
          for (const s of skills) paths.push(s.path)
        }
      }
    }
    if (paths.length === 0) {
      setBulkBusy(false)
      setFlash({ kind: 'error', text: '没有可切换的文件。' })
      return
    }
    const result = await postVisible({ paths, visible })
    if (!alive.current) return
    setBulkBusy(false)
    if (result !== null && result.ok === true) {
      setFlash({
        kind: 'ok',
        text: '已' + (visible ? '全部显示' : '全部隐藏') + '（' + String(paths.length) + ' 个文件）。',
      })
      setDetail((prev) => ({ ...prev, visible }))
      void load(selectionRef.current.group, selectionRef.current.item)
    } else {
      setFlash({ kind: 'error', text: '批量切换失败：' + String(result === null ? '宿主无响应' : result.message) })
    }
  }, [state.data, load])

  /**
   * 打开设置弹窗（先拉当前设置，让输入框有正确的初值）。
   */
  const openSettings = React.useCallback(async () => {
    setFlash(null)
    const info = await fetchSettings()
    if (!alive.current) return
    if (info !== null && info.ok === true) setSettingsOpen(info)
    else setFlash({ kind: 'error', text: '读取设置失败：' + String(info === null ? '宿主无响应' : info.message) })
  }, [])

  /**
   * 保存书架目录。传空串 = 清除覆盖（回到插件配置 / 内置默认）。
   *
   * 【保存后立即重扫】不必重启也不需要手动点刷新 —— 宿主的 rootDir 已经换了，
   * 这次 load() 拿到的就是新目录的内容。
   * @param value - 用户输入的目录（空串表示清除覆盖）。
   */
  const saveSettings = React.useCallback(async (value) => {
    setSavingSettings(true)
    setFlash(null)
    const result = await postSettings(value)
    if (!alive.current) return
    setSavingSettings(false)
    if (result !== null && result.ok === true) {
      setSettingsOpen(null)
      // 目录变了：清掉右侧详情（它属于旧目录），并重扫
      selectionRef.current = { group: null, item: null }
      setSelection(selectionRef.current)
      setDetail({ skill: null, text: '', loading: false, error: null, truncated: false, visible: false, switching: false })
      setFlash({
        kind: 'ok',
        text: result.saved === true
          ? '已保存，正在扫描：' + String(result.effective)
          : '已恢复默认：' + String(result.effective),
      })
      void load(null, null)
    } else {
      setFlash({ kind: 'error', text: '保存失败：' + String(result === null ? '宿主无响应' : result.message) })
    }
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
      React.createElement('span', { className: 'dsh-cjg-brand' }, React.createElement(PanelIcon, { size: 14 })),
      React.createElement('span', { className: 'dsh-cjg-title' }, '藏经阁'),
      React.createElement('span', { className: 'dsh-cjg-sub', title: rootText }, rootText),
      React.createElement('span', { className: 'dsh-cjg-spacer' }),
      React.createElement('button', {
        type: 'button', className: 'dsh-cjg-btn',
        title: '把整座书架的所有 skill 设为「在 / 菜单显示」',
        disabled: bulkBusy,
        onClick: () => { void bulkVisible(true, 'all') },
      }, bulkBusy ? '处理中…' : '全部显示'),
      React.createElement('button', {
        type: 'button', className: 'dsh-cjg-btn',
        title: '把整座书架的所有 skill 设为「不在 / 菜单显示」（书架里仍在）',
        disabled: bulkBusy,
        onClick: () => { void bulkVisible(false, 'all') },
      }, '全部隐藏'),
      React.createElement('button', {
        type: 'button', className: 'dsh-cjg-btn',
        title: '更改书架根目录',
        onClick: () => { void openSettings() },
      }, '设置'),
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
            title: '分组', kind: 'group', className: 'dsh-cjg-col-l',
            entries: groups, active: selection.group,
            onPick: pickGroup,
            emptyText: '藏经阁里还没有分组文件夹。在根目录下建一个文件夹，里面再建子文件夹放 skill。',
          }),
          React.createElement(Column, {
            title: '子项', kind: 'item', className: 'dsh-cjg-col-m',
            entries: items, active: selection.item,
            onPick: pickItem,
            emptyText: '这个分组下还没有子文件夹。',
          }),
          React.createElement('div', { className: 'dsh-cjg-col dsh-cjg-col-r' },
            React.createElement('div', { className: 'dsh-cjg-col-head' },
              React.createElement('span', null, 'skill'),
              React.createElement('span', { className: 'dsh-cjg-spacer' }),
              skills.length > 0
                ? React.createElement('span', { className: 'dsh-cjg-count' }, String(skills.length))
                : null),
            React.createElement('div', { className: 'dsh-cjg-list-top' },
              skills.length === 0
                ? React.createElement('div', { className: 'dsh-cjg-empty' },
                  React.createElement('span', { className: 'dsh-cjg-empty-mark' }, '∘'),
                  '这个子项下还没有 skill 文件（支持 .md / .markdown / .txt）。')
                : skills.map((skill) => {
                  const on = detail.skill !== null && detail.skill !== undefined && detail.skill.path === skill.path
                  return React.createElement('button', {
                    key: skill.path,
                    type: 'button',
                    className: 'dsh-cjg-row' + (on ? ' dsh-cjg-row-on' : ''),
                    title: skill.name,
                    onClick: () => { void openSkill(skill) },
                  },
                  React.createElement('span', { className: 'dsh-cjg-ico' }, React.createElement(FileGlyph, null)),
                  React.createElement('span', { className: 'dsh-cjg-row-name' }, skill.name),
                  skill.visible === true
                    ? React.createElement('span', { className: 'dsh-cjg-auto-dot', title: '在 / 菜单显示' })
                    : null)
                })),
            React.createElement('div', { className: 'dsh-cjg-body' },
              flash === null ? null : React.createElement('div', {
                className: flash.kind === 'error' ? 'dsh-cjg-err' : 'dsh-cjg-note',
              }, flash.text),
              React.createElement(SkillDetail, {
                skill: detail.skill, text: detail.text, loading: detail.loading,
                error: detail.error, truncated: detail.truncated, onCopy: copy,
                visible: detail.visible, switching: detail.switching,
                onVisible: (next) => { void switchVisible(next) },
              })))),
    settingsOpen === null ? null : React.createElement(SettingsDialog, {
      info: settingsOpen,
      busy: savingSettings,
      onClose: () => setSettingsOpen(null),
      onSubmit: (value) => { void saveSettings(value) },
    }))
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
     * 【两段式】空 query 只给「分组行」—— 书架大起来时把上百个 skill 全铺出来
     *   会刷屏，第一屏给分组名就够（且只有含已勾选 skill 的组会出现）。
     *   带 query 时展开 skill 行，按「分组 / 子项 / 文件名」面包屑过滤。
     *
     * 【只列已勾选的】哪些 skill 能被搜到由书架的「在 / 菜单显示」开关决定
     *   （宿主侧 /cangjingge/candidates 已过滤，这里拿到的就是可用的）。
     * @param session - { sessionId }。
     * @param req - { query, signal }。
     * @returns 候选行数组。
     */
    async candidates(session, req) {
      const query = req !== null && typeof req.query === 'string' ? req.query : ''
      const data = await fetchShelf(null, null)
      if (data === null || data.ok !== true) return []
      const groups = data.groups !== undefined && Array.isArray(data.groups) ? data.groups : []

      // 第一屏：只有分组名，且该组下得有计划可插入的 skill。
      if (query.trim().length === 0) {
        return groupCandidates(groups).slice(0, 200)
      }

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
      // 上限：菜单是给人挑的，几百行没意义
      return filterCandidates(rows, query).slice(0, 200)
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
// 【inject 必须声明 inputTriggers —— 这是「打 / 看不到藏经阁」的根因】
//
// cordis 是依赖注入框架：apply 被调用的时机由**声明的依赖**决定。
// 早期版本只声明了 'slots'，于是 apply 可能在 inputTriggers 服务注册之前
// 就跑完 —— 那时 ctx.get('inputTriggers') 返回 undefined，source 静默
// 不注册（只留一条 console.warn，用户看不到），表现就是「打 / 没有藏经阁」。
//
// 已对 0.1.7-rc.2 的 ui-commands / ui-reference 核实：它们的 inject 里
// 都明确列了 'inputTriggers'。这里照做。
// 'slots' 同样必要：侧栏图标与主面板要等槽位声明后才能注册。
exports.inject = ['slots', 'inputTriggers']
exports.__view = { ShelfPanel, PanelIcon, Column, SkillDetail, SettingsDialog, FolderGlyph, FileGlyph }
exports.__const = {
  CSS, ICON_SLOT, MAIN_SLOT, PANEL_ID, SOURCE_TRIGGER, SOURCE_NAME,
  SHELF_URL, SKILL_URL, SETTINGS_URL, VISIBLE_URL,
}
