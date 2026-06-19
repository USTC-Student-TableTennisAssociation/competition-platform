# Git 工作流

本文说明本项目日常协作中如何查看分支、新建分支、提交改动、推送代码和打开 Pull Request。所有协作者应按本文约定提交改动。

## 基本原则

* `main` 是默认稳定分支，对应线上可部署版本。
* 所有功能、修复和文档调整都应从最新的 `main` 新建分支。
* 不直接在 `main` 上开发或向 `main` 推送代码。
* 一个分支应只处理一个明确任务。
* 分支、commit 和 PR 说明应让其他维护者能够快速理解改动目的和影响范围。
* PR 合并后，应及时删除已经完成的临时分支。

## 常用概念

### branch

branch 是分支，用于隔离未完成的改动。每个任务应在独立分支完成，并通过 PR 合并回 `main`。

### commit

commit 是一次提交记录，用于保存一组相关改动。每个 commit 应只表达一个清晰目的。

示例：

* 修复报名按钮无法点击的问题。
* 调整个人主页移动端样式。
* 增加 Git 工作流说明。

### Pull Request

Pull Request，简称 PR，用于请求将一个分支的改动合并到目标分支。

PR Review 用于确认改动是否清晰、可维护、可安全合并。PR 说明和讨论记录也是后续维护时的重要上下文。

## 标准工作流程

一般改动应按以下流程进行：

1. 查看当前分支和工作区状态。
2. 切换到 `main` 分支并同步最新代码。
3. 从 `main` 新建工作分支。
4. 在工作分支上修改代码或文档。
5. 查看本地改动。
6. 提交 commit。
7. 推送分支到 GitHub。
8. 打开 Pull Request。
9. 根据 Review 意见继续修改。
10. 检查通过后合并。
11. 合并后清理临时分支。

## 查看分支和状态

查看当前所在分支：

```bash
git branch --show-current
```

查看当前工作区状态：

```bash
git status -sb
```

查看本地分支：

```bash
git branch
```

查看本地和远程分支：

```bash
git branch -a
```

查看本地分支与远程分支的对应关系：

```bash
git branch -vv
```

常见输出示例：

```text
* main
  remotes/origin/HEAD -> origin/main
  remotes/origin/main
```

其中：

* `* main` 表示当前在本地 `main` 分支。
* `origin/main` 表示 GitHub 远程仓库中的 `main` 分支在本地的记录。
* `origin/HEAD -> origin/main` 表示远程仓库的默认分支是 `main`。

如果 `git status -sb` 显示有未提交改动，应先确认这些改动是否属于当前任务。不要在不了解改动来源的情况下直接覆盖或丢弃。

## 从 main 新建工作分支

新任务应从最新的 `main` 开始。

```bash
git switch main
git pull origin main
```

其中：

* `git switch main`：切换到本地 `main` 分支。
* `git pull origin main`：从远程仓库 `origin` 的 `main` 分支拉取最新代码。

然后新建工作分支：

```bash
git switch -c docs/add-collaboration-docs
```

其中：

* `-c` 表示创建新分支。
* `docs/add-collaboration-docs` 是新分支名。

分支名应符合下方“分支命名规范”。

## 查看和提交改动

完成代码或文档修改后，查看改动范围：

```bash
git status -sb
```

查看具体内容差异：

```bash
git diff
```

也可以使用 VS Code 的 Source Control 面板查看文件改动和具体差异。

确认改动范围正确后，提交本次任务相关文件：

```bash
git add CONTRIBUTING.md docs/collaboration/01-git-workflow.md
git commit -m "docs: 增加协作说明"
```

其中：

* `git add`：把文件加入本次提交。
* `git commit -m "..."`：创建提交记录。`-m` 是 `--message` 的缩写，后面的引号内容是本次提交说明。

如果使用 VS Code，也可以在 Source Control 面板中完成暂存和提交。

不要把无关改动一起提交。

## 推送分支到 GitHub

本地新建的分支一开始只存在于自己的电脑上。推送分支就是把这个分支和其中的 commit 上传到 GitHub，这样才能在 GitHub 页面打开 Pull Request。

第一次推送新分支时：

```bash
git push -u origin docs/add-collaboration-docs
```

其中：

* `git push`：把本地提交推送到远程仓库。
* `-u`：设置本地分支与远程分支的跟踪关系。设置后，之后在同一分支上可以直接使用 `git push`。
* `origin`：远程仓库名称，通常就是 GitHub 上的仓库。
* `docs/add-collaboration-docs`：要推送的分支名。远程仓库中会创建同名分支。

设置跟踪关系后，Git 会记住：

```text
本地 docs/add-collaboration-docs 分支
对应远程 origin/docs/add-collaboration-docs 分支
```

后续继续在同一分支提交时，通常只需要：

```bash
git push
```

如果使用 VS Code，也可以点击 Source Control 面板中的 `Publish Branch`。它通常等价于第一次推送当前分支，并建立本地分支和远程分支的跟踪关系。


## 打开 Pull Request

推送分支后，到 GitHub 仓库页面打开 Pull Request。

常见方式：

1. 推送分支后，GitHub 仓库页面通常会出现 `Compare & pull request` 按钮。
2. 如果没有出现，可以进入仓库的 `Pull requests` 页面，点击 `New pull request`。
3. 目标分支选择 `main`，来源分支选择自己的工作分支。

方向应为：

```text
docs/add-collaboration-docs → main
```

含义是：

```text
请求把 docs/add-collaboration-docs 分支的改动合并到 main 分支。
```

PR 标题应简短说明改动内容，描述应按下方“PR 说明规范”填写。

## 根据 Review 修改

如果 PR 收到 Review 意见，应在同一个工作分支继续修改、提交并推送。

```bash
git status -sb
git add docs/collaboration/01-git-workflow.md
git commit -m "docs: 补充分支和推送命令说明"
git push
```

新的 commit 会自动出现在原 PR 中，不需要重新打开 PR。

commit 信息应说明具体修改内容，不建议写成：

```text
fix: 修复 Review 中指出的问题
```

应改为更具体的说明，例如：

```text
docs: 补充分支查看命令说明
docs: 解释 git push 参数含义
fix: 补充未登录用户处理逻辑
```

## PR 合并后的清理

PR 合并后，回到本地 `main` 并同步远程最新代码：

```bash
git switch main
git pull origin main
```

删除已经合并的本地临时分支：

```bash
git branch -d docs/add-collaboration-docs
```

如果 GitHub 页面没有自动删除远程分支，可以手动删除：

```bash
git push origin --delete docs/add-collaboration-docs
```

删除分支不会删除已经合并进 `main` 的代码。它只是清理已经完成的临时工作分支。

## 分支命名规范

分支名应使用英文小写，使用 `/` 分组，使用 `-` 连接单词。

格式：

```text
类型/简短说明
```

常用类型：

| 类型        | 适用场景                   | 示例                          |
| ----------- | -------------------------- | ----------------------------- |
| `feat/`     | 新功能                     | `feat/team-registration`      |
| `fix/`      | 修复问题                   | `fix/login-redirect`          |
| `docs/`     | 文档修改                   | `docs/add-collaboration-docs` |
| `style/`    | 样式或展示调整             | `style/profile-page`          |
| `refactor/` | 重构，不改变功能           | `refactor/match-actions`      |
| `chore/`    | 工具、依赖、配置等维护工作 | `chore/update-dependencies`   |
| `hotfix/`   | 紧急线上修复               | `hotfix/certificate-export`   |

无法准确归类时，应选择最接近的类型，并在 PR 说明中补充背景。

## commit 信息规范

commit 信息应使用中文说明改动内容，类型前缀保留英文。

格式：

```text
类型: 中文说明
```

常用类型：

| 类型       | 含义     | 示例                              |
| ---------- | -------- | --------------------------------- |
| `feat`     | 新功能   | `feat: 新增团体赛结果导出`        |
| `fix`      | 修复 bug | `fix: 修复报名后页面未刷新的问题` |
| `docs`     | 文档     | `docs: 增加 Git 工作流说明`       |
| `style`    | 样式调整 | `style: 调整个人主页移动端间距`   |
| `refactor` | 重构     | `refactor: 简化比赛状态判断逻辑`  |
| `chore`    | 杂项维护 | `chore: 更新项目依赖`             |
| `test`     | 测试     | `test: 增加分组逻辑测试用例`      |

提交信息应具体说明改动内容。不得使用无法说明改动内容的提交信息，例如：

```text
update
fix
改一下
临时提交
不知道
```

如果需要临时保存未完成工作，可以使用 `wip` 前缀：

```text
wip: 调整比赛详情页
```

包含 `wip` 的提交不应作为最终状态合并。合并前应补充完成对应改动，或在 PR 中说明保留原因。

## PR 说明规范

PR 描述应包含以下内容：

* 改动内容。
* 改动原因或背景。
* 已完成的验证方式。
* 是否涉及数据库迁移。
* 是否涉及环境变量。
* 如果有界面变化，应附截图或说明影响页面。

示例：

```md
## 改动

- 新增 CONTRIBUTING.md
- 新增 Git 工作流说明

## 验证

- 文档修改，未运行构建

## 注意事项

- 不涉及数据库迁移
- 不涉及环境变量
```

## 高风险改动

涉及以下内容的 PR 应在说明中明确标注影响范围和验证方式：

* 数据库模型或迁移。
* 认证、权限、登录态、CSRF。
* 比赛报名、退赛、分组、赛果、ELO。
* 管理员后台和批量操作。
* 部署配置、环境变量、构建配置。

涉及以下文件时应特别说明：

* `prisma/schema.prisma`
* `prisma/migrations/`
* `src/lib/prisma.ts`
* 任何会创建、修改、删除比赛或用户数据的 Server Action

生产环境数据库迁移必须由维护者确认后执行，不得直接在生产环境试验命令。

## Review 沟通规范

Review 应聚焦改动本身，包括正确性、可维护性、安全性和用户影响。

提出意见时应尽量具体，例如：

* “这里是否需要处理未登录用户？”
* “这个按钮在手机屏幕上可能会换行，需要验证移动端。”
* “这里改了 schema，PR 说明中需要补充 migration 影响。”

收到 Review 意见后，应通过修改代码、补充说明或解释原因来回应。无法立即处理的问题应在 PR 中记录后续安排。

