// 离线自测：不需要启动 DSH，也不联网合成。
//
// 覆盖：配置存储的合并/脱敏/导入投影、HTTP 路由的注册与鉴权细节、
// 工具定义与 execute 的边界、OneBot 目标解析与限流、tts-lib 关键推导。
//
// 跑法：node test/standalone.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  buildImportPatch,
  configPathOf,
  defaultSettings,
  maskKey,
  mergeSettings,
  readSettings,
  saveSettings,
} from '../lib/config.js'
import { registerRoutes } from '../lib/routes.js'
import { registerTools } from '../lib/tools.js'
import {
  actionUrl,
  budgetCheck,
  budgetCommit,
  callOneBot,
  detectedPrefix,
  encodeHeaderValue,
  findNonAscii,
  hasActionPrefix,
  isLocalGateway,
  looksLikeCrossMachineMissingFile,
  looksLikeOneBot,
  looksLikeSnowLumaWebui,
  pingOneBot,
  RECORD_FILE_MODES,
  resolveOneBot,
  sanitizeOnebot,
  sendVoiceRecord,
  targetToParams,
} from '../lib/onebot.js'
import {
  OFFICIAL_MODELS,
  PRESET_VOICES,
  describeTtsConfig,
  guessModeForModel,
  measureWavSpeech,
  mimeFromFormat,
  reconcileModeModel,
  resolveRouteStyle,
  resolveVoiceValue,
  saveRefAudio,
  ttsCfg,
} from '../lib/tts-lib.js'

/* ------------------------------------------------------------------ harness */

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${error?.stack ?? error}`)
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-test-'))
const logger = { info() {}, warn() {}, error() {}, list: () => [] }

// 预先落一份默认配置，避免 readSettings 去探测真实 qq-bridge 配置做自动导入。
fs.mkdirSync(path.dirname(configPathOf(home)), { recursive: true })
fs.writeFileSync(configPathOf(home), `${JSON.stringify(defaultSettings(), null, 2)}\n`, 'utf8')

const deps = {
  home,
  logger,
  getSettings: () => readSettings(home),
}

const routes = new Map()
const scope = {
  webServer: {
    register(route) {
      assert.equal(route.kind, 'exact')
      routes.set(route.path, route.handler)
      return () => {}
    },
  },
}
registerRoutes(scope, deps)

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const handler = routes.get(pathname)
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'no route' }))
    return
  }
  void handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function req(method, pathname, { body, headers } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(headers ?? {}),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {}
  return { status: response.status, payload, text }
}

/* ------------------------------------------------------------- 路由注册面 */

await test('注册了全部 /dsh-tts 路由且形状合法', () => {
  const expected = [
    '/dsh-tts/state',
    '/dsh-tts/config',
    '/dsh-tts/models',
    '/dsh-tts/voices',
    '/dsh-tts/preview',
    '/dsh-tts/audio',
    '/dsh-tts/ref-audio',
    '/dsh-tts/clone',
    '/dsh-tts/clear-ref',
    '/dsh-tts/ref-backup',
    '/dsh-tts/fetch-audio',
    '/dsh-tts/speak',
    '/dsh-tts/ping',
    '/dsh-tts/import',
    '/dsh-tts/log',
  ]
  for (const pathname of expected) assert.ok(routes.has(pathname), `缺少路由 ${pathname}`)
})

await test('GET /state 返回插件状态', async () => {
  const { status, payload } = await req('GET', '/dsh-tts/state')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.enabled, true)
  assert.equal(payload.hasApiKey, false)
  assert.equal(payload.model, 'mimo-v2.5-tts')
  assert.equal(payload.mode, 'preset')
})

await test('GET /config 返回描述、存储位置与脱敏 curl', async () => {
  const { status, payload } = await req('GET', '/dsh-tts/config')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.officialModels.length, 3)
  assert.equal(payload.presetVoices.length, 9)
  assert.ok(payload.storage.configPath.endsWith(path.join('dsh-tts', 'config.json')))
  assert.equal(typeof payload.curl, 'string')
  assert.ok(payload.onebot && typeof payload.onebot.httpUrl === 'string')
})

await test('GET /config 的密钥只出现脱敏提示', async () => {
  saveSettings(home, { tts: { apiKey: 'sk-test-1234567890abcdef' } })
  const { payload } = await req('GET', '/dsh-tts/config')
  assert.equal(payload.apiKeySet, true)
  assert.ok(String(payload.apiKeyHint).length > 0)
  assert.ok(!JSON.stringify(payload).includes('sk-test-1234567890abcdef'))
  saveSettings(home, { tts: { apiKey: '' } })
})

await test('GET /audio 拒绝非法 id（路径穿越）', async () => {
  const { status, payload } = await req('GET', '/dsh-tts/audio?id=../../etc/passwd')
  assert.ok(status === 400 || status === 404, `unexpected status ${status}`)
  assert.equal(payload.ok, false)
})

await test('GET /ref-audio 在无参考音频时 404', async () => {
  const { status } = await req('GET', '/dsh-tts/ref-audio?kind=clone')
  assert.equal(status, 404)
})

await test('未知的 /dsh-tts 路径落到 404（不吞其它路由）', async () => {
  const { status } = await req('GET', '/dsh-tts/nope')
  assert.equal(status, 404)
})

/* ------------------------------------------------------------- 配置写入面 */

await test('POST /config 局部更新音色后立即生效', async () => {
  const { status, payload } = await req('POST', '/dsh-tts/config', { body: { tts: { voice: '苏打' } } })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.voice, '苏打')
  const state = await req('GET', '/dsh-tts/state')
  assert.equal(state.payload.voice, '苏打')
  assert.equal(readSettings(home).settings.tts.enabled, true)
})

await test('POST /config 把 routeMode=auto 归一成 smart', async () => {
  const { payload } = await req('POST', '/dsh-tts/config', { body: { tts: { routeMode: 'auto' } } })
  assert.equal(payload.routeMode, 'smart')
})

await test('POST /config 拒绝非法 routeMode', async () => {
  const { status, payload } = await req('POST', '/dsh-tts/config', { body: { tts: { routeMode: 'bogus' } } })
  assert.equal(status, 400)
  assert.equal(payload.ok, false)
})

// 用户 m03329 明确要求的分界语义：
// 字数 >= 分界 或 估算时长 >= 分界 → 走小米；两个都没到 → 按合成延迟自动选。
await test('智能分界：达到字数或时长任一阈值就走小米，都没到才按延迟挑边', async () => {
  const mk = (over) => ttsCfg({
    routeMode: 'smart',
    apiStyle: 'openai',
    lengthThreshold: 50,
    durationThreshold: 10,
    baseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    apiKey: 'sk-mimo',
    model: 'mimo-v2.5-tts',
    breeze: { baseUrl: 'https://api.breeze.blue/v1', apiKey: 'brz', model: 'breeze-tts-2', voice: 'voc_1' },
    ...over,
  }, { rootDir: home })

  const longText = '一'.repeat(50) // 正好等于字数分界 → 走小米
  assert.equal(resolveRouteStyle(mk(), { text: longText }), 'openai', '达到字数分界应走小米')
  // 时长分界：4 字/秒，40 字 ≥ 10 秒 → 走小米（字数未到达 50 但时长到了）
  assert.equal(resolveRouteStyle(mk(), { text: '一'.repeat(40) }), 'openai', '达到时长分界应走小米')
  // 两个都没到：交给延迟判定。让 Breeze 更快 → 应选 breeze
  const latency = { breeze: { avgMs: 800 }, mimo: { avgMs: 3000 } }
  assert.equal(resolveRouteStyle(mk(), { text: '一'.repeat(10), latency }), 'breeze', '短文本且 Breeze 更快时应走 Breeze')
  const latency2 = { breeze: { avgMs: 4000 }, mimo: { avgMs: 900 } }
  assert.equal(resolveRouteStyle(mk(), { text: '一'.repeat(10), latency: latency2 }), 'openai', '短文本且小米更快时应走小米')
  // 边界：刚好少一个字，且时长也没到 → 不进小米分支，走延迟
  assert.equal(resolveRouteStyle(mk(), { text: '一'.repeat(39), latency }), 'breeze', '39 字（时长 9.75s < 10）不应强制小米')
})

await test('智能分界：AI 主动发语音与普通合成走同一套判定（speak 与 synthesize 同源）', async () => {
  // speak() 与 synthesize() 都调用 resolveRouteStyle(cfg, { text })，所以只要验证
  // 「相同文本 + 相同配置 → 相同路由」，就能保证 AI 主动语音不会另走一套。
  const cfg = ttsCfg({
    routeMode: 'smart',
    lengthThreshold: 20,
    durationThreshold: 5,
    baseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    apiKey: 'sk-mimo',
    model: 'mimo-v2.5-tts',
    breeze: { baseUrl: 'https://api.breeze.blue/v1', apiKey: 'brz', model: 'breeze-tts-2', voice: 'voc_1' },
  }, { rootDir: home })
  const long = '一'.repeat(30)
  // synthesize 内部：resolveRouteStyle(baseCfg, { sing, text: body })
  assert.equal(resolveRouteStyle(cfg, { text: long, sing: false }), 'openai')
  // speak 内部：resolveRouteStyle(tts, { text: body, sing: sing === true })
  assert.equal(resolveRouteStyle(cfg, { text: long, sing: false }), 'openai')
  // 唱歌永远走小米（Breeze 无唱歌参数），这条不受分界影响
  assert.equal(resolveRouteStyle(cfg, { text: '短', sing: true }), 'openai')
})

await test('POST /config 把越界 maxChars 夹到合法区间', async () => {
  const { status, payload } = await req('POST', '/dsh-tts/config', { body: { tts: { maxChars: 10 } } })
  assert.equal(status, 200)
  assert.equal(payload.maxChars, 20)
  await req('POST', '/dsh-tts/config', { body: { tts: { maxChars: 2000 } } })
})

await test('POST /config 拒绝非 JSON content-type（CSRF 防护）', async () => {
  const response = await fetch(`${base}/dsh-tts/config`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ tts: { voice: 'x' } }),
  })
  assert.equal(response.status, 415)
})

await test('POST /config 拒绝跨站 Origin', async () => {
  const { status } = await req('POST', '/dsh-tts/config', {
    body: { tts: { voice: 'x' } },
    headers: { origin: 'http://evil.example.com' },
  })
  assert.equal(status, 403)
})

await test('保存后 apiKey 不回显（只在 hasApiKey 里体现）', async () => {
  await req('POST', '/dsh-tts/config', { body: { tts: { apiKey: 'sk-abcdefghijklmnop' } } })
  const { payload } = await req('GET', '/dsh-tts/state')
  assert.equal(payload.hasApiKey, true)
  assert.ok(String(payload.apiKeyHint).length > 0)
  assert.ok(!String(payload.apiKeyHint).includes('sk-abcdefghijklmnop'))
  await req('POST', '/dsh-tts/config', { body: { tts: { apiKey: '' } } })
})

await test('POST /config 的 onebot 补丁不会误清空 token', async () => {
  await req('POST', '/dsh-tts/config', { body: { onebot: { accessToken: 'tok-1' } } })
  await req('POST', '/dsh-tts/config', { body: { onebot: { httpUrl: 'http://127.0.0.1:3000' } } })
  const stored = readSettings(home).settings.onebot
  assert.equal(stored.accessToken, 'tok-1')
  assert.equal(stored.httpUrl, 'http://127.0.0.1:3000')
  await req('POST', '/dsh-tts/config', { body: { onebot: { accessToken: '' } } })
})

await test('GET /log 返回最近日志数组', async () => {
  const { status, payload } = await req('GET', '/dsh-tts/log')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.ok(Array.isArray(payload.log))
})

await test('POST /import 在没有可用来源时报错但结构可读', async () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-import-'))
  fs.mkdirSync(path.join(isolated, 'dsh-tts'), { recursive: true })
  fs.writeFileSync(configPathOf(isolated), `${JSON.stringify(defaultSettings(), null, 2)}\n`, 'utf8')
  const local = new Map()
  registerRoutes(
    { webServer: { register(r) { local.set(r.path, r.handler); return () => {} } } },
    { home: isolated, logger, getSettings: () => readSettings(isolated) },
  )
  const srv = http.createServer((rq, rs) => {
    const handler = local.get(new URL(rq.url, 'http://x').pathname)
    if (handler) void handler(rq, rs)
    else { rs.writeHead(404); rs.end('{}') }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/dsh-tts/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    // 这台机器上存在 qq-bridge 源码配置，所以可能成功；只要求响应是合法 JSON 且有 ok 字段。
    const payload = await res.json()
    assert.equal(typeof payload.ok, 'boolean')
  } finally {
    srv.close()
  }
})

/* ------------------------------------------------------------------ tools */

await test('registerTools 注册 tts_speak 与 tts_voices', () => {
  const defs = []
  const ctx = {
    tools: { register(def) { defs.push(def); return () => {} } },
  }
  const dispose = registerTools(ctx, deps)
  assert.equal(typeof dispose, 'function')
  assert.equal(defs.length, 2)
  const speakDef = defs.find((d) => d.name === 'tts_speak')
  const voicesDef = defs.find((d) => d.name === 'tts_voices')
  assert.ok(speakDef && voicesDef)
  assert.deepEqual(speakDef.parameters.required, ['text'])
  assert.equal(typeof speakDef.execute, 'function')
  assert.equal(typeof speakDef.output.render, 'function')
  assert.ok(speakDef.description.includes('OneBot'))
  assert.ok(speakDef.description.includes('唱歌'))
  dispose()
})

await test('tts_voices.execute 返回音色与通道状态（不联网）', async () => {
  const defs = []
  registerTools({ tools: { register(d) { defs.push(d); return () => {} } } }, deps)
  const payload = JSON.parse(await defs.find((d) => d.name === 'tts_voices').execute({}))
  assert.equal(payload.ok, true)
  assert.equal(payload.voices.length, 9)
  assert.equal(payload.model, 'mimo-v2.5-tts')
  assert.ok(payload.onebot && typeof payload.onebot.httpUrl === 'string')
})

await test('tts_speak.execute 拒绝空文本（不产生网络请求）', async () => {
  const defs = []
  registerTools({ tools: { register(d) { defs.push(d); return () => {} } } }, deps)
  const payload = JSON.parse(await defs.find((d) => d.name === 'tts_speak').execute({ text: '   ' }))
  assert.equal(payload.ok, false)
  assert.match(payload.error, /text/)
})

/* ----------------------------------------------------------------- onebot */

await test('targetToParams 解析 group / private 目标', () => {
  assert.deepEqual(targetToParams('group:12345'), { kind: 'group', id: '12345', key: 'group:12345' })
  assert.deepEqual(targetToParams('private:123456789'), {
    kind: 'private',
    id: '123456789',
    key: 'private:123456789',
  })
  assert.throws(() => targetToParams('12345'))
  assert.throws(() => targetToParams('group:0'))
  assert.throws(() => targetToParams('room:1'))
})

/* ------------------------- 跨机器发语音：路径 vs base64（0.3.10 回归） */
//
// 现场（0.3.9，别处安装）：
//   音频已经合成好了，但发送失败：OneBot send_private_msg 失败：
//   ENOENT: no such file or directory, stat
//   'C:\Users\<你>\.dsh\dsh-tts\voice\tts-mvv0lvah-8f49f2.wav'
// 根因：插件装在 A 机、OneBot 在 B 机（远程网关）。
// record 段填的是 **A 机**的绝对路径，B 机的 OneBot 去 stat 当然找不到。
// 修法：跨机器时用 `base64://` 内联发送，数据随请求走，对端不需要读我们的磁盘。

await test('isLocalGateway 认得出本机回环地址，别的一律算远程', () => {
  assert.equal(isLocalGateway('http://127.0.0.1:3000'), true)
  assert.equal(isLocalGateway('http://localhost:3000'), true)
  assert.equal(isLocalGateway('http://[::1]:3000'), true)
  // 局域网与公网都算远程
  assert.equal(isLocalGateway('http://192.0.2.10:3000'), false)
  assert.equal(isLocalGateway('http://203.0.113.7:3000'), false)
  assert.equal(isLocalGateway('not a url'), false)
})

await test('跨机器发送自动改用 base64，不再把本机路径发给远端', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-b64-'))
  const file = path.join(dir, 'tts-demo.wav')
  const payload = Buffer.from('RIFFxxxxWAVE-demo-audio')
  fs.writeFileSync(file, payload)

  const seen = []
  const srv = http.createServer((rq, rs) => {
    let acc = ''
    rq.on('data', (c) => { acc += c })
    rq.on('end', () => {
      seen.push(acc)
      rs.writeHead(200, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    // 注意：用 127.0.0.1 会被判成「本机」。这里显式强制 base64 来模拟远程行为。
    const conn = { httpUrl: `http://127.0.0.1:${srv.address().port}`, accessToken: '', source: 'test' }
    const sent = await sendVoiceRecord(conn, { kind: 'private', id: '123', key: 'private:123' }, file, { fileMode: 'base64' })
    assert.equal(sent.fileMode, 'base64')
    const body = JSON.parse(seen[0])
    const fileField = body.message[0].data.file
    assert.ok(fileField.startsWith('base64://'), `必须是 base64:// 形式，实际：${String(fileField).slice(0, 30)}`)
    // 解出来的字节必须和原文件一模一样
    assert.deepEqual(Buffer.from(fileField.slice('base64://'.length), 'base64'), payload)
    // 绝不能出现本机绝对路径
    assert.ok(!fileField.includes(dir), '不能把本机路径发给远端')
  } finally {
    srv.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('本机网关 + auto 模式仍用路径（省掉一大段 base64）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-path-'))
  const file = path.join(dir, 'tts-demo.wav')
  fs.writeFileSync(file, Buffer.from('RIFFxxxxWAVE'))

  const seen = []
  const srv = http.createServer((rq, rs) => {
    let acc = ''
    rq.on('data', (c) => { acc += c })
    rq.on('end', () => {
      seen.push(acc)
      rs.writeHead(200, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 } }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const conn = { httpUrl: `http://127.0.0.1:${srv.address().port}`, accessToken: '', source: 'test' }
    // auto + 本机回环 → 走路径
    const sent = await sendVoiceRecord(conn, { kind: 'private', id: '1', key: 'private:1' }, file, { fileMode: 'auto' })
    assert.equal(sent.fileMode, 'path')
    const body = JSON.parse(seen[0])
    assert.equal(body.message[0].data.file, file)
  } finally {
    srv.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('looksLikeCrossMachineMissingFile 认得出 ENOENT 这类「远端读不到本机文件」', () => {
  assert.equal(looksLikeCrossMachineMissingFile(
    "OneBot send_private_msg 失败：ENOENT: no such file or directory, stat 'C:\\Users\\tester\\.dsh\\dsh-tts\\voice\\tts-x.wav'",
  ), true)
  assert.equal(looksLikeCrossMachineMissingFile('connection refused'), false)
})

await test('RECORD_FILE_MODES 只含三个合法值，非法值回落 auto', async () => {
  assert.deepEqual(RECORD_FILE_MODES, ['auto', 'path', 'base64'])
  // 传非法值时不该崩，按 auto 处理
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-mode-'))
  const file = path.join(dir, 'tts-demo.wav')
  fs.writeFileSync(file, Buffer.from('RIFFxxxxWAVE'))
  const srv = http.createServer((rq, rs) => {
    rq.resume()
    rq.on('end', () => {
      rs.writeHead(200, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const conn = { httpUrl: `http://127.0.0.1:${srv.address().port}`, accessToken: '', source: 'test' }
    const sent = await sendVoiceRecord(conn, { kind: 'private', id: '1', key: 'private:1' }, file, { fileMode: 'bogus' })
    assert.equal(sent.fileMode, 'path', '非法 fileMode 回落 auto，本机网关即走 path')
  } finally {
    srv.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('budgetCheck 按分钟限流，budgetCommit 记录占用', () => {
  const key = `group:${Date.now()}`
  const cfg = { maxPerMinute: 2, maxPerHour: 10 }
  budgetCheck(key, cfg)
  budgetCommit(key)
  budgetCheck(key, cfg)
  budgetCommit(key)
  assert.throws(() => budgetCheck(key, cfg), /分钟|限流|太快/)
})

/* ---------------------------------------- /api 前缀探测（0.3.6 回归） */
//
// 现场错误（0.3.5，别处安装，网关 http://192.0.2.10:5099）：
//   ① 【测试连接】点了没任何反馈；
//   ② 【发到QQ】报「音频已经合成好了，但发送失败：OneBot send_private_msg
//      返回的不是 JSON（HTTP 404）：404 Not Found」。
// 实测那台网关：POST /get_login_info → 404 纯文本，POST /api/get_login_info → 401 JSON，
// GET / → HTML 首页。也就是说它是「action 挂在 /api 下」的部署，而插件一直拼 /<action>。

await test('hasActionPrefix 认得 /api 与 /api/v1，不把普通路径误判', () => {
  assert.equal(hasActionPrefix('http://127.0.0.1:3000'), false)
  assert.equal(hasActionPrefix('http://127.0.0.1:3000/'), false)
  assert.equal(hasActionPrefix('http://127.0.0.1:5099/api'), true)
  assert.equal(hasActionPrefix('http://127.0.0.1:5099/api/'), true)
  assert.equal(hasActionPrefix('http://127.0.0.1:5099/api/v1'), true)
  // 用户填了 /api/xxx 这种完整 action 地址时，不该被判成前缀（那是配置错误，另行报错）
  assert.equal(hasActionPrefix('http://127.0.0.1:5099/apix'), false)
  assert.equal(hasActionPrefix('not a url'), false)
})

await test('actionUrl 拼接自动去重斜杠', () => {
  assert.equal(actionUrl('http://h:1', 'get_login_info'), 'http://h:1/get_login_info')
  assert.equal(actionUrl('http://h:1/', 'get_login_info'), 'http://h:1/get_login_info')
  assert.equal(actionUrl('http://h:1', 'get_login_info', '/api'), 'http://h:1/api/get_login_info')
  assert.equal(actionUrl('http://h:1', '/get_login_info'), 'http://h:1/get_login_info')
})

await test('无前缀网关：一次成功，不多打一次 /api', async () => {
  const hits = []
  const srv = http.createServer((rq, rs) => {
    hits.push(rq.url)
    rs.writeHead(200, { 'content-type': 'application/json' })
    rs.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 7, nickname: '普通号' } }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const conn = { httpUrl: `http://127.0.0.1:${srv.address().port}`, accessToken: '', source: 'test' }
    const info = await pingOneBot(conn, { timeoutMs: 5000 })
    assert.equal(info.nickname, '普通号')
    assert.equal(info.actionPrefix, '')
    assert.deepEqual(hits, ['/get_login_info'])
  } finally {
    srv.close()
  }
})

await test('/api 前缀网关：自动改走 /api 并记住（第二次不再试错）', async () => {
  const hits = []
  const srv = http.createServer((rq, rs) => {
    hits.push(rq.url)
    if (String(rq.url).startsWith('/api/')) {
      rs.writeHead(200, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 42, nickname: '前缀号' } }))
      return
    }
    // 复刻现场：POST 到没挂 action 的路径回纯文本 404
    rs.writeHead(404, { 'content-type': 'text/plain' })
    rs.end('404 Not Found')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const conn = { httpUrl: `http://127.0.0.1:${srv.address().port}`, accessToken: '', source: 'test' }
    const info = await pingOneBot(conn, { timeoutMs: 5000 })
    assert.equal(info.nickname, '前缀号')
    assert.equal(info.actionPrefix, '/api')
    assert.deepEqual(hits, ['/get_login_info', '/api/get_login_info'])
    // 第二次命中缓存：只打 /api，不再先撞一次 404
    hits.length = 0
    await pingOneBot(conn, { timeoutMs: 5000 })
    assert.deepEqual(hits, ['/api/get_login_info'])
  } finally {
    srv.close()
  }
})

await test('打到 Web 前端（200 + HTML）也认成「路径上没有 action」，继续换 /api', async () => {
  const hits = []
  const srv = http.createServer((rq, rs) => {
    hits.push(rq.url)
    if (String(rq.url).startsWith('/api/')) {
      rs.writeHead(200, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 1, nickname: 'SPA 后' } }))
      return
    }
    // 复刻现场：GET/POST 到前端路由都吐 index.html
    rs.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' })
    rs.end('<!doctype html><html></html>')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const conn = { httpUrl: `http://127.0.0.1:${srv.address().port}`, accessToken: '', source: 'test' }
    const info = await pingOneBot(conn, { timeoutMs: 5000 })
    assert.equal(info.nickname, 'SPA 后')
    assert.equal(info.actionPrefix, '/api')
  } finally {
    srv.close()
  }
})

await test('地址已带 /api 时不额外探测，直接打一次', async () => {
  const hits = []
  const srv = http.createServer((rq, rs) => {
    hits.push(rq.url)
    rs.writeHead(200, { 'content-type': 'application/json' })
    rs.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 3, nickname: '显式' } }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const base = `http://127.0.0.1:${srv.address().port}/api`
    const info = await pingOneBot({ httpUrl: base, accessToken: '', source: 'test' }, { timeoutMs: 5000 })
    assert.equal(info.nickname, '显式')
    assert.deepEqual(hits, ['/api/get_login_info'])
  } finally {
    srv.close()
  }
})

await test('两边都没有 action（真打错端口）时报路径错误，不谎报成功', async () => {
  const srv = http.createServer((rq, rs) => {
    rs.writeHead(404, { 'content-type': 'text/plain' })
    rs.end('404 Not Found')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const conn = { httpUrl: `http://127.0.0.1:${srv.address().port}`, accessToken: '', source: 'test' }
    await assert.rejects(
      () => callOneBot(conn, 'send_private_msg', {}),
      (error) => {
        // 关键：不能再出现「返回的不是 JSON（HTTP 404）：404 Not Found」这种半截话
        assert.match(error.message, /路径上不是一个 action|连不上/)
        assert.ok(!/返回的不是 JSON（HTTP 404）/.test(error.message), '旧的半截报错不该再出现')
        return true
      },
    )
  } finally {
    srv.close()
  }
})

/* ---------------- SnowLuma 同端口并存 WebUI 与 OneBot（0.3.9 回归） */
//
// 这条踩了三轮才看清，实测某台部署的 5099：
//   POST /api/login           → {"success":false,"message":"密码错误"}   ← WebUI 登录（密码）
//   POST /api/get_login_info  → {"status":"failed","message":"Token expired or invalid"}
//   POST /api/get_status      → 同上
//   POST /get_login_info      → 404 Not Found                            ← 无前缀没有 action
// 决定性证据是「加不加 Bearer 响应不同」：
//   不带 Authorization → Unauthorized
//   带任意 Bearer      → Token expired or invalid
// 只有真在读 Authorization 做鉴权才会这样，所以 /api/get_* 是 **OneBot action**，
// 不是 WebUI 内部接口。用户的 5099 配置本来就是对的。
// 0.3.8 我把 `{"status":"failed","message":"Token expired or invalid"}`
// 当成了「WebUI 面板」的铁证，差点让人去改成 3000——那是错的，这里固化成测试。

await test('只有 {"success":false} 才算 WebUI 登录接口；status/message 不算', () => {
  // WebUI 登录失败的唯一铁证
  assert.equal(looksLikeSnowLumaWebui({ success: false, message: '密码错误' }), true)
  // 下面这些实测来自 /api/get_* 的 OneBot action，不能判成 WebUI
  assert.equal(looksLikeSnowLumaWebui({ status: 'failed', message: 'Token expired or invalid' }), false)
  assert.equal(looksLikeSnowLumaWebui({ status: 'failed', message: 'Unauthorized' }), false)
  // 标准 OneBot 形状
  assert.equal(looksLikeOneBot({ status: 'ok', retcode: 0, data: {} }), true)
  assert.equal(looksLikeSnowLumaWebui({ status: 'ok', retcode: 0 }), false)
  // 空值不误判
  assert.equal(looksLikeOneBot(null), false)
  assert.equal(looksLikeSnowLumaWebui(null), false)
})

await test('5099 那种「无前缀 404、/api 下回 Token 错误」的网关：自动走 /api 并报 Token 问题', async () => {
  const hits = []
  const srv = http.createServer((rq, rs) => {
    hits.push(rq.url)
    // 复刻实测：无前缀一律纯文本 404；/api 下是 OneBot action，token 不对就回这个
    if (String(rq.url).startsWith('/api/')) {
      rs.writeHead(401, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ status: 'failed', message: 'Token expired or invalid' }))
      return
    }
    rs.writeHead(404, { 'content-type': 'text/plain' })
    rs.end('404 Not Found')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const port = srv.address().port
    await assert.rejects(
      () => callOneBot({ httpUrl: `http://127.0.0.1:${port}`, accessToken: 'x' }, 'get_login_info'),
      (error) => {
        // 关键：这是 Token 问题，不是「端口填错」
        assert.ok(!error.notOneBot, '不能判成「这不是 OneBot」——它就是 OneBot')
        assert.match(error.message, /Token expired or invalid/)
        // 必须指向真正的排查方向
        assert.match(error.message, /access token/)
        // 不该再出现「改成 3000」这种误导
        assert.ok(!/改成.*3000/.test(error.message), '不能让人去改端口')
        return true
      },
    )
    // 确实走了 /api
    assert.ok(hits.some((u) => u.startsWith('/api/get_login_info')), `应尝试 /api 前缀，实际：${hits.join(',')}`)
  } finally {
    srv.close()
  }
})

await test('地址自带 /api 直连，不会先撞一次 404', async () => {
  const hits = []
  const srv = http.createServer((rq, rs) => {
    hits.push(rq.url)
    rs.writeHead(200, { 'content-type': 'application/json' })
    rs.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 9, nickname: '直连号' } }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const port = srv.address().port
    const info = await pingOneBot(
      { httpUrl: `http://127.0.0.1:${port}/api`, accessToken: 'x', source: 't' },
      { timeoutMs: 5000 },
    )
    assert.equal(info.nickname, '直连号')
    assert.deepEqual(hits, ['/api/get_login_info'])
  } finally {
    srv.close()
  }
})

await test('真 OneBot 的失败响应仍然照实报 retcode 与 wording', async () => {
  const srv = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'content-type': 'application/json' })
    rs.end(JSON.stringify({ status: 'failed', retcode: 1403, wording: 'token verify failed' }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const port = srv.address().port
    await assert.rejects(
      () => callOneBot({ httpUrl: `http://127.0.0.1:${port}`, accessToken: 'x' }, 'get_login_info'),
      (error) => {
        assert.ok(!error.notOneBot, '这是真 OneBot，不该标成非 OneBot')
        assert.match(error.message, /token verify failed/)
        return true
      },
    )
  } finally {
    srv.close()
  }
})

/* ------------------------------------- Token 里的非 ASCII 字符（0.3.7 回归） */
//
// 两轮相反的教训：
//   0.3.3 现场：Token 里有个全角「！」，undici 的 Headers 抛
//     Cannot convert argument to a ByteString ... 65281 ...，
//     异常又被 catch 包成「连不上 OneBot 网关」。
//   0.3.4 的错误修法：把全角标点自动转成半角 → **把用户的密码改坏了**
//     （他的 Token 本来就含「！」），网关回 401「Token expired or invalid」。
//   0.3.7 正确做法：一个字节都不动。把 UTF-8 字节映射成 latin1 字符交给 undici，
//     服务端按 UTF-8 解码即可还原原文。

await test('encodeHeaderValue 纯 ASCII 原样返回，非 ASCII 按 UTF-8 字节映射', () => {
  // 纯 ASCII 快路径：不做任何转换
  assert.equal(encodeHeaderValue('Bearer abc123'), 'Bearer abc123')
  // 全角！(U+FF01) 的 UTF-8 是 EF BC 81 → latin1 三个字符
  const mapped = encodeHeaderValue('abc！def')
  assert.equal(mapped.length, 9) // 3 + 3 + 3 字节
  assert.deepEqual([...mapped].map((c) => c.charCodeAt(0)), [97, 98, 99, 0xef, 0xbc, 0x81, 100, 101, 102])
  // 汉字同理
  assert.equal(encodeHeaderValue('密').length, 3)
  // 关键不变式：latin1 串按 UTF-8 解码能还原原文
  assert.equal(Buffer.from(mapped, 'latin1').toString('utf8'), 'abc！def')
})

await test('sanitizeOnebot 一个字符都不改，只报出 Token 里的非 ASCII 字符', () => {
  const token = 'abcdefghijk！mnop'
  const clean = sanitizeOnebot({ httpUrl: ' http://127.0.0.1:3000/ ', accessToken: token })
  // 地址只去空白与尾斜杠
  assert.equal(clean.httpUrl, 'http://127.0.0.1:3000')
  // Token 原样保留——这是用户明确要求的：「不要自动改全角/半角字符，我的密码有『！』」
  assert.equal(clean.accessToken, token)
  assert.deepEqual(clean.nonAscii, [{ index: 11, char: '！', code: 0xff01 }])
  // 纯 ASCII Token 不报任何非 ASCII
  const ascii = sanitizeOnebot({ httpUrl: 'http://127.0.0.1:3000', accessToken: 'tok' })
  assert.deepEqual(ascii.nonAscii, [])
  assert.equal(ascii.accessToken, 'tok')
})

await test('resolveOneBot 读配置时保持 Token 原文（含全角/汉字）', () => {
  const conn = resolveOneBot(
    { onebot: { httpUrl: 'http://127.0.0.1:5099', accessToken: 'abc！def密钥' } },
    home,
  )
  assert.equal(conn.source, 'plugin-config')
  // Token 一字未改
  assert.equal(conn.accessToken, 'abc！def密钥')
  assert.deepEqual(conn.nonAscii.map((f) => f.char), ['！', '密', '钥'])
})

await test('带全角 Token 的请求能真正发出去，且服务端还原出原文', async () => {
  const seen = []
  const srv = http.createServer((rq, rs) => {
    // Node 的 http 按 latin1 解码头值；按 UTF-8 还原就是客户端发的那串字节
    seen.push(Buffer.from(rq.headers.authorization ?? '', 'latin1').toString('utf8'))
    rs.writeHead(200, { 'content-type': 'application/json' })
    rs.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 1, nickname: '全角号' } }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const token = 'abc！def'
    const conn = { httpUrl: `http://127.0.0.1:${srv.address().port}`, accessToken: token, source: 'test' }
    const info = await pingOneBot(conn, { timeoutMs: 5000 })
    assert.equal(info.nickname, '全角号')
    // 关键：网关收到的就是用户那把带「！」的 Token，一个字节都没被改
    assert.equal(seen[0], `Bearer ${token}`)
    assert.ok(seen[0].includes('！'), '全角感叹号必须原样送达')
    assert.ok(!seen[0].includes('!'), '不能被偷偷换成半角 !')
  } finally {
    srv.close()
  }
})

await test('地址里的全角字符仍然硬报错（那不是密码，是配置错误）', async () => {
  await assert.rejects(
    () => callOneBot({ httpUrl: 'http://例子.com', accessToken: '' }, 'get_login_info'),
    /HTTP 地址里有非半角字符/,
  )
})

await test('POST /config 保存含全角 Token 时原样落盘，并回报 onebotNonAscii', async () => {
  const token = 'tok！abc'
  const { status, payload } = await req('POST', '/dsh-tts/config', {
    body: { onebot: { httpUrl: 'http://127.0.0.1:3000', accessToken: token } },
  })
  assert.equal(status, 200)
  assert.equal(payload.onebotNonAscii.length, 1)
  assert.equal(payload.onebotNonAscii[0].char, '！')
  // 落盘的必须还是原文——0.3.4 就是在这里把密码改成半角弄坏的
  const stored = readSettings(home).settings.onebot
  assert.equal(stored.accessToken, token)
  assert.ok(!JSON.stringify(payload).includes(token), '响应里不该回显完整 Token')
  await req('POST', '/dsh-tts/config', { body: { onebot: { accessToken: '' } } })
})

/* ------------------------------------------------------------------ config */

await test('mergeSettings 深度合并、数组替换、null 保留', () => {
  const merged = mergeSettings(
    { a: { b: 1, c: 2 }, list: [1, 2], keep: 'x' },
    { a: { b: 3 }, list: [9], ref: null },
  )
  assert.deepEqual(merged, { a: { b: 3, c: 2 }, list: [9], keep: 'x', ref: null })
})

await test('buildImportPatch 只投影 tts / onebot / voice', () => {
  const patch = buildImportPatch({
    tts: { enabled: true, model: 'mimo-v2.5-tts' },
    snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'tok' },
    socialV2: { voice: { enabled: true, maxPerMinute: 3 } },
    other: { x: 1 },
  })
  assert.deepEqual(patch.tts, { enabled: true, model: 'mimo-v2.5-tts' })
  assert.deepEqual(patch.onebot, { httpUrl: 'http://127.0.0.1:3000', accessToken: 'tok' })
  assert.equal(patch.voice.maxPerMinute, 3)
  assert.equal(patch.other, undefined)
  assert.equal(buildImportPatch(null), null)
})

await test('maskKey 永远不泄露完整密钥', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey('short'), 'sh****rt')
  assert.ok(!maskKey('sk-1234567890abcdef').includes('1234567890abcdef'))
})

await test('readSettings 在已有配置时不重复导入', () => {
  const result = readSettings(home)
  assert.equal(result.created, false)
  assert.equal(result.settings.tts.model, 'mimo-v2.5-tts')
})

await test('导入 qq-bridge 配置时把参考音频复制进插件目录', () => {
  const srcHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-qb-'))
  const qb = path.join(srcHome, 'qq-bridge')
  const cloneDir = path.join(qb, 'state', 'tts-clone')
  fs.mkdirSync(cloneDir, { recursive: true })
  const wav = path.join(cloneDir, 'clone-test.wav')
  fs.writeFileSync(wav, Buffer.alloc(64, 1))
  fs.writeFileSync(
    path.join(qb, 'config.json'),
    JSON.stringify({
      tts: {
        enabled: true,
        model: 'mimo-v2.5-tts-voiceclone',
        mode: 'clone',
        clone: { fileName: 'clone-test.wav', path: wav, mimeType: 'audio/wav', bytes: 64 },
      },
      snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'tok' },
    }),
  )
  const result = readSettings(srcHome)
  assert.equal(result.created, true)
  const meta = result.settings.tts.clone
  assert.equal(meta.fileName, 'clone-test.wav')
  assert.ok(meta.path.startsWith(path.join(srcHome, 'dsh-tts', 'state', 'tts-clone')))
  assert.ok(fs.existsSync(meta.path), '参考音频应被复制到插件数据目录')
  assert.equal(result.settings.onebot.accessToken, 'tok')
})

await test('参考音频源文件丢失时元数据被清空（不留下必错的音色）', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-gone-'))
  fs.mkdirSync(path.join(h, 'dsh-tts'), { recursive: true })
  fs.writeFileSync(
    path.join(h, 'dsh-tts', 'config.json'),
    JSON.stringify({ tts: { clone: { fileName: 'gone.wav', path: path.join(h, 'nope', 'gone.wav') } } }),
  )
  const result = readSettings(h)
  assert.deepEqual(result.settings.tts.clone, {})
})

/* ------------------------------------- 上游探活失败回归（0.2.9 bare TypeError） */

// 起一个假上游：任何请求都回 HTTP 500 纯文本。fetchModelList / fetchVoiceList
// 失败时返回 {ok:false, error}（不是抛错），routes 必须先判 ok 再取字段，
// 把真实原因转成 502 / check.error，而不是崩出
// "Cannot read properties of undefined (reading 'length')"。
const upstream = http.createServer((req, res) => {
  res.writeHead(500, { 'content-type': 'text/plain' })
  res.end('upstream boom')
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`

await test('上游 500 时 /models 返回 502 与真实错误（不再是裸 TypeError）', async () => {
  const r = await req('POST', '/dsh-tts/models', { body: { apiStyle: 'openai', baseUrl: upstreamBase, apiKey: 'k', headerTemplate: '' } })
  assert.equal(r.status, 502)
  assert.equal(r.payload.ok, false)
  assert.ok(String(r.payload.error).includes('upstream boom'), `应包含上游错误原文：${r.payload.error}`)
  assert.ok(!String(r.payload.error).includes("reading 'length'"), `不应是裸 TypeError：${r.payload.error}`)
})

await test('上游 500 时 /voices 返回 502 与真实错误', async () => {
  const r = await req('POST', '/dsh-tts/voices', { body: { apiStyle: 'breeze', baseUrl: upstreamBase, apiKey: 'k' } })
  assert.equal(r.status, 502)
  assert.equal(r.payload.ok, false)
  assert.ok(String(r.payload.error).includes('upstream boom'), `应包含上游错误原文：${r.payload.error}`)
  assert.ok(!String(r.payload.error).includes("reading 'length'"), `不应是裸 TypeError：${r.payload.error}`)
})

await test('上游 500 时 /config 的 check 报真实原因且配置本身保存成功', async () => {
  const r = await req('POST', '/dsh-tts/config', { body: { tts: { baseUrl: upstreamBase, apiKey: 'k', check: true } } })
  assert.equal(r.status, 200)
  assert.equal(r.payload.ok, true)
  assert.equal(r.payload.check.ok, false)
  assert.ok(String(r.payload.check.error).includes('upstream boom'), `应包含上游错误原文：${r.payload.check.error}`)
  assert.ok(!String(r.payload.check.error).includes("reading 'length'"), `不应是裸 TypeError：${r.payload.check.error}`)
})

upstream.close()

/* --------- 保存并检查必须打向「被点的那一套」，不能按 apiStyle 猜（0.3.13） */

// 用户实测（m00483）：Breeze 面板「拉取模型」成功，紧接着「保存并检查」却报
//   「配置已保存 · 模型检查失败：Invalid API Key」
// 根因：/config 的 check 分支用 makeTts(settings) 探活，而 makeTts 是按 **apiStyle** 投影的。
// 用户 apiStyle='openai'（上次在小米面板编辑过）、routeMode='breeze'（实际走 Breeze），
// 于是拿小米的 baseUrl（api.xiaomimimo.com）配 Breeze 的 brz_ Key 去打 → 上游必然 401。
// 修复：前端明确传 checkStyle，后端按它（或按 routeMode）投影，而不是按 apiStyle。
//
// 这里起两个假上游：mimo 只认 api-key 头、breeze 只认 xi-api-key 头，
// 各自回自己名字的模型清单。谁被打了、打对没打对，一目了然。
const fakeMimo = http.createServer((req_, res_) => {
  const key = String(req_.headers['api-key'] ?? '')
  res_.writeHead(key === 'mimo-good' ? 200 : 401, { 'content-type': 'application/json' })
  res_.end(JSON.stringify(key === 'mimo-good'
    ? { data: [{ id: 'mimo-model-a' }] }
    : { error: 'Invalid API Key' }))
})
const fakeBreeze = http.createServer((req_, res_) => {
  const key = String(req_.headers['xi-api-key'] ?? '')
  res_.writeHead(key === 'brz-good' ? 200 : 401, { 'content-type': 'application/json' })
  res_.end(JSON.stringify(key === 'brz-good'
    ? { models: [{ model_id: 'breeze-model-a' }] }
    : { error: 'Invalid API Key' }))
})
await new Promise((resolve) => fakeMimo.listen(0, '127.0.0.1', resolve))
await new Promise((resolve) => fakeBreeze.listen(0, '127.0.0.1', resolve))
const mimoBase = `http://127.0.0.1:${fakeMimo.address().port}`
const breezeBase = `http://127.0.0.1:${fakeBreeze.address().port}`

await test('保存并检查：apiStyle=openai 但 routeMode=breeze 时，checkStyle=breeze 必须查 Breeze', async () => {
  // 复刻用户的真实配置形状：两个面板各存各的，apiStyle 停在小米，实际路由走 Breeze。
  const seeded = await req('POST', '/dsh-tts/config', {
    body: {
      tts: {
        baseUrl: `${mimoBase}/v1/chat/completions`,
        apiKey: 'mimo-good',
        headerTemplate: 'api-key: {{API_KEY}}\nContent-Type: application/json',
        apiStyle: 'openai',
        routeMode: 'breeze',
        breeze: {
          baseUrl: `${breezeBase}/v1`,
          apiKey: 'brz-good',
          headerTemplate: 'xi-api-key: {{API_KEY}}\nContent-Type: application/json',
        },
      },
    },
  })
  assert.equal(seeded.status, 200)

  // 用户点「保存 Breeze 配置并检查」——前端现在会带 checkStyle: 'breeze'。
  const r = await req('POST', '/dsh-tts/config', {
    body: { tts: { breeze: { baseUrl: `${breezeBase}/v1` }, check: true, checkStyle: 'breeze' } },
  })
  assert.equal(r.status, 200)
  assert.equal(r.payload.ok, true)
  assert.equal(r.payload.check.ok, true, `应成功探活 Breeze，实际：${r.payload.check.error}`)
  assert.ok(r.payload.check.url.includes(fakeBreeze.address().port), `应打 Breeze 的地址：${r.payload.check.url}`)
  assert.deepEqual(r.payload.check.models, ['breeze-model-a'])
  assert.equal(r.payload.check.style, 'breeze')
})

await test('保存并检查：checkStyle=openai 时只查小米，不受 routeMode 影响', async () => {
  const r = await req('POST', '/dsh-tts/config', {
    body: { tts: { check: true, checkStyle: 'openai' } },
  })
  assert.equal(r.status, 200)
  assert.equal(r.payload.check.ok, true, `应成功探活小米，实际：${r.payload.check.error}`)
  assert.ok(r.payload.check.url.includes(fakeMimo.address().port), `应打小米的地址：${r.payload.check.url}`)
  assert.deepEqual(r.payload.check.models, ['mimo-model-a'])
  assert.equal(r.payload.check.style, 'openai')
})

await test('保存并检查：没传 checkStyle 时按 routeMode 推断，不按 apiStyle 猜', async () => {
  // 这条是回归护栏：即便前端忘了传 checkStyle，后端也不能拿 apiStyle 去猜。
  const r = await req('POST', '/dsh-tts/config', { body: { tts: { check: true } } })
  assert.equal(r.status, 200)
  assert.equal(r.payload.check.style, 'breeze', 'routeMode=breeze 时应推断成 breeze')
  assert.equal(r.payload.check.ok, true, `应成功探活 Breeze，实际：${r.payload.check.error}`)
  assert.ok(r.payload.check.url.includes(fakeBreeze.address().port), `应打 Breeze 的地址：${r.payload.check.url}`)
})

await test('保存并检查：拉到的模型存回被检查的那一套，不污染另一套', async () => {
  const { settings } = readSettings(home)
  assert.deepEqual(settings.tts.breeze.models, ['breeze-model-a'], 'Breeze 的模型应写进 breeze.models')
  assert.ok(!(settings.tts.models || []).includes('breeze-model-a'), 'Breeze 的模型不该出现在小米的 models 里')
})

fakeMimo.close()
fakeBreeze.close()

/* ------------------------------- routeReady 口径一致 + 探活超时诊断（0.3.0） */

// 用户 m02401：Key 存好了、只是没选模型，调用优先级却显示「还没填 Key」。
// 根因是 /state 只判 apiKey、/config 判「地址+Key+模型」两套口径，
// 且前端把「缺模型」一律说成「没填 Key」。
await test('routeReady 与 routeReadyDetail：Key 已存但缺模型时，/state 与 /config 口径一致', async () => {
  const keyOnly = { tts: { breeze: { baseUrl: 'https://api.breeze.blue/v1', apiKey: 'brz_test', model: '' } } }
  const saved = await req('POST', '/dsh-tts/config', { body: keyOnly })
  assert.equal(saved.status, 200)
  // 缺模型 → 未就绪，但 apiKey 那一项必须是 true（不能再被说成没填 Key）
  assert.equal(saved.payload.routeReady.breeze, false)
  assert.equal(saved.payload.routeReadyDetail.breeze.apiKey, true)
  assert.deepEqual(saved.payload.routeReadyDetail.breeze.missing, ['model'])
  const state = await req('GET', '/dsh-tts/state')
  assert.equal(state.payload.routeReady.breeze, saved.payload.routeReady.breeze)
  assert.equal(state.payload.routeReadyDetail.breeze.apiKey, true)
  assert.deepEqual(state.payload.routeReadyDetail.breeze.missing, ['model'])
  // 补齐模型后就绪
  const done = await req('POST', '/dsh-tts/config', { body: { tts: { breeze: { model: 'breeze-tts-2' } } } })
  assert.equal(done.payload.routeReady.breeze, true)
  assert.deepEqual(done.payload.routeReadyDetail.breeze.missing, [])
})

// 起一个「只接连接、永不回包」的假上游：验证超时错误里带目标地址与耗时，
// 而不是只回一个「超时」让用户无从判断是网关卡住还是地址写错。
const blackhole = http.createServer(() => { /* 故意不回 */ })
await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve))
const blackholeBase = `http://127.0.0.1:${blackhole.address().port}`

await test('探活超时：错误带目标地址与耗时，且 body.timeoutMs 生效（不走双倍等待）', async () => {
  const startedAt = Date.now()
  const r = await req('POST', '/dsh-tts/models', {
    body: { apiStyle: 'openai', baseUrl: blackholeBase, apiKey: 'k', headerTemplate: '', timeoutMs: 1500 },
  })
  const cost = Date.now() - startedAt
  assert.equal(r.status, 502)
  assert.equal(r.payload.ok, false)
  const error = String(r.payload.error)
  assert.ok(error.includes('超时'), `应写明超时：${error}`)
  assert.ok(error.includes(blackholeBase), `应写明打的是哪个地址：${error}`)
  assert.ok(error.includes('1500'), `应写明等待上限：${error}`)
  // 连接阶段双栈会各等一轮，只靠 socket 空闲超时会变成 2×timeoutMs；
  // 这里断言整体硬截止生效（留 1s 余量给 CI）——否则「等待上限 1500ms」的文案就是假的。
  assert.ok(cost < 2600, `应在 timeoutMs 附近返回（实际 ${cost}ms）`)
  assert.ok(Number(r.payload.elapsedMs) < 2600, `elapsedMs 应与真实等待一致：${r.payload.elapsedMs}`)
})

// 用户 m00001（0.3.11 实测报错原文）：
//   「拉取模型超时：https://api.breeze.blue/v1/models 在 10010ms 内没有响应（等待上限 20000ms）」
// 这句自相矛盾的话是 0.3.11 的真 bug：probeGet 第一次超时后用 family:4 重试，两次各给
// 一份 timeoutMs，于是 elapsedMs 是两次之和（10010）、上限却写单次（20000）。
// 修复后两次共用一份预算，elapsedMs 必须 ≤ timeoutMs —— 否则「等待上限 N ms」就是谎话。
// 这里用 127.0.0.1（IP 字面量，没有第二个地址族可换）验证单次预算，再用域名验证
// 「重试也不超预算」两条路径都不会把文案撑破。
await test('探活超时文案自洽：elapsedMs 不超过文案里写的等待上限（IP 字面量）', async () => {
  const budget = 1200
  const r = await req('POST', '/dsh-tts/models', {
    body: { apiStyle: 'openai', baseUrl: blackholeBase, apiKey: 'k', headerTemplate: '', timeoutMs: budget },
  })
  assert.equal(r.status, 502)
  const error = String(r.payload.error)
  // 文案里的两个数字必须能对上：解析出来比对，而不是只查字符串包含。
  const m = error.match(/在 (\d+)ms 内没有响应（等待上限 (\d+)ms/)
  assert.ok(m, `文案格式应符合「在 Xms 内没有响应（等待上限 Yms）」：${error}`)
  const spent = Number(m[1])
  const limit = Number(m[2])
  assert.equal(limit, budget, `等待上限应等于请求里的 timeoutMs：${error}`)
  assert.ok(spent <= limit, `「等了 ${spent}ms」不能超过「上限 ${limit}ms」——这正是 0.3.11 的 bug：${error}`)
  // IP 字面量没有第二个地址族，不该重试、不该出现「重试」字样。
  assert.ok(!error.includes('重试'), `IP 字面量不应声称重试过：${error}`)
  assert.ok(!r.payload.triedFamilies, 'IP 字面量不该标记 triedFamilies')
})

// 域名路径：第一次超时后 probeGet 会「重试一次」，此时必须共用同一份预算。
// 0.3.11 的病根就在这里——两次各拿一份 timeoutMs，总耗时翻倍、文案却写单次上限。
// 用 localhost 指向同一个黑洞（域名 → 走重试分支，IP 字面量不走），断言：
//   ① 整体耗时仍被 timeoutMs 约束（留 800ms 给 CI 抖动）；
//   ② 文案里的「等了 Xms」不超过「上限 Yms」。
await test('探活超时文案自洽：域名重试也不突破等待上限（共用一份预算）', async () => {
  const budget = 1200
  const startedAt = Date.now()
  const r = await req('POST', '/dsh-tts/models', {
    body: { apiStyle: 'openai', baseUrl: `http://localhost:${blackhole.address().port}`, apiKey: 'k', headerTemplate: '', timeoutMs: budget },
  })
  const cost = Date.now() - startedAt
  assert.equal(r.status, 502)
  const error = String(r.payload.error)
  const m = error.match(/在 (\d+)ms 内没有响应（等待上限 (\d+)ms/)
  assert.ok(m, `文案格式应符合「在 Xms 内没有响应（等待上限 Yms）」：${error}`)
  const spent = Number(m[1])
  const limit = Number(m[2])
  assert.equal(limit, budget)
  assert.ok(spent <= limit, `「等了 ${spent}ms」不能超过「上限 ${limit}ms」：${error}`)
  assert.ok(cost < budget + 800, `域名重试也必须共用预算（实际 ${cost}ms，上限 ${budget}ms）`)
})

// 第二层病根（同样来自 m00001 那句报错）：0.3.11 把连接层的 ETIMEDOUT 也当成
// 「我们等满了预算」，于是套上「等待上限 20000ms」的模板——可实际 10 秒就被上游掐断了，
// 用户看到的「10 秒 vs 上限 20 秒」自相矛盾就是这么来的。
// 这里用一个必然被拒绝的地址（端口没监听 → ECONNREFUSED，不是超时），断言：
//   ① 文案不能出现「等待上限」——那会暗示等满了预算；
//   ② 必须如实带出错误码与真实耗时，方便判断是配置错还是网络卡。
await test('探活连接被拒：不套用「等待上限」模板，如实报错误码与耗时', async () => {
  // 先占一个端口再放掉，确保拿到的是「没人监听」的端口号。
  const probe = http.createServer(() => {})
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const deadPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  const r = await req('POST', '/dsh-tts/models', {
    body: { apiStyle: 'openai', baseUrl: `http://127.0.0.1:${deadPort}`, apiKey: 'k', headerTemplate: '', timeoutMs: 20000 },
  })
  assert.equal(r.status, 502)
  const error = String(r.payload.error)
  assert.ok(!error.includes('等待上限'), `连接被拒不是「等满了预算」，不该写等待上限：${error}`)
  assert.ok(/ECONNREFUSED/.test(error), `应如实带出底层错误码：${error}`)
  // 立刻被拒时 elapsedMs 为 0，此时不写「耗时 0ms」（那是噪音）；真的等了才写。
  if (Number(r.payload.elapsedMs) > 0) {
    assert.ok(error.includes('耗时'), `等了 ${r.payload.elapsedMs}ms 就该写明：${error}`)
  }
  assert.ok(Number.isFinite(Number(r.payload.elapsedMs)), 'elapsedMs 必须回传')
  assert.ok(error.includes(`127.0.0.1:${deadPort}`), `应写明打的是哪个地址：${error}`)
  assert.equal(r.payload.timedOut, false, '连接被拒不该标记为超时')
})

blackhole.close()

// 上游 400 的 param 字段必须透出来。小米实测：克隆模型拿到非 DataURL 的 voice 时回
// {code:"400", message:"Param Incorrect", param:"audio.voice must be a DataURL for voice clone model"}
// 以前只取 message，用户看到的就是一句没有任何指向性的「Param Incorrect」。
await test('上游 400 的 param 字段被透出，并翻译成可操作提示', async () => {
  const upstream = http.createServer((req_, res_) => {
    res_.writeHead(400, { 'content-type': 'application/json' })
    res_.end(JSON.stringify({
      code: '400',
      message: 'Param Incorrect',
      param: 'audio.voice must be a DataURL for voice clone model',
    }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${upstream.address().port}`
  try {
    const r = await req('POST', '/dsh-tts/preview', {
      body: {
        text: '你好',
        apiStyle: 'openai',
        baseUrl: base,
        apiKey: 'k',
        headerTemplate: '',
        bodyTemplate: '{"model":"m","messages":[{"role":"user","content":{{STYLE_JSON}}},{"role":"assistant","content":{{SPEECH_JSON}}}],"audio":{"format":"wav","voice":{{VOICE_JSON}}}}',
      },
    })
    assert.equal(r.status, 400)
    const error = String(r.payload.error)
    assert.ok(error.includes('audio.voice'), `应带出上游 param：${error}`)
    assert.ok(/DataURL/.test(error), `应带出上游原始说明：${error}`)
    // 翻译成「该改哪里」，而不是笼统的「模板拼错了」
    assert.ok(/克隆|voiceclone|DataURL/.test(error), `应给出可操作提示：${error}`)
  } finally {
    upstream.close()
  }
})

// 克隆模型的 voice 只能是参考音频 DataURL。控制台的「合成模式」下拉与「模型」是两个
// 独立字段，用户很容易只改其中一个；resolveVoiceValue 以前只看 mode，于是把预设音色名
// 直接发给克隆模型 —— 必 400。这里以模型为准兜底。
await test('克隆模型的 voice 以模型为准：传预设音色名也不会发出去', async () => {
  const cfg = ttsCfg({
    model: 'mimo-v2.5-tts-voiceclone',
    mode: 'preset', // 故意与模型不一致
    voice: '冰糖',
  }, { rootDir: home })
  // 没有参考音频 → 明确报错，而不是把「冰糖」发出去
  assert.throws(() => resolveVoiceValue(cfg, '冰糖'), /克隆|参考音频|DataURL/)
  // 有参考音频 → 无论传入什么预设音色名，都返回 DataURL
  // （refAudioInfo 按 dir + basename(fileName) 找文件，所以必须真写一份）
  const cloneDir = path.join(home, 'state', 'tts-clone')
  fs.mkdirSync(cloneDir, { recursive: true })
  fs.writeFileSync(path.join(cloneDir, 'clone-test.wav'), Buffer.alloc(64))
  const cloneCfg = ttsCfg({
    model: 'mimo-v2.5-tts-voiceclone',
    mode: 'preset',
    clone: { fileName: 'clone-test.wav', mimeType: 'audio/wav', bytes: 64 },
  }, { rootDir: home })
  const uri = resolveVoiceValue(cloneCfg, '冰糖')
  assert.ok(/^data:audio\//.test(uri), `克隆模型必须拿到 DataURL，实际：${String(uri).slice(0, 40)}`)
  // 非克隆模型仍然尊重显式传入的音色
  const presetCfg = ttsCfg({ model: 'mimo-v2.5-tts', mode: 'preset', voice: '冰糖' }, { rootDir: home })
  assert.equal(resolveVoiceValue(presetCfg, '苏打'), '苏打')
})

/* ----------------------------------------------------------------- tts-lib */

await test('ttsCfg 把默认配置解释成可用视图', () => {
  const cfg = ttsCfg(defaultSettings().tts, { rootDir: home })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.model, 'mimo-v2.5-tts')
  assert.equal(cfg.mode, 'preset')
  assert.equal(cfg.format, 'wav')
  assert.ok(cfg.cacheDir.endsWith(path.join('state', 'tts-cache')))
  assert.equal(cfg.timeoutMs, 180000)
  assert.equal(cfg.maxChars, 2000)
  assert.equal(cfg.singStyle, '唱歌')
})

await test('mimeFromFormat / guessModeForModel 与上游口径一致', () => {
  assert.equal(mimeFromFormat('wav'), 'audio/wav')
  assert.equal(mimeFromFormat('mp3'), 'audio/mpeg')
  assert.equal(mimeFromFormat('pcm'), 'audio/L16')
  assert.equal(guessModeForModel('mimo-v2.5-tts'), 'preset')
  assert.equal(guessModeForModel('mimo-v2.5-tts-voiceclone'), 'clone')
  assert.equal(guessModeForModel('mimo-v2.5-tts-voicedesign'), 'voicedesign')
})

await test('官方模型与预置音色数量', () => {
  assert.equal(OFFICIAL_MODELS.length, 3)
  assert.equal(PRESET_VOICES.length, 9)
})

// 用户报的 bug：小米模板里选了「克隆音色」，但模型还是预置音色 TTS，于是试听必然 400
// `Unknown voice: data:audio/wav;base64,…`（报错里还会列一串预置音色名，看起来就像
// 「非要先选个预置音色」）。根因是 mode 与 model 是两个独立字段，上传参考音频只写 mode、
// 控制台的「合成模式」Tab 也只写 mode，模型从来没跟着变过。
await test('mode=clone 但模型是预置模型时，自动换成克隆模型（不再 400）', () => {
  const cfg = ttsCfg({
    model: 'mimo-v2.5-tts', // 分叉：预置模型
    mode: 'clone',          // 用户选的是克隆
    voice: '茉莉',
  }, { rootDir: home })
  assert.equal(cfg.mode, 'clone')
  assert.equal(cfg.model, 'mimo-v2.5-tts-voiceclone', '选了克隆模式就该用克隆模型')
  assert.equal(guessModeForModel(cfg.model), cfg.mode, 'mode 与 model 必须自洽')
})

await test('reconcileModeModel：克隆优先，且不碰用户手填的自定义模型', () => {
  // 官方模型分叉 → 按克隆收敛
  assert.deepEqual(reconcileModeModel('clone', 'mimo-v2.5-tts'),
    { mode: 'clone', model: 'mimo-v2.5-tts-voiceclone', changed: true })
  // 反向：预置模式 + 克隆模型 → 也按克隆（克隆是用户上传过参考音频才有的明确选择）
  assert.equal(reconcileModeModel('preset', 'mimo-v2.5-tts-voiceclone').model, 'mimo-v2.5-tts-voiceclone')
  // 已经自洽 → 不动
  assert.deepEqual(reconcileModeModel('clone', 'mimo-v2.5-tts-voiceclone'),
    { mode: 'clone', model: 'mimo-v2.5-tts-voiceclone', changed: false })
  // 手填的自定义模型：绝不因为 mode 被悄悄改掉
  assert.equal(reconcileModeModel('clone', 'my-custom-tts').model, 'my-custom-tts')
  // 非官方、非克隆的模型同样保留
  assert.equal(reconcileModeModel('preset', 'mimo-v2.6-pro').model, 'mimo-v2.6-pro')
})

// 用户报的现象：明明用的是克隆，可每次试听出来的音色和语速都不太一样，像是调了预置音色。
// 实测根因是参考音频只有 2.91 秒（有效语音 2.13 秒），上游每次复现的语速波动极大
// （时长变异 40.8%），而预置音色同一句话只有 1.9%。所以「短参考音频」必须明确警告，
// 不能等用户自己怀疑是插件没走克隆。
await test('参考音频有效语音太短时，describeTtsConfig 给出 tooShort 结论', () => {
  const cloneDir = path.join(home, 'state', 'tts-clone')
  fs.mkdirSync(cloneDir, { recursive: true })
  fs.writeFileSync(path.join(cloneDir, 'clone-short.wav'), Buffer.alloc(64))
  const base = {
    model: 'mimo-v2.5-tts-voiceclone',
    mode: 'clone',
    clone: { fileName: 'clone-short.wav', mimeType: 'audio/wav', bytes: 64 },
  }

  // 2.13 秒有效语音 → 明显不够
  const short = describeTtsConfig(ttsCfg({
    ...base,
    clone: { ...base.clone, seconds: 2.91, speechSeconds: 2.13 },
  }, { rootDir: home }))
  assert.equal(short.clone.seconds, 2.91)
  assert.equal(short.clone.speechSeconds, 2.13)
  assert.equal(short.clone.tooShort, true, '有效语音 2.13 秒必须判为过短')

  // 12 秒 → 达标
  const good = describeTtsConfig(ttsCfg({
    ...base,
    clone: { ...base.clone, seconds: 12.4, speechSeconds: 11.8 },
  }, { rootDir: home }))
  assert.equal(good.clone.tooShort, false)

  // 老配置没有这两个字段 → 时长未知，不能凭空报警
  const legacy = describeTtsConfig(ttsCfg(base, { rootDir: home }))
  assert.equal(legacy.clone.seconds, 0)
  assert.equal(legacy.clone.speechSeconds, 0)
  assert.equal(legacy.clone.tooShort, false, '量不出时长时不该误报')
})

await test('saveRefAudio 记录浏览器量出的时长，并在 ttsCfg 里保留', () => {
  const cfg = ttsCfg({ model: 'mimo-v2.5-tts-voiceclone', mode: 'clone' }, { rootDir: home })
  const saved = saveRefAudio(cfg, {
    buffer: Buffer.alloc(96),
    fileName: 'ref.wav',
    kind: 'clone',
    seconds: 12.4,
    speechSeconds: 11.8,
  })
  assert.equal(saved.seconds, 12.4)
  assert.equal(saved.speechSeconds, 11.8)

  // 落盘后再读回来仍然是同一组数（面板重启后也要能显示）
  const reread = ttsCfg({ clone: saved, model: 'mimo-v2.5-tts-voiceclone', mode: 'clone' }, { rootDir: home })
  assert.equal(reread.clone.seconds, 12.4)
  assert.equal(reread.clone.speechSeconds, 11.8)

  // 没传时长（比如老客户端）→ 存 0，不报错也不编数
  const bare = saveRefAudio(cfg, { buffer: Buffer.alloc(96), fileName: 'ref.wav', kind: 'clone' })
  assert.equal(bare.seconds, 0)
  assert.equal(bare.speechSeconds, 0)
})

// 时长不能只靠浏览器报：老版本上传的参考音频根本没记过时长，如果只信配置，
// 「已经传了一段 3 秒的音频」这个最该提示的场景反而永远不提示。所以服务端要能从
// 落盘的 WAV 自己量出来（不依赖 ffmpeg）。
function makeWav({ rate = 24000, seconds = 3, voiced = 2 } = {}) {
  const frames = Math.round(rate * seconds)
  const voicedFrames = Math.round(rate * voiced)
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i += 1) {
    // 有声段给 0.3 幅度方波（远超 0.008 阈值），静音段全 0
    const amp = i < voicedFrames ? 0.3 : 0
    const v = Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * amp * 32767)
    data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)          // PCM
  header.writeUInt16LE(1, 22)          // 单声道
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

await test('measureWavSpeech 自己从 WAV 量时长与有效语音（不依赖 ffmpeg）', () => {
  // 3 秒文件、2 秒有声 → 有效语音应接近 2 秒
  const m = measureWavSpeech(makeWav({ seconds: 3, voiced: 2 }))
  assert.ok(m, '应能量出结果')
  assert.ok(Math.abs(m.seconds - 3) < 0.02, `总时长应约 3 秒，实际 ${m.seconds}`)
  assert.ok(Math.abs(m.speechSeconds - 2) < 0.15, `有效语音应约 2 秒，实际 ${m.speechSeconds}`)

  // 全静音 → 有效语音 0
  const silent = measureWavSpeech(makeWav({ seconds: 2, voiced: 0 }))
  assert.ok(Math.abs(silent.speechSeconds) < 0.01, '全静音应判 0')

  // 非 WAV / 太短 / null 一律返回 null，绝不抛错（调用方按「时长未知」处理）
  assert.equal(measureWavSpeech(Buffer.alloc(10)), null)
  assert.equal(measureWavSpeech(Buffer.from('this is not a wav file, just some text')), null)
  assert.equal(measureWavSpeech(null), null)
  assert.equal(measureWavSpeech(undefined), null)
})

await test('老配置没记时长时，describeTtsConfig 从落盘文件现量并报 tooShort', () => {
  const cloneDir = path.join(home, 'state', 'tts-clone')
  fs.mkdirSync(cloneDir, { recursive: true })
  // 模拟老版本：只有 fileName，没有 seconds / speechSeconds
  fs.writeFileSync(path.join(cloneDir, 'clone-legacy.wav'), makeWav({ seconds: 3, voiced: 2 }))
  const cfg = ttsCfg({
    model: 'mimo-v2.5-tts-voiceclone',
    mode: 'clone',
    clone: { fileName: 'clone-legacy.wav', mimeType: 'audio/wav', bytes: 64 },
  }, { rootDir: home })

  const d = describeTtsConfig(cfg)
  assert.ok(Math.abs(d.clone.seconds - 3) < 0.05, `应从文件量出 3 秒，实际 ${d.clone.seconds}`)
  assert.ok(d.clone.speechSeconds > 1.5, `应量出约 2 秒有效语音，实际 ${d.clone.speechSeconds}`)
  assert.equal(d.clone.tooShort, true, '2 秒有效语音必须判为过短')
})

await test('saveRefAudio 优先用服务端从落盘文件量出的时长（覆盖浏览器报的数）', () => {
  const cfg = ttsCfg({ model: 'mimo-v2.5-tts-voiceclone', mode: 'clone' }, { rootDir: home })
  // 浏览器谎报 20 秒，但真正落盘的是 3 秒 / 2 秒有声的 wav
  const saved = saveRefAudio(cfg, {
    buffer: makeWav({ seconds: 3, voiced: 2 }),
    fileName: 'ref.wav',
    kind: 'clone',
    seconds: 20,
    speechSeconds: 19,
  })
  assert.ok(Math.abs(saved.seconds - 3) < 0.05, `应以落盘文件为准（3 秒），实际 ${saved.seconds}`)
  assert.ok(saved.speechSeconds < 2.5, `应以落盘文件为准（约 2 秒），实际 ${saved.speechSeconds}`)
})

// 端到端：真的走一次 /clone 上传，确认 /config 立刻报出「有效语音过短」。
// 这条链路上有两个容易断的点：routes 是否把时长透给 saveRefAudio、
// describeTtsConfig 是否把它算进 tooShort。
// 放在最后：它会改共享测试 home 的配置（mode/model/clone），跑在前面会污染其它用例。
await test('POST /clone 上传短参考音频后，/config 立刻报 tooShort', async () => {
  const wav = makeWav({ seconds: 3, voiced: 2 })
  const { status, payload } = await req('POST', '/dsh-tts/clone', {
    body: {
      fileName: 'e2e-short.wav',
      kind: 'clone',
      dataBase64: wav.toString('base64'),
      overwrite: true,
      seconds: 3,
      speechSeconds: 2,
    },
  })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  // 上传说话音色后必须成对写 mode/model（0.4.1 的修复不能被这次改动碰坏）
  assert.equal(payload.mode, 'clone')
  assert.equal(payload.model, 'mimo-v2.5-tts-voiceclone')
  assert.ok(payload.clone.seconds > 2.5, `应记下约 3 秒，实际 ${payload.clone.seconds}`)
  assert.ok(payload.clone.speechSeconds > 1.5, `应记下约 2 秒有效语音，实际 ${payload.clone.speechSeconds}`)
  assert.equal(payload.clone.tooShort, true)

  // 重新拉一次配置，结论必须稳定（不是只在响应里算对）
  const again = await req('GET', '/dsh-tts/config')
  assert.equal(again.payload.clone.tooShort, true)
  assert.ok(again.payload.clone.seconds > 2.5)
})

/* ------------------------------------------------------------------- 收尾 */

server.close()
fs.rmSync(home, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
