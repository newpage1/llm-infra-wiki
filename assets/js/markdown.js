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

  /* 标题锚点用 **GitHub 那套规则**，不是自己发明一套。
     原因：`flows/` 下的长文都带目录，目录链接是作者按 GitHub 的习惯写的；
     同一份 md 在站内和 GitHub 上都要能点开，两边的 id 就必须一致。
     规则（等价于 github-slugger）：转小写、去掉非「字母/数字/组合标记/连字符/空格」的
     字符、再把空格换成连字符。注意标点是**删掉**而不是换成连字符——
     所以 `1. 标题` → `1-标题`、`a/b` → `ab`、`「引号」` → `引号`。 */
  function slug(s, used) {
    let base = String(s)
      .replace(/<[^>]+>/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\-_ ]/gu, '')
      .replace(/ /g, '-') || 'sec';
    let id = base, n = 1;
    while (used[id]) { id = base + '-' + n++; }   // 重名时第二个叫 xxx-1
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
  /* 段落 / 列表项内的软换行怎么拼
     ------------------------------------------------------------
     源码里的段落是**按列折行**的，一个换行只表示「同一段还接着」。
     英文里拼一个空格是对的；中文里拼空格有两重害处：
       ① 句子中间多出一个可见空格；
       ② 空格是合法的断行点，于是浏览器会在「两种模式 ␣（…」这种地方断行，
          而中文排版不该在「（」前断行 —— 读者看到的就是「莫名其妙的换行」。
     所以：换行两侧只要有一侧是中文或全角标点，就直接拼接、不加空格。

     判断前要把行尾 / 行首的 markdown 记号剥掉，否则
     `…%%server.py%%` 换行到 `（…` 会因为末尾是 % 而被误判成西文。

     实测：全站 3190 处段落内软换行，其中 2119 处断在中文字符或全角标点之间。 */
  const WIDE = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF\u2018\u2019\u201C\u201D\u2013\u2014\u2026]/;
  const peelTail = t => t.replace(/[\s*_`%~]+$/, '');
  const peelHead = t => t.replace(/^[\s*_`%~]+/, '');
  function joinLines(lines) {
    let s = lines[0];
    for (let k = 1; k < lines.length; k++) {
      const prev = peelTail(s).slice(-1);
      const next = peelHead(lines[k]).charAt(0);
      s += ((!prev || !next || WIDE.test(prev) || WIDE.test(next)) ? '' : ' ') + lines[k];
    }
    return s;
  }

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
      if (para.length) { out.push('<p>' + inline(joinLines(para)) + '</p>'); para = []; }
    };
    const closeList = () => { if (inList) { out.push('</' + inList + '>'); inList = null; } };

    while (i < lines.length) {
      const line = lines[i];

      /* 围栏代码 */
      const fence = line.match(/^\s*(~~~|```)(.*)$/);
      if (fence) {
        flushPara(); closeList();
        const mark = fence[1];
        const lang = (fence[2] || '').trim().toLowerCase().split(/\s+/)[0];
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + mark).test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过结束围栏
        if (lang === 'mermaid') {
          // 交给页面里的 mermaid 渲染器（app.js 的 renderMermaid）。
          // 这里照常 esc 一次：浏览器读 textContent 时会把实体还原，
          // mermaid 拿到的仍是原文（含 `<br/>` 这类它自己的语法）。
          out.push('<div class="mermaid">' + esc(buf.join('\n')) + '</div>');
          continue;
        }
        // 带上语言：页面据此区分「真源码」与「```text 的 ASCII 示意图」，
        // 代码块右上角也能挂一个语言小标（见 style.css 的 .codeblk）。
        out.push('<div class="codeblk" data-lang="' + esc(lang) + '">' +
          '<pre><code class="language-' + esc(lang || 'plain') + '">' +
          esc(buf.join('\n')) + '</code></pre></div>');
        continue;
      }

      /* 行间公式：把 \[ ... \] 整段吃掉
         公式的续行常以 +、-、* 开头（换行相加的 LaTeX 写法），不拦住就会被
         下面那条列表规则切开，公式被拆进 <p> 与 <ul> 两个节点，页面上的
         KaTeX（app.js 的 renderMath）就看不到成对的定界符了。
         这里按「围栏」的待遇处理：整段当一个段落输出，内部不再做块级解释。 */
      const mathAt = line.indexOf('\\[');
      if (mathAt >= 0 && line.indexOf('\\]', mathAt + 2) < 0) {
        flushPara(); closeList();
        const buf = [line];
        i++;
        while (i < lines.length) {
          buf.push(lines[i]);
          const done = lines[i].indexOf('\\]') >= 0;
          i++;
          if (done) break;
        }
        out.push('<p>' + inline(buf.join('\n')) + '</p>');
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
        out.push('<li>' + inline(joinLines(parts)) + '</li>');
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
        out.push('<li>' + inline(joinLines(parts)) + '</li>');
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
