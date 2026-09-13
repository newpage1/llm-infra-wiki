/* ============================================================
   LLM Infra Wiki — 轻量 Markdown 渲染器
   支持：标题 / 段落 / 有序无序列表 / 引用 / 表格 / 围栏代码 /
        行内代码（反引号或 %%..%%）/ 粗斜体 / 链接 / 图片 / 分隔线
   同时产出 heading 锚点，供右侧 TOC 使用。
   ============================================================ */
(function () {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slug(s, used) {
    let base = String(s).toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'sec';
    let id = base, n = 2;
    while (used[id]) { id = base + '-' + n++; }
    used[id] = true;
    return id;
  }

  /* ---------- 行内 ---------- */
  function inline(raw) {
    let s = esc(raw);

    // 图片
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
    // 链接
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // 行内代码：%%..%% 或 `..`
    // 先抽成占位符 —— 代码内容里可能有 * （如 C++ 的 BatchDesc*），
    // 直接转成 <code> 会让后面的粗体正则被那个 * 截断。
    const stash = [];
    const keep = (html) => { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000'; };
    s = s.replace(/%%([^%]+)%%/g, (m, c) => keep('<code>' + c + '</code>'));
    s = s.replace(/`([^`]+)`/g, (m, c) => keep('<code>' + c + '</code>'));
    // 粗体 / 斜体
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // 删除线
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // 还原代码 span
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
    return s;
  }

  /* ---------- 表格 ---------- */
  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  }
  function splitRow(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  }

  /* ---------- 主渲染 ---------- */
  function render(src, opts) {
    opts = opts || {};
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const toc = [];
    const used = {};
    const out = [];
    let i = 0;
    let inList = null;   // 'ul' | 'ol'
    let para = [];

    const flushPara = () => {
      if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
    };
    const closeList = () => { if (inList) { out.push('</' + inList + '>'); inList = null; } };

    while (i < lines.length) {
      const line = lines[i];

      /* 围栏代码 */
      const fence = line.match(/^\s*(~~~|```)(.*)$/);
      if (fence) {
        flushPara(); closeList();
        const mark = fence[1];
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + mark).test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过结束围栏
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      /* 空行 */
      if (!line.trim()) { flushPara(); closeList(); i++; continue; }

      /* 分隔线 */
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushPara(); closeList(); out.push('<hr>'); i++; continue;
      }

      /* 标题 */
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara(); closeList();
        const lvl = h[1].length;
        const text = h[2].trim();
        const id = slug(text, used);
        toc.push({ level: lvl, text: text.replace(/[*`%]/g, ''), id });
        out.push('<h' + lvl + ' id="' + id + '">' + inline(text) + '</h' + lvl + '>');
        i++; continue;
      }

      /* 引用 */
      if (/^\s*>\s?/.test(line)) {
        flushPara(); closeList();
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, '')); i++;
        }
        out.push('<blockquote>' + render(buf.join('\n'), { noToc: true }).html + '</blockquote>');
        continue;
      }

      /* 表格 */
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara(); closeList();
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i])); i++;
        }
        let t = '<table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
        t += rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('');
        out.push(t + '</tbody></table>');
        continue;
      }

      /* 无序列表 */
      const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
        // 吸收缩进续行：**粗体** 等行内标记可能跨行，必须合并后再 inline
        const parts = [ul[2]]; i++;
        while (i < lines.length && lines[i].trim() &&
               /^\s{2,}\S/.test(lines[i]) &&
               !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
               !/^\s*(#{1,6}\s|>|~~~|```)/.test(lines[i])) {
          parts.push(lines[i].trim()); i++;
        }
        out.push('<li>' + inline(parts.join(' ')) + '</li>');
        continue;
      }

      /* 有序列表 */
      const ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
        const parts = [ol[2]]; i++;
        while (i < lines.length && lines[i].trim() &&
               /^\s{2,}\S/.test(lines[i]) &&
               !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
               !/^\s*(#{1,6}\s|>|~~~|```)/.test(lines[i])) {
          parts.push(lines[i].trim()); i++;
        }
        out.push('<li>' + inline(parts.join(' ')) + '</li>');
        continue;
      }

      /* 段落 */
      closeList();
      para.push(line.trim());
      i++;
    }
    flushPara(); closeList();

    return { html: out.join('\n'), toc: opts.noToc ? [] : toc };
  }

  window.md = render;
})();
