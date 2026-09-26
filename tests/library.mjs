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

// ---- 结果 ---------------------------------------------------------------------
if (failures.length > 0) {
  console.error('library 测试失败 ' + String(failures.length) + ' 项：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('library: ' + String(passed) + ' 项通过')
