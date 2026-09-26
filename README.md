# 藏经阁 · skill 书架（dsh-cangjingge）

给 DeepSeek Harness（`dsh`）用的插件：在左侧栏放一个**小阁楼图标**，点开是一面
**三栏书架**，用来浏览本地 skill 库，并把选中的 skill 插入聊天输入框。

---

## 它长什么样

```
┌─ 分组 ─┬─ 子项 ─┬─ skill ──────────────────┐
│ 易经   │ 乾     │ 心经.md                  │
│ 兵法   │ 坤     │  ─────────────           │
│        │        │  [复制路径] [复制全文]   │
│        │        │  正文预览……               │
└────────┴────────┴──────────────────────────┘
```

左栏 = 顶层文件夹名，中栏 = 子文件夹名，右栏 = 该子文件夹里的 skill 文件。
名字就是你文件夹的真实名字，插件不做任何改名或编号。

---

## 目录约定

书架根目录（默认 `~/.dsh/cangjingge`，可配置）的结构：

```
藏经阁/
├── 易经/                 ← 左栏（分组）
│   ├── 乾/               ← 中栏（子项）
│   │   ├── 心经.md        ← 右栏（skill）
│   │   └── 序言.txt
│   └── 坤/
│       └── 系辞.md
└── 兵法/
    └── 谋/
        └── 三十六计.md
```

- 识别为 skill 的扩展名：`.md` / `.markdown` / `.txt`
- 以 `.` 或 `_` 开头的目录/文件会被忽略（隐藏项、内部项）
- 排序：文件夹在前，文件在后；同类按拼音

---

## 怎么把 skill 插进聊天框

**在聊天输入框里打 `/`** → 菜单里选「藏经阁」→ 挑一个 skill → 它作为**路径引用**
插入到当前对话。

### 为什么不是点面板里的按钮直接插入

这是刻意的取舍，不是没做完。DSH 的 composer 对外**没有**「直接写文本」的接口：

- 唯一受支持的插入路径是输入触发流水线的 pick 流程
  （`insertText(text, span)`），而 `span` 里带 `draftRev` 版本号，
  **只能由 pick 现场提供**；
- 侧栏 / main 面板的按钮拿不到 `span`，`slash/input-insert-text` 事件同样要求
  合法 span。

所以插件把两件事分开：**书架负责「浏览与挑选」**（大面板、三栏、预览），
**插入由 `/` 菜单完成**（官方唯一支持、且不随版本升级崩掉的路）。

面板右侧另外给了「复制路径」「复制全文」，作为不走 composer 的替代出口。

---

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `libraryDir` | `~/.dsh/cangjingge` | 书架根目录 |
| `insertMode` | `quote` | 预留：插入形式 quote / path / body |

改动方式：**DSH 设置界面**，或写进 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-cangjingge
  config:
    libraryDir: 'E:/my/skills'
```

> ⚠️ patch 是**整段替换**，不是深合并：覆盖某行就要重述该行全部键。

---

## 构建与安装

### 环境要求

- 桌面端 `@deepseek-ai/dsh-desktop` **0.1.7-rc.2**（本项目实测目标）
- 构建 / 测试只需 Node.js ≥ 22。桌面端自带的 Node 在
  `Z:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`

### 零依赖是硬约束（不是洁癖）

宿主半**不 import 任何 `@deepseek-ai/*`**（`src/toolkit.js` 内联了 Config schema
的等价实现）。原因是真实事故：一旦把 `@deepseek-ai/*` 声明成依赖并装进 profile，
那份副本会**顶掉**桌面端自带的那一份 → 版本错配 → `dsh-tools` 导入失败 →
**整个软件打不开**。零依赖的附带好处是本地 link 安装安全，不必打 tarball。

### 1. 构建（只有改代码的人需要）

从 GitHub 安装的使用者**不需要**构建 —— 仓库里已经带了构建好的 `lib/`。

```powershell
cd <你把仓库克隆到哪里>
node tools\build.mjs
```

产出：

| 产物 | 说明 |
|---|---|
| `lib/index.js` | 宿主半（`src/host.js` 拷贝） |
| `lib/library.js` | 纯函数书架模型 |
| `lib/toolkit.js` | 零依赖 Config 层 |
| `lib/client.js` | 浏览器半（CJS closure-factory） |

构建脚本自带**五项自检**：语法能过、能在假环境里装载、`factory` 返回了
`apply`/`inject`、槽位注册走了 `ctx.slots.inject`、以及「用到但没定义」的名字扫描。

### 2. 跑测试

```powershell
node tests\library.mjs   # 纯函数 44 项
node tests\host.mjs      # 宿主半装载 + 路由 + 路径安全 31 项
node tests\bundle.mjs    # 组合包 + 零依赖契约 27 项
node tests\e2e.mjs       # 真实 HTTP 端到端 12 项
```

或一条命令：

```powershell
npm run verify
```

### 3. 安装进 profile

有**两条互斥**的路，只能选一条：

**A) 从 GitHub 装（推荐给使用者）**

在 DSH 的插件列表里添加 `github:jiutianyisui/cangjingge`，或在 profile 目录里：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add github:jiutianyisui/cangjingge
```

**B) 本地挂载（推荐给改代码的人）**

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
```

脚本做三件事（幂等）：建 junction → 登记进 `dsh.profile.bundles` →
确保藏经阁目录存在。

> 本插件**零依赖**，所以本地 link 安装是安全的，不像一般插件那样必须打 tarball。

### 4. 重启并验证

**重启桌面端**（包元数据与浏览器半不热更新）。重启后左侧栏出现小阁楼图标。

---

## 项目结构

```
dsh-cangjingge/
├── package.json           # npm manifest（零依赖）+ dsh.bundle / dsh.client 声明
├── cordis.patch.yml       # 组合包配置层
├── install.ps1 / uninstall.ps1
├── LICENSE / .gitignore / .gitattributes
├── src/
│   ├── library.js         # 纯函数：过滤、排序、三栏模型、候选与插入
│   ├── toolkit.js         # 零依赖 Config schema
│   ├── host.js            # 宿主半：扫描 + 三个 HTTP 路由
│   └── @client.js         # 浏览器半：三栏 UI + `/` 触发 source
├── tools/build.mjs        # 装配 + 五项自检
├── tests/                 # library / host / bundle / e2e
└── lib/                   # 构建产物（随仓库提交，使用者直接装就能跑）
```

---

## 兼容性与边界

- 适配桌面端 **0.1.7-rc.2**，关键点已对 `app.asar` 核实：
  `sidebar.panellist` / `main` 槽位、`inputTriggers.registerSource` 的
  source 形状（`{ trigger, name, candidates, onPick }`）、候选行字段
  （`{ name, description, icon, section, value }`）、`insert` 指令形状。
- 升级 `dsh` 后请重跑 `npm run verify`。
- 书架深度固定三层（分组 / 子项 / skill）——再深是资源管理器的活。
- `/` 菜单的候选取自全库，规模大时首次打开会有多次请求（上限 200 行）。
- 单个 skill 文件读取上限 256 KB，超出截断并标记。

## 许可

MIT
