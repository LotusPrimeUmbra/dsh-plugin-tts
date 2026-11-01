// OneBot v11（SnowLuma 等网关）HTTP 通道：发语音 + 回读 + 频率限制。
//
// 为什么直连 OneBot HTTP 而不经过 qq-bridge 插件：本插件是 qq-bridge「内嵌 TTS」的独立复制版，
// 不带 QQ 消息桥接能力，只借用同一台机器上已经在跑的 OneBot 网关（默认 127.0.0.1:3000）。
// record 段的 file 支持**本机绝对路径**，所以不需要先上传文件。
//
// 频率限制按会话 key（group:xxx / private:xxx）单独计数，只在内存里，进程重启清零 ——
// 这是「防止 AI 刷屏」的软保护，不是审计账本，重启后重新计数完全可以接受。
import fs from 'node:fs'
import path from 'node:path'
import { parseTargetKey } from './voice-core.js'

const BUDGETS = new Map()
const DEFAULT_HTTP_URL = 'http://127.0.0.1:3000'

function trimUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

// ── 头值里的非 ASCII 字符：原样发送，绝不改用户的密码 ──────────────────
//
// 背景（两轮相反的教训）：
//   0.3.3 现场：Token 里有个全角「！」，undici 的 Headers 抛
//     Cannot convert argument to a ByteString ... 65281 ...
//   0.3.4 的错误修法：把全角标点自动转成半角。但 Token 是用户的密码，
//     他那把 Key 里本来就是「！」——自动「纠错」等于把密码改坏，
//     网关只会回 401「Token expired or invalid」。
//
// 正确做法：**一个字节都不动**。HTTP/1.1 的头值在传输层就是字节流，
// 网关按 UTF-8 解读就能拿回原文。undici 只肯收 ≤0xFF 的字符，
// 所以把「UTF-8 字节」映射成同值的 latin1 字符串再交给它：
//   '！'(U+FF01) → UTF-8 EF BC 81 → latin1 串 "ï ¼ "
//   服务端收到那三个字节，按 UTF-8 解码回来仍是「！」。
// 已实测往返一致（见 test/standalone.test.mjs 的「非 ASCII 头值」回归）。
//
// 全角标点确实是打字手滑时，插件只**提示**、不替用户改——是不是手滑只有他知道。

/** 把字符串编码成 undici 收得下的头值：≥0x80 的字符按 UTF-8 字节映射到 latin1。 */
export function encodeHeaderValue(value) {
  const text = String(value ?? '')
  // 快路径：纯 ASCII（绝大多数 Token）原样返回，不产生任何拷贝。
  let ascii = true
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) {
      ascii = false
      break
    }
  }
  if (ascii) return text
  return Buffer.from(text, 'utf8').toString('latin1')
}

/** 找出头值里的非 ASCII 字符（供界面提示「我们没改它」），最多列前 8 个。 */
export function findNonAscii(value) {
  const text = String(value ?? '')
  const list = []
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code > 0x7f && list.length < 8) list.push({ index: i, char: text[i], code })
  }
  return list
}

/**
 * URL 里的非 ASCII 字符是真问题：地址必须能被解析成主机名，
 * 全角冒号/全角斜杠会让 URL 直接非法，这里保留硬校验。
 */
function findNonLatin1(value) {
  const text = String(value ?? '')
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code > 0xff) return { index: i, char: text[i], code }
  }
  return null
}

function describeChar(bad) {
  return `第 ${bad.index + 1} 个字符「${bad.char}」（U+${bad.code.toString(16).toUpperCase().padStart(4, '0')}）`
}

/**
 * 发请求前自查地址能不能构成合法 URL。
 * Token 一律不检查内容——那是用户的密码，我们只负责原样送达。
 */
function assertUrlOk(url) {
  const badUrl = findNonLatin1(url)
  if (badUrl) {
    throw new Error(
      `OneBot HTTP 地址里有非半角字符：${describeChar(badUrl)}。`
      + '地址必须是纯英文/数字/半角符号（形如 http://127.0.0.1:3000），请改成半角后重试。',
    )
  }
}

/**
 * 规整 OneBot 连接配置：只去首尾空白，不做任何字符替换。
 * 返回 { httpUrl, accessToken, nonAscii }，nonAscii 里是 Token 中逐字的非 ASCII 字符，
 * 供界面说明「这些字符我们原样发，没改」。
 */
export function sanitizeOnebot(input = {}) {
  const httpUrl = String(input.httpUrl ?? '').trim().replace(/\/+$/, '')
  const accessToken = String(input.accessToken ?? '').trim()
  return { httpUrl, accessToken, nonAscii: findNonAscii(accessToken) }
}

/**
 * 解析 OneBot 连接：显式配置 > dsh-plugin-qq-bridge 的 connection.json > 默认 3000 端口。
 * 返回 { httpUrl, accessToken, source, nonAscii }，source 方便在 UI 上说明「这条通道是哪来的」，
 * nonAscii 是 Token 里的非 ASCII 字符（只用于提示，Token 本身一字不改）。
 */
export function resolveOneBot(settings, home) {
  const onebot = settings?.onebot ?? {}
  const explicitUrl = trimUrl(onebot.httpUrl)
  if (explicitUrl) {
    const clean = sanitizeOnebot({ httpUrl: onebot.httpUrl, accessToken: onebot.accessToken })
    return { httpUrl: clean.httpUrl, accessToken: clean.accessToken, source: 'plugin-config', nonAscii: clean.nonAscii }
  }
  const candidates = home
    ? [path.join(home, 'qq-bridge', 'connection.json'), path.join(home, 'dsh-qq-bridge', 'connection.json')]
    : []
  for (const file of candidates) {
    try {
      const conn = JSON.parse(fs.readFileSync(file, 'utf8'))
      const httpUrl = trimUrl(conn.httpApiUrl)
      if (httpUrl) {
        const clean = sanitizeOnebot({ httpUrl: conn.httpApiUrl, accessToken: conn.httpToken })
        return { httpUrl: clean.httpUrl, accessToken: clean.accessToken, source: file, nonAscii: clean.nonAscii }
      }
    } catch {}
  }
  return { httpUrl: DEFAULT_HTTP_URL, accessToken: '', source: 'default', nonAscii: [] }
}

function authHeaders(conn) {
  const headers = { 'content-type': 'application/json' }
  // 关键：Token 原样送去，只做「UTF-8 字节 → latin1 字符」的传输层映射，
  // 服务端按 UTF-8 解码即可拿回原文。绝不做全角→半角之类的「纠正」。
  if (conn.accessToken) headers.authorization = encodeHeaderValue(`Bearer ${conn.accessToken}`)
  return headers
}

// ── action 前缀 & 「这根本不是 OneBot」识别 ──────────────────────────────
//
// 这块的结论我反复搞错过一次，把真正的机制记清楚，别再走弯路：
//
// SnowLuma 的 **同一个 5099 端口同时提供两套 API**（实测某台部署如此）：
//   · `POST /api/login`          → `{"success":false,"message":"密码错误"}`
//                                  WebUI 登录接口，认的是**密码**
//   · `POST /api/get_login_info` → `{"status":"failed","message":"Token expired or invalid"}`
//   · `POST /api/get_status`     → 同上
//   · `POST /api/send_private_msg` → 同上
//                                  ↑ 这些是 **OneBot action**，认的是 `Authorization: Bearer <token>`
//   · `POST /get_login_info`（无 /api 前缀）→ `404 Not Found`
//                                  说明这台机器的 action **只挂在 /api 下**
//
// 判别「带 Bearer 与不带 Bearer 的响应是否不同」是决定性证据：
//   不带 Authorization → `{"status":"failed","message":"Unauthorized"}`
//   带任意 Bearer      → `{"status":"failed","message":"Token expired or invalid"}`
// 只有真的在读 Authorization 头做鉴权，才会因为「带了 token 但不对」而换个错误；
// 如果那只是 WebUI 的登录接口，加不加 header 都不会变。
//
// 所以正确的处理是：**地址已经带 /api 就直连**（用户自己填对了），
// 没带就按「无前缀 → /api」顺序探测一次并记住。不要因为看到
// 「/api/login 存在」就断定整台机器是 WebUI 面板——两套 API 并存。
//
// 那什么时候才该说「这不是 OneBot」？只有在**两种前缀都拿不到 OneBot 形状的响应**时。

/** 地址里是否已经显式带了 action 前缀（/api、/api/v1 …）。 */
export function hasActionPrefix(httpUrl) {
  try {
    const pathname = new URL(String(httpUrl)).pathname.replace(/\/+$/, '')
    return /\/api(\/v\d+)?$/i.test(pathname)
  } catch {
    return false
  }
}

/** 拼一个 action 的完整 URL，自动去重斜杠。 */
export function actionUrl(httpUrl, action, prefix = '') {
  const base = trimUrl(httpUrl)
  const tail = `${prefix ? `/${String(prefix).replace(/^\/+/, '')}` : ''}/${String(action).replace(/^\/+/, '')}`
  return `${base}${tail}`
}

/** 这个响应看起来像「这个路径上没有 action」，而不是「action 执行失败」。 */
function looksLikeMissingAction(response, text) {
  if (response.status === 404 || response.status === 405) return true
  if (response.status === 200) {
    // 打到 Web 前端时会 200 + text/html：内容是 SPA 的 index.html，不是 OneBot 的 JSON。
    const type = String(response.headers.get('content-type') ?? '').toLowerCase()
    if (type.includes('text/html')) return true
    // 纯文本 404 页（实测 SnowLuma 的 POST /get_login_info 回 "404 Not Found"）。
    if (/^\s*404\b/i.test(text) || /not found/i.test(text)) return true
  }
  return false
}

/**
 * 这个 JSON 是 OneBot 的响应吗？
 * OneBot v11 的每条响应都有 retcode（数值，成功 0）。
 */
export function looksLikeOneBot(body) {
  return Boolean(body) && typeof body === 'object' && Object.hasOwn(body, 'retcode')
}

/**
 * 这个 JSON 是 SnowLuma **WebUI 登录接口**的响应吗？
 * 只认 `{"success":false,...}` 这一种——那是 /api/login 的密码校验失败。
 *
 * 注意：`{"status":"failed","message":"Unauthorized"}` 与
 * `{"status":"failed","message":"Token expired or invalid"}` **不能**算 WebUI 证据。
 * 实测它们来自 /api/get_* 这些 OneBot action（区别只在有没有带 Bearer），
 * 0.3.8 我把它们当成了「WebUI 面板」的铁证，于是把正确配置判成了「端口填错」。
 */
export function looksLikeSnowLumaWebui(body) {
  if (!body || typeof body !== 'object') return false
  if (looksLikeOneBot(body)) return false
  return body.success === false
}

/** 从任意 httpUrl 推出「这台机器的 OneBot 端口」：把 WebUI 的 5099 换成 3000。 */
function guessOneBotPort(httpUrl) {
  try {
    const u = new URL(trimUrl(httpUrl))
    if (u.port === '5099') return `${u.protocol}//${u.hostname}:3000`
    return `${u.protocol}//${u.hostname}:3000`
  } catch {
    return ''
  }
}

// 每个 httpUrl 探测到的前缀：'' 或 '/api'。只活在本进程里，重启重探。
const ACTION_PREFIX = new Map()

function cacheKeyOf(conn) {
  return `${trimUrl(conn.httpUrl)}\u0000${conn.accessToken ? 't' : ''}`
}

/** 组装「你连的不是 OneBot」这条错误：说清打到了什么、该改哪个端口。 */
function notOneBotError(conn, detail) {
  const suggestion = guessOneBotPort(conn.httpUrl)
  return Object.assign(
    new Error(
      `${detail}`
      + `当前填的地址是 ${trimUrl(conn.httpUrl)}。`
      + (suggestion
        ? `这通常是 SnowLuma 的 **WebUI 管理面板**（用密码登录的地方），不是 OneBot 接口。`
          + `请把「HTTP 地址」改成 ${suggestion}（OneBot HTTP 默认端口 3000）再测试。`
        : '请确认地址指向 OneBot 的 HTTP 端口（默认 3000），而不是 WebUI 面板端口。'),
    ),
    { notOneBot: true },
  )
}

/** 调一个 OneBot action，校验 status/retcode，返回完整响应体。 */
export async function callOneBot(conn, action, params = {}, { timeoutMs = 60000 } = {}) {
  // 地址自带 /api 就直连，不必猜。
  if (hasActionPrefix(conn.httpUrl)) {
    return callOneBotOnce(conn, action, params, { timeoutMs, prefix: '' })
  }
  const key = cacheKeyOf(conn)
  const cached = ACTION_PREFIX.get(key)
  if (cached !== undefined) {
    try {
      return await callOneBotOnce(conn, action, params, { timeoutMs, prefix: cached })
    } catch (error) {
      // 缓存的前缀失效了（网关换了部署方式）：清掉，下一次重新探测。
      if (error?.missingAction) {
        ACTION_PREFIX.delete(key)
      }
      throw error
    }
  }
  try {
    const body = await callOneBotOnce(conn, action, params, { timeoutMs, prefix: '' })
    // 不带前缀就能用：记下来，后续请求不必再探。（用 '' 作值，undefined 表示「没探过」。）
    ACTION_PREFIX.set(key, '')
    return body
  } catch (error) {
    // notOneBot 不再是「结论性错误」：SnowLuma 同端口并存 WebUI 与 OneBot，
    // 无前缀那次可能正好打中 WebUI 的 /api/login 之类，换 /api 仍有救。
    // 只有 missingAction（路径上压根没有 action）才值得重试。
    if (!error?.missingAction && !error?.notOneBot) throw error
  }
  // ①不通 → 试 ②（/api 前缀）。
  const body = await callOneBotOnce(conn, action, params, { timeoutMs, prefix: '/api' })
  ACTION_PREFIX.set(key, '/api')
  return body
}

/**
 * 这条通道当前用的 action 前缀（'' 或 '/api'）。
 * 还没探过时返回 null —— 界面只说「未探测」，不替用户猜。
 */
export function detectedPrefix(conn) {
  if (hasActionPrefix(conn?.httpUrl)) return ''
  return ACTION_PREFIX.get(cacheKeyOf(conn)) ?? null
}

/** 真正发一次请求；路径不对时抛带 missingAction=true 的错误，供上层换前缀重试。 */
async function callOneBotOnce(conn, action, params, { timeoutMs = 60000, prefix = '' } = {}) {
  const url = actionUrl(conn.httpUrl, action, prefix)
  // 地址必须能构成合法 URL；Token 不做内容校验（见文件顶部说明）。
  assertUrlOk(url)
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(conn),
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = String(error?.message ?? error)
    // 兜底：ByteString 现在是理论不可能（头值已经映射成 latin1），
    // 万一走了别家 fetch 实现仍报这条，也要说清是「字符」而不是「连不上」。
    if (message.includes('ByteString')) {
      throw new Error(
        `OneBot 请求头里有当前 fetch 实现无法编码的字符（对方没收到请求）：${message}。`
        + '这与网关无关，请把这条报错原样反馈——Token 本身不会被插件改写。',
      )
    }
    throw new Error(
      `连不上 OneBot 网关（${url}）：${message}。`
      + '请确认 SnowLuma / OneBot 已启动，且 onebot HTTP 端口（默认 3000）与 access token 正确。',
    )
  }
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    // 打到 Web 前端 / 错误的路径：标记出来，让 callOneBot 换 /api 再试一次。
    if (looksLikeMissingAction(response, text)) {
      throw Object.assign(
        new Error(
          `OneBot ${action} 的路径上不是一个 action（HTTP ${response.status}，返回的不是 JSON）。`
          + `当前地址：${url}`,
        ),
        { missingAction: true },
      )
    }
    throw new Error(`OneBot ${action} 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`)
  }
  // 只有 `{"success":false,...}` 才是 WebUI 登录接口的铁证（/api/login 的密码校验）。
  // `{"status":"failed","message":"Token expired or invalid"}` **不是**——实测它来自
  // /api/get_* 这些 OneBot action，只是某些网关的失败响应不带 retcode。
  if (looksLikeSnowLumaWebui(body)) {
    throw notOneBotError(conn, `OneBot ${action} 打到了 WebUI 的登录接口：${text.slice(0, 120)}`)
  }
  // 判定这条响应「算不算 OneBot 的答复」：
  //   有 retcode → 标准 OneBot v11；
  //   或者有 status(ok/failed/stats) + message/wording → 兼容变体（SnowLuma /api 下的实际形态）。
  // 两者都不是，才认为打错了服务。
  const looksLikeReply = looksLikeOneBot(body)
    || (typeof body?.status === 'string' && typeof (body.wording ?? body.message) === 'string')
  if (!looksLikeReply) {
    throw notOneBotError(conn, `OneBot ${action} 的响应里没有 retcode / status，不像是 OneBot：${text.slice(0, 120)}`)
  }
  // 兼容「没有 retcode 但 status=failed」的变体：把 message 当成 wording 报出去。
  const ok = body.status === 'ok' && (body.retcode === undefined || body.retcode === 0)
  if (!ok) {
    const extra = response.status === 426 ? '（426 通常是把 HTTP 请求打到了 WS 端口：HTTP 默认 3000、WS 默认 3001）' : ''
    const wording = body.wording || body.message || body.retcode || response.status
    const auth = /token|auth|unauthorized|401|403/i.test(`${wording}${response.status}`)
      ? '（网关拒绝了这个 Token：确认它和 SnowLuma 控制台里 OneBot 连接页显示的 access token 一致；插件不会改动 Token 内容，若有全角字符也是原样发送的）'
      : ''
    const pathHint = hasActionPrefix(conn.httpUrl) || detectedPrefix(conn) === null
      ? ''
      : `（实际用的 action 路径：${trimUrl(conn.httpUrl)}${detectedPrefix(conn)}/${action}）`
    throw new Error(`OneBot ${action} 失败：${wording}${extra}${auth}${pathHint}`)
  }
  return body
}

/** 探活：返回登录账号信息。 */
export async function pingOneBot(conn, { timeoutMs = 5000 } = {}) {
  const body = await callOneBot(conn, 'get_login_info', {}, { timeoutMs })
  return {
    ok: true,
    userId: body?.data?.user_id ?? null,
    nickname: body?.data?.nickname ?? '',
    httpUrl: conn.httpUrl,
    source: conn.source,
    // Token 里的非 ASCII 字符（全角标点、汉字等）——只是提示，实际发送时原样保留。
    nonAscii: conn.nonAscii ?? [],
    // 这次实际打通的路径前缀：'' = /get_login_info，'/api' = /api/get_login_info。
    // 带 /api 的部署以前每个 action 都 404，界面把这条写出来，用户才知道是哪种网关。
    actionPrefix: detectedPrefix(conn) ?? '',
  }
}

function budgetState(key, now) {
  const list = (BUDGETS.get(key) ?? []).filter((t) => now - t < 3600_000)
  BUDGETS.set(key, list)
  return list
}

/** 只检查不占额：真正发出去后再 budgetCommit()。 */
export function budgetCheck(key, voiceCfg = {}) {
  const now = Date.now()
  const list = budgetState(key, now)
  const maxPerMinute = positiveInt(voiceCfg.maxPerMinute, 2)
  const maxPerHour = positiveInt(voiceCfg.maxPerHour, 10)
  const minute = list.filter((t) => now - t < 60_000).length
  if (minute >= maxPerMinute) {
    throw new Error(`发语音太频繁：${key} 每分钟最多 ${maxPerMinute} 条，刚刚已经发了 ${minute} 条，稍等再发`)
  }
  if (list.length >= maxPerHour) {
    throw new Error(`发语音太频繁：${key} 每小时最多 ${maxPerHour} 条，刚满额度，稍等再发`)
  }
}

export function budgetCommit(key) {
  const now = Date.now()
  const list = budgetState(key, now)
  list.push(now)
  BUDGETS.set(key, list)
}

function positiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

/** 把 target（"group:123" / "private:456"）解析成 OneBot 参数；非法时抛错。 */
export function targetToParams(targetKey) {
  const target = parseTargetKey(targetKey)
  if (!target) {
    throw new Error(`发送目标格式不对：${JSON.stringify(String(targetKey ?? ''))}（应为 group:群号 或 private:QQ号）`)
  }
  return target
}

/**
 * 决定 record 段的 `file` 该用什么形式：
 *   · 'path'   ——本机绝对路径。只有 OneBot 与本插件**跑在同一台机器**时才可用。
 *   · 'base64' ——`base64://<数据>`。数据随请求走，对端不需要读我们的磁盘。
 *
 * 为什么需要 base64：插件可以装在 A 机、OneBot 在 B 机（远程网关）。
 * 这时传本机路径过去，B 机的 OneBot 会 `stat` 一个不存在的文件：
 *   OneBot send_private_msg 失败：ENOENT: no such file or directory,
 *   stat 'C:\Users\<你>\.dsh\dsh-tts\voice\tts-xxxx.wav'
 * 那个路径是 A 机的，B 机当然没有。base64 内联能彻底绕开跨机读文件。
 */
export const RECORD_FILE_MODES = ['auto', 'path', 'base64']

/** 这个 httpUrl 指向的是不是本机（决定 auto 模式下能不能用路径）。 */
export function isLocalGateway(httpUrl) {
  try {
    const host = new URL(trimUrl(httpUrl)).hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0'
  } catch {
    return false
  }
}

/** 把音频文件读成 OneBot 的 `base64://` 形式。 */
export function fileToRecordBase64(filePath) {
  const buf = fs.readFileSync(filePath)
  return `base64://${buf.toString('base64')}`
}

/**
 * 发送一条 record 语音；返回 { messageId, target, fileMode, fileBytes }。
 *
 * fileMode 决定 `file` 字段怎么填（见 RECORD_FILE_MODES 的注释）。
 * 'auto'：网关是本机 → 用路径（省一大段 base64）；网关在远端 → 用 base64。
 */
export async function sendVoiceRecord(conn, target, filePath, { timeoutMs = 60000, fileMode = 'auto' } = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`要发送的音频不存在：${filePath}`)
  const mode = RECORD_FILE_MODES.includes(fileMode) ? fileMode : 'auto'
  const useBase64 = mode === 'base64' || (mode === 'auto' && !isLocalGateway(conn.httpUrl))
  const file = useBase64 ? fileToRecordBase64(filePath) : filePath
  const fileBytes = useBase64 ? Buffer.byteLength(file) : 0
  const params =
    target.kind === 'group'
      ? { group_id: Number(target.id), message: [{ type: 'record', data: { file } }] }
      : { user_id: Number(target.id), message: [{ type: 'record', data: { file } }] }
  const action = target.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
  const body = await callOneBot(conn, action, params, { timeoutMs })
  const messageId = Number(body?.data?.message_id ?? body?.data?.messageId ?? 0)
  return { messageId, target, fileMode: useBase64 ? 'base64' : 'path', fileBytes }
}

/**
 * 对端报 ENOENT / 找不到文件时，基本可以断定「插件和 OneBot 不在一台机器」。
 * 把这条判断写成函数，方便在错误信息里给出可直接照做的提示。
 */
export function looksLikeCrossMachineMissingFile(message) {
  const text = String(message ?? '')
  return /ENOENT|no such file or directory|文件不存在|not found/i.test(text)
}

/**
 * 回读一条语音消息，确认它真的落地成 record 段。
 * 只回报 confirmed / duration，不回传 file / url —— 本机路径没有必要进模型上下文。
 */
export async function verifyVoiceSent(conn, messageId, { timeoutMs = 8000 } = {}) {
  if (!messageId) return { confirmed: false, duration: null }
  try {
    const body = await callOneBot(conn, 'get_msg', { message_id: Number(messageId) }, { timeoutMs })
    const message = body?.data?.message
    const segments = Array.isArray(message)
      ? message
      : Array.isArray(message?.message)
        ? message.message
        : Array.isArray(body?.data?.segments)
          ? body.data.segments
          : []
    const record = segments.find((segment) => segment?.type === 'record' || segment?.type === 'voice')
    if (!record) return { confirmed: false, duration: null }
    const duration = Number(record?.data?.duration ?? record?.data?.time ?? 0) || null
    return { confirmed: true, duration }
  } catch {
    return { confirmed: false, duration: null }
  }
}
