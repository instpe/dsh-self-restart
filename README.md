# dsh-self-restart

允许会话智能体重启承载它的 DeepSeek Harness 宿主进程，并在重启完成后于原会话内收到一条消息（默认「已重启」）。

设计说明见 [docs/design.md](docs/design.md)。

## 能力

- 工具 `restart_self`：由会话智能体调用，写入重启标记，等待当前轮结束并刷盘后替换进程。
- 命令 `/restart`：由人直接触发，出现在输入框的命令菜单中，不经模型；命令名之后的文本即投递文本。
- 常驻提示段：把「何时该用」写进系统提示，使模型在「重启 dsh / 让改动生效」这类请求下主动选择该工具，而不仅依赖 schema 被偶然读到。
- 进程替换：分离式 helper 等待端口释放，以完全相同的命令行拉起替换进程；日志写入系统临时目录。
- 续跑投递：浏览器端在宿主恢复后，把标记中的消息作为一条用户消息送回原会话。

### 智能体如何知道有这个工具

三层，缺一都会退化成「偶然才用」：

1. **目录**：`ctx.tools.register` 让 `restart_self` 进入该 Agent 的工具目录，随每次模型请求下发名称、描述与参数。
2. **提示**：`ctx.systemPrompt.section` 注入常驻提示段，写明触发条件与「调用后不必再叮嘱重启」。
3. **命令**：`/restart` 给人用；输入框输入 `/` 即可看到。

注意：若会话使用「首轮工具收窄」的预设（例如 liangshen），**新会话的第一个请求只暴露 bootstrap 工具**，`restart_self` 会在第一次工具调用之后才出现于目录中；这属于预设行为，不是插件缺注册。

## 配置

插件行 `config` 支持下列键（缺省值见括号）：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `allowRestart` | boolean（`true`） | 为 `false` 时工具直接失败 |
| `message` | string（`已重启`） | 默认投递文本 |
| `maxAgeMs` | 正整数（`600000`） | 标记有效期 |
| `readyDelayMs` | 非负整数（`1500`） | 刷盘后到终止自身的等待 |
| `idleTimeoutMs` | 正整数（`15000`） | 等待智能体静默的上限 |
| `port` | 正整数或 `null`（`null`） | 覆盖端口；缺省取 Web 载体实际端口 |
| `markerDir` | string（`''`） | 覆盖标记目录；缺省 `<DSH_HOME>/self-restart` |
| `dryRun` | boolean（`false`） | 只写标记，不替换进程；用于自检与演练 |

## 安装

```powershell
# 1. 目录联接：把插件检出目录接到 profile 的 @local 作用域（与既有 @local 插件同形）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@local\dsh-self-restart" `
  -Target "<CHECKOUT>"

# 2. profile 清单：dependencies 增加 "link:<CHECKOUT>"，
#    dsh.profile.bundles 追加 "@local/dsh-self-restart"

# 3. 重启一次宿主
```

其中 `<CHECKOUT>` 指本仓库的本地检出路径，例如 `link:C:/src/dsh-self-restart`。

不使用 `cordis.patch.yml` 直接插入：插件自带装载行，重复插入会产生同 id 双行。

## 使用

两种触发方式，效果相同：

```
/restart                 # 人：输入框直接执行，投递默认文本「已重启」
/restart 环境已就绪       # 人：命令名之后的文本即投递文本
```

```
restart_self({ message: "已重启" })   # 模型：由智能体调用
```

两条路径都是「先安排、后发生」：调用当即返回，**此刻尚未重启**。工具返回值里 `restarted` 恒为 `false`，并用 `timing` 说明随后的等待：

```json
{
  "ok": true,
  "restarted": false,
  "pid": 20532,
  "sessionId": "session-…",
  "deliverAfterRestart": "已重启",
  "timing": { "afterTurnMs": 1500, "idleTimeoutMs": 15000, "portWaitMs": 30000 },
  "note": "尚未重启。进程会在本轮回复结束、会话刷盘后被替换……",
  "logPath": "…\\Temp\\dsh-self-restart-….err.log"
}
```

`restarted: false` 是刻意留的：只有它能让模型不把「已排程」说成「已重启」。本轮回复可能在替换时被截断，属正常；浏览器重连后，原会话收到 `deliverAfterRestart` 并产生一轮回复。

## 验证

```powershell
node test/smoke.mjs
```

自检覆盖配置校验、启动命令行重建、工具/命令/提示段/路由注册、标记存储与接口契约（含写入者隔离），以及真实拉起一个替换子进程。第 4 项会把返回值键集合与 `output.schema.required` 逐字比对——只断言「字段存在」抓不到「schema 已改、execute 还返回旧字段」这种半途状态。

查看运行中的注册情况（宿主 Inspect）：`Tool.listTools` 应含 `restart_self`；`/api/commands/list` 应含 `restart`。

> **改动本插件时的注意**：宿主会热重载被 watch 的插件文件。若一次改动拆成多次保存，watcher 可能在中间态重载，得到一个「新 schema + 旧 execute」的混合定义，表现为调用时报 `missing required property "value.…"`。改完一组相关编辑后重启一次宿主再验收，或一次保存整块。

## 投递语义

标记带写入者 `pid`，`GET /api/pending` 只返回**非当前进程**写入的条目。因此在重启发生前，前端看不到这条标记，不会把消息投进仍在运行的旧 agent 的队列；只有替换进程启动后条目才可见，此时会话处于冷态，投递会正常开启一轮。若一次重启并未真的发生（例如 `dryRun`，或 helper 引导失败），这条消息就不投递——因为「已重启」只有在确实重启后才成立。

## 已知局限

- 无恢复页面：替换进程引导失败时只有日志，需手工重新执行 `dsh web`。
- 投递依赖浏览器在线：无界面宿主下标记会在有效期后失效。
- 多标签页并发投递为弱一致去重，极端竞态最多重复一条消息。
