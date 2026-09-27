# 藏经阁（dsh-cangjingge）· 维护交接

> 给"下次升级遇到问题时的我"看。**先读本文，再动手。**
> 每一条都是真实踩过的坑，附带症状与根因，避免重复排查。

---

## 0. 一句话现状

| 项 | 值 |
|---|---|
| 源码 | `E:\xiangmu\chajian\cangjingge` |
| 书架目录 | 由**界面设置**管理：`~/.dsh/cangjingge-settings.json` |
| 当前值 | `E:\xiangmu\chajian\藏经阁` |
| 安装方式 | **GitHub 版**（pnpm 真实目录，不是 junction） |
| 仓库 | `https://github.com/jiutianyisui/cangjingge` |
| 适配版本 | 桌面端 `0.1.7-rc.2` |
| GitHub 地址 | `github:jiutianyisui/cangjingge` |

**你的工作流**：我改源码 → 你在 GitHub Desktop 提交推送 → DSH 插件列表更新 → 重启。

---

## 1. ⚠️ 最容易再犯的坑：webServer 不允许重复 exact 路由

### 症状（极具误导性）

```
/cangjingge/所有路由  ->  HTTP 404
而同一 profile 的其它插件（如 /tianshu/tree）-> 200
```

看起来像「**插件根本没加载**」，实际是「**注册到一半炸了**」。

### 根因

dsh 的 `webServer` **不允许同一 path 注册两条 `kind: 'exact'` 路由**。第二条会抛：

```
Error: webserver: duplicate exact route "/cangjingge/settings"
```

抛错发生在 `ctx.effect()` 里 → **cordis 回滚整个插件的 effect** → 之前注册的路由**一起消失** → 全站 404。

### 正确写法

**一条路由，用 `req.method` 分支**：

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: '/cangjingge/settings',
  handler: async (req, res) => {
    if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') {
      // 读分支
      return
    }
    if (req.method !== 'POST') { /* 405 */ return }
    // 写分支
  },
}), '...')
```

天枢的 `/tianshu/thread/bind` 也是这么写的。

### 已有防线

`tests/host.mjs` 里有断言钉住这点：

```js
// 【关键回归】同一 path 不许注册两条 exact 路由
const seen = new Set()
for (const r of routes) { if (seen.has(r.path)) { dup = r.path; break } seen.add(r.path) }
eq(dup, null, '没有重复的 exact 路由路径')
```

**加新路由后一定跑 `npm test`**，不要再靠"重启试试"来发现。

---

## 2. 排查这类问题的**正确方法**（别走我走过的弯路）

我在这上面浪费了很久，依次**错误地怀疑**了：profile patch、`inject` 声明、`Config` 形状、模块加载、pnpm 安装形态。**全都不对**。

### 有效的排查法：埋诊断 + 二分

1. **先切一刀**：把 `apply` 函数体换成最小版（只注册一条探针路由），**保留所有 import 与 Config**。
   - 探针通 → 问题在 `apply` 体里
   - 探针不通 → 问题在装载阶段

2. **在 apply 里埋 stage 标记 + try/catch**，用一条探针路由把错误吐出来：

```js
const __mark = (s) => { globalThis.__cjgStage = s }
try {
  __mark('before-shelf')
  ctx.effect(() => ctx.webServer.register({ ... }))
  // ...
} catch (e) { globalThis.__cjgDiag = String(e && e.stack ? e.stack : e) }
```

3. 探针路由返回 `{ stage, error }` —— 一次重启就能拿到**真实错误堆栈**。

**这比逐个猜快 10 倍。** 直接看 `error` 字段就知道是哪一行炸的。

### 能直接打路由验证（不用开界面）

```powershell
$port = (Get-NetTCPConnection -State Listen |
  Where-Object { $_.OwningProcess -eq (Get-Process 'DeepSeek Harness')[0].Id }).LocalPort
Invoke-WebRequest "http://127.0.0.1:$port/cangjingge/shelf" -UseBasicParsing
```

---

## 3. cordis 依赖注入：`inject` 声明要非常小心

### 症状

插件完全不加载（路由 404），**不报错**。

### 根因

`inject` 里声明了**根 ctx 拿不到的服务**（如 `systemPrompt` 是 **Agent scope** 的服务），cordis 会**无限期等待** → `apply()` 一次都不执行。

### 规则

- **`inject` 只放确实能在根 ctx 解析到的服务**
- 拿不准的服务，用**运行时** `ctx.get(name)`，拿不到就**功能降级**而不是整体阵亡：

```js
export const inject = ['webServer']   // 只有它确定可用

// 运行时取
const sp = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
if (sp && typeof sp.section === 'function') { /* 注册注入 */ }
else { ctx.logger?.warn?.('systemPrompt 不可用，自动注入已跳过') }
```

### 客户端同理

客户端的 `exports.inject` 必须含 `'slots'`（槽位）与 `'inputTriggers'`（`/` 菜单 source）。**漏了 `inputTriggers` → 打 `/` 看不到藏经阁**，且只有一条 `console.warn`，界面上看不到。

`tools/build.mjs` 有断言守着这两项。

---

## 4. `systemPrompt.section()` 的三个约束

「自动」skill 注入系统提示靠它。如果注入不生效，查这三点：

1. **`text` 必须同步返回**。dsh 的组装是同步的：
   ```js
   text: typeof section.text === 'function' ? section.text(context) : section.text
   ```
   传 `async` 函数会得到 `[object Promise]`。**所以注入路径用 `readFileSync`，不用 promise 版**。

2. **用 `ctx.get` 拿服务**（见第 3 点）。

3. **空串 = 这一节消失**。`renderPrompt` 会过滤空 section。所以"取消全部自动"不需要注销注册。

**5 秒 TTL 缓存**：系统提示每轮组装，不缓存就是每轮打盘。改了目录或开关要 `autoCache = { at: 0, text: '' }` 作废缓存。

---

## 5. ⚠️ PowerShell 脚本必须存 UTF-8 with BOM

### 症状

```
Unexpected token '鏄竴涓湡瀹炵洰褰?...
Missing closing ')' in expression
```

### 根因

Windows PowerShell 5.1 对**无 BOM 的 UTF-8** 按 GBK 解码 → 中文注释乱码 → 引号配对打乱 → 语法崩。

### 规则

`install.ps1` / `uninstall.ps1` / `patch-lib.ps1` / `tools/*.ps1` **必须带 BOM（EF BB BF）**。

**用编辑工具改完 .ps1 后，一定要补 BOM**：

```powershell
$p = '路径\install.ps1'
$t = [IO.File]::ReadAllText($p, (New-Object System.Text.UTF8Encoding($false)))
[IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($true)))
```

`.gitattributes` 里已把 `*.ps1` 固定为 CRLF。

---

## 6. profile patch 的编辑：已改成安全方式

### 旧 bug（已修）

```powershell
$own = [regex]::Escape($begin) + '(?s).*?' + [regex]::Escape($end)
```

`(?s)` + `.*?` 会在块边界不干净时**吞掉夹在中间的别人的条目** —— 实测把用户的 `agent-loop` 条目吃掉了，写坏整个 profile patch → 所有插件配置失效。

### 现在的做法（`patch-lib.ps1`）

**逐行扫描**，只删自己认得的行；块内遇到不认识的条目就**抛错拒绝执行**（宁可中止，也不破坏配置）。写前自动备份到 `.bak-<时间戳>`。

### 测试

```powershell
powershell -ExecutionPolicy Bypass -File tools\test-patch-lib.ps1   # 18 项
powershell -ExecutionPolicy Bypass -File tools\drill-patch.ps1      # 12 项（含事故复现）
```

### 配置优先级（重要）

```
界面设置(settings 文件)  >  patch 里的 libraryDir  >  内置默认
```

**你若已在界面设过目录，`install.ps1` 就只清理 patch 里的旧块、不再写入** —— 避免产生"僵尸配置"（写了却被盖住，后人改了没效果还找不到原因）。

---

## 7. 零依赖是硬约束

宿主半**不得 import 任何 `@deepseek-ai/*`**。

**原因**：一旦声明成依赖并装进 profile，那份副本会**顶掉**桌面端自带的那一份 → 版本错配 → `dsh-tools` 导入失败 → **整个软件打不开**，而且卸载重装也没用（坏的是 `~/.dsh/` 配置目录）。

`tests/bundle.mjs` 有断言守着（只查代码行的 import，注释里提到包名不算）。

---

## 8. 目录结构（三层固定）

```
藏经阁/
├── 分组A/              ← 左栏
│   ├── 子项1/          ← 中栏
│   │   ├── skill.md    ← 右栏（.md / .markdown / .txt）
│   │   └── 序.txt
│   └── 子项2/
└── 分组B/
```

- 以 `.` 或 `_` 开头的目录/文件被忽略
- 排序：文件夹在前，文件在后；同类按拼音
- 深度固定三层（再深是资源管理器的活）

---

## 9. 常用命令

```powershell
cd E:\xiangmu\chajian\cangjingge

# 构建（改了 src/ 必须跑）
node tools\build.mjs

# 全量测试（222 项）
npm test

# 生成视觉预览（用 Edge 无头渲染真实 CSS）
node tools\preview.mjs

# patch 编辑安全测试
powershell -ExecutionPolicy Bypass -File tools\test-patch-lib.ps1
powershell -ExecutionPolicy Bypass -File tools\drill-patch.ps1
```

**Node 用桌面端自带的**：
`Z:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`

---

## 10. 组件与数据流

```
浏览器半 (@client.js)
  ├─ sidebar.panellist  小阁楼图标
  ├─ main               三栏书架面板（含「设置」弹窗）
  └─ inputTriggers      `/` 菜单 source（唯一能往聊天框插内容的受支持路径）
        ↓ fetch（相对路径，自带 origin）
宿主半 (host.js)
  ├─ GET  /cangjingge/shelf       书架树 + 每项 mode
  ├─ GET  /cangjingge/skill       单个 skill 正文
  ├─ GET  /cangjingge/candidates  `/` 菜单候选
  ├─ GET  /cangjingge/auto        自动清单
  ├─ POST /cangjingge/mode        切自动/手动
  └─ GET+POST /cangjingge/settings  读/改书架目录（**一条路由两个 method**）
        ↓
  _state.json             自动/手动标记（在书架目录里）
  cangjingge-settings.json 目录设置（在 ~/.dsh/，与书架目录解耦）
```

**重要**：`systemPrompt.section` 注册的动态 section（order 700，在 TEAM_POLICY 600 与 PTC_ONLY 800 之间）把标记为「自动」的 skill 正文**每轮注入系统提示**。

---

## 11. 「界面里为什么没有自动生成的设置框」

DSH **没有**给插件自动生成设置表单的机制：

- `ui-settings-plugin-inventory`（插件列表）明确是**只读**："查看插件，而不改变其配置"
- 配置页要**插件自己写客户端 UI**

所以藏经阁自带一个「设置」弹窗（面板右上角），只做一件事：改书架目录。

---

## 12. 升级 DSH 后要做的

1. `node tools\build.mjs && npm test`
2. 重启，打路由验证：
   ```powershell
   Invoke-WebRequest "http://127.0.0.1:$port/cangjingge/shelf" -UseBasicParsing
   ```
3. 重点核对（都是版本敏感项）：
   - `sidebar.panellist` / `main` 槽位名是否还在
   - `inputTriggers.registerSource` 的 source 形状
   - `systemPrompt.section()` 的 `text` 是否仍支持函数
   - `webServer.register` 是否仍用 `kind: 'exact'`

---

## 13. 遇到问题时的 checklist

```
1. 打路由看是不是 404
   ├─ 全部 404  → 插件没加载 / 注册中途炸了 → 看第 1、3 点，用第 2 点的埋诊断法
   └─ 单个 404  → 该路由没注册 → 看是不是新增的、有没有踩重复路径
2. 书架空但路由正常
   → 查 /cangjingge/settings 的 effective 与 source，确认扫的是哪个目录
3. 界面看不到小阁楼图标
   → 客户端 inject 是否有 slots；槽位名是否变
4. 打 / 看不到藏经阁
   → 客户端 inject 是否有 inputTriggers
5. 「自动」不生效
   → systemPrompt 是否可用（降级时会 warn）；_state.json 有没有内容
6. 脚本报语法错
   → .ps1 的 BOM 掉了 → 补 BOM（第 5 点）
```

---

## 14. 边界（这些做不到）

- **不能给队友/会话指定模型** —— `spawn_teammate` 没有 model 参数；「盘古」是 Agent Preset 不是模型
- **不能往聊天框直接写文本** —— 唯一受支持路径是 `/` 菜单的 pick 流程
- **不能自动加载 skill 进上下文** —— 「自动」的真实含义是「注入系统提示」（第 4 点），不是 DSH 的 skill 机制
- **不能改自己的 profile 配置** —— 那是宿主/插件管理器的地盘；设置存在自己的 json 里
