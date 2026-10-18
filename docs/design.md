# dsh-self-restart 设计文档

| 项目 | 内容 |
| --- | --- |
| 插件标识 | `@local/dsh-self-restart` |
| 版本 | 0.1.0 |
| 文档性质 | 设计说明（实现与维护依据） |
| 适用范围 | DeepSeek Harness Web profile（`dsh web`） |
| 入口 | 宿主半 `index.js`、前端半 `client.js`、替换链路 `restart.js` |

---

## 1. 概述

本插件为会话智能体提供一项能力：**主动重启承载它的宿主进程，并在重启完成后于原会话内收到一条消息**。

该能力由两项既有机制合并而成：

1. **进程自重启**。参考插件市场（`dshmarket`）的实现：由当前进程生成一份分离式子进程（下称 helper），helper 在父进程退出、监听端口释放之后，以完全相同的命令行拉起替换进程。
2. **会话续跑**。参考 `dsh-auto-continue` 一类前端插件的实现：在服务端恢复之后，由浏览器端向同一会话发送一条消息。

合并后形成闭环：智能体调用工具 → 宿主写入重启标记 → 进程被替换 → 浏览器重新连接 → 原会话收到「已重启」并产生一轮回复。

## 2. 目标与非目标

### 2.1 目标

| 编号 | 目标 | 判定方式 |
| --- | --- | --- |
| G1 | 智能体可通过一次工具调用触发宿主重启 | 会话记录中出现 `restart_self` 调用及其返回值 |
| G2 | 替换进程以同一命令行、同一端口启动 | 重启日志含 `replacement started (pid N)`，`N` 与旧进程不同；浏览器自动恢复连接 |
| G3 | 重启完成后原会话出现一条「已重启」用户消息 | 该消息 `source.kind` 为 `user`，并触发一轮模型回复 |
| G4 | 页面刷新不产生重复消息 | 刷新后会话记录中该消息仍为一条 |

### 2.2 非目标

| 编号 | 项目 | 说明 |
| --- | --- | --- |
| N1 | 恢复页面 | 本插件不提供引导失败后的交互式恢复面，失败信息仅落日志 |
| N2 | 图形界面 | 不注册任何界面插槽，前端半无可见元素 |
| N3 | 发布分发 | 不发布至 npm，仅作为本地链接插件装配 |
| N4 | 子代理会话投递 | 在子代理会话内调用时，标记按有效期自然失效（见 §8 B5） |
| N5 | 变更既有语义 | 不改变宿主的会话恢复、预设装配与模型选择逻辑 |

## 3. 术语

| 术语 | 定义 |
| --- | --- |
| 宿主进程 | 运行 `dsh web` 的 Node.js 主进程 |
| 会话智能体 | 由 `ctx.agents` 发布、绑定单一会话的 Agent 实例 |
| 重启标记 | 落盘待投递记录，含会话标识、消息文本与调度时刻 |
| 续跑投递 | 重启完成后将标记内容作为用户消息送入原会话的动作 |
| 宿主半 / 前端半 | 插件的 Node 侧入口 / 浏览器侧入口 |
| 分离式 helper | 以 `detached` 启动、可存活于父进程退出之后的中间进程 |
| 冷会话 | 已持久化、当前进程中尚无活动 Agent 的会话 |

## 4. 设计依据

设计判断所依据的事实，均可在下表所列位置复核。

| 编号 | 事实 | 依据 |
| --- | --- | --- |
| F1 | 宿主启动命令行为 `node <npm 根>/@deepseek-ai/dsh/lib/bin.js web --no-open` | 进程表 `Win32_Process.CommandLine` |
| F2 | `process.argv[1]` 命中 `/[\\/](?:bin\.(?:js\|ts)\|dsh)$/`，据此可重建等价命令行 | `dshmarket/src/dsh-cli.ts` 之 `dshArgv()` |
| F3 | 监听端口可由 `ctx.webServer.port` 读取 | `packages/host/webserver/src/index.ts` |
| F4 | 工具注册接口为 `ctx.tools.register(ToolDefinition)`；`ToolDefinition` 为普通对象，`parameters` 接受 JSON Schema 字面量 | `packages/core/tools/src/index.ts`、`dsh-llm` 之 `ToolSchema` |
| F5 | `defineTool` 仅承担类型收窄与参数校验；直接注册裸对象合法，但参数不再自动校验 | `packages/core/tools/src/schema.ts` |
| F6 | 工具执行上下文 `exec.agent.session.id` 即调用方会话标识 | `packages/goal/tool-goal/src/authority.ts` |
| F7 | 等待智能体静默用 `agent.whenIdle()`；持久化刷盘用 `ctx.sessions.flush(session)` | `packages/core/agent/lib/types/runtime-types.d.ts`、`packages/core/session/lib/types/index.d.ts` |
| F8 | 冷会话仅在收到请求时由 `createApiRemoteAgentResolver` 按会话记录的预设装配后 `resume` | `packages/api/remotes/src/agent-lookup.ts`、`packages/host/apiproxy/src/api-proxy.ts` |
| F9 | 前端插件经 `window.__ModuleLoader__.load({id, factory})` 注册，工厂返回 `{inject, apply}` | `@local/dsh-anki/client.js`、`dsh-client-modules` 文档 |
| F10 | 前端会话能力经 `ctx.sessions` 暴露：`list` 快照含 `phase` 与 `byId`；`binding(id).session.prompt(content, 'queue')` | `packages/client/runtime/src/client/sessions/` |
| F11 | 同源 `fetch` 携带会话 Cookie 可用；路径基址应取 `new URL(rel, document.baseURI).pathname` 以兼容反向代理前缀 | `dshmarket/src/client/market-data.ts` |
| F12 | 链接型插件的真实路径位于 profile 之外，无法解析 `@deepseek-ai/*` | `~/.dsh/profiles/node_modules` 的实际布局 |

由 F8 与 F12 得出两条硬性约束：

- **C1**：续跑投递必须由浏览器端发起。宿主端自行 `resume` 冷会话会使智能体绑定到全局层，丢失会话预设提供的工具与提示段。
- **C2**：实现仅使用 Node.js 内置模块与 `ctx` 服务，不引入宿主运行时依赖。

## 5. 总体架构

### 5.1 组件划分

```
宿主半 index.js
 ├ 配置规范化        normalizeConfig
 ├ 标记存储          readEntries / writeEntries（原子替换、超期剔除、损坏隔离）
 ├ 工具              restart_self
 ├ 重启调度          arm：whenIdle → sessions.flush → scheduleRestart
 └ HTTP 接口         GET /api/pending、POST /api/done

宿主半 restart.js
 ├ launchArgv()          由 argv 重建启动命令行（F1、F2）
 ├ respawnInvocation()   Windows 隐藏窗口包装
 ├ restartLogPaths()     诊断日志路径
 ├ helperSource()        分离式 helper 源码
 └ scheduleRestart()     启动 helper 并终止自身

前端半 client.js
 └ 轮询 /api/pending → 过滤 → prompt(message) → POST /api/done
```

### 5.2 端到端时序

```
智能体 ──restart_self──▶ 宿主：同步写入重启标记 → 返回 {ok, pid, message, sessionId, logPath}
                        └─ 脱离任务：whenIdle（上限 idleTimeoutMs）
                                     → sessions.flush
                                     → 等待 readyDelayMs
                                     → 启动 helper
                                                 helper：等待端口释放（上限 30s）
                                                        → 拉起替换进程
                                                        → 记录日志 → 退出
                                 宿主：500ms 后 SIGTERM 终止自身

浏览器（前端半）：每 1500ms 轮询 /api/pending（跨重启存活；页面刷新后重新挂载）
   └─ 标记会话已在列表中 → binding(id).session.prompt([{text}], 'queue')
        └─ 成功 → POST /api/done {id}

宿主：冷会话按会话记录的预设 resume → 产生一轮回复
```

### 5.3 关键设计取舍

| 取舍 | 决定 | 理由 |
| --- | --- | --- |
| 投递发起方 | 浏览器端 | 见 §4 C1 |
| 工具返回时机 | 立即返回，不等待重启完成 | 重启会终止当前进程，延迟返回会使结果无处落盘 |
| 进程终止时机 | 当前轮静默并刷盘之后 | 保证会话记录中工具调用及其结果完整 |
| helper 形态 | `node -e` 内联源码 | helper 不得依赖本包解析；重启场景中最常见的失败即包树不可解析 |
| 恢复面 | 不实现 | 见 §2 N1；由用户在必要时重新执行 `dsh web` |
| 重启入口 | 仅工具，不设 HTTP 触发 | 避免任一同源页面可获得终止宿主的能力 |

## 6. 详细设计

### 6.1 配置

`apply(ctx, config)` 首先调用 `normalizeConfig(config)`；非法取值抛出 `TypeError`，使配置错误在挂载点可见。

| 键 | 类型 | 默认值 | 语义 |
| --- | --- | --- | --- |
| `allowRestart` | boolean | `true` | 为 `false` 时工具直接失败，不重启 |
| `message` | string（非空） | `已重启` | 默认投递文本 |
| `maxAgeMs` | 正整数 | `600000` | 标记有效期；超期在读取时剔除 |
| `readyDelayMs` | 非负整数 | `1500` | 刷盘后到终止自身的等待时长 |
| `idleTimeoutMs` | 正整数 | `15000` | 等待智能体静默的上限 |
| `port` | 正整数 \| `null` | `null` | 覆盖端口；`null` 时取 `ctx.webServer.port` |
| `markerDir` | string | `''` | 覆盖标记目录；空串取 `<DSH_HOME>/self-restart` |
| `dryRun` | boolean | `false` | 只写标记与日志路径，不执行进程替换；用于自检与演练 |

插件声明：

```js
export const name = 'self-restart'
export const inject = ['tools', 'agents', 'sessions']
```

`webServer` 不列入静态依赖，而以 `ctx.inject(['webServer'], ...)` 可选获取：无 Web 载体的宿主（TUI、headless）仍可使用重启能力，仅缺少标记投递方。

### 6.2 重启标记存储

| 项目 | 规定 |
| --- | --- |
| 路径 | `<DSH_HOME>/self-restart/pending.json`；`DSH_HOME` 取值顺序为环境变量、`~/.dsh` |
| 结构 | `{ "entries": PendingEntry[] }` |
| 写入 | 先写 `<file>.tmp`，再 `renameSync` 覆盖；读者不会观察到半写状态 |
| 读取 | 剔除 `now - scheduledAt > maxAgeMs` 的条目并回写 |
| 损坏处理 | JSON 解析失败时备份为 `<file>.bad` 并视为空集合：损坏的标记不得阻断重启能力 |
| 字段校验 | 缺少 `id` / `sessionId` / `message` / `scheduledAt` 的条目在读取时丢弃 |
| **可见性** | 条目带写入者 `pid`；HTTP 接口只返回 `entry.pid !== process.pid` 的条目 |

```ts
interface PendingEntry {
  id: string            // randomUUID
  sessionId: string     // exec.agent.session.id
  message: string
  scheduledAt: number   // Date.now()
  pid?: number          // 写入它的进程；缺省视为更早版本写入（外部进程）
  source: 'restart_self'
}
```

**可见性为什么必须按进程隔离。** 标记在工具返回时即落盘，而重启要等这一轮结束才发生（§6.4）。若此时就对外可见，前端会在 1.5s 内读到并立即 `prompt`，消息被送进**仍然存活**的旧 agent 的内存队列（`queue` 模式 + 运行中），随后进程终止、队列消失；同时客户端因拿到 `ok: true` 已删除该标记——消息两头落空，会话里既不出现也不续跑。这是本插件曾经的实现缺陷（用户实测复现）。

按写入者 `pid` 过滤后：本进程写下的标记对前端不可见，替换进程启动后 `process.pid` 不同，条目才变为可投递，此时会话必然处于冷态（重启发起的第一个请求会按会话记录的预设 resume）。没有 `pid` 字段的条目来自更早版本，按外部写入处理。

### 6.3 工具 `restart_self`

| 字段 | 内容 |
| --- | --- |
| `name` | `restart_self` |
| `description` | 中文一行 + 英文一行，说明能力与重启后行为 |
| `parameters` | `{type:'object', properties:{message:{type:'string'}}, additionalProperties:false}` |
| `output.schema` | 见 §7.1 |
| `output.render` | `[{type:'text', text: JSON.stringify(value)}]` |
| `presentCall` | `{card:'generic', title:'重启自己', kind:'other'}` |

执行顺序：

1. `exec.agent` 缺失 → 拒绝（不重启、不写标记）。
2. `allowRestart === false` → 拒绝。
3. 解析消息文本：`args.message` 为非空字符串则采用，否则取配置默认值。参数未经宿主校验（F5），此处自行收窄。
4. 若本进程尚无调度结果：同步写入标记（失败即拒绝，不重启），随后启动脱离的重启调度。
5. 返回 §7.1 结构值。

幂等性：同一进程只写入一条标记、只调度一次；后续调用回报首次调度信息。该约束避免重复重启与重复消息。

### 6.3.1 发现性（模型如何知道并选择该工具）

工具注册之后仍有一个独立问题：模型如何稳定地想到它。本实现使用三个层次，缺一都会退化为「只有偶然才会用」：

| 层次 | 机制 | 面向 | 作用 |
| --- | --- | --- | --- |
| 目录 | `ctx.tools.register` 使 `restart_self` 进入该 Agent 的工具目录，随每次模型请求下发 schema | 模型 | 使工具可被调用；这是必要条件而非充分条件 |
| 提示 | `ctx.systemPrompt.section({name:'tool:restart-self', order:115})` 注入常驻提示段（见 §6.3.2） | 模型 | 把「何时该用」写进系统提示，不再依赖模型逐条读 schema 后自行推断 |
| 命令 | `ctx.commands.register({name:'restart'})` | 人 | 输入框 `/` 菜单直接可见、可执行，不经模型（§6.6.1） |

工具 `description` 自身也写明触发条件（「用户要求重启 dsh、让插件或配置改动生效，或你判定必须重启才能继续时调用」），因为部分客户端只呈现 description 而不保证提示段在场。

### 6.3.2 常驻提示段

```
restart_self：安排一次 dsh 宿主进程重启。调用当时进程仍在运行——重启发生在本轮回复结束之后，
返回值里的 restarted 为 false；新进程用完全相同的命令行与端口起身，重启完成后本会话会收到一条消息
（默认「已重启」）。用户要求重启 dsh、要求让插件或配置改动生效、或你判定必须重启才能继续时，调用它。
调用后不要对用户宣称「已重启」，也不要再说「请重启」——消息会自己到；用户也可以直接在输入框输入 /restart。
```

该段常驻且只占数行；它承担三项职责：告知能力、说明「尚未重启」的等待期、消除「调用后还要叮嘱用户重启」这类噪音。第三项与 `restart_self` 返回值里的 `restarted: false` 是同一件事的两处表述：提示段负责让模型提前知道语义，返回值负责在调用当场留下不可误读的事实。

### 6.4 重启调度

调度在工具返回之后以脱离任务执行，顺序为：

1. `Promise.race([agent.whenIdle(), sleep(idleTimeoutMs)])` —— 上限等待，避免异常轮次无限推迟重启。
2. `ctx.sessions.flush(agent.session)` —— 失败仅记录警告，不阻断重启。
3. 等待 `readyDelayMs`。
4. `dryRun` 为真时记录并返回；否则调用 `scheduleRestart(port, logs)`。

### 6.5 分离式 helper

helper 源码由 `helperSource()` 生成，以 `node -e` 执行，职责四项：

1. **等待端口释放**：以 `net.connect` 探测连接是否失败（而非本地绑定探测——绑定探测自身会在关键时刻占用端口）。有端口时轮询至连接失败（上限 30s），随后等待 300ms；无端口时固定等待 1500ms。
2. **拉起替换进程**：

```js
spawn(file, args, {
  cwd, detached,
  stdio: ['ignore', out, err],
  env: process.env,
  shell: viaShell,
  windowsHide: true,
})
```

必须注册异步 `error` 监听并写日志：`spawn` 的启动失败不会同步抛出，缺少该监听会使失败完全静默。

3. **驻留**：拉起之后 helper 不得立即退出。Windows 上刚被 spawn 的子进程尚未真正脱离进程组，helper 退出会将其一并带走——实测表现为「日志显示 replacement started，但替换进程立即消失且无任何输出」。驻留判据为：有端口时轮询至端口应答（上限 60s），无端口时固定驻留 3s。
4. **记录并退出**：日志行前缀 `[self-restart]`，写入 `%TEMP%\dsh-self-restart-<时间戳>.{out,err}.log`；引导结果记为 `replacement answered on port N` 或 `the replacement never answered on port N`。

平台差异由 `respawnInvocation()` 处理：Windows 下以

```
powershell.exe -NoProfile -WindowStyle Hidden -Command "& '<file>' '<arg>' ..."
```

包装启动，并在 `viaShell` 为真时显式指名 `.cmd` 垫片。两个原因：`detached` 在 Windows 上映射为无控制台进程，替换进程此后创建的控制台子进程会各自弹出窗口；而直接调用 `dsh` 会让 PowerShell 优先选择受执行策略约束的 `dsh.ps1`。

该包装把参数交由 PowerShell 重新解析，因此仅适用于不含双引号与 `%` 的简单参数；出现复杂参数时退回直接 detached 启动。正常的宿主命令行属于前者。

### 6.6 HTTP 接口

以 `webServer` 存在为前提注册，`kind: 'prefix'`、`path: '/dsh-self-restart'`，disposer 由 `ctx.effect` 持有。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` | `/dsh-self-restart/api/pending` | 剔除超期条目后，返回**非本进程写入**的条目 `{entries}`（§6.2 可见性） |
| `POST` | `/dsh-self-restart/api/done` | 请求体 `{id:string}`，删除该条，返回 `{ok:true, removed:0|1}` |

错误分支：`done` 缺少 `id` 返回 400；其它路径返回 404。响应统一为 `application/json; charset=utf-8` 且 `cache-control: no-store`。请求体上限 64 KiB。

两条接口均无进程控制语义，故不设来源围栏；重启只能由工具或用户手工执行。`done` 不校验写入者：删除一条外来标记是投递完成的正常收尾。

### 6.7 续跑投递

前端半以 `window.__ModuleLoader__.load({id, factory})` 注册，工厂返回 `{inject:['sessions'], apply}`，不注册界面插槽。

`apply` 内以 `ctx.effect` 启动可终止的轮询任务：

| 项目 | 规定 |
| --- | --- |
| 频率 | 立即执行一次；前 180s 间隔 1500ms（覆盖一次冷启动，大插件树下引导可达 45s 以上），此后转为 10000ms 长尾 |
| 预算 | 不设终止条件：页面长期打开时，任意时刻写入的标记都能被投递 |
| 前置条件 | `ctx.sessions.list.getSnapshot()` 的 `phase === 'ready'` 且 `byId[sessionId]` 存在；否则本轮跳过，下轮重试 |
| 投递 | `ctx.sessions.binding(sessionId)?.session.prompt([{type:'text', text}], 'queue')` |
| 成功后 | 加入已投递集合、写入 `localStorage['dsh.self-restart.handled']`（保留最近 20 条）、`POST /api/done` |
| 失败处理 | 单条最多 5 次后放弃本轮；标记保留，下次页面加载重试 |
| 已投递但条目仍在 | 补一次 `POST /api/done`，避免条目长期驻留 |

不调用 `ctx.sessions.open()`：不改变用户当前会话。正常流程下重启后的当前会话本即该会话（`dsh.sessions.current` 已持久化）。

## 7. 接口契约

### 7.1 工具返回值

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["ok", "restarted", "pid", "sessionId", "deliverAfterRestart", "timing", "note", "logPath"],
  "properties": {
    "ok":                  { "type": "boolean" },
    "restarted":           { "type": "boolean" },
    "pid":                 { "type": "integer" },
    "sessionId":           { "type": "string" },
    "deliverAfterRestart": { "type": "string" },
    "timing": {
      "type": "object",
      "additionalProperties": false,
      "required": ["afterTurnMs", "idleTimeoutMs", "portWaitMs"],
      "properties": {
        "afterTurnMs":    { "type": "integer" },
        "idleTimeoutMs":  { "type": "integer" },
        "portWaitMs":     { "type": "integer" }
      }
    },
    "note":    { "type": "string" },
    "logPath": { "type": "string" }
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `restarted` | **恒为 `false`**。调用当时进程仍在运行，重启发生在本轮回复结束之后 |
| `pid` | 将被终止的进程标识 |
| `deliverAfterRestart` | 重启完成后投递进本会话的文本（原字段名 `message` 已废弃：它紧挨 `ok: true` 会被读成「已重启」） |
| `timing.afterTurnMs` | 本轮结束到替换之间的等待（`readyDelayMs`） |
| `timing.idleTimeoutMs` | 等待智能体静默的上限 |
| `timing.portWaitMs` | helper 等待端口释放的上限（`PORT_WAIT_MS`） |
| `note` | 模型侧说明：尚未重启、本轮回复可能被截断、不要宣称已重启、不要重复调用；重复调用时前置「已排程」 |
| `logPath` | 诊断日志路径，位于系统临时目录 |

**为什么必须有 `restarted: false`。** 原返回值是 `{ok:true, message:'已重启', …}`，这个形状把「已排程」与「已完成」混在一起：模型会把 `message` 读成当前状态，于是对用户宣称已经重启，或在同一轮里继续做重启后才有意义的事。显式一位 `restarted: false` 加 `note`，把「等待期」写进返回值的唯一事实来源，而不是靠提示段的劝告。工具描述同样先写「安排一次重启……返回时尚未重启」。

### 7.1.1 `/restart` 命令

| 项目 | 内容 |
| --- | --- |
| 命令名 | `restart`（输入框输入 `/restart`） |
| 描述 | 重启 DeepSeek Harness 宿主进程；重启完成后本会话收到一条消息（默认「已重启」） |
| 入参 | 命令名之后的文本即投递文本；为空时取配置 `message` |
| 成功返回 | `{kind:'success', text:'已安排重启：当前进程（pid N）将在几秒内被替换……页面会短暂断开并自动重连。日志：…'}` |
| 停用返回 | `{kind:'error', text:'自重启已在插件配置中停用（allowRestart: false）'}` |

命令与工具共用同一调度入口 `restartOnce()`，差异仅在触发者与送达方式：命令由宿主直接执行，不经模型。命令回执照样写明「尚未重启」——它面向人，页面会先断开再重连。

### 7.2 HTTP 响应

```json
// GET /dsh-self-restart/api/pending
{ "entries": [ { "id": "…", "sessionId": "…", "message": "已重启", "scheduledAt": 0 } ] }

// POST /dsh-self-restart/api/done   ← { "id": "…" }
{ "ok": true, "removed": 1 }
```

### 7.3 插件清单

```json
{
  "name": "@local/dsh-self-restart",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-runtime"]
    }
  }
}
```

`immediately: true` 为必要项：前端半无界面元素，按需加载将使其永不物化。

## 8. 失败模式与边界条件

| 编号 | 条件 | 处置 |
| --- | --- | --- |
| B1 | 非会话内调用（`exec.agent` 缺失） | 工具拒绝，不重启 |
| B2 | 标记写入失败 | 工具拒绝，不重启（fail closed） |
| B3 | 智能体长时间不静默 | 至多等待 `idleTimeoutMs` 后照常重启 |
| B4 | 刷盘失败 | 记录警告，继续重启 |
| B5 | 在子代理会话内调用 | 允许；子会话通常不在前端列表内，标记按 `maxAgeMs` 失效 |
| B6 | 无 Web 载体 | 工具可用，跳过接口注册；无投递方，标记到期失效 |
| B7 | 端口未知 | helper 退化为固定等待 1500ms |
| B8 | 替换进程启动或引导失败 | 仅记日志；工具返回值不受影响（已提前返回） |
| B9 | 多标签页同时轮询 | 内存集合与 `localStorage` 双重去重；极端竞态最多重复一条 |
| B10 | 标记超期或会话已删除 | 读取时剔除，不投递 |
| B11 | 预设首轮工具收窄 | 仅影响会话首个请求；完成过一次工具调用的会话可见全部工具 |
| B12 | 命令行含双引号或 `%` | Windows 包装无法保真，退回直接 detached 启动；代价为替换进程的控制台子进程可能显示窗口 |
| B13 | 标记在本进程内已写入、重启尚未发生 | 按写入者 `pid` 对外隐藏（§6.2）：否则消息会被塞进旧 agent 的内存队列并随进程消失 |

## 9. 安全与权限边界

- 重启能力仅由 `restart_self` 工具暴露，无 HTTP 触发入口，任何同源页面均无法终止宿主进程。
- 两条 HTTP 接口为只读与幂等删除语义，不含进程控制。
- 标记文件位于用户级 `DSH_HOME`，内容为会话标识与固定文本，不含凭据。
- 替换命令行完全来自当前进程的 `argv`，不拼接任何外部输入。
- 不引入外部依赖，不执行网络请求（前端半仅访问同源接口）。

## 10. 部署

1. 建立目录联接：`~/.dsh/profiles/web/node_modules/@local/dsh-self-restart` → `<CHECKOUT>`（本仓库的本地检出路径）。
2. 在 `~/.dsh/profiles/web/package.json` 中：
   - `dependencies` 增加 `"@local/dsh-self-restart": "link:<CHECKOUT>"`；
   - `dsh.profile.bundles` 追加 `"@local/dsh-self-restart"`。
3. 不向 profile 的 `cordis.patch.yml` 插入同名行：插件自带 `cordis.patch.yml`，重复插入会产生同 id 双行。
4. 重启一次宿主使装配生效。

## 11. 验证

### 11.1 自检 `node test/smoke.mjs`

不触碰运行中的宿主，覆盖 9 项：配置规范化、启动命令行重建与平台包装、工具/命令/提示段/路由注册、工具写标记与幂等调度、失败路径、命令写标记与停用分支、标记的写入者隔离与接口读写、超期剔除与损坏隔离、helper 真实拉起子进程。

### 11.2 装配验证

重启宿主后确认：浏览器控制台无 `client-modules` 报错；`GET /dsh-self-restart/api/pending` 返回 `{"entries":[]}`；`restart_self` 出现在工具目录中。

### 11.3 端到端验收

在会话内调用 `restart_self`：当前轮结束后宿主被替换（日志 pid 变化），重新连接的页面向同一会话投递「已重启」并产生一轮回复；随后刷新页面，确认无重复消息。

## 12. 已知局限与演进

| 局限 | 演进路径 |
| --- | --- |
| 无恢复页面（§2 N1） | 复用 `dshmarket/src/recovery.ts` 的恢复面，在 helper 的失败分支启动 |
| 投递依赖浏览器在线 | 若需无界面场景，需在宿主侧实现「按会话记录的预设装配后 resume」，即等价于 `composeAgent`（§4 F8） |
| 多客户端去重非强一致 | 改为 `POST /api/claim` 原子领取语义 |
| 未接入插件操作互斥 | 若后续引入长操作（安装、更新），可在调度前复用市场的操作门 |

## 13. 附录：交付物

| 路径 | 说明 |
| --- | --- |
| `index.js` | 宿主半：配置、标记存储、工具、接口、调度 |
| `restart.js` | 启动命令行重建、平台包装、helper 源码、进程替换 |
| `client.js` | 前端半：轮询与投递 |
| `cordis.patch.yml` | 装载行 |
| `package.json` | 清单声明（§7.3） |
| `test/smoke.mjs` | 自检（§11.1） |
| `README.md` | 使用说明 |
