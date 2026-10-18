/**
 * @local/dsh-self-restart 宿主半。
 *
 * 能力：会话智能体通过 `restart_self` 工具触发宿主进程重启；重启完成后，由前端半
 * 从重启标记中取出消息并投递回原会话。设计说明见 docs/design.md。
 *
 * 与宿主解耦：仅使用 Node.js 内置模块与 ctx 服务，不引入宿主运行时依赖（链接型插件
 * 的真实路径位于 profile 之外，无法解析宿主包）。
 *
 * @module dsh-self-restart
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { PORT_WAIT_MS, restartLogPaths, scheduleRestart } from './restart.js'

/** 宿主插件名。 */
export const name = 'self-restart'

/** 依赖：工具注册、智能体注册表、会话存储。webServer 以可选方式获取。 */
export const inject = ['tools', 'agents', 'sessions']

/** HTTP 路由前缀，前端半使用同一常量。 */
export const PREFIX = '/dsh-self-restart'

/** 缺省配置。 */
const DEFAULTS = Object.freeze({
  allowRestart: true,
  message: '已重启',
  maxAgeMs: 600000,
  readyDelayMs: 1500,
  idleTimeoutMs: 15000,
  port: null,
  markerDir: '',
  dryRun: false,
})

/** POST 请求体的上限；标记请求仅承载一个标识。 */
const MAX_BODY_BYTES = 64 * 1024

/** 缺省等待。 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 记录诊断信息；日志服务缺失时静默。 */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`self-restart: ${message}`)
  } catch {
    /* 日志服务不可用不构成失败 */
  }
}

/** 校验安全整数配置项。 */
function safeInteger(value, field, min) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`self-restart: ${field} 必须是 ${min} 以上的安全整数`)
  }
  return value
}

/** 校验并补全插件配置；非法取值在挂载点抛出。 */
export function normalizeConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('self-restart: config 必须是对象')
  }
  const config = { ...DEFAULTS, ...source }
  if (typeof config.allowRestart !== 'boolean') throw new TypeError('self-restart: allowRestart 必须是布尔值')
  if (typeof config.dryRun !== 'boolean') throw new TypeError('self-restart: dryRun 必须是布尔值')
  if (typeof config.message !== 'string' || config.message.trim() === '') {
    throw new TypeError('self-restart: message 必须是非空字符串')
  }
  if (typeof config.markerDir !== 'string') throw new TypeError('self-restart: markerDir 必须是字符串')
  safeInteger(config.maxAgeMs, 'maxAgeMs', 1)
  safeInteger(config.readyDelayMs, 'readyDelayMs', 0)
  safeInteger(config.idleTimeoutMs, 'idleTimeoutMs', 1)
  if (config.port !== null) safeInteger(config.port, 'port', 1)
  return config
}

/** 用户级 DSH 主目录：环境变量优先，其次 ~/.dsh。 */
export function dshHome(env = process.env) {
  const configured = (env.DSH_HOME ?? '').trim()
  return configured === '' ? join(homedir(), '.dsh') : configured
}

/** 标记文件路径。 */
export function markerFile(config, env = process.env) {
  const dir = config.markerDir.trim() === ''
    ? join(dshHome(env), 'self-restart')
    : config.markerDir
  return join(dir, 'pending.json')
}

/** 判断一条候选记录是否具备完整字段。 */
function isEntry(value) {
  return value !== null && typeof value === 'object'
    && typeof value.id === 'string' && value.id !== ''
    && typeof value.sessionId === 'string' && value.sessionId !== ''
    && typeof value.message === 'string' && value.message !== ''
    && typeof value.scheduledAt === 'number' && Number.isFinite(value.scheduledAt)
}

/** 原子写入标记集合：先写临时文件，再替换目标文件。 */
export function writeEntries(file, entries) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify({ entries }, null, 2))
  renameSync(temporary, file)
}

/**
 * 读取标记集合，剔除超期条目。
 *
 * 文件损坏时将其备份为 `<file>.bad` 并视为空集合：损坏的标记不应阻断重启能力。
 * @param {string} file - 标记文件路径。
 * @param {number} maxAgeMs - 条目有效期。
 * @param {() => number} now - 时钟，便于自检。
 * @returns {Array<object>} 仍然有效的条目。
 */
export function readEntries(file, maxAgeMs, now = Date.now) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    try {
      renameSync(file, `${file}.bad`)
    } catch {
      /* 备份失败不影响本次读取结果 */
    }
    return []
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter(isEntry) : []
  const timestamp = now()
  const kept = entries.filter(entry => timestamp - entry.scheduledAt <= maxAgeMs)
  if (kept.length !== entries.length) {
    try {
      writeEntries(file, kept)
    } catch {
      /* 剔除失败时仍返回有效子集，下次读取重试 */
    }
  }
  return kept
}

/** 追加一条标记。 */
function appendEntry(file, entry, maxAgeMs) {
  writeEntries(file, [...readEntries(file, maxAgeMs), entry])
  return entry
}

/** 统一的 JSON 响应。 */
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** 读取并解析 JSON 请求体；超限或非法时返回 undefined。 */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** 面向前端半的条目投影：不暴露内部字段。 */
function publicEntry(entry) {
  return { id: entry.id, sessionId: entry.sessionId, message: entry.message, scheduledAt: entry.scheduledAt }
}

/**
 * 一条标记只有在**写入它的进程已经不在**之后才可投递。
 *
 * 为什么必须这样：标记在工具返回时就已落盘，而重启要等这一轮结束才发生。
 * 若此时就对外可见，前端会立刻 `prompt`，消息被塞进旧 agent 的内存队列
 * （`queue` 模式 + 运行中），随后进程终止、队列消失，而客户端已因 `ok:true`
 * 删掉标记——消息两头落空。按写入者 pid 过滤后，本进程写下的标记对前端不可见，
 * 只有替换进程启动后才会被看到并投递。
 *
 * 没有 `pid` 字段的条目来自更早的版本，按「外部写入」处理。
 * @param {object} entry - 候选条目。
 * @param {number} pid - 当前进程标识。
 * @returns {boolean} 是否可投递。
 */
function deliverable(entry, pid) {
  return entry.pid !== pid
}

/** 常驻提示段：让模型在相关意图下想到该工具，而不只依赖 schema 被偶然读到。 */
const GUIDANCE = 'restart_self：安排一次 dsh 宿主进程重启。调用当时进程仍在运行——重启发生在本轮回复结束之后，'
  + '返回值里的 restarted 为 false；新进程用完全相同的命令行与端口起身，重启完成后本会话会收到一条消息'
  + '（默认「已重启」）。用户要求重启 dsh、要求让插件或配置改动生效、或你判定必须重启才能继续时，调用它。'
  + '调用后不要对用户宣称「已重启」，也不要再说「请重启」——消息会自己到；用户也可以直接在输入框输入 /restart。'

/**
 * 工具的输出契约。
 *
 * `restarted: false` 是这份返回值里最重要的一位：调用当时进程仍在运行，重启发生在
 * 本轮回复结束之后。缺少这一位时，模型会把紧随其后的 `deliverAfterRestart` 读成
 * 「已经重启完成」，从而对用户谎报状态，或在同一轮里继续做重启后才有意义的事。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'restarted', 'pid', 'sessionId', 'deliverAfterRestart', 'timing', 'note', 'logPath'],
  properties: {
    ok: { type: 'boolean' },
    restarted: { type: 'boolean' },
    pid: { type: 'integer' },
    sessionId: { type: 'string' },
    deliverAfterRestart: { type: 'string' },
    timing: {
      type: 'object',
      additionalProperties: false,
      required: ['afterTurnMs', 'idleTimeoutMs', 'portWaitMs'],
      properties: {
        afterTurnMs: { type: 'integer' },
        idleTimeoutMs: { type: 'integer' },
        portWaitMs: { type: 'integer' },
      },
    },
    note: { type: 'string' },
    logPath: { type: 'string' },
  },
}

/** 返回给模型的状态说明：说清「尚未重启」与随后的等待，避免它谎报完成。 */
const PENDING_NOTE = '尚未重启。进程会在本轮回复结束、会话刷盘后被替换：先等待 afterTurnMs，'
  + '若久不静默最多等 idleTimeoutMs；helper 还要等端口释放（上限 portWaitMs），'
  + '随后的冷启动需要数秒到数十秒。本轮回复可能在替换时被截断，属正常。'
  + '重启完成后本会话会收到 deliverAfterRestart 这条消息，不要在此前对用户宣称已重启，也不要重复调用。'

/**
 * 挂载插件：注册 `restart_self` 工具与两条标记接口。
 * @param {object} ctx - 宿主 Context。
 * @param {object} config - 插件行配置。
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  const file = markerFile(resolved)

  /** 本次进程的唯一调度结果：一次进程只重启一次，重复调用回报同一份信息。 */
  let scheduled = null

  /**
   * 等待当前轮结束、刷盘、再替换进程。
   * 与工具返回值无关，故以脱离的任务执行：工具必须立即返回，否则结果无处可写。
   */
  function arm(agent, port, logs) {
    const task = (async () => {
      // 上限等待：智能体可能因长工具或异常永不静默，重启不应被无限期推迟。
      await Promise.race([agent.whenIdle().catch(() => undefined), sleep(resolved.idleTimeoutMs)])
      try {
        await ctx.sessions.flush(agent.session)
      } catch (error) {
        warn(ctx, `flush failed: ${String(error)}`)
      }
      await sleep(resolved.readyDelayMs)
      if (resolved.dryRun) {
        warn(ctx, `dryRun: 跳过进程替换（日志 ${logs.err}）`)
        return
      }
      scheduleRestart(port, logs)
    })()
    task.catch(error => warn(ctx, `scheduling failed: ${String(error)}`))
    return task
  }

  /**
   * 写入标记并启动一次重启调度（幂等：一次进程只重启一次）。
   * 工具与 `/restart` 命令共用此入口，两者的差异仅在触发者与送达方式。
   * @param {object} agent - 触发重启的会话智能体。
   * @param {string} message - 重启后投递进该会话的文本。
   * @returns {{ deliverAfterRestart: string, sessionId: string, logPath: string, repeated: boolean }} 本进程的调度信息。
   */
  function restartOnce(agent, message) {
    if (scheduled !== null) return { ...scheduled, repeated: true }
    const logs = restartLogPaths()
    const entry = appendEntry(file, {
      id: randomUUID(),
      sessionId: String(agent.session.id),
      message,
      scheduledAt: Date.now(),
      pid: process.pid,
      source: 'restart_self',
    }, resolved.maxAgeMs)
    const port = resolved.port ?? ctx.get('webServer')?.port ?? null
    scheduled = { deliverAfterRestart: entry.message, sessionId: entry.sessionId, logPath: logs.err }
    arm(agent, port, logs)
    return { ...scheduled, repeated: false }
  }

  /** 等待参数：告知模型它要等多久，而不是让它以为重启已经完成。 */
  const timing = {
    afterTurnMs: resolved.readyDelayMs,
    idleTimeoutMs: resolved.idleTimeoutMs,
    portWaitMs: PORT_WAIT_MS,
  }

  const tool = {
    name: 'restart_self',
    description: '安排一次宿主进程重启：本轮回复结束后，进程被相同命令行与端口的新进程替换。'
      + '返回时尚未重启（restarted: false）；重启完成后本会话会收到 deliverAfterRestart 这条消息。'
      + '用户要求重启 dsh、让插件或配置改动生效，或你判定必须重启才能继续时调用。'
      + ' / Schedule an in-place restart of the host process. It happens AFTER this turn ends, so the '
      + 'immediate result reports restarted: false; the delivered text arrives in this session once the '
      + 'new process is up. Call it when the user asks for a restart, when a change needs one to take effect, '
      + 'or when you judge a restart is required.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message: {
          type: 'string',
          description: '重启后发进本会话的文本，缺省使用插件配置的 message / Text delivered into this session after the restart',
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: '重启自己', kind: 'other' }),
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        return Promise.reject(new Error('restart_self: 必须在会话智能体内调用 / requires a calling agent'))
      }
      if (!resolved.allowRestart) {
        return Promise.reject(new Error('restart_self: 已在插件配置中停用 / disabled by config'))
      }
      // 参数未经宿主校验（裸 ToolDefinition），此处自行收窄。
      const message = typeof args?.message === 'string' && args.message.trim() !== ''
        ? args.message
        : resolved.message
      const state = restartOnce(agent, message)
      return Promise.resolve({
        ok: true,
        // 调用当时进程仍在运行：这一位存在的唯一目的就是阻止模型把「已排程」说成「已重启」。
        restarted: false,
        pid: process.pid,
        sessionId: state.sessionId,
        deliverAfterRestart: state.deliverAfterRestart,
        timing,
        note: state.repeated
          ? '本进程的重启已排程，本次调用不产生第二次重启，参数保持不变。' + PENDING_NOTE
          : PENDING_NOTE,
        logPath: state.logPath,
      })
    },
  }

  ctx.effect(() => ctx.tools.register(tool), 'self-restart: tool')

  // 常驻提示段：工具 schema 只在模型读到参数时存在，提示段负责把「何时用」写进系统提示。
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'tool:restart-self',
      order: 115,
      text: GUIDANCE,
    }), 'self-restart: prompt section')
  })

  // 用户可见入口：`/restart` 出现在输入框的命令菜单里，不经模型直接由宿主执行。
  // 工具面向模型，命令面向人——两者共用同一调度入口。
  ctx.inject(['commands'], commandCtx => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'restart',
      description: '重启 DeepSeek Harness 宿主进程；重启完成后本会话收到一条消息（默认「已重启」）',
      handler: invocation => {
        if (!resolved.allowRestart) {
          return { kind: 'error', text: '自重启已在插件配置中停用（allowRestart: false）' }
        }
        const typed = invocation.rawInput.trim()
        const state = restartOnce(invocation.agent, typed === '' ? resolved.message : typed)
        return {
          kind: 'success',
          // 命令由人触发，也必须说清「尚未重启」：页面会先重连、再出现投递消息。
          text: `已安排重启：当前进程（pid ${process.pid}）将在几秒内被相同命令行与端口的新进程替换，`
            + `替换后本会话收到「${state.deliverAfterRestart}」。页面会短暂断开并自动重连。日志：${state.logPath}`,
        }
      },
    }), 'self-restart: command')
  })

  // 无 Web 载体的宿主（TUI、headless）仍然可以重启，只是没有客户端投递标记。
  ctx.inject(['webServer'], webCtx => {
    const handler = async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname.slice(PREFIX.length)
      if (path === '/api/pending' && request.method === 'GET') {
        const visible = readEntries(file, resolved.maxAgeMs)
          .filter(entry => deliverable(entry, process.pid))
        json(response, 200, { entries: visible.map(publicEntry) })
        return
      }
      if (path === '/api/done' && request.method === 'POST') {
        const body = await readJson(request)
        const id = typeof body?.id === 'string' ? body.id : undefined
        if (id === undefined) {
          json(response, 400, { error: 'id is required' })
          return
        }
        const entries = readEntries(file, resolved.maxAgeMs)
        const kept = entries.filter(entry => entry.id !== id)
        if (kept.length !== entries.length) writeEntries(file, kept)
        json(response, 200, { ok: true, removed: entries.length - kept.length })
        return
      }
      json(response, 404, { error: 'not found' })
    }
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler,
    }), 'self-restart: routes')
  })
}
