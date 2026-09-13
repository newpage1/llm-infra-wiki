#!/usr/bin/env python3
"""把已改造过的模块升到「八节」版本：

  用途与职责 → 内部结构 → 公开 API 与入口 → 参与的流程
  → 具体实现 → 关键文件 → 依赖    （未覆盖降为文末 notCovered）

「具体实现」从备份里恢复——那些节在上一轮被我误删。
"""
import io, re, sys
sys.path.insert(0, '/Users/hexiaoying/workspace/llm-infra-wiki')
import do_module7 as M
import merge_impl as G

KEEP = {'position', 'structure', 'architecture', 'interface', 'flow', 'path', 'files', 'deps'}
DROP = {'issues', 'uncovered', 'edges', 'quality', 'decisions', 'risks'}


# 某些模块的实现节只存在于更早的备份里
IMPL_BACKUP = {'mp-transport': '.backup/analyses.b4-gc.js'}


def impl_sources(mid):
    txt = io.open(IMPL_BACKUP.get(mid, G.BACKUP), encoding='utf-8').read()
    bids = list(G._sections_of(txt, mid).keys())
    return [x for x in bids if x not in KEEP and x not in DROP]


def notcovered_items(mid):
    txt = io.open(G.BACKUP, encoding='utf-8').read()
    secs = G._sections_of(txt, mid)
    for sid in ('issues', 'uncovered'):
        if sid in secs:
            html = G._field(secs[sid], 'html') or ''
            return [re.sub(r'^-\s*', '', l).strip()
                    for l in html.split('\n') if l.strip().startswith('- ')]
    return []


def run(mid, dry=False):
    ids = M.ids_of(mid)
    if 'files' not in ids or 'deps' not in ids:
        print("  ⏭  %s 还没到七节，跳过" % mid); return
    src = impl_sources(mid)
    if not src:
        print("  ⚠️  %s 找不到实现来源" % mid); return
    items = notcovered_items(mid)
    secs = [
        M.retitle(M.grab_any(mid, 'position'), 'position', '用途与职责'),
        M.retitle(M.grab_any(mid, 'structure', 'architecture'), 'structure', '内部结构'),
        M.retitle(M.grab_any(mid, 'interface'), 'interface', '公开 API 与入口'),
        M.retitle(M.grab_any(mid, 'flow', 'path'), 'flow', '参与的流程'),
        G.build_impl(mid, src, backup=IMPL_BACKUP.get(mid, G.BACKUP)),
        M.retitle(M.grab_any(mid, 'files'), 'files', '关键文件'),
        M.retitle(M.grab_any(mid, 'deps'), 'deps', '依赖'),
    ]
    M.rewrite(mid, secs, dry=True)
    M.rewrite(mid, secs)
    if items:
        M.set_notcovered(mid, items)
    print("     impl ← %s | notCovered ← %d 条" % (src, len(items)))


if __name__ == '__main__':
    for mid in sys.argv[1:]:
        print("── %s" % mid)
        run(mid)
