# Git 工作流

本文面向第一次或不太熟悉 Git 协作的同学，说明本项目推荐的分支、提交和 Pull Request 流程。

## 几个基本概念

### Git 是什么

Git 是代码版本管理工具。它会记录每一次修改，方便大家一起开发，也方便出问题时回头查看。

### commit 是什么

commit 可以理解为一次“保存记录”。每个 commit 应该说明这次改了什么。

好的 commit 不是越大越好。一次 commit 最好只做一件相对清楚的事，例如：

- 修改登录页文案。
- 修复报名按钮无法点击的问题。
- 增加协作说明文档。

### branch 是什么

branch 是分支。你可以把它理解成从主线代码上复制出来的一条工作线。

我们不要直接在 `main` 上改代码，而是新建一个分支，在自己的分支上修改，确认没问题后再通过 PR 合并回去。

### Pull Request 是什么

Pull Request，简称 PR，可以理解为“请求把我的修改合并进项目”。

开 PR 之后，其他同学可以看到你改了什么、提出建议、帮你检查问题。PR 不是考试，也不是审核你这个人，它只是团队一起把代码变稳的过程。

## 推荐协作流程

一般开发请按这个流程：

1. 从最新的 `main` 分支开始。
2. 新建自己的功能分支。
3. 在自己的分支上修改代码或文档。
4. 提交 commit。
5. 推送到 GitHub。
6. 开 Pull Request。
7. 根据 Review 意见继续修改。
8. 通过检查后合并。

常用命令示例：

```bash
git checkout main
git pull
git checkout -b docs/add-collaboration-docs
```

修改完成后：

```bash
git status
git add CONTRIBUTING.md docs/collaboration/01-Git工作流.md
git commit -m "docs: add collaboration guide"
git push -u origin docs/add-collaboration-docs
```

然后到 GitHub 页面上打开 Pull Request。

## 分支命名

分支名建议使用英文小写，用 `/` 分组，用 `-` 连接单词。

常见类型：

| 类型 | 适合场景 | 示例 |
| --- | --- | --- |
| `feat/` | 新功能 | `feat/team-registration` |
| `fix/` | 修复问题 | `fix/login-redirect` |
| `docs/` | 文档修改 | `docs/add-collaboration-docs` |
| `style/` | 样式或展示调整 | `style/profile-page` |
| `refactor/` | 重构，不改变功能 | `refactor/match-actions` |
| `chore/` | 工具、依赖、配置等杂项 | `chore/update-dependencies` |
| `hotfix/` | 紧急线上修复 | `hotfix/certificate-export` |

如果不确定用哪个，优先用最接近的类型，不必纠结太久。

## 提交信息命名

推荐格式：

```text
类型: 简短说明
```

英文类型建议使用：

| 类型 | 含义 | 示例 |
| --- | --- | --- |
| `feat` | 新功能 | `feat: add team match export` |
| `fix` | 修复 bug | `fix: handle expired reset token` |
| `docs` | 文档 | `docs: add contributing guide` |
| `style` | 样式调整 | `style: improve mobile header spacing` |
| `refactor` | 重构 | `refactor: simplify match status helpers` |
| `chore` | 杂项维护 | `chore: update dependencies` |
| `test` | 测试 | `test: add match grouping cases` |

中文说明也可以，例如：

```text
docs: 增加协作说明
fix: 修复报名后页面未刷新的问题
feat: 新增团体赛结果导出
```

尽量避免这些提交信息：

```text
update
fix
改一下
临时提交
不知道
```

如果一次改动还没做完，但想先保存，可以用：

```text
wip: 调整比赛详情页
```

`wip` 表示 work in progress，也就是还在进行中。合并前最好把这类临时 commit 整理掉，或者至少确保 PR 说明写清楚。

## PR 说明应该写什么

PR 描述里尽量写清楚：

- 这次改了什么。
- 为什么要这样改。
- 自己测试了什么。
- 是否涉及数据库迁移。
- 是否涉及环境变量。
- 如果有界面变化，最好附截图。

一个简单示例：

```md
## 改动

- 新增 CONTRIBUTING.md
- 新增 Git 工作流说明

## 测试

- 文档修改，无需运行构建

## 注意事项

- 不涉及数据库迁移
- 不涉及环境变量
```

## 修改数据库时要格外小心

这个项目的比赛、报名、赛果、ELO 和用户数据都依赖数据库。数据库相关改动需要更谨慎。

涉及以下文件时，请在 PR 里特别说明：

- `prisma/schema.prisma`
- `prisma/migrations/`
- `src/lib/prisma.ts`
- 任何会创建、修改、删除比赛或用户数据的 Server Action

不要在生产环境直接试命令。迁移和部署流程请以维护者确认的方式执行。

## Review 时怎么沟通

Review 的目标是让项目更稳定，不是挑错或否定别人。

提建议时尽量具体，例如：

- “这里是否需要处理未登录用户？”
- “这个按钮在手机屏幕上可能会换行，可以测一下移动端。”
- “这里改了 schema，PR 里可以补充 migration 说明。”

收到建议时也不用紧张。可以直接修改，也可以解释自己的想法。协作时把问题说清楚，比一次写对更重要。
