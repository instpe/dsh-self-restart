/**
 * 自检：不触碰运行中的宿主，验证工具契约、标记存储、两条接口与进程替换链路。
 *
 * 运行：node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply, markerFile, normalizeConfig, readEntries, writeEntries } from '../index.js'
import { helperSource, launchArgv, respawnInvocation } from '../restart.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-self-restart-test-'))

/** 记录用例结果。 */
let passed = 0
function check(label) {
  passed += 1
  console.log(`ok ${passed} - ${label}`)
}

/** 伪造的宿主上下文：只提供被测代码实际使用的成员。 */
function fakeContext() {
  const tools = []
  const routes = []
  const commands = []
  const sections = []
  const webServer = {
    port: 3099,
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    logger: { warn() {}, info() {} },
    tools: { register(definition) { tools.push(definition); return () => {} } },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    systemPrompt: { section(section) { sections.push(section); return () => {} } },
    sessions: { flush: () => Promise.resolve(true) },
    agents: {},
    webServer,
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    inject(dependencies, callback) {
      const served = ['webServer', 'commands', 'systemPrompt']
      if (dependencies.some(name => served.includes(name))) callback(ctx)
    },
    effect(callback) {
      return callback()
    },
  }
  return { ctx, tools, routes, commands, sections, webServer }
}

/** 伪造的响应对象：记录状态码与响应体。 */
function fakeResponse() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.body = typeof chunk === 'string' ? chunk : ''
    },
  }
}

/** 把 JSON 请求体包装成可异步迭代的请求对象。 */
function fakePostRequest(url, payload) {
  const request = Readable.from([Buffer.from(JSON.stringify(payload))])
  request.url = url
  request.method = 'POST'
  return request
}

// 1. 配置规范化
{
  const config = normalizeConfig({})
  assert.equal(config.message, '已重启')
  assert.equal(config.allowRestart, true)
  assert.throws(() => normalizeConfig({ maxAgeMs: 0 }), /maxAgeMs/)
  assert.throws(() => normalizeConfig({ message: '  ' }), /message/)
  assert.throws(() => normalizeConfig({ allowRestart: 'yes' }), /allowRestart/)
  check('配置规范化与非法取值')
}

// 2. 启动命令行重建
{
  const windows = launchArgv(
    ['node.exe', 'C:\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', 'web', '--no-open'],
    'C:\\node\\node.exe',
    [],
    'win32',
  )
  assert.equal(windows.viaShell, false)
  assert.equal(windows.file, 'C:\\node\\node.exe')
  assert.deepEqual(windows.args.slice(-2), ['web', '--no-open'])
  assert.match(windows.args.at(-3), /bin\.js$/u)
  const posix = launchArgv(['node', '/usr/local/bin/dsh', 'web'], '/usr/bin/node', [], 'linux')
  assert.equal(posix.args.at(-1), 'web')
  const bare = launchArgv(['node', '/somewhere/entry.js'], 'node', [], 'win32')
  assert.equal(bare.file, 'dsh')
  assert.equal(bare.viaShell, true)
  const wrapped = respawnInvocation({ file: 'dsh', args: ['web'], viaShell: true }, 'win32')
  assert.equal(wrapped.file, 'powershell.exe')
  assert.match(wrapped.args.at(-1), /dsh\.cmd/u)

  // 真实宿主命令行必须走隐藏窗口包装；含双引号或 % 的复杂参数退回直接 detached 启动，
  // 以换取参数保真（PowerShell 会重新解析 -Command 的字符串）。
  const real = respawnInvocation({
    file: 'E:\\env\\nodejs\\node.exe',
    args: ['C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', 'web', '--no-open'],
    viaShell: false,
  }, 'win32')
  assert.equal(real.file, 'powershell.exe')
  assert.equal(real.detached, false)
  const complex = respawnInvocation({ file: 'node.exe', args: ['-e', 'a="b"'], viaShell: false }, 'win32')
  assert.equal(complex.file, 'node.exe')
  assert.equal(complex.detached, true)
  check('启动命令行重建与平台包装')
}

// 3. 挂载并检查工具、命令、提示段与路由定义
const { ctx, tools, routes, commands, sections } = fakeContext()
apply(ctx, { markerDir: join(root, 'markers'), readyDelayMs: 0, idleTimeoutMs: 5000, dryRun: true })
assert.equal(tools.length, 1)
const tool = tools[0]
assert.equal(tool.name, 'restart_self')
assert.match(tool.description, /用户要求重启 dsh/u, '描述必须写明触发条件，否则模型只会偶然用到它')
assert.equal(tool.parameters.type, 'object')
assert.equal(tool.output.schema.additionalProperties, false)
assert.deepEqual(
  tool.output.schema.required,
  ['ok', 'restarted', 'pid', 'sessionId', 'deliverAfterRestart', 'timing', 'note', 'logPath'],
)
assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])
assert.equal(routes.length, 1)
assert.equal(routes[0].path, '/dsh-self-restart')
assert.equal(commands.length, 1)
assert.equal(commands[0].name, 'restart')
assert.equal(typeof commands[0].handler, 'function')
assert.equal(sections.length, 1)
assert.equal(sections[0].name, 'tool:restart-self')
assert.match(sections[0].text, /restart_self/u)
check('工具、命令、提示段与路由注册')

// 4. 工具执行写入标记，重复执行只保留一条
const config = normalizeConfig({ markerDir: join(root, 'markers') })
const file = markerFile(config)
{
  const exec = { agent: { session: { id: 'session-1' }, whenIdle: () => Promise.resolve() } }
  const first = await tool.execute({}, exec)
  assert.equal(first.ok, true)
  assert.equal(first.sessionId, 'session-1')
  // 调用当时进程仍在运行：这一位是「不要把已排程说成已重启」的唯一依据
  assert.equal(first.restarted, false)
  assert.equal(first.deliverAfterRestart, '已重启')
  assert.match(first.note, /尚未重启/u)
  assert.equal(first.timing.portWaitMs, 30000)
  assert.equal(first.timing.afterTurnMs, 0, '取自测试配置的 readyDelayMs')
  assert.match(first.logPath, /dsh-self-restart-.*\.err\.log$/u)
  const second = await tool.execute({ message: '再次' }, exec)
  assert.equal(second.deliverAfterRestart, '已重启', '同一进程只调度一次，重复调用回报首条信息')
  assert.match(second.note, /已排程/u)
  const entries = readEntries(file, config.maxAgeMs)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].sessionId, 'session-1')
  assert.equal(entries[0].source, 'restart_self')
  const custom = await tool.execute({ message: '  ' }, exec)
  assert.equal(custom.deliverAfterRestart, '已重启', '空白参数回退到配置默认值')
  check('工具写入标记、未重启声明、幂等调度与参数回退')
}

// 5. 无调用智能体与停用配置均失败
{
  await assert.rejects(() => tool.execute({}, {}), /requires a calling agent/u)
  const off = fakeContext()
  apply(off.ctx, { markerDir: join(root, 'off'), allowRestart: false })
  await assert.rejects(
    () => off.tools[0].execute({}, { agent: { session: { id: 's' }, whenIdle: () => Promise.resolve() } }),
    /disabled by config/u,
  )
  check('缺少智能体与停用配置的失败路径')
}

// 6. `/restart` 命令：无参数用配置默认值，带参数用输入文本
{
  const fresh = fakeContext()
  apply(fresh.ctx, { markerDir: join(root, 'cmd'), readyDelayMs: 0, idleTimeoutMs: 5000, dryRun: true })
  const command = fresh.commands[0]
  const agent = { session: { id: 'session-cmd' }, whenIdle: () => Promise.resolve() }
  const settled = await command.handler({ agent, rawInput: '  ' })
  assert.equal(settled.kind, 'success')
  assert.match(settled.text, /已重启/u)
  const entries = readEntries(markerFile(normalizeConfig({ markerDir: join(root, 'cmd') })), 600000)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].sessionId, 'session-cmd')

  const off = fakeContext()
  apply(off.ctx, { markerDir: join(root, 'cmd-off'), allowRestart: false })
  const refused = await off.commands[0].handler({ agent, rawInput: '' })
  assert.equal(refused.kind, 'error')
  check('命令写入标记与停用分支')
}

// 7. 接口：本进程写下的标记不可见，外来标记可见且可删
{
  const handler = routes[0].handler

  // 本进程写的标记必须隐藏：否则前端会在重启发生前就投递，
  // 消息被塞进旧 agent 的内存队列并随进程消失（真实故障）。
  const own = fakeResponse()
  await handler({ url: '/dsh-self-restart/api/pending', method: 'GET' }, own)
  assert.equal(own.status, 200)
  assert.deepEqual(JSON.parse(own.body).entries, [], '本进程写下的标记不得对外暴露')

  // 模拟上一个进程留下的标记：pid 不同即视为可投递
  writeEntries(file, [{
    id: 'from-previous-boot',
    sessionId: 'session-1',
    message: '已重启',
    scheduledAt: Date.now(),
    pid: process.pid + 1,
    source: 'restart_self',
  }])
  const foreign = fakeResponse()
  await handler({ url: '/dsh-self-restart/api/pending', method: 'GET' }, foreign)
  const listed = JSON.parse(foreign.body)
  assert.equal(listed.entries.length, 1)
  assert.deepEqual(Object.keys(listed.entries[0]).sort(), ['id', 'message', 'scheduledAt', 'sessionId'])

  const missing = fakeResponse()
  await handler(fakePostRequest('/dsh-self-restart/api/done', {}), missing)
  assert.equal(missing.status, 400)

  const done = fakeResponse()
  await handler(fakePostRequest('/dsh-self-restart/api/done', { id: listed.entries[0].id }), done)
  assert.equal(done.status, 200)
  assert.equal(JSON.parse(done.body).removed, 1)
  assert.equal(readEntries(file, config.maxAgeMs).length, 0)

  const unknown = fakeResponse()
  await handler({ url: '/dsh-self-restart/api/nope', method: 'GET' }, unknown)
  assert.equal(unknown.status, 404)
  check('标记的写入者隔离、读取、删除与错误分支')
}

// 8. 超期条目被剔除，损坏文件被隔离
{
  const expiredFile = join(root, 'markers', 'expired.json')
  writeEntries(expiredFile, [
    { id: 'old', sessionId: 's', message: 'x', scheduledAt: Date.now() - 10_000, source: 'restart_self' },
    { id: 'fresh', sessionId: 's', message: 'y', scheduledAt: Date.now(), source: 'restart_self' },
  ])
  const kept = readEntries(expiredFile, 1000)
  assert.deepEqual(kept.map(entry => entry.id), ['fresh'])
  assert.deepEqual(
    JSON.parse(readFileSync(expiredFile, 'utf8')).entries.map(entry => entry.id),
    ['fresh'],
    '剔除结果回写文件',
  )

  const brokenFile = join(root, 'markers', 'broken.json')
  writeFileSync(brokenFile, '{not json')
  assert.deepEqual(readEntries(brokenFile, 1000), [])
  assert.equal(existsSync(`${brokenFile}.bad`), true)
  check('超期剔除与损坏隔离')
}

// 9. 进程替换链路：helper 真实拉起一个子进程
{
  const marker = join(root, 'replaced.txt')
  const logs = { out: join(root, 'helper.out.log'), err: join(root, 'helper.err.log') }
  const spawned = {
    file: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`],
    viaShell: false,
    detached: true,
  }
  const source = helperSource(spawned, { cwd: process.cwd() }, logs, null)
  spawn(process.execPath, ['-e', source], { detached: true, stdio: 'ignore' }).unref()

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !existsSync(marker)) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(existsSync(marker), true, 'helper 必须能拉起替换进程')
  assert.match(readFileSync(logs.err, 'utf8'), /replacement started \(pid/u)
  check('helper 拉起替换进程')
}

console.log(`\n${passed} 项自检通过`)
