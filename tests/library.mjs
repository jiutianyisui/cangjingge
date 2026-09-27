// ---------------------------------------------------------------------------
// dsh-cangjingge —— 纯函数层测试（library.js）
//
// 跑法： node tests/library.mjs
//
// 覆盖：扩展名判定 / 过滤规则 / 排序 / 三栏视图选择 / 插入文本 / 候选与解析。
// 全部不碰磁盘，纯函数，确定性。
// ---------------------------------------------------------------------------

import {
  isSkillFile,
  visibleEntries,
  shelfView,
  skillInsertText,
  skillCandidates,
  parseCandidateValue,
  groupCandidates,
  filterCandidates,
  VISIBLE_FILE_NAME,
  normalizeVisible,
  isVisible,
  withVisible,
  visibleSkills,
  SETTINGS_FILE_NAME,
  normalizeSettings,
  pickLibraryDir,
  validateLibraryDir,
  SKILL_EXTENSIONS,
} from '../src/library.js'

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

// ---- 扩展名判定 ---------------------------------------------------------------
ok(isSkillFile('foo.md'), '.md 是 skill')
ok(isSkillFile('foo.MARKDOWN'), '大小写不敏感')
ok(isSkillFile('a.txt'), '.txt 是 skill')
ok(!isSkillFile('a.png'), '.png 不是 skill')
ok(!isSkillFile(''), '空名不是 skill')
ok(!isSkillFile(null), 'null 不是 skill')
eq(SKILL_EXTENSIONS.length >= 3, true, '至少三种扩展名')

// ---- 过滤与排序 ---------------------------------------------------------------
{
  const raw = [
    { name: '.hidden', kind: 'dir' },
    { name: '_internal', kind: 'dir' },
    { name: 'B组', kind: 'dir' },
    { name: 'A组', kind: 'dir' },
    { name: 'readme.md', kind: 'file' },
    { name: 'image.png', kind: 'file' },
    { name: 'z.md', kind: 'file' },
  ]
  const out = visibleEntries(raw)
  const names = out.map((e) => e.name)
  // 隐藏/内部被剔除，非 skill 文件被剔除
  eq(names.includes('.hidden'), false, '隐藏目录被剔除')
  eq(names.includes('_internal'), false, '内部目录被剔除')
  eq(names.includes('image.png'), false, '非 skill 文件被剔除')
  // 目录在前，文件在后
  eq(out[0].kind, 'dir', '目录排在前')
  eq(out[out.length - 1].kind, 'file', '文件排在后')
  eq(names.length, 4, '剩余 4 项：A组 B组 readme.md z.md')
}

// ---- 三栏视图 ---------------------------------------------------------------
const TREE = {
  root: '/x',
  groups: [
    { name: '易经', items: [
      { name: '乾', skills: [{ name: 'a.md', path: '/x/易经/乾/a.md' }] },
      { name: '坤', skills: [{ name: 'b.md', path: '/x/易经/坤/b.md' }] },
    ] },
    { name: '兵法', items: [
      { name: '谋', skills: [{ name: 'c.md', path: '/x/兵法/谋/c.md' }] },
    ] },
  ],
}

{
  const view = shelfView(TREE, { group: null, item: null })
  eq(view.groups.map((g) => g.name), ['易经', '兵法'], '左栏列出全部分组')
  eq(view.groups[0].count, 2, '分组条目数')
  eq(view.active_group, '易经', '未指定时默认第一个分组')
  eq(view.items.map((i) => i.name), ['乾', '坤'], '中栏列出该分组子项')
  eq(view.active_item, '乾', '未指定时默认第一个子项')
  eq(view.skills.map((s) => s.name), ['a.md'], '右栏列出该子项 skill')
}

{
  const view = shelfView(TREE, { group: '兵法', item: '谋' })
  eq(view.active_group, '兵法', '显式分组生效')
  eq(view.active_item, '谋', '显式子项生效')
  eq(view.skills[0].path, '/x/兵法/谋/c.md', '右栏 path 正确')
}

{
  // 分组名不存在 -> 回落到第一个
  const view = shelfView(TREE, { group: '不存在', item: null })
  eq(view.active_group, '易经', '未知分组回落到第一个')
  // 子项名不存在 -> 回落到第一个
  const view2 = shelfView(TREE, { group: '易经', item: '不存在' })
  eq(view2.active_item, '乾', '未知子项回落到第一个')
}

{
  const view = shelfView({ groups: [] }, {})
  eq(view.groups, [], '空树左栏为空')
  eq(view.items, [], '空树中栏为空')
  eq(view.skills, [], '空树右栏为空')
  eq(view.active_group, null, '空树无 active_group')
}

// ---- 插入文本 ---------------------------------------------------------------
{
  const skill = { name: '心经.md', path: '/a/b/心经.md', text: '正文内容' }
  eq(skillInsertText(skill, 'path'), '/a/b/心经.md', 'path 模式只给路径')
  eq(skillInsertText(skill, 'body'), '正文内容', 'body 模式只给正文')
  const quote = skillInsertText(skill, 'quote')
  ok(quote.includes('心经.md'), 'quote 含名字')
  ok(quote.includes('/a/b/心经.md'), 'quote 含路径')
  ok(quote.includes('正文内容'), 'quote 含正文')
  eq(skillInsertText(null, 'quote'), '', 'null 返回空串')
}

// ---- 候选与解析 ---------------------------------------------------------------
{
  const view = shelfView(TREE, { group: '易经', item: '乾' })
  const rows = skillCandidates(view)
  eq(rows.length, 1, '一个 skill 一行')
  eq(rows[0].name, 'a.md', '候选 name 是文件名')
  eq(rows[0].icon, 'file', '候选 icon 是 file')
  eq(rows[0].section, '乾', '候选 section 是子项名')

  const parsed = parseCandidateValue(rows[0].value)
  eq(parsed.kind, 'skill', 'value 可解析回 kind=skill')
  eq(parsed.path, '/x/易经/乾/a.md', 'value 带回 path')
}

eq(parseCandidateValue('不是JSON'), null, '坏 JSON 返回 null')
eq(parseCandidateValue('{"kind":"other"}'), null, '非 skill kind 返回 null')
eq(parseCandidateValue(''), null, '空串返回 null')
eq(parseCandidateValue(null), null, 'null 返回 null')

// ---- `/` 菜单可见性（状态纯函数）----------------------------------------------
eq(VISIBLE_FILE_NAME, '_visible.json', '可见性文件名以下划线开头（会被书架过滤）')

{
  // 只有 true 被保留；false / 杂值一律丢掉（取消勾选 = 删键）
  const s = normalizeVisible({ skills: { '/a.md': true, '/b.md': false, '/c.md': 'yes', '/d.md': 1 } })
  eq(s.skills['/a.md'], true, '保留 true')
  eq(s.skills['/b.md'], undefined, '丢掉 false')
  eq(s.skills['/c.md'], undefined, '丢掉字符串')
  eq(s.skills['/d.md'], undefined, '丢掉数字')
}

eq(normalizeVisible(null).skills, {}, 'null 状态 -> 空')
eq(normalizeVisible('x').skills, {}, '非对象状态 -> 空')
eq(normalizeVisible({ skills: [] }).skills, {}, 'skills 是数组 -> 空')

{
  // 默认不显示：这是「方案 A」的核心 —— 名单里没有 = 不在 / 菜单出现
  eq(isVisible(normalizeVisible(null), '/x.md'), false, '没记录过 = 不显示')
  const s = withVisible(normalizeVisible(null), '/x.md', true)
  eq(isVisible(s, '/x.md'), true, '设为显示后读到 true')
  eq(isVisible(normalizeVisible(null), '/x.md'), false, 'withVisible 不改原对象')
  const back = withVisible(s, '/x.md', false)
  eq(isVisible(back, '/x.md'), false, '设回隐藏')
  eq(Object.prototype.hasOwnProperty.call(back.skills, '/x.md'), false, '设回隐藏时删除键')
}

{
  let s = normalizeVisible(null)
  s = withVisible(s, '/b.md', true)
  s = withVisible(s, '/a.md', true)
  eq(visibleSkills(s), ['/a.md', '/b.md'], '可见清单已排序')
}

// ---- 候选行的两段式（分组行 + 关键词过滤）---------------------------------------
{
  eq(groupCandidates(null), [], 'null -> 空')
  const rows = groupCandidates([
    { name: '有声', visibleCount: 3 },
    { name: '空的', visibleCount: 0 },
    { name: '', visibleCount: 5 },
  ])
  eq(rows.length, 1, '只列有可见项的分组')
  eq(rows[0].name, '有声', '分组名正确')
  eq(rows[0].section, '分组', 'section 标记为分组')
  eq(JSON.parse(rows[0].value).kind, 'group', 'value 是可解析的分组引用')
}

{
  const rows = [
    { name: '团队 / 编制 / 规程.md', description: '/a/团队/编制/规程.md' },
    { name: '兵法 / 谋 / 孙子.md', description: '/a/兵法/谋/孙子.md' },
  ]
  eq(filterCandidates(rows, '').length, 2, '空关键词返回全部')
  eq(filterCandidates(rows, '规程').length, 1, '按名字过滤')
  eq(filterCandidates(rows, '兵法').length, 1, '按面包屑里的分组名过滤')
  eq(filterCandidates(rows, 'PROCEDURE').length, 0, '大小写不敏感（无命中）')
  eq(filterCandidates(rows, '规程.md').length, 1, '按路径片段也能命中')
}

// ---- 设置（书架目录）纯函数 ---------------------------------------------------
eq(SETTINGS_FILE_NAME, 'cangjingge-settings.json', '设置文件名')

{
  eq(normalizeSettings(null).libraryDir, null, 'null -> 无覆盖')
  eq(normalizeSettings('x').libraryDir, null, '非对象 -> 无覆盖')
  eq(normalizeSettings({ libraryDir: '  E:/a  ' }).libraryDir, 'E:/a', '值被 trim')
  eq(normalizeSettings({ libraryDir: '' }).libraryDir, null, '空串 -> 无覆盖')
  eq(normalizeSettings({ libraryDir: 7 }).libraryDir, null, '非字符串 -> 无覆盖')
  eq(normalizeSettings({ other: 1 }).libraryDir, null, '无关键 -> 无覆盖')
}

{
  const a = pickLibraryDir('E:/o', 'E:/c', 'E:/d')
  eq(a.value, 'E:/o', 'override 优先')
  eq(a.source, 'settings', 'source=settings')
  const b = pickLibraryDir(null, 'E:/c', 'E:/d')
  eq(b.value, 'E:/c', '回落 config')
  eq(b.source, 'config', 'source=config')
  const c = pickLibraryDir(null, null, 'E:/d')
  eq(c.value, 'E:/d', '再回落 default')
  eq(c.source, 'default', 'source=default')
  eq(pickLibraryDir('   ', 'E:/c', 'E:/d').value, 'E:/c', '空白串视为无覆盖')
}

{
  eq(validateLibraryDir('E:/x').ok, true, '正常路径通过')
  eq(validateLibraryDir('  E:/x  ').value, 'E:/x', '校验后 trim')
  eq(validateLibraryDir('').ok, false, '空串拒绝')
  eq(validateLibraryDir('   ').ok, false, '纯空白拒绝')
  eq(validateLibraryDir(null).ok, false, 'null 拒绝')
  eq(validateLibraryDir(7).ok, false, '非字符串拒绝')
  eq(validateLibraryDir('a\u0000b').ok, false, 'NUL 拒绝')
  eq(validateLibraryDir('x'.repeat(600)).ok, false, '超长拒绝')
}

// ---- 结果 ---------------------------------------------------------------------
if (failures.length > 0) {
  console.error('library 测试失败 ' + String(failures.length) + ' 项：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('library: ' + String(passed) + ' 项通过')
