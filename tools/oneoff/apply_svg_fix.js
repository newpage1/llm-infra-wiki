// 把设计页里未求值的 SVG 模板表达式展开，写回 analyses.js 源文件。
const fs = require('fs');
const P = 'data/analyses.js';
const src = fs.readFileSync(P, 'utf8');

function evalTemplateExprs(s) {
  let out = '', i = 0, n = 0;
  while (i < s.length) {
    const k = s.indexOf('${', i);
    if (k < 0) { out += s.slice(i); break; }
    out += s.slice(i, k);
    let d = 1, j = k + 2, inStr = null, inTpl = false;
    while (j < s.length && d > 0) {
      const c = s[j], p = s[j - 1];
      if (inStr) { if (c === inStr && p !== '\\') inStr = null; }
      else if (inTpl) { if (c === '`' && p !== '\\') inTpl = false; }
      else if (c === '"' || c === "'") inStr = c;
      else if (c === '`') inTpl = true;
      else if (c === '{') d++;
      else if (c === '}') d--;
      j++;
    }
    let val;
    try { val = new Function('return (' + s.slice(k + 2, j - 1) + ')')(); } catch (e) { val = ''; }
    out += (val == null ? '' : String(val)); n++; i = j;
  }
  return { out, n };
}

// 定位嵌入模式那张图的模板表达式区间：从 "${[" 或 "${['store'" 到对应的 ")}" 结尾
// 做法：找出所有含 .map( 的行块，逐个求值。
let count = 0;
const lines = src.split('\n');
let i = 0;
const outLines = [];
while (i < lines.length) {
  const l = lines[i];
  if (/\$\{\[|\$\{\['/.test(l)) {
    // 收集到模板表达式结束（以 ).join('')} 结尾的行）
    let j = i, buf = [];
    while (j < lines.length && !/\.join\(''\)\}/.test(lines[j])) { buf.push(lines[j]); j++; }
    if (j < lines.length) { buf.push(lines[j]); j++; }
    const { out, n } = evalTemplateExprs(buf.join('\n'));
    outLines.push(out); count += n; i = j; continue;
  }
  outLines.push(l); i++;
}
fs.writeFileSync(P, outLines.join('\n'));
console.log(`  展开 ${count} 处模板表达式`);
