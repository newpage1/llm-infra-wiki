// 把 SVG 里未求值的 ${...} 模板表达式求值成真实 SVG。
// 这些表达式是生成脚本残留——坐标数据完好，只是从没被执行。
const fs = require('fs');

function evalTemplateExprs(src) {
  let out = '', i = 0, n = 0;
  while (i < src.length) {
    const k = src.indexOf('${', i);
    if (k < 0) { out += src.slice(i); break; }
    out += src.slice(i, k);
    // 花括号配平（跳过字符串与模板里的括号）
    let d = 1, j = k + 2, inStr = null, inTpl = false;
    while (j < src.length && d > 0) {
      const c = src[j], p = src[j - 1];
      if (inStr) { if (c === inStr && p !== '\\') inStr = null; }
      else if (inTpl) { if (c === '`' && p !== '\\') inTpl = false; }
      else if (c === '"' || c === "'") inStr = c;
      else if (c === '`') inTpl = true;
      else if (c === '{') d++;
      else if (c === '}') d--;
      j++;
    }
    const expr = src.slice(k + 2, j - 1);
    let val;
    try { val = new Function('return (' + expr + ')')(); }
    catch (e) { console.error('  求值失败:', expr.slice(0, 60), '→', e.message); val = ''; }
    out += (val == null ? '' : String(val));
    n++;
    i = j;
  }
  return { out, n };
}

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const before = (src.match(/\$\{/g) || []).length;
const { out, n } = evalTemplateExprs(src);
const after = (out.match(/\$\{/g) || []).length;
fs.writeFileSync(file, out);
console.log(`  ${file}: 求值 ${n} 处表达式，剩余 \${ ${after} 处（原 ${before}）`);
console.log(`  长度 ${src.length} → ${out.length}`);
// 校验
const open = (out.match(/<svg/g) || []).length, close = (out.match(/<\/svg>/g) || []).length;
const rect = (out.match(/<rect/g) || []).length, text = (out.match(/<text/g) || []).length;
console.log(`  <svg> ${open}/${close} · <rect> ${rect} · <text> ${text}`);
if (/[<>]"[^"]*\$\{/.test(out)) console.log('  ⚠️ 仍有残留的 ${ 在属性里');
