# 会话管理（Session Admin）· DeepSeek Harness 插件

给 Harness Web UI 增加**真正删除会话**的能力：不是归档，而是把会话从列表里永久清掉，
并连带删除它在磁盘上占用的文件。顺带可以清理该会话在工作区里写过的文件。

一句话：Harness 本身没有「删除会话」这个 API（`dsh-workspace` 和
`dsh-session-persistence-jsonl` 都把删除列为未提供的能力），这个插件用官方支持的数据面
（会话日志目录、投影缓存存储域、`Workspace.detachSession()`、`api-session/removed`）把它补上，
UI 和 agent 工具两个入口都能用。

纯 JS、零依赖、不需要任何密钥；路径全部基于 `DSH_HOME` 推导，换机器不用改代码。

---

## 安装

```powershell
dsh plugin --profile desktop add github:ttkxyglj/dsh-session-admin
```

这条命令会：从 GitHub 拉取仓库 → 把包 `@local/dsh-session-admin` 装进该 profile 的
`node_modules` → 自动把包名写进 profile 的 bundles，并把插件条目插进 profile 的
`cordis.patch.yml`（`id: session-admin`）。

装完**重启 DSH**；已经在运行的话，刷新页面（F5）并确认插件管理里该插件是开启状态。
装完看到的包名就是 `@local/dsh-session-admin`（保持这个包名，不要改——DSH 用它做 bundle 名和目录名）。

不需要任何配置：插件从 `DSH_HOME` 环境变量（DSH 自己会导出，Windows 通常是
`C:\Users\<你>\.dsh`）定位会话数据；没有这个变量时退回 `~/.dsh`。

### 更新

再跑一次同一条命令：

```powershell
dsh plugin --profile desktop add github:ttkxyglj/dsh-session-admin
```

更新后**必须刷新页面**：Host 代码会被重载，但浏览器里的 Client 模块不会自动换新版。

### 卸载

```powershell
dsh plugin --profile desktop remove @local/dsh-session-admin
```

也可以只在插件管理页里把它关掉。卸载不影响已删除的会话（删除不可恢复，没有回收站）。

---

## 怎么用

### 1. 在侧边栏删除一个会话

1. 把鼠标移到左侧任意会话行，点行尾的 **`...`** 菜单。
2. 选择 **删除会话…**（在「复制会话 ID」之后，按 `order 460` 排序）。
3. 弹窗会先做一次**预演**，列出将删除的内容：
   - 会话日志目录与大小、投影缓存大小；
   - 一并删除的**子会话**（子代理会话）；
   - 一并取消的**定时提醒**；
   - 该会话在工作区里写过的文件（`write` / `edit` 等工具记录的路径，且必须在该会话的
     工作目录内）。
4. 勾选需要的选项（「同时删除这些工作区文件」默认**不勾**），点 **永久删除**。

### 2. 让助手代删（agent 工具）

任意会话里都可以让模型调用 `session_admin` 工具：

```
列出可以删除的会话            ->  action: list
看看删掉这个会话会损失什么      ->  action: preview, sessionId: "..."
删掉它                        ->  action: delete, sessionId: "...", confirm: true
连它写过的文件一起删            ->  action: delete, sessionId: "...", confirm: true, deleteWorkspaceFiles: true
```

删除是不可撤销的，工具要求显式 `confirm: true`；和 UI 一样受下面的安全规则约束。

---

## 删除到底删了什么

逐项（每个会话、以及它名下的子会话）：

| 内容 | 位置 / 方式 |
|---|---|
| 会话日志目录（含所有历史格式代） | `<DSH_HOME>/sessions/<工程目录>/<会话 id>/`（递归删除） |
| 投影缓存行 | `session_projcache` 存储域的表行（`ctx.storageDomain` 删除，随后确保磁盘文件也消失） |
| 工作区记账 | `Workspace.detachSession()`；并从归档集 `unarchiveSession()`、置顶集 `unpinSession()` 移除 |
| 定时提醒 | `ctx.schedule.list/delete`（会话被删后提醒无处唤醒） |
| 子会话 | 沿持久化的 `parentSession` 关系整棵子树一起删除 |
| 工作区文件 | 仅当勾选时：解析该会话 `tool/call` 事件里 `write` / `edit` / `str_replace_editor` 等
写入的路径，限定在会话工作目录内、且仍存在 |
| UI 列表 | 逐个会话 `emit('api-session/removed')`，客户端立刻丢掉该行；`detachSession` 的
`domain/changed` 让 `workspace/follow` 推送新的分组状态 |

**不会删**的东西（故意保留）：

- 附件与上传对象：`<DSH_HOME>/attachments/v1/objects/...` 是**全局内容寻址、去重共享**的，
  会话之间可能共用同一份字节；Harness 本身也没有按会话归属的索引，删了会破坏别的会话。
  因此删除会话不会回收附件（这是官方同样保留的行为）。
- 工作区目录本身、以及没被这个会话写过的文件。
- 其他会话的任何数据。

---

## 安全规则

| 情况 | 行为 |
|---|---|
| 会话正在跑（`agent.status !== 'idle'`，例如正在出字、跑工具、子代理在跑） | **拒绝**，等它跑完再删 |
| 会话仍是「当前正在问你的那个会话」 | **拒绝**，会话不能删除自己（切换到别的会话后即可删） |
| 会话仍被运行中的应用加载（今天打开过、可能开在另一个窗口），但已空闲 | 允许；弹窗会警告并带一个确认勾选，勾选后才点得动「永久删除」。删完请关掉那个窗口或刷新页面 |
| 会话已冷（本进程从未打开过） | 直接可删 |
| 会话不存在 / 已删过 | 幂等：报「不存在」，不会误删别的东西 |

> 服务端不再硬性要求 `allowLive`（兼容旧页面缓存），勾选确认由 UI 把关；agent 工具仍然强制要求
> 对「已加载但空闲」的会话显式传 `allowLive: true`。

删除顺序：先停掉/移除该会话的提醒 → 删派生投影缓存 → 删日志目录 → 解绑工作区记账 →
通知客户端。任一步失败会记在返回结果的 `warnings` 里，不会假装成功。

## 审计日志（排查删除失败）

每次 `list` / `preview` / `delete`（UI 和工具都算）都会追加一行到：

```
<DSH_HOME>/session-admin/audit.jsonl      # 例如 %USERPROFILE%\.dsh\session-admin\audit.jsonl
```

每行是 `{ time, method, sessionId, ok, code?, message?, ms }`。排查「点了删除但失败」时：

- 日志里**没有**对应记录 → 请求根本没到 Host：页面里的客户端代码有问题或 Remote 没挂上，
  刷新页面（F5）后重试；仍不行就看下面的「浏览器诊断」。
- 有记录但 `ok: false` → 原因就在 `code` / `message`（例如 `session-admin/blocked` 表示会话在运行）。
- 有记录且 `ok: true` → Host 已删除；若界面没变，是客户端列表刷新问题，刷新页面即可。

日志超过 512 KB 会轮转为 `audit.jsonl.1`。

## 浏览器诊断（客户端侧失败）

`client.js` 会把启动、Remote 挂载和每个调用的结果写进页面 `localStorage` 的
`session-admin:diagnostics.v1`。桌面版存在 leveldb 里，可以直接读：

```
%APPDATA%\@deepseek-ai\dsh-desktop\Local Storage\leveldb\*.log
```

典型事件：`boot`（客户端已加载）、`namespace-ready`（`remote.sessionAdmin` 注入成功）、
`mount-ok`、`call-ok`、`call-failed`（带 message/stack）。

> **更新插件代码后必须刷新页面**：Host 代码会被 HMR 重载，但浏览器里的 Client 模块不会自动换新版。

## 修复记录：`cannot get property "remote.sessionAdmin" without inject`

早期版本在客户端直接用 `ctx.remote.sessionAdmin` 取命名空间。Cordis 的 traced 子服务必须
先用 `inject` 声明才能读，否则抛这个错——于是所有调用都在页面本地失败，Host 侧一条审计都
没有。现在改为 `ctx.inject(['remote.sessionAdmin'], ready => …)`，并用
`ctx.get('remote.sessionAdmin')` 做快路径兜底（`$mount()` 只保证排入队列，命名空间是异步挂载的）。

---

## 文件与结构

```
dsh-session-admin/
├── package.json         bundle 声明 + dsh.client（web, immediately）
├── cordis.patch.yml     insert id: session-admin
├── index.js             Host 半边：服务、Typert Remote 描述符、session_admin 工具、删除引擎
├── client.js            Client 半边：会话行菜单项 + shell.overlay 确认弹窗
├── locale/en.json       插件面板里的标题/描述
├── locale/zh.json
├── icon.svg             垃圾桶图标
├── LICENSE              MIT
└── README.md            本文
```

要点（写给维护者）：

- **Host 服务用 `ctx.provide()` 注册，没有 import Harness 包。** 本地 `link:` 方式安装的 bundle
  解析不到 `@deepseek-ai/*`（第一次安装就是因为 `dsh-typert-protocol` 解析失败而没激活），
  所以 `sessionAdmin` 是一个普通 provided service。
- **必须自带 `typertRemote` 绑定。** Gateway 对每个调用都会 `validateBinding()`，要求服务上
  有 `{ service, serviceKey, namespace }` 的冻结对象，否则报 `gateway/binding-invalid`。
  这里手工补上，等价于 `TypertRemoteService` 构造器里做的事。
- Remote 描述符手写在 `index.js`，Client 侧 `client.js` 里重复一份（两边都用普通 JS，
  不能共享模块）。
- Client 侧通过 `ctx.remote.$mount(contribution)` 挂载命名空间；**取命名空间必须走
  `ctx.inject(['remote.sessionAdmin'], …)` 或 `ctx.get(...)`**，直接读
  `ctx.remote.sessionAdmin` 会抛 `cannot get property ... without inject`。
  返回 `{ ok, value } | { ok:false, error }`。
- 结果统一 `JSON.parse(JSON.stringify(...))` 一次，去掉 `undefined` 字段——工具结果和
  Remote 结果都必须是 lossless JSON，否则会被判为非法输出。
- 会话 id 是路径安全段，日志目录名即 id；但工程目录名是 cwd 的**有损**编码，所以不反推，
  而是在 `sessions/*` 下按 id 精确查找（与后端 `findLog` 同样的策略）。
- 投影缓存必须在**存储域**里删：只删磁盘文件时，内存表可能把它写回来。
- 删除 live 会话日志有已知风险：该 Agent 仍持有写路径，之后若有 append 会失败/重建坏日志。
  所以 running 一律拒绝；live 但 idle 由 UI 二次确认（工具侧要求 `allowLive`），服务端放行以兼容旧页面。

## 验证记录

已在此机器上实际验证：

- 安装：`install_bundle` → `application: applied`；Host 插件行、`session_admin` 工具、
  Client 两个插槽占用（`session-admin.delete` / `session-admin.dialog`）均 active。
- Host 引擎单测（临时目录 + 假 ctx）：父/子会话闭包、投影缓存、工作区 detach、提醒删除、
  工作区文件提取、running / live-idle / not-found 三种拒绝、审计日志全部通过。
- Typert Gateway 真实派发自检：以 owner peer 调 `sessionAdmin/list`，返回 `ok: true`。
- 真实删除（工具）：空白冷会话 `session-79dcd0f2…`、`session-2801bbec…`，日志/缓存均消失、工作区记账移除。
- 真实删除（UI，根因修复后）：用户删除 `session-85e031a8…`（487 KB）和
  `session-1b305065…`（826 KB）成功——审计日志 `preview`/`delete` 均 `ok: true`；
  浏览器诊断记录 `boot → namespace-ready → mount-ok`；磁盘上日志目录与投影缓存消失；
  `sessions` 与缓存文件数量一致（23/23），工作区记账同步减少。

未覆盖：所有窗口都已关闭时删除「live」会话的极端路径（预期会话报错、不影响其他数据）。
Client 样式与宿主完全一致仍以肉眼为准。

## 配置与路径

不需要配置文件、不需要密钥、不需要改代码。所有路径都从 `DSH_HOME` 推导
（`index.js` 的 `harnessHome()`：`$DSH_HOME` → 否则 `~/.dsh`）：

| 用途 | 路径 |
|---|---|
| 会话日志（删除目标） | `<DSH_HOME>/sessions/<工程目录>/<会话 id>/` |
| 投影缓存（删除目标） | `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` |
| 本插件审计日志 | `<DSH_HOME>/session-admin/audit.jsonl`（512 KB 轮转 `audit.jsonl.1`） |

要让插件指向另一个数据目录，在启动 DSH 前设置 `DSH_HOME=<路径>` 即可（一般不需要）。

## 卸载

```powershell
dsh plugin --profile desktop remove @local/dsh-session-admin
```

或在插件管理页里关掉/移除 **Session Admin**。卸载不影响已删除的会话——删除不可恢复，没有回收站。

## 许可

MIT —— 见 [LICENSE](LICENSE)。Copyright (c) 2026 Erji Gao
