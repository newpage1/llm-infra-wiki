// 正确做法：在「已解析的字符串」上求值，再重新 JSON 编码写回。
// 不触碰源文件的其他部分——按 key 精确定位。
const fs = require('fs');
const P = 'data/analyses.js';
let src = fs.readFileSync(P, 'utf8');

function expand(s) {                       // 把 ${...} 求值
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
    let v; try { v = new Function('return (' + s.slice(k + 2, j - 1) + ')')(); } catch (e) { v = ''; }
    out += (v == null ? '' : String(v)); n++; i = j;
  }
  return { out, n };
}

// 只处理「含 ${ 的 svg: "..." JSON 字符串」
let total = 0;
src = src.replace(/svg: ("(?:[^"\\]|\\.)*\$\{(?:[^"\\]|\\.)*")/g, (mm, jsonStr) => {
  let val;
  try { val = JSON.parse(jsonStr); } catch (e) { console.log('  解析失败，跳过'); return mm; }
  const { out, n } = expand(val);
  total += n;
  console.log('  展开 ' + n + ' 处，' + val.length + ' → ' + out.length + ' 字节');
  return 'svg: ' + JSON.stringify(out);
});
fs.writeFileSync(P, src);
console.log('合计 ' + total + ' 处');
