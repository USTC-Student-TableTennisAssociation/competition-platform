# 服务器数据库、切换与备份

## 当前状态

2026-10-17 已在现有 Ubuntu 22.04 服务器部署 PostgreSQL 17 的独立 `17/kedapp` 集群。

- 数据库 `kedapp_standby`，仅监听 `127.0.0.1:5433`，没有公网数据库端口。
- 编码 UTF8、默认排序规则 `C.UTF-8`，使用与源 Neon 相同的 PostgreSQL builtin locale provider，避免依赖不同系统 libc 的字符分类行为。
- systemd 随服务器启动；配置位于 `/etc/postgresql/17/kedapp/`，数据位于 `/var/lib/postgresql/17/kedapp/`。
- 2026-10-17 准备阶段保持正式网站连接原 Neon production。2026-10-22 正式切换操作的备份、核验和结果记录放在 `shared/database-cutovers/`；当前运行目标以 `shared/.env`、实际 PM2 进程环境及数据库会话三者核对为准。
- 切换前这是按需刷新的静态副本，不是自动复制或自动故障切换。恢复时间不等于源数据时间；以导出 manifest 中 `source.capturedAt` 为准。切换后本机库成为唯一生产写入目标，原 Neon 保留只读，不再自动同步。
- 网站与数据库同机时，共享 CPU、内存和故障范围；备用库部署不等于生产容量保证。

私有状态目录：`/var/www/kedapp/shared/database-standby/`（0700）。其中的 `connections.json`、`local.env`、`preview.url` 和 `neon-original.env` 含凭据，必须保持 0600，不能提交或输出到日志。`local.env` 只包含未来切换的两条数据库变量，不是完整网站环境文件。

`kedapp_migrator` 拥有目标库且仅用于恢复/迁移；`kedapp_app` 具备业务表读写权限；`kedapp_preview` 仅能读取。三个角色均非超级用户，不能建库、建角色或复制。数据库默认事务只读是额外防误写设置，不是权限安全边界；验证依赖 preview 的实际权限。

## 导出与刷新备用库

工具位于仓库 `deploy/database/`，服务器私有副本位于 `/var/www/kedapp/operations/database/`。以下命令只用于备用库，不切换网站：

```bash
# 在服务器，以 ubuntu 执行。替换时间戳，目标目录必须尚不存在。
node /var/www/kedapp/operations/database/export-neon.mjs \
  --output-dir /var/www/kedapp/shared/database-standby/backups/neon-YYYYMMDDTHHMMSSZ

node /var/www/kedapp/operations/database/restore-standby.mjs \
  /var/www/kedapp/shared/database-standby/backups/neon-YYYYMMDDTHHMMSSZ/database.dump \
  --replace-standby
```

首次空库恢复不加 `--replace-standby`。替换已有备用库时，工具先保存旧备用库备份，再重建目标库。工具固定本机数据库身份，并检查正式环境和运行进程仍使用 Neon；生产已切走时会拒绝刷新。`operation.lock` 排除并发恢复，未来切换也必须取得同一把锁。异常中断遗留锁时，先确认原进程已退出、目标库状态可解释，再人工移除锁。

导出通过原生产直接连接执行只读 REPEATABLE READ 事务，表计数和 pg_dump 共用导出快照；持有事务最终回滚。输出包括 custom 归档、SHA256、全部 public 表计数、匿名业务汇总和迁移列表。序列状态不受 PostgreSQL MVCC 快照约束；最终切换仍必须先停止全部写入者。

归档列目录、完整解码检查不能替代实际恢复。恢复后使用 `verify-standby.mjs --help` 指定 preview.url、当前 release、源计数基线和全新私有诊断目录。它检查全表计数、迁移、索引/约束、账本汇总、6 连接有界读取与当前 Prisma 查询。基线表计数格式为 `{ "tableCounts": { "public.User": 504 } }`，应由本次导出 manifest 转换，不能沿用旧基线。

`web-smoke.mjs` 必须使用独立 release 副本且删除该副本内 `.env*`，在本机 3001 端口启动，使用独立临时 AUTH_SECRET 和只读账号，检查后自动停止。不能直接用正式 release 目录加载生产密钥。当前首页 GET 会更新过期约球，故只读测试首页会失败；该失败必须单列，不能声称全站验收通过。商店 SSR 检查不等于兑换写入验收。

## 实际切换的维护窗口

执行以下步骤前，需收到网站维护者对正式切换的授权。不要只替换 URL 后立即开放流量。把完整环境文件及原数据库只读设置保存在私有操作目录，文件权限保持 0600。

1. 当前为分阶段人工维护流程。先部署并验证本节后的发布适配，再暂停 GitHub 自动部署并确认没有在途发布，暂停其他运维/刷新操作；此时不要预占 `operation.lock`。在 Nginx 站点的 server 层返回维护 503，停止正式 PM2 应用并排空请求。确认其他脚本和管理员也已停写；记录源库原只读设置，将 Neon 数据库默认事务设为只读并结束已识别的网站连接，用全新连接核验。数据库默认只读仍可被高权限客户端覆盖，因此不能替代写入者停用。
2. 从仍为权威数据源的 Neon 取得最终完整备份，再恢复目标库；restore 自行取得并释放 `operation.lock`。成功返回后，当前操作者立即单独取得该锁，核对 `latest-restore.json` 的路径和 SHA256 确为本次最终备份，核验并持续持锁至切换验收或回退完成。持锁期间不得再次调用 restore；需要重做恢复时，在维护及停写持续生效的前提下，先释放锁、恢复、重新取得锁并核验。若 Neon 已不可读，只能使用现有快照；快照之后的变更无法保证保留，必须明确数据缺口，不能无损切换。
3. 使用 `cutover-audit.mjs` 比较最终导出前的源库、导出后的源库和恢复后的目标库。它以只读快照计算每张 public 表的完整行内容 SHA256 与计数，包含迁移记录；比较序列状态、列定义、enum、索引、约束和序列参数。固定 UTC、浮点格式和 C 排序。配合 `verify-standby.mjs` 检查角色、当前 Prisma 读取和有界并发读取。源在备份后发生变化时不得继续切换。
4. 备份当时完整网站环境文件，保留原 Neon。仅用 `local.env` 中的两条数据库配置更新完整 `.env`，保留 AUTH_SECRET、其他服务配置和文件权限。确认目标数据库、schema、迁移与应用版本一致，再取消目标库的默认只读设置。
5. 用 `activate-release.sh` 重建单个 `kedapp` 进程。它通过 `start-release.mjs` 从目标 release 的 `.env` 显式注入两条数据库变量，兼容旧 release 的回滚；新版 ecosystem 也读取同一文件。Next 优先读取继承环境，单改文件或仅 reload 不够。不能打印完整 PM2 环境或凭据。
6. 入口仍保持维护，私下确认运行时真实数据库目标，验证健康检查、真实登录、赛事读取以及受控写入。`/api/health` 仅 SELECT 1 和检查代码版本，不足以单独证明切对数据库。验收通过后开放入口。

验收用临时合成账号进行登录与受控写入，完成后删除，并在开放流量前再次核对业务数据基线。首页 GET 会更新过期约球，应在允许业务写入后再访问。恢复入口和自动部署后，重新运行该版本发布以验证本机数据库的后续 migration 路径。

### 发布流程的数据库来源

`deploy/remote-database.mjs` 在 GitHub runner 使用仓库锁定的 Prisma CLI，凭据仅从服务器 `shared/.env` 读取；旧的 GitHub `PROD_DATABASE_URL_UNPOOLED` secret 不再参与发布。Neon 目标直接连接；服务器本地目标通过仅监听 runner `127.0.0.1` 的 SSH 隧道连接到服务器 `127.0.0.1:5433`。校验运行时使用 `kedapp_app`、迁移使用 `kedapp_migrator`，并指向同一数据库。

SSH 会话在迁移、首次 preflight、激活、健康检查及必要回滚期间持有 `operation.lock`。配置变化、未知目标、隧道失败会停止发布。异常断线留下的锁需要先核实原操作已退出再清理；不要直接删除锁重试。

### 全表核验示例

```bash
node /var/www/kedapp/operations/database/cutover-audit.mjs \
  --source-env /var/www/kedapp/shared/database-cutovers/RUN/production.env.before \
  --target-connection-file /var/www/kedapp/shared/database-standby/preview.url \
  --baseline /var/www/kedapp/shared/database-cutovers/RUN/audit-before/source.json \
  --output-dir /var/www/kedapp/shared/database-cutovers/RUN/audit-after
```

该命令只读；输出目录必须尚不存在。仅输出表数、序列数和比较结果，内容摘要保存在私有目录，不输出业务行或连接密码。

## 回退边界与备份

本机库尚未接收新业务写入时，可以在维护状态恢复切换前配置并重新创建应用进程，核验后回到原 Neon。接收新写入后，必须先停写、备份并将新增数据完整迁回或完成对账；直接切回旧 Neon 会丢掉本机新成绩和兑换。

现有应用 release 回滚仅切代码，所有 release 共用同一个 `.env`；它不会回滚数据库配置或撤销迁移。

切换后的 `kedapp-database-backup.timer` 每天上海时间 04:30 执行 `backup-local.mjs`，备份到 `shared/database-backups/`。使用 custom 格式，完整解码和 SHA256 校验成功后才生成成功 manifest；保留至少七天且始终保留最新成功备份。它与切换、恢复、发布共用操作锁，冲突时安全失败，不自动删除残留锁。用 `systemctl status kedapp-database-backup.timer` 和 `journalctl -u kedapp-database-backup.service` 检查状态。

备份目录 0700、文件 0600，日志不输出凭据或业务记录。每天的服务器备份不是异机备份；迁移时点另保存一份到维护者本机。持续异机备份和定期恢复演练需要单独安排。旧 Neon 仅保留切换时点，不包含切换后的新成绩或兑换。
