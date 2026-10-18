/**
 * 进程替换链路。
 *
 * 职责边界：
 *   1. 由当前进程的 argv 重建等价启动命令行（launchArgv）；
 *   2. 处理平台差异（respawnInvocation）：Windows 下以隐藏窗口的 PowerShell 包装，
 *      否则替换进程会为每个控制台子进程弹出一个可见窗口；
 *   3. 生成分离式 helper 源码（helperSource）：等待端口释放、拉起替换进程、记录日志；
 *   4. 调度（scheduleRestart）：启动 helper 并终止当前进程。
 *
 * helper 必须先确认端口不再接受连接，再拉起替换进程。省略该等待会造成替换进程
 * 因 EADDRINUSE 立即退出，而启动失败在 spawn 中是异步事件，同步 try/catch 无法捕获。
 *
 * @module dsh-self-restart/restart
 */

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 可作为宿主入口重放的路径形态：bin.js、bin.ts 与 PATH 上的 dsh 可执行文件。 */
const ENTRY = /[\\/](?:bin\.(?:js|ts)|dsh)$/u

/** helper 等待旧端口释放的上限；工具返回值据此告知模型它需要等多久。 */
export const PORT_WAIT_MS = 30000

/**
 * 由当前进程的 argv 重建启动命令行。
 * @param {string[]} argv - 进程参数向量，默认取 process.argv。
 * @param {string} execPath - Node.js 可执行文件路径。
 * @param {string[]} execArgv - 当前进程的 Node.js 选项（如 --import tsx/esm）。
 * @param {string} platform - 平台标识，仅影响 PATH 分支的 shell 判定。
 * @returns {{ file: string, args: string[], cwd: string, viaShell: boolean }}
 */
export function launchArgv(
  argv = process.argv,
  execPath = process.execPath,
  execArgv = process.execArgv,
  platform = process.platform,
) {
  const entry = argv[1]
  if (typeof entry === 'string' && ENTRY.test(entry)) {
    // 绝对路径为必需项：源码启动传入的是相对入口，替换进程会按自身工作目录解析。
    const absolute = resolve(entry)
    return {
      file: execPath,
      args: [...execArgv, absolute, ...argv.slice(2)],
      cwd: dirname(absolute),
      viaShell: false,
    }
  }
  // PATH 上的 dsh 在 Windows 是 .cmd 垫片，只有 shell 能启动。
  return { file: 'dsh', args: [...argv.slice(2)], cwd: process.cwd(), viaShell: platform === 'win32' }
}

/**
 * 生成平台正确的拉起参数。
 *
 * Windows 分支以 PowerShell 包装，使替换进程拥有一个隐藏的控制台：`detached` 在 Windows 上
 * 映射为无控制台进程，替换进程此后创建的控制台子进程会各自弹出窗口。
 *
 * 该包装会把参数交给 PowerShell 重新解析，因此仅适用于「不含双引号与 %」的简单参数
 * （正常的宿主命令行即属此类）。出现复杂参数时退回直接 detached 启动：换取参数保真，
 * 代价是替换进程的子进程可能各自获得可见控制台。
 * @param {{ file: string, args: string[], viaShell: boolean }} launch - launchArgv 的结果。
 * @param {string} platform - 平台标识。
 * @returns {{ file: string, args: string[], viaShell: boolean, detached: boolean }}
 */
export function respawnInvocation(launch, platform = process.platform) {
  if (platform !== 'win32') {
    return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true }
  }
  const simple = [launch.file, ...launch.args].every(word => !/["%]/u.test(word))
  if (!simple) {
    return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true }
  }
  const quote = part => `'${part.replace(/'/g, "''")}'`
  // 显式指名 .cmd 垫片：直接调用 dsh 会让 PowerShell 优先选择受执行策略约束的 dsh.ps1。
  const file = launch.viaShell && !/\.(?:cmd|bat)$/iu.test(launch.file)
    ? `${launch.file}.cmd`
    : launch.file
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      [`& ${quote(file)}`, ...launch.args.map(quote)].join(' ')],
    viaShell: false,
    detached: false,
  }
}

/**
 * 本次重启的日志路径。
 * @param {string} stamp - 时间戳标识，缺省由当前时间生成。
 * @returns {{ out: string, err: string }}
 */
export function restartLogPaths(stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)) {
  return {
    out: join(tmpdir(), `dsh-self-restart-${stamp}.out.log`),
    err: join(tmpdir(), `dsh-self-restart-${stamp}.err.log`),
  }
}

/**
 * 生成分离式 helper 的源码，以 `node -e` 执行。
 *
 * 源码以字符串形式产出而非独立文件：helper 必须能在一个只装了 Node.js 的进程里启动，
 * 且不能依赖本包的解析结果（重启场景中最常见的失败就是包树本身不可解析）。
 * @param {{ file: string, args: string[], viaShell: boolean, detached: boolean }} spawned - 替换进程的拉起参数。
 * @param {{ cwd: string }} launch - 替换进程的工作目录。
 * @param {{ out: string, err: string }} logs - 标准输出与诊断日志路径。
 * @param {number | null} port - 替换进程必须接管的端口；未知时退化为固定等待。
 * @returns {string} helper 源码。
 */
export function helperSource(spawned, launch, logs, port) {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(spawned.file)}`,
    `const args = ${JSON.stringify(spawned.args)}`,
    `const cwd = ${JSON.stringify(launch.cwd)}`,
    `const viaShell = ${JSON.stringify(spawned.viaShell)}`,
    `const detached = ${JSON.stringify(spawned.detached)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const port = ${JSON.stringify(port)}`,
    'const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))',
    'const note = line => { try { fs.appendFileSync(logErr, "[self-restart] " + line + "\\n") } catch {} }',
    'process.on("uncaughtException", error => note("helper crashed: " + (error && error.stack ? error.stack : error)))',
    'process.on("unhandledRejection", error => note("helper rejection: " + (error && error.stack ? error.stack : error)))',
    // 以「连接失败」判定端口释放，而非本地绑定：绑定探测自身会占用端口恰好那一刻。
    'const listening = () => new Promise(resolve => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = value => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    'const main = async () => {',
    '  note(`helper up (pid ${process.pid}) for port ${port}`)',
    '  if (port) {',
    `    const until = Date.now() + ${PORT_WAIT_MS}`,
    '    while (Date.now() < until && await listening()) await sleep(250)',
    `    if (await listening()) note(\`port \${port} was still in use after ${PORT_WAIT_MS / 1000}s; starting anyway\`)`,
    '    await sleep(300)',
    '  } else {',
    '    await sleep(1500)',
    '  }',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    child = spawn(file, args, { cwd, detached, stdio: ["ignore", out, err], env: process.env, shell: viaShell, windowsHide: true })',
    // spawn 的启动失败是异步事件，同步 try/catch 覆盖不到；缺少该监听会让失败完全静默。
    '    child.on("error", error => note("could not start the replacement: " + (error && error.message ? error.message : error)))',
    '    child.unref()',
    '    note(`replacement started (pid ${child.pid})`)',
    '  } catch (error) {',
    '    note("could not start the replacement: " + (error && error.message ? error.message : error))',
    '    return',
    '  }',
    // helper 必须比替换进程活得更久：Windows 上刚 spawned 的子进程尚未真正脱离进程组，
    // helper 立即退出会把它一起带走。带有端口时以「端口是否应答」作为存活判据，
    // 无端口时固定驻留 3s。
    '  let answered = port ? false : null',
    '  const startedAt = Date.now()',
    '  const deadline = startedAt + 60000',
    '  while (Date.now() < deadline) {',
    '    if (port) {',
    '      if (await listening()) { answered = true; break }',
    '      await sleep(500)',
    '    } else if (Date.now() - startedAt >= 3000) {',
    '      break',
    '    } else {',
    '      await sleep(500)',
    '    }',
    '  }',
    '  note(port ? (answered ? `replacement answered on port ${port}` : `the replacement never answered on port ${port} — see the output log beside this one`) : "helper finished")',
    '}',
    'main()',
  ].join('\n')
}

/**
 * 调度一次进程替换：启动分离式 helper，并在 500ms 后终止当前进程。
 * @param {number | null} port - 当前进程监听的端口。
 * @param {{ out: string, err: string }} logs - 日志路径。
 * @returns {{ pid: number, helperPid: number | undefined, logOut: string, logErr: string }}
 */
export function scheduleRestart(port = null, logs = restartLogPaths()) {
  const launch = launchArgv()
  const spawned = respawnInvocation(launch)
  const helper = spawn(process.execPath, ['-e', helperSource(spawned, launch, logs, port)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  helper.on('error', () => { /* 由日志文件承担诊断职责 */ })
  helper.unref()
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
  // ponytail: 无恢复页面 —— 替换进程引导失败时只留日志；需要恢复面时接入 dshmarket/src/recovery.ts。
  return { pid: process.pid, helperPid: helper.pid, logOut: logs.out, logErr: logs.err }
}
