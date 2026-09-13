<!-- 标题建议：<类型>: <一句话>，类型同 commit（docs / fix / feat / chore） -->

## 改了什么

<!-- 一两句说清。涉及内容改动时给出页面路径，例如 #/a/mooncake/link-backends -->

## 为什么要改

<!-- 是纠错（原来哪里不对）？补充（原来缺什么）？还是新增模块？ -->

## 自检

- [ ] `bash tools/verify.sh` 通过（0 错误 0 提示）
- [ ] 改了 `路径:行号` 或代码围栏 → 已跑 `bash tools/verify-anchors.sh <分析页 id>`
- [ ] 改了 `assets/` 下的静态资源 → 已跑 `python3 bump.py`
- [ ] 新增/改动了关键模块 → 已读过 [`authoring/MODULE-SPEC.md`](../blob/main/authoring/MODULE-SPEC.md)

## 说明

<!-- 可选：哪些论断没锚上、哪些是推断、有没有已知遗留。
     这一栏是本站的口径——如实写比写得漂亮重要。 -->
