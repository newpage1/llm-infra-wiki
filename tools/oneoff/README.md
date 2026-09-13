# 一次性迁移脚本（留档，不再维护）

这些脚本是**当前数据形成过程**的留档——把早期手写的 `data/*.js` 逐步改成今天的结构。
它们已经跑完了，**正常情况下不需要再运行**。

保留它们的理由只有一个：如果哪天要回溯「某段内容是怎么变成现在这样的」，
这些脚本比 commit message 更精确。

| 脚本 | 干过什么 |
|---|---|
| `sec.py` / `sec_del.py` / `sec_top.py` | 按「模块 id + 节 id」定点替换，避免同名节改错模块 |
| `restructure8.py` / `reorder_secs.py` | 把小节统一成 8 节固定顺序 |
| `merge_*.py` / `merge_details.js` | 把分头写的模块合并进 `analyses.js` / `details.js` / `catalog.js` |
| `rewrite_*.py` / `rm_decisions.py` / `requote.py` | 批量改写正文（去决策段、统一引号、改写某模块） |
| `insert_data.py` / `do_module7.py` | 早期插入数据的一次性入口 |
| `apply_svg_fix.js` / `fix_svg2.js` / `fix_svg_template.js` | 批量修 SVG |

> 注意：这些脚本里的相对路径（如 `data/analyses.js`）是**相对仓库根**的，
> 不是在脚本所在目录。真要跑，请 `cd` 到仓库根再执行。
