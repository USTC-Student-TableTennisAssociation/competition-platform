# 本地 PostgreSQL 开发环境

V2 的数据库结构、事务、并发锁和 migration 均在本地 PostgreSQL 17 上开发及验证。开发阶段不需要修改生产 Neon；仓库脚本不会 source 或改写 `.env`，并在执行 Prisma、开发服务和测试命令时显式覆盖数据库连接地址。Prisma 或 Next.js 仍可按项目原有机制读取 `.env` 中的其他配置，但其中的 Neon 数据库地址不会覆盖脚本传入的本地地址。

## 1. 安全边界

本地环境固定使用：

- PostgreSQL 17，与当前生产主版本一致；
- `127.0.0.1:55432`，不监听外网地址；
- 专用角色 `ustctta_local`；
- 开发数据库 `ustctta_v2`，以及独立集成测试数据库 `ustctta_v2_test`；
- 仓库内被 Git 忽略的 `.local-postgres/` 数据目录；
- UTC 数据库时区；
- 每个本地数据库的 URL 同时充当 Prisma pooled 和 direct URL，本地不需要连接池。

脚本始终覆盖 `DATABASE_URL` 和 `DATABASE_URL_UNPOOLED`，因此即使 `.env` 中保存了 Neon URL，脚本内的 migration、开发服务和测试也只会连接本地数据库。脚本还会读取服务器的 `data_directory`，确认端口确实属于本仓库的专用 cluster 后才执行重建。

本地 cluster 只监听 loopback，并使用无密码的 `trust` 验证，不能将这个配置用于服务器或任何可被其他主机访问的环境。

## 2. 安装 PostgreSQL 17

macOS 使用 Homebrew：

```bash
brew install postgresql@17
```

脚本优先查找 Apple Silicon 和 Intel Homebrew 的 `postgresql@17`。其他系统可以显式指定二进制目录：

```bash
USTCTTA_LOCAL_PG_BIN=/path/to/postgresql-17/bin npm run db:local:start
```

## 3. 第一次启动

```bash
npm install
npm run db:local:migrate
npm run db:local:verify
```

`db:local:migrate` 会按需初始化并启动空 cluster，创建 `ustctta_v2`，随后通过 `prisma migrate deploy` 应用仓库中所有已提交 migration。它不会生成新 migration。

默认 Prisma URL 是：

```text
postgresql://ustctta_local@127.0.0.1:55432/ustctta_v2?schema=public
```

真实 PostgreSQL 集成测试使用独立 URL，不会读写开发数据：

```text
postgresql://ustctta_local@127.0.0.1:55432/ustctta_v2_test?schema=public
```

它只包含本地专用角色且不含生产凭据，可以安全用于本机调试；不要把这个无密码模式复制到部署环境。

## 4. 日常命令

```bash
# 查看 cluster、连接地址和 PostgreSQL 运行时
npm run db:local:status

# 启动或停止；stop 保留全部本地数据
npm run db:local:start
npm run db:local:stop

# 应用新增的已提交 migration
npm run db:local:migrate

# 检查 migration 状态，并比较实际数据库与 schema.prisma
npm run db:local:verify

# 应用 migration 后启动连接本地库的 Next.js
npm run dev:local

# 清空并重建独立测试库，再运行真实 PostgreSQL V2 测试
npm run test:v2:local

# 直接连接专用数据库
./scripts/local-postgres.sh psql
```

如果默认端口被占用，可以为所有相关命令指定同一个端口：

```bash
USTCTTA_LOCAL_PG_PORT=55433 npm run db:local:migrate
```

不要在 cluster 已运行时切换端口；应先用原端口停止，再使用新端口启动。

在 Codex 的受限命令沙箱中，宿主 PostgreSQL 进程和 loopback 连接可能不可见。此时 `db:local:status` 会明确显示 `unknown`，而不会把无权检查误报为 `stopped`；启动、停止、迁移和测试命令会要求本地进程权限。可在普通终端运行相同命令，或允许 Codex 使用本地进程后获得权威状态。这种可见性限制不会主动停止已经运行的 PostgreSQL。

## 5. 运行其他命令

需要让任意命令只连接本地数据库时，使用包装命令：

```bash
./scripts/local-postgres.sh run -- npm run prisma:validate
```

也可以查看需要的 shell 变量，但不必写入 `.env`：

```bash
./scripts/local-postgres.sh env
```

其中 `DATABASE_URL` 和 `DATABASE_URL_UNPOOLED` 指向开发库；`V2_CORE_INTEGRATION_DATABASE_URL` 指向独立测试库，让标记为 PostgreSQL integration 的测试实际执行而不是 skip。

日常运行集成测试应直接使用 `npm run test:v2:local`。每次运行前，该命令都会验证仓库 ownership marker、固定运行目录和端口对应的 PostgreSQL `data_directory`，然后仅对固定名称 `ustctta_v2_test` 执行 `dropdb --force`、重新创建并应用全部 migration。测试进程的三个数据库变量也全部指向这个测试库，因此上次失败或中断留下的数据不会影响下次运行，开发库 `ustctta_v2` 不会被清空或迁移。

## 6. 重建空库

需要从零复现完整 migration 链时：

```bash
npm run db:local:rebuild
```

交互提示会要求准确输入 `ustctta_v2`。非交互环境必须显式确认：

```bash
npm run db:local:rebuild -- --yes
```

重建只会删除 `127.0.0.1:55432` 上、且已确认属于本仓库专用 cluster 的 `ustctta_v2` 数据库；不会删除 cluster、其他数据库、`.env` 或任何 Neon 数据。

## 7. 编写 migration

已提交 migration 使用 `db:local:migrate`。确实需要生成一个新的开发 migration 时，先启动本地库，再用包装命令执行 Prisma：

```bash
npm run db:local:start
./scripts/local-postgres.sh run -- npx prisma migrate dev --name descriptive_name
npm run db:local:verify
```

审查新生成的 `migration.sql` 后再提交。开发阶段不要对生产 Neon 执行 `prisma migrate dev`；最终发布时，在最新生产数据的 Neon 演练分支验证完整 migration 链，确认后才通过部署流程运行 `prisma migrate deploy`。
