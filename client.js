/**
 * @instpe/dsh-self-restart 前端半。
 *
 * 职责：宿主重启完成后，把重启标记中的消息作为一条用户消息投递回原会话。
 *
 * 为什么由浏览器端投递，而不由宿主在启动时自行恢复会话：冷会话只有在前端发起请求时
 * 才会以「会话记录的预设」重新装配并 resume；宿主自行 resume 会把智能体绑到全局层，
 * 丢失预设提供的工具与提示段。
 *
 * 与宿主解耦：仅依赖 ctx.sessions 与同源 HTTP，不引用宿主模块。
 */
(function () {
  'use strict'

  /** 浏览器模块标识，须与 package.json 的包名一致。 */
  const MODULE_ID = '@instpe/dsh-self-restart'

  /** 标记接口前缀，与宿主入口保持同值。 */
  const PREFIX = '/dsh-self-restart/api'

  /** 轮询节奏：重启窗口内保持密集轮询，之后转为长尾低频。 */
  const POLL_MS = 1500
  const FAST_WINDOW_MS = 180000
  const SLOW_POLL_MS = 10000

  /** 已投递标识的持久化键与保留条数。 */
  const HANDLED_KEY = 'dsh.self-restart.handled'
  const HANDLED_LIMIT = 20

  /** 单条标记在本次页面会话内的最大投递次数。 */
  const MAX_ATTEMPTS = 5

  /**
   * 把接口路径解析为页面基址下的路径。
   * 反代将 dsh 挂在子路径下时，根绝对路径会绕开前缀规则。
   */
  function endpoint(path) {
    const relative = path.replace(/^\/+/, '')
    return typeof document === 'undefined' ? `/${relative}` : new URL(relative, document.baseURI).pathname
  }

  /** 读取已投递标识集合。 */
  function readHandled() {
    try {
      const raw = JSON.parse(window.localStorage.getItem(HANDLED_KEY) ?? '[]')
      return Array.isArray(raw) ? raw.filter(id => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  /** 记录一个已投递标识，保留最近 HANDLED_LIMIT 条。 */
  function remember(id) {
    const next = [id, ...readHandled().filter(candidate => candidate !== id)].slice(0, HANDLED_LIMIT)
    try {
      window.localStorage.setItem(HANDLED_KEY, JSON.stringify(next))
    } catch {
      /* 存储不可用时退化为内存去重 */
    }
  }

  /** 拉取待投递条目；失败返回 null 以便下一轮重试。 */
  async function fetchPending() {
    const response = await fetch(endpoint(`${PREFIX}/pending`), {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!response.ok) return null
    const body = await response.json()
    return Array.isArray(body?.entries) ? body.entries : null
  }

  /** 确认一条标记已投递，宿主据此删除该条目。 */
  async function markDone(id) {
    try {
      await fetch(endpoint(`${PREFIX}/done`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id }),
      })
    } catch {
      /* 删除失败只会在下一轮重复确认，不产生重复消息 */
    }
  }

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory() {
      return {
        inject: ['sessions'],
        apply(ctx) {
          const handled = new Set(readHandled())
          const attempts = new Map()
          let stopped = false

          const stop = () => { stopped = true }
          const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

          /**
           * 投递一条标记。
           * 会话尚未出现在列表中时静默返回，由下一轮重试：重启后的列表是被动拉取的。
           */
          async function deliver(entry) {
            const snapshot = ctx.sessions.list.getSnapshot()
            if (snapshot.phase !== 'ready' || snapshot.byId[entry.sessionId] === undefined) return
            const count = attempts.get(entry.id) ?? 0
            if (count >= MAX_ATTEMPTS) return
            attempts.set(entry.id, count + 1)
            const session = ctx.sessions.binding(entry.sessionId)?.session
            if (session === undefined) return
            let result
            try {
              result = await session.prompt([{ type: 'text', text: entry.message }], 'queue')
            } catch {
              return
            }
            if (result?.ok === true) {
              handled.add(entry.id)
              remember(entry.id)
              await markDone(entry.id)
            }
          }

          /** 一轮：取标记、逐条投递。 */
          async function tick() {
            let entries
            try {
              entries = await fetchPending()
            } catch {
              return
            }
            if (stopped || entries === null) return
            for (const entry of entries) {
              if (stopped) return
              if (handled.has(entry.id)) {
                // 上一次投递成功但确认丢失：补一次确认，避免条目长期驻留。
                await markDone(entry.id)
                continue
              }
              await deliver(entry)
            }
          }

          ctx.effect(() => {
            void (async () => {
              // 密集窗口覆盖一次冷启动；之后转为长尾轮询，使页面长期打开时也能收到标记。
              const deadline = Date.now() + FAST_WINDOW_MS
              while (!stopped) {
                await tick()
                await sleep(Date.now() < deadline ? POLL_MS : SLOW_POLL_MS)
              }
            })()
            return stop
          }, 'self-restart: delivery')
        },
      }
    },
  })
})()
