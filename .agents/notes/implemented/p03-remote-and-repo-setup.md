# P-03 远端与仓库设置 + 首个真实事件

- **日期**：2026-10-20
- **状态**：implemented（远端、9 个 state label、首个真实事件已验收；类型 label 与分支保护未做，理由见落地记录）
- **里程碑**：M0 · 自举
- **依赖**：P-01、P-02
> **需要人工/授权**：建远端、`gh auth login`、改仓库设置都超出工作区，须由人执行或明确授权。

## 背景

本仓当前 0 个 remote，`gh` 未登录。`state-writer` 与全部 label 逻辑一次都没跑过。

## 决策

按「先让写者能读能写、再让事件进来」的顺序推，一条命令一件可验证的事：

```bash
# 1 远端与登录
git remote add origin <url> && git push -u origin main
gh auth login

# 2 九个 state label（缺了 gh issue edit --add-label 会直接报错，不会自动建）
for s in triage analyzing needs-info rejected accepted in-progress blocked done cancelled; do
  gh label create "state:$s" --color 0e8a16 --force
done

# 3 类型 label
gh label create proposed --color 1d76db --force
gh label create bugfix   --color d73a4a --force
```

## 目标 · 验收 · 边界

- **目标**：一条真实 issue 创建后数秒内自动带上 `state:accepted`。
- **验收**：三条命令原文——`git remote -v` 有 origin；`gh label list --limit 30 | grep -c '^state:'` 等于 9；新建一条 issue 后 `gh issue view <n> --json labels,state` 含 `state:accepted`，并在 issue 时间线上能看出 label 是 workflow 加的（actor 是 github-actions）。
- **边界**：只动远端与仓库设置，不动仓库内文件。若验证失败，只允许改 `.github/workflows/state-writer.yml` 并另开提案，不在本提案里扩大范围。

## 放弃了什么

- **先写 merge gate 再验证写者**：门依赖写者的产出，写者不通时门只能对着空数据跑。
- **用 Terraform / probot 管仓库设置**：当前只有一个仓，声明式管理设置的收益为零，成本是一整套新工具链。

## 落地记录

- **验收事实（2026-10-21）**：
  ```
  $ gh api repos/Theodoree/ai_native_framework/issues/1/timeline --jq '.[] | select(.event=="labeled")'
  {"event":"labeled","label":"state:accepted","actor":"github-actions[bot]"}
  $ gh api ".../actions/runs?per_page=1" --jq '.workflow_runs[0] | {id, name, conclusion, event}'
  {"conclusion":"success","event":"issues","id":39533142226,"name":"state-writer"}
  ```
  时间线上 label 的 actor 是 `github-actions[bot]`，不是 `Theodoree`——「自动流转」这个说法有第三方证据，不是自述。
- **HTTPS push 被 workflow scope 挡住**：`refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope`。改用 SSH remote 绕开，随后 `gh auth login` 补上 `workflow` scope。教训：**推 workflow 文件的权限和推代码的权限不是同一件事**，缺 scope 时错误信息只提到 workflow 文件，很容易误判成文件内容问题。
- **真事件暴露了机制侧的坑（本地永远跑不出）**：`scripts/build-intent.mjs` 只读 `process.env.DEFAULT_FLOW`，而 workflow 从未设置该 env，CI 上 `issues.opened` 会落 `triage` 而不是 `accepted`。改成「声明的 `policy.default_flow` 是唯一真源，env 仅覆盖」。教训：**默认值写在使用方而不是声明里，本地手动带 env 的验证永远是假绿**。
- **没做的两件（不为凑齐计划而做）**：① 提案里的 `proposed` / `bugfix` 类型 label 未建——当前没有任何消费者（merge gate 只读 `state:*`），先建即为无主配置；② 分支保护与 required check 属 P-09，不在本提案边界内。
