#!/usr/bin/env python3
"""重写 lmcache 的 storage-backend——**用分析域限定**，避免改到 mooncake 的同名模块。"""
import io, re, sys
sys.path.insert(0,'/Users/hexiaoying/workspace/llm-infra-wiki')
import sec

new = io.open('/tmp/sb_all.txt', encoding='utf-8').read()
body = new.split('sections: [', 1)[1].rstrip('\n')      # 8 个节
n_sec = len(re.findall(r"\n      \{\n        id: '[a-z-]+',", body))
assert n_sec == 8, "新内容节数 %d ≠ 8" % n_sec

s, a, b = sec.module_bounds_in('lmcache', 'storage-backend')
seg = s[a:b]
# 校验：确认改的是 lmcache 那一份
assert 'storage_backend/storage_manager.py' in seg or 'backend 契约' in seg or 'CreateStorageBackends' in seg, \
    "这不是 lmcache 的 storage-backend，拒绝执行"
he = seg.index('      sections: [')
head = seg[:he]
tail = seg[seg.rindex('\n      ]'):]
out = head + '      sections: [' + body + tail
assert re.search(r"      sections: \[\n      \{", out), "sections: [ 后未接 {"
assert len(re.findall(r"\n      \{\n        id: '[a-z-]+',", out)) == 8, "写回后节数不对"
io.open(sec.P, 'w', encoding='utf-8').write(s[:a] + out + s[b:])
print("  ✅ lmcache / storage-backend 已重写为 8 节")
