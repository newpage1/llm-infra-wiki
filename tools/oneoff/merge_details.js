// details.js：把 mooncake-te 与 mooncake-store 两个组件详情页合并成一个 mooncake。
// 做法：先求值取出数据，重新生成「合并条目」的文本，再替换回文件——
// 只动这一个条目，其余条目原样保留。
const fs = require('fs');
const P = 'data/details.js';
let s = fs.readFileSync(P, 'utf8');

global.window = {};
eval(s);
const D = window.WIKI_DETAILS;
const te = D['mooncake-te'], st = D['mooncake-store'];
if (!te || !st) throw new Error('找不到两个条目');

// ── 合并 overview ───────────────────────────────────────────────
// te 的 overview 是「整个仓库」的视角（含全局架构图），保留作页面开头；
// 只把其中「本页只讲内核层」那句改掉——现在两层都讲了。
let ovTe = te.overview.replace(
  /> 本页只讲\*\*内核层\*\*[\s\S]*?见 \[Mooncake Store\]\(#\/c\/mooncake\)。\n?/,
  '> 本页把两层一起讲：**上层对象模型（Store）** 与 **下层字节搬运（Transfer Engine）**。\n' +
  '> 其余三个服务（p2p-store / pg / ep）不在本页范围内。\n'
);
// store 的 overview 去掉自己的「一句话定位」，改成本页的「上层」专章
let ovSt = st.overview.replace(/^\s*## 一句话定位\n/, '## 上层：对象模型（Mooncake Store）\n');
const overview = ovTe.replace(/\s+$/, '') + '\n\n---\n\n' + ovSt.replace(/^\s+/, '');

// ── 合并 modules：对象层在前，字节层在后（与总体设计图同序）──────
const modules = [...(st.modules || []), ...(te.modules || [])];

// ── 生成条目文本 ───────────────────────────────────────────────
const esc = t => t.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const entry =
  "window.WIKI_DETAILS['mooncake'] = {\n" +
  '  overview: `' + esc(overview) + '`,\n' +
  '  modules: ' + JSON.stringify(modules, null, 2).replace(/\n/g, '\n  ') + '\n};\n';

// ── 替换：删掉 te 条目，把 store 条目换成合并条目 ─────────────────
function entrySpan(key) {
  const start = s.indexOf("window.WIKI_DETAILS['" + key + "'] = {");
  if (start < 0) throw new Error('找不到 ' + key);
  const ob = s.indexOf('{', start);
  let depth = 0, inTpl = false, esc2 = false;
  for (let n = ob; n < s.length; n++) {
    const c = s[n];
    if (esc2) { esc2 = false; continue; }
    if (c === '\\') { esc2 = true; continue; }
    if (c === '`') { inTpl = !inTpl; continue; }
    if (inTpl) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { 
      let end = n + 1;
      while (end < s.length && (s[end] === ';' || s[end] === '\n')) end++;
      return [start, end];
    } }
  }
  throw new Error('括号没配平 ' + key);
}

const teSpan = entrySpan('mooncake-te');
s = s.slice(0, teSpan[0]) + s.slice(teSpan[1]);        // 删 te
const stSpan = entrySpan('mooncake-store');
s = s.slice(0, stSpan[0]) + entry + s.slice(stSpan[1]); // store → mooncake

fs.writeFileSync(P, s);
console.log('已合并 details.js');
console.log('  模块数', modules.length, '→', modules.map(m => m.id).join(', '));
console.log('  overview 长度', overview.length);
