# 账号、登录与权限配置

状态：proposed（2026-10-27，四条决定已由人拍板，实现待 t37/t38/t39）
相关模块：`apps/chain`（model / store / http / intake / roles）、`apps/web`

## 为什么要推倒上一版

上几轮为了让「谁能按节点」成立，我发明了四种口令：服务启动参数 `-admin-token`、项目访问口令 `pk_`、角色口令 `rl_`、建项目时发的 `owner` 口令。人一句话点破：**「我这个平台会有登录和登出的呀，你得配置权限呀」**。

口令是这个决策的替代品，不是需求。四类口令并存等于两套授权系统：说不清谁有权，也没法登出、没法吊销、没法看谁在用。

## 四条决定（人已选）

1. **账号内建**：用户名 + 密码，第一个注册的人是管理员。（放弃：只接 OIDC——单机自部署最省事的入口不能依赖外部 IdP。留接缝，不实现。）
2. **权限是项目级角色**：角色仍是四种权力（review / dev / test / release）的集合，但**属于项目、不再有口令**；用户被授予「某项目的某角色」，一个用户在不同项目可以有不同角色。取并集。
3. **旧口令全删**：`-admin-token`、`pk_`、`rl_`、`ownerToken` 全部作废；外部系统接入改用「用户自己的 API 密钥」。
4. **登录态是服务端会话 + HttpOnly Cookie**：登出立刻失效，前端脚本碰不到凭据。

## 实体

| 实体 | 关键字段 | 说明 |
| --- | --- | --- |
| User | id、username（唯一）、passwordHash、admin、createdAt | 密码哈希用 argon2id（`golang.org/x/crypto/argon2`），不存明文、不回传 |
| Session | tokenHash（主键）、userId、createdAt、expiresAt | Cookie 里是原文，库里存 sha256；登出删行即失效 |
| APIKey | id、userId、name、keyHash、createdAt、lastUsedAt | 外部接入用；形如 `ak_…`，只在创建那一次返回原文 |
| Role | id、projectKey、name、powers[] | 不再有 token 字段 |
| Assignment | projectKey + roleId + userId | 授予关系；同一项目可给多个角色，权力并集 |

## 接口

| 方法 | 路径 | 谁能用 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/signup` | 所有人，但只在用户表为空时 | 第一个用户成为管理员；之后一律 409 |
| POST | `/api/login` | 所有人 | `{username,password}` → 下发会话 Cookie |
| POST | `/api/logout` | 已登录 | 删会话并清 Cookie |
| GET | `/api/me` | 已登录 | `{user, memberships:[{project, role, powers}]}`；未登录 401 |
| PUT | `/api/me/password` | 已登录 | 改自己的密码（要求旧密码） |
| GET / POST | `/api/users` | 管理员 | 列用户 / 建用户（建号即给初始密码，不回传哈希） |
| POST | `/api/users/{id}/password` | 管理员 | 重置别人的密码 |
| GET / POST | `/api/p/{project}/roles` | 管理员 | 列 / 建角色（name + powers） |
| DELETE | `/api/p/{project}/roles/{id}` | 管理员 | 删角色（连带删授予） |
| GET / POST | `/api/p/{project}/roles/{id}/members` | 管理员 | 列成员 / 加成员 `{username}` |
| DELETE | `/api/p/{project}/roles/{id}/members/{username}` | 管理员 | 移出成员 |
| GET / POST | `/api/keys` | 已登录 | 列自己的密钥（不回显原文）/ 新建（原文只出现一次） |
| DELETE | `/api/keys/{id}` | 已登录 | 吊销自己的密钥 |
| POST | `/api/intake/requirements` | 该项目成员（会话或 API 密钥） | 外部提需求，`{project, context, images?, reporter?}` |
| GET | `/api/intake/requirements/{id}` | 该项目成员 | 拉模式取结论 |

节点动作（`run` / `accept` / `reject`）的判据：**当前身份在该项目里有这一站要求的权力**。管理员等同全权。评论仍不受限（未登录记访客）。

## 身份从哪来（唯一解析点）

`whoIs(c)` 一处解析，返回 `{user, via: "session"|"key"}`：

1. `Authorization: Bearer ak_…` → 查 APIKey（比对 sha256），命中即该用户；
2. 否则读 Cookie `chain_session` → 查 Session，过期即删并当未登录；
3. 都没有 → 匿名（`user == nil`）。

权限判定 `powersFor(user, project)`：管理员 → 四权齐全；否则该用户在该项目的所有角色权力并集；无角色 → 空集。

## 要删掉的东西

- `-admin-token` 启动参数与 `adminGate`；`Project.IntakeToken` 与 `pk_` 生成；`Role.Token` 与 `rl_` / `issueOwnerRole` / `rotateRole`；`Project.OwnerToken`。
- 前端 `roles.ts` 的口令池（t34 那版已 stash，留作 UI 参考）。
- 旧库迁移：列可以留着不写（SQLite 删列麻烦），但代码不再读它们；`migrate` 只加新表与新列。

## 边界（明确不做）

- 不做邮箱验证、忘记密码自助重置（管理员重置代替）。
- 不做多租户隔离、不做 OIDC、不做审计日志（谁在什么时候用哪个密钥，只记 `lastUsedAt`）。
- 不做密码强度策略之外的账号安全（限流、锁定先不做）。
- 会话固定过期时间（例如 7 天），不做滑动续期。

## 验收口径

1. 空库启动 → 注册第一个用户 → 自动是管理员 → 建项目 → 建角色「审核员(review)」→ 建第二个用户 → 授予该角色 → 第二个用户登录后能对 assess 站 run/accept，对 release 站 403。
2. 未登录访问任何 `/api/**`（除 signup/login）→ 401。
3. 登出后原会话 Cookie 立刻失效（同一 Cookie 再用 401）。
4. 非管理员访问 `/api/users` 与角色/授予接口 → 403。
5. API 密钥：创建一次拿到 `ak_…`，用它调接入层提需求成功；吊销后再用 401；列表接口不回显原文。
6. 四个旧口令一个都不接受（带上也不该改变判定），相关代码删除。