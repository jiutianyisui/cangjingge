// 从 lib/client.js 里抽出真实的 CSS 常量，生成预览页，再用 Edge 截图。
// 用法: node tools/preview.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// 从 bundle 里抠出 CSS 数组：找 ".dsh-cjg-root{" 起到 "].join('')" 为止
const start = bundle.indexOf('.dsh-cjg-root{')
if (start < 0) { console.error('找不到 CSS 起点'); process.exit(1) }
// 往前找到数组开头的引号
const arrStart = bundle.lastIndexOf('[', start)
const arrEnd = bundle.indexOf("].join('')", start)
if (arrStart < 0 || arrEnd < 0) { console.error('找不到 CSS 边界'); process.exit(1) }

const arrLiteral = bundle.slice(arrStart, arrEnd + 1)
// eslint-disable-next-line no-new-func
const CSS = new Function('return ' + arrLiteral)().join('')

// DSH 主题变量的近似值（深色）。真实 DSH 会给这些变量赋值，
// 这里只为了在没有 DSH 的环境下能看到效果。
const theme = `
:root{
  --dsw-alias-bg-base:#1b1b1d;
  --dsw-alias-bg-layer-1:#232325;
  --dsw-alias-bg-layer-2:#2b2b2e;
  --dsw-alias-bg-overlay:#1c1c1f;
  --dsw-alias-label-primary:#e8e6e3;
  --dsw-alias-label-secondary:#b3b0ab;
  --dsw-alias-label-tertiary:#807d78;
  --dsw-alias-border-l1:#333336;
  --dsw-alias-border-l2:#44444a;
  --dsw-alias-brand-primary:#c9a227;
  --dsw-alias-state-error-primary:#e5534b;
  --dsw-specific-font-family-code:'Cascadia Code',Consolas,monospace;
}
`

function row(glyphPath, name, count, on) {
  return `<button class="dsh-cjg-row${on ? ' dsh-cjg-row-on' : ''}">
    <span class="dsh-cjg-ico">${glyphPath}</span>
    <span class="dsh-cjg-row-name">${name}</span>
    ${count === null ? '' : `<span class="dsh-cjg-count-chip">${count}</span>`}
  </button>`
}

const folder = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M1.6 3.6 h4.2 l1.3 1.7 h7.3 v6.9 a.8.8 0 0 1 -.8.8 h-11.2 a.8.8 0 0 1 -.8-.8 z"/></svg>`
const file = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M3.4 1.9 h5.6 l3.6 3.6 v8.6 a.8.8 0 0 1 -.8.8 h-8.4 a.8.8 0 0 1 -.8-.8 z"/><path d="M9 1.9 v3.6 h3.6"/></svg>`
const fileBig = file.replace('width="13" height="13"', 'width="15" height="15"')

const attic = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M10 2.1 L18.2 8.6 L16.9 10.2 L10 4.8 L3.1 10.2 L1.8 8.6 Z" fill="currentColor"/><path d="M4 10.6 L16 10.6 L16 18 L4 18 Z" fill="currentColor" opacity="0.55"/><rect x="8.4" y="12.6" width="3.2" height="3.6" rx="0.4" fill="#1b1b1d"/></svg>`

const body = `
<div class="dsh-cjg-root">
  <div class="dsh-cjg-head">
    <span class="dsh-cjg-brand">${attic}</span>
    <span class="dsh-cjg-title">藏经阁</span>
    <span class="dsh-cjg-sub">E:\\xiangmu\\chajian\\藏经阁</span>
    <span class="dsh-cjg-spacer"></span>
    <button class="dsh-cjg-btn">重新扫描</button>
  </div>
  <div class="dsh-cjg-cols">
    <div class="dsh-cjg-col dsh-cjg-col-l">
      <div class="dsh-cjg-list">
        <div class="dsh-cjg-col-head"><span>分组</span><span class="dsh-cjg-spacer"></span><span class="dsh-cjg-count">3</span></div>
        ${row(folder, '经部', 2, false)}
        ${row(folder, '史部', 1, true)}
        ${row(folder, '子部', 4, false)}
      </div>
    </div>
    <div class="dsh-cjg-col dsh-cjg-col-m">
      <div class="dsh-cjg-list">
        <div class="dsh-cjg-col-head"><span>子项</span><span class="dsh-cjg-spacer"></span><span class="dsh-cjg-count">3</span></div>
        ${row(folder, '正史', 2, true)}
        ${row(folder, '编年', 1, false)}
        ${row(folder, '杂记', 3, false)}
      </div>
    </div>
    <div class="dsh-cjg-col dsh-cjg-col-r">
      <div class="dsh-cjg-list-top">
        <div class="dsh-cjg-col-head"><span>skill</span><span class="dsh-cjg-spacer"></span><span class="dsh-cjg-count">3</span></div>
        ${row(file, '史记.md', null, true)}
        ${row(file, '汉书.md', null, false)}
        ${row(file, '后汉书.markdown', null, false)}
      </div>
      <div class="dsh-cjg-body">
        <div class="dsh-cjg-skill-head">
          <span class="dsh-cjg-ico" style="opacity:1;color:var(--dsh-cjg-gold)">${fileBig}</span>
          <span class="dsh-cjg-skill-name">史记.md</span>
        </div>
        <div class="dsh-cjg-path">E:\\xiangmu\\chajian\\藏经阁\\史部\\正史\\史记.md</div>
        <div class="dsh-cjg-actions">
          <button class="dsh-cjg-btn">复制路径</button>
          <button class="dsh-cjg-btn dsh-cjg-btn-primary">复制全文</button>
        </div>
        <div class="dsh-cjg-hint">在聊天输入框里打 <span class="dsh-cjg-kbd">/</span>　打开菜单 → 选「藏经阁」→ 挑这个 skill，即可插入当前对话。</div>
        <div class="dsh-cjg-paper"><pre class="dsh-cjg-pre"># 史记

太史公曰：余读谍记，黄帝以来皆有年数。
稽其历谱谍终始五德之传，古文咸不同，乖异。
夫子之弗论次其年月，岂虚哉！

于是以五帝系谍、尚书集世纪黄帝以来讫共和为世表。</pre></div>
      </div>
    </div>
  </div>
</div>
<div class="dsh-cjg-modal-mask">
  <div class="dsh-cjg-modal">
    <div class="dsh-cjg-modal-title">藏经阁 · 设置</div>
    <div class="dsh-cjg-effective">
      <div><span class="dsh-cjg-effective-k">当前扫描</span><span class="dsh-cjg-badge">内置默认</span></div>
      <div class="dsh-cjg-effective-v">C:\\Users\\Administrator\\.dsh\\cangjingge</div>
    </div>
    <label>
      <span class="dsh-cjg-field-hint">书架根目录</span>
      <input class="dsh-cjg-input" type="text" value="" placeholder="C:\\Users\\Administrator\\.dsh\\cangjingge">
    </label>
    <span class="dsh-cjg-field-hint">留空 = 用当前生效值（不覆盖）。目录不存在会自动创建。<br>保存后立即重扫，不需要重启。</span>
    <div class="dsh-cjg-modal-actions">
      <span class="dsh-cjg-spacer"></span>
      <button class="dsh-cjg-btn">取消</button>
      <button class="dsh-cjg-btn">恢复默认</button>
      <button class="dsh-cjg-btn dsh-cjg-btn-primary">保存</button>
    </div>
  </div>
</div>`

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${theme}${CSS}
html,body{margin:0;height:100%;}
body{background:#1b1b1d}
.dsh-cjg-root{height:100%}
</style></head><body>${body}</body></html>`

const out = join(root, 'tools', 'preview.html')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html, 'utf8')
console.log('preview: ' + out)
console.log('CSS 长度: ' + String(CSS.length))
