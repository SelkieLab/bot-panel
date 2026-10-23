## 这个 PR 做了什么

<!-- 一两句话，别贴 diff -->

## 为什么

<!-- 解决什么问题。如果对应某个 issue，写 Closes #123 -->

## 怎么验证的

- [ ] `python -m py_compile server.py` 通过
- [ ] `python deploy/bin/panel_tests.py` 通过
- [ ] 手动跑了改动的功能

## 自查

- [ ] 一个 PR 只做一件事
- [ ] 没有引入新依赖（或已在上面说明为什么必须引）
- [ ] 没有提交口令、IP、域名等敏感信息
- [ ] 改完 css/js 后跑过 `deploy/bin/hash_assets.py`
