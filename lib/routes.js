// TTS 插件的 HTTP 面：/dsh-tts/*
//
// 全部同源（不额外引入鉴权 token）：DSH Web 已经要求登录会话，插件路由挂在同一个 server 上，
// 非 GET 再做一道同源 + JSON content-type 的 CSRF 双保险。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import {
  API_STYLES,
  CACHE_MAX_AGE_MS,
  CLONE_ALLOWED_EXT,
  CLONE_MAX_BASE64_BYTES,
  OFFICIAL_MODELS,
  PLACEHOLDER_NAMES,
  SINGING_STYLE,
  SINGING_TAG,
  STYLE_PRESETS,
  TTS_MODES,
  clearRefAudio,
  clearRefBackups,
  cloneAudioInfo,
  describeAsCurl,
  describeTtsConfig,
  fetchAudioFromUrl,
  fetchModelList,
  fetchVoiceList,
  guessModeForModel,
  isStyleConfigured,
  listRefBackups,
  normalizeRefAudio,
  readAudioCache,
  readJsonBodyLarge,
  reconcileModeModel,
  refAudioInfo,
  saveRefAudio,
  styleReadiness,
  synthesize,
  ttsCfg,
  viewForStyle,
} from './tts-lib.js'
import {
  dataDirOf,
  importFromQqBridge,
  maskKey,
  saveSettings,
} from './config.js'
import { makeTts, speak, voiceLibraryDir } from './speak.js'
import { pingOneBot, RECORD_FILE_MODES, resolveOneBot, sanitizeOnebot } from './onebot.js'

export const ROUTE_PREFIX = '/dsh-tts'

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

function sendJson(res, status, payload) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return parsed.host === req.headers.host
  } catch {
    return false
  }
}

function requestUrl(req) {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
}

async function readBody(req, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!sameOrigin(req)) {
    throw Object.assign(new Error('跨站请求被拒绝（Origin 与 Host 不一致）'), { statusCode: 403 })
  }
  const type = String(req.headers['content-type'] ?? '')
  if (!type.includes('application/json')) {
    throw Object.assign(new Error('请求必须是 application/json（防止表单 CSRF）'), { statusCode: 415 })
  }
  return readJsonBodyLarge(req, { maxBytes })
}

function method(req, res, allowed) {
  if (allowed.includes(req.method)) return true
  sendJson(res, 405, { ok: false, error: `只支持 ${allowed.join(' / ')}` })
  return false
}

/** 把 tts-lib 的默认视图与当前视图拼成「保存后该长什么样」的只读描述。 */
function describeAll(settings, home) {
  const tts = makeTts(settings, home)
  const conn = resolveOneBot(settings, home)
  return {
    ...describeTtsConfig(tts),
    onebot: {
      httpUrl: conn.httpUrl,
      tokenSet: Boolean(conn.accessToken),
      source: conn.source,
      // 配置里若还躺着全角字符，在这里先报出来：界面能提示「这条通道的 Token 有问题」，
      // 不必等用户点「测试连接」撞一次「连不上网关」才知道。
      nonAscii: conn.nonAscii ?? [],
    },
    // 注意：不能叫 voice —— describeTtsConfig 里的 voice 是「当前音色」字符串，重名会把 UI 的音色下拉污染成对象。
    voicePolicy: { ...settings.voice, dir: voiceLibraryDir(settings, home) },
    storage: {
      dataDir: dataDirOf(home),
      configPath: path.join(dataDirOf(home), 'config.json'),
      voiceDir: voiceLibraryDir(settings, home),
      cacheDir: tts.cacheDir,
      refDir: tts.cloneDir,
    },
    placeholders: PLACEHOLDER_NAMES,
  }
}

function safeCurl(tts, text) {
  try {
    return describeAsCurl(tts, { text: text || '你好，这是试听文本。' })
  } catch {
    return ''
  }
}

/**
 * @param {object} scope 带 webServer 的 cordis 作用域
 * @param {object} deps  { home, getSettings, logger }
 */
export function registerRoutes(scope, deps) {
  const { home, getSettings, logger } = deps
  const disposers = []
  const route = (pathname, handler) => {
    disposers.push(scope.webServer.register({ kind: 'exact', path: pathname, handler }))
  }

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      const status = Number(error?.statusCode) || (error?.stage === 'sing' ? 502 : 400)
      sendJson(res, status, {
        ok: false,
        error: String(error?.message ?? error),
        stage: error?.stage ?? '',
        ...(error?.summary ? { summary: error.summary } : {}),
      })
    }
  }

  // ── 状态 ────────────────────────────────────────────────────────────────
  route(`${ROUTE_PREFIX}/state`, wrap(async (req, res) => {
    if (!method(req, res, ['GET'])) return
    const { settings, file } = getSettings()
    const tts = makeTts(settings, home)
    const conn = resolveOneBot(settings, home)
    sendJson(res, 200, {
      ok: true,
      enabled: tts.enabled,
      aiEnabled: tts.aiEnabled,
      hasApiKey: Boolean(tts.apiKey),
      apiKeyHint: maskKey(tts.apiKey),
      apiStyle: tts.apiStyle,
      routeMode: tts.routeMode,
      routeModeEffective: tts.routeMode === '' ? tts.apiStyle : tts.routeMode,
      routeReady: {
        mimo: isStyleConfigured(tts, 'mimo'),
        breeze: isStyleConfigured(tts, 'breeze'),
      },
      // 与 /config 同口径（同一个 styleReadiness），并说明缺的是哪一项：
      // 早先这里只判 apiKey，于是「Key 存好了但没选模型」在 /state 显示已就绪、/config 显示未就绪。
      routeReadyDetail: {
        mimo: styleReadiness(tts, 'mimo'),
        breeze: styleReadiness(tts, 'breeze'),
      },
      model: tts.mimo.model,
      mode: tts.mode,
      voice: tts.mode === 'clone' ? '（克隆音色）' : tts.mode === 'voicedesign' ? '（音色设计）' : tts.voice,
      format: tts.format,
      maxChars: tts.maxChars,
      onebot: {
        httpUrl: conn.httpUrl,
        tokenSet: Boolean(conn.accessToken),
        source: conn.source,
        nonAscii: conn.nonAscii ?? [],
      },
      cloneReady: Boolean(cloneAudioInfo(tts)),
      configPath: file,
      log: logger.list().slice(-20),
    })
  }))

  // ── 配置 ────────────────────────────────────────────────────────────────
  route(`${ROUTE_PREFIX}/config`, wrap(async (req, res) => {
    if (req.method === 'GET') {
      const { settings, file } = getSettings()
      const tts = makeTts(settings, home)
      sendJson(res, 200, {
        ok: true,
        ...describeAll(settings, home),
        curl: safeCurl(tts, ''),
        importedFrom: settings.importedFrom ?? '',
        importedAt: settings.importedAt ?? 0,
        configPath: file,
      })
      return
    }
    if (!method(req, res, ['POST'])) return
    const body = await readBody(req, { maxBytes: 512 * 1024 })
    const patch = {}
    if (body.tts && typeof body.tts === 'object') {
      patch.tts = sanitizeTtsPatch(body.tts)
      // mode 与 model 是同一件事的两个说法：只改一个必然分叉，而分叉的后果很具体 ——
      // mode=clone + 预置模型会把参考音频 DataURL 当音色名发出去（上游 400
      // `Unknown voice: data:audio/wav;base64,…`），而 model 悄悄退回预置模型就是
      // 用户看到的「选了克隆 TTS，有时变回预置语音 TTS」。写盘前补全未提交的那一半，
      // 再以 mode 为准收敛成一对自洽的值。
      const currentTts = getSettings().settings?.tts ?? {}
      const settled = reconcileModeModel(
        patch.tts.mode !== undefined ? patch.tts.mode : currentTts.mode,
        patch.tts.model !== undefined ? patch.tts.model : currentTts.model
      )
      patch.tts.mode = settled.mode
      patch.tts.model = settled.model
    }
    if (body.onebot && typeof body.onebot === 'object') {
      patch.onebot = {
        ...(typeof body.onebot.httpUrl === 'string' ? { httpUrl: body.onebot.httpUrl.trim() } : {}),
        ...(typeof body.onebot.accessToken === 'string' ? { accessToken: body.onebot.accessToken.trim() } : {}),
      }
    }
    if (body.voice && typeof body.voice === 'object') patch.voice = sanitizeVoicePatch(body.voice)
    if (!Object.keys(patch).length) throw new Error('没有可保存的字段')
    let { settings } = saveSettings(home, patch)
    // 只去首尾空白，**绝不改写 Token 内容**：Token 是用户密码，
    // 0.3.4 曾把全角「！」自动转成「!」,把密码改坏（网关回 401）。
    // 这里只把「Token 里有非 ASCII 字符」这件事报出来，改不改由用户决定。
    const saved = sanitizeOnebot(settings.onebot)
    let onebotNonAscii = saved.nonAscii
    if (onebotNonAscii.length) {
      logger.info(
        `OneBot Token 里有 ${onebotNonAscii.length} 个非 ASCII 字符（${onebotNonAscii.map((f) => `${f.index}:${f.char}`).join(' / ')}）；`
        + '已原样保存并会原样发送，未做任何替换。',
      )
    }
    let check = null
    // 「保存并检查」：保存后立刻用新配置拉一次模型列表，成功就把清单回存进 models。
    //
    // checkStyle 决定「检查哪一套协议」：面板上点的是「保存 Breeze 配置并检查」，
    // 就该拿 Breeze 的地址 + Breeze 的 Key 去探活。以前这里直接 makeTts(settings)，
    // 而 makeTts 是按 **apiStyle** 投影的 —— 用户完全可能 apiStyle='openai'（上次在小米面板
    // 编辑过）却 routeMode='breeze'（实际走 Breeze），于是拿小米的 baseUrl 配 Breeze 的
    // brz_ Key 去打，上游必然回 401 Invalid API Key：明明刚成功拉过模型，一保存就说 Key 错。
    if (body.tts && body.tts.check === true) {
      try {
        const checkStyle = pickCheckStyle(body.tts, settings)
        const result = await fetchModelList(makeTtsForStyle(settings, home, checkStyle))
        // fetchModelList 失败时是返回 {ok:false,error} 而不是抛错；不判 ok 就取
        // result.models 会崩出裸的 "reading 'length'"，把真实原因（超时/401/非 JSON）吞掉。
        if (!result.ok) {
          const err = new Error(result.error || '模型检查失败')
          err.status = result.status ?? null
          err.url = result.url ?? ''
          throw err
        }
        const models = result.models || []
        // 拉到的模型存回**被检查的那一套**，别一律写顶层 models（那会让 Breeze 的模型
        // 出现在小米面板的下拉里，看着就像串台了）。
        const repatched = checkStyle === 'breeze'
          ? saveSettings(home, { tts: { breeze: { models } } })
          : saveSettings(home, { tts: { models } })
        settings = repatched.settings
        check = { ok: true, url: result.url, count: models.length, models, style: checkStyle }
      } catch (error) {
        check = { ok: false, error: String(error?.message ?? error), status: error?.status ?? null, url: error?.url ?? '' }
        logger.warn(`保存后拉取模型失败：${check.error}`)
      }
    }
    logger.info(`配置已保存：${Object.keys(patch).join(' / ')}`)
    sendJson(res, 200, {
      ok: true,
      ...describeAll(settings, home),
      curl: safeCurl(makeTts(settings, home), ''),
      saved: Object.keys(patch),
      check,
      onebotNonAscii,
    })
  }))

  // ── 模型 / 音色探活 ─────────────────────────────────────────────────────
  // 探活的失败原因必须带上「打了哪个地址、等了多久」：只回一个「超时」，
  // 用户和日志都无从判断是网关卡住、地址写错还是 DNS 不解析。
  route(`${ROUTE_PREFIX}/models`, wrap(async (req, res) => {
    if (!method(req, res, ['POST'])) return
    const body = await readBody(req)
    const { settings } = getSettings()
    const tts = makeTts(settings, home)
    const style = API_STYLES.includes(body.apiStyle) ? body.apiStyle : tts.apiStyle
    const base = viewForStyle(tts, style)
    const timeoutMs = probeTimeout(body.timeoutMs)
    const probe = {
      ...base,
      baseUrl: String(body.baseUrl ?? '').trim() || base.baseUrl,
      apiKey: String(body.apiKey ?? '').trim() || base.apiKey,
      headerTemplate: String(body.headerTemplate ?? '').trim() || base.headerTemplate,
    }
    const startedAt = Date.now()
    try {
      const result = await fetchModelList(probe, { timeoutMs })
      // 同 check 分支：失败是返回 {ok:false}，不是抛错；不判 ok 会在下面崩裸 TypeError。
      if (!result.ok) throw probeError('拉取模型', result, Date.now() - startedAt, timeoutMs)
      const models = result.models || []
      sendJson(res, 200, {
        ok: true,
        url: result.url,
        elapsedMs: Date.now() - startedAt,
        count: models.length,
        note: result.note ?? '',
        models: models.map((id) => {
          const known = OFFICIAL_MODELS.find((item) => item.id === id)
          return { id, mode: known?.mode ?? '', label: tts.modelLabels?.[id] || known?.label || id, note: known?.note ?? '' }
        }),
      })
    } catch (error) {
      logger.error(`拉取模型失败：${error?.message ?? error}`)
      sendJson(res, 502, { ok: false, error: String(error?.message ?? error), url: error?.target ?? '', elapsedMs: error?.elapsedMs ?? null, code: error?.code ?? '', timedOut: error?.timedOut === true, triedFamilies: error?.triedFamilies === true })
    }
  }))

  route(`${ROUTE_PREFIX}/voices`, wrap(async (req, res) => {
    if (!method(req, res, ['POST'])) return
    const body = await readBody(req)
    const { settings } = getSettings()
    const tts = makeTts(settings, home)
    const style = API_STYLES.includes(body.apiStyle) ? body.apiStyle : tts.apiStyle
    const base = viewForStyle(tts, style)
    const timeoutMs = probeTimeout(body.timeoutMs)
    const probe = {
      ...base,
      baseUrl: String(body.baseUrl ?? '').trim() || base.baseUrl,
      apiKey: String(body.apiKey ?? '').trim() || base.apiKey,
    }
    const startedAt = Date.now()
    try {
      const result = await fetchVoiceList(probe, { timeoutMs })
      // 同上：失败返回 {ok:false}，不判 ok 会崩裸 TypeError（reading 'length'）。
      if (!result.ok) throw probeError('拉取音色', result, Date.now() - startedAt, timeoutMs)
      const voices = result.voices || []
      sendJson(res, 200, { ok: true, url: result.url, elapsedMs: Date.now() - startedAt, count: voices.length, note: result.note ?? '', voices })
    } catch (error) {
      logger.error(`拉取音色失败：${error?.message ?? error}`)
      sendJson(res, 502, { ok: false, error: String(error?.message ?? error), url: error?.target ?? '', elapsedMs: error?.elapsedMs ?? null, code: error?.code ?? '', timedOut: error?.timedOut === true, triedFamilies: error?.triedFamilies === true })
    }
  }))

  // ── 试听 ────────────────────────────────────────────────────────────────
  route(`${ROUTE_PREFIX}/preview`, wrap(async (req, res) => {
    if (!method(req, res, ['POST'])) return
    const body = await readBody(req, { maxBytes: 512 * 1024 })
    const text = String(body.text ?? '').trim()
    if (!text) throw new Error('试听文本不能为空')
    const { settings } = getSettings()
    const tts = makeTts(settings, home)
    const style = API_STYLES.includes(body.apiStyle) ? body.apiStyle : tts.apiStyle
    const base = viewForStyle(tts, style)
    const probe = {
      ...base,
      // 试听走单边协议：不参与 smart 路由（用户正在编辑哪套就测哪套）。
      routeMode: style === 'breeze' ? 'breeze' : 'mimo',
      apiStyle: style,
      ...(String(body.voice ?? '').trim() ? { voice: String(body.voice).trim() } : {}),
      ...(String(body.baseUrl ?? '').trim() ? { baseUrl: String(body.baseUrl).trim() } : {}),
      ...(String(body.apiKey ?? '').trim() ? { apiKey: String(body.apiKey).trim() } : {}),
      ...(String(body.headerTemplate ?? '').trim() ? { headerTemplate: String(body.headerTemplate).trim() } : {}),
      ...(String(body.bodyTemplate ?? '').trim() ? { bodyTemplate: String(body.bodyTemplate).trim() } : {}),
    }
    const startedAt = Date.now()
    // 预置音色试听撞上克隆模型：用户点的是音色卡上的「试听」，意图是听这个音色，
    // 但克隆模型的 voice 必须是参考音频 DataURL，照原样发一定 400。
    // 这里自动把试听切到预置音色模型（只影响这一次试听，不改保存的配置），并如实告知。
    const warnings = []
    const askedVoice = String(body.voice ?? '').trim()
    if (style !== 'breeze' && askedVoice && !/^data:audio\//i.test(askedVoice) && guessModeForModel(probe.model) === 'clone') {
      const presetModel = 'mimo-v2.5-tts'
      warnings.push(
        `当前模型 ${probe.model} 是克隆模型，不能直接念预设音色「${askedVoice}」；`
        + `这次试听已临时改用 ${presetModel}（保存的配置没变）`
      )
      probe.model = presetModel
      probe.mode = 'preset'
    }
    try {
      const result = await synthesize(probe, {
        text,
        style: body.style ?? null,
        sing: body.sing === true,
        format: body.format ?? null,
        design: body.design ?? null,
        prompt: body.prompt ?? null,
      })
      logger.info(`试听成功：${text.length} 字 / ${Date.now() - startedAt}ms / ${result.route}`)
      sendJson(res, 200, {
        ok: true,
        ...result,
        warnings: [...warnings, ...(result.warnings || [])],
        curl: safeCurl(probe, text),
      })
    } catch (error) {
      // 以前试听失败根本不写日志，用户报「试听报错」时日志里一条都没有，只能靠猜。
      // 把路由、目标地址、上游原始响应一起落盘，下次直接看日志就能定位。
      const summary = error?.summary || {}
      logger.error(
        `试听失败：${text.length} 字 / ${Date.now() - startedAt}ms / route=${summary.route ?? probe.apiStyle}`
        + ` / 上游 HTTP ${error?.upstreamStatus ?? '-'} / url=${summary.sentUrl ?? probe.baseUrl}`
        + ` / ${error?.message ?? error}`
        + (summary.excerpt ? ` / 原文=${String(summary.excerpt).replace(/\s+/g, ' ').slice(0, 300)}` : '')
      )
      throw error
    }
  }))

  route(`${ROUTE_PREFIX}/audio`, wrap(async (req, res) => {
    if (!method(req, res, ['GET'])) return
    const url = requestUrl(req)
    const id = url.searchParams.get('id') ?? ''
    const { settings } = getSettings()
    const tts = makeTts(settings, home)
    const cached = readAudioCache(tts, id)
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': cached.mimeType,
      'content-length': cached.bytes,
    })
    res.end(cached.buffer)
  }))

  route(`${ROUTE_PREFIX}/ref-audio`, wrap(async (req, res) => {
    if (!method(req, res, ['GET'])) return
    const url = requestUrl(req)
    const kind = url.searchParams.get('kind') === 'sing' ? 'sing' : 'clone'
    const { settings } = getSettings()
    const tts = makeTts(settings, home)
    const info = refAudioInfo(tts, kind)
    if (!info) throw Object.assign(new Error('还没有上传这类参考音频'), { statusCode: 404 })
    const buffer = fs.readFileSync(info.path)
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': info.mimeType || 'audio/wav',
      'content-length': buffer.length,
    })
    res.end(buffer)
  }))

  // ── 参考音频（克隆 / 唱歌） ─────────────────────────────────────────────
  route(`${ROUTE_PREFIX}/clone`, wrap(async (req, res) => {
    if (!method(req, res, ['POST'])) return
    const body = await readBody(req, { maxBytes: Math.ceil(CLONE_MAX_BASE64_BYTES * 1.4) })
    const fileName = String(body.fileName ?? '').trim();
    if (!fileName) throw new Error('缺少 fileName（如 voice.mp3）')
    const ext = path.extname(fileName).toLowerCase()
    if (!CLONE_ALLOWED_EXT.includes(ext)) throw new Error(`只支持 ${CLONE_ALLOWED_EXT.join(' / ')}，收到 ${ext || '空扩展名'}`)
    const kind = body.kind === 'sing' ? 'sing' : 'clone'
    const raw = String(body.dataBase64 ?? body.b64 ?? '').replace(/^data:[^;]+;base64,/, '')
    if (!raw) throw new Error('缺少音频内容（dataBase64）')
    const buffer = Buffer.from(raw, 'base64')
    if (!buffer.length) throw new Error('音频内容解码后为空')
    const { settings } = getSettings()
    const tts = makeTts(settings, home)
    const current = kind === 'sing' ? refAudioInfo(tts, 'sing') : cloneAudioInfo(tts)
    if (current && body.overwrite !== true) {
      sendJson(res, 409, {
        ok: false,
        needsConfirm: true,
        kind,
        error: '已经有参考音频了；确认覆盖请带 overwrite=true 再提交一次',
        current: { fileName: current.fileName, bytes: current.bytes, savedAt: current.savedAt },
      })
      return
    }
    const normalized = await normalizeRefAudio(tts, { buffer, ext })
    const saved = saveRefAudio(tts, {
      buffer: normalized.buffer,
      fileName: normalized.changed ? `${path.basename(fileName, ext)}.wav` : fileName,
      kind,
      // 时长只用于在控制台提示「够不够长」，不参与请求构造。
      // saveRefAudio 会优先从落盘的 WAV 自己量一遍（不依赖 ffmpeg），这里传的只是兜底值。
      seconds: body.seconds,
      speechSeconds: body.speechSeconds,
    })
    // 上传说话音色 = 用户明确要用克隆音色，所以这里把 mode 切成 clone。**同时必须把模型
    // 也切到克隆模型**：只写 mode 会让「合成模式」显示克隆音色、模型却还是预置音色 TTS，
    // 这种分叉的请求上游只会回 400 `Unknown voice: data:audio/wav;base64,…`，用户听到的
    // 就是「明明选了克隆，念出来的还是预置语音」。唱歌参考音频只当歌词素材，不动这两项。
    const clonePatch = kind === 'sing'
      ? { singRef: saved }
      : { clone: saved, ...reconcileModeModel('clone', makeTts(settings, home).model) };
    const { settings: next } = saveSettings(home, { tts: clonePatch })
    logger.info(`参考音频已保存（${kind}）：${saved.fileName ?? fileName} / ${saved.bytes ?? buffer.length} bytes`)
    sendJson(res, 200, {
      ok: true,
      kind,
      previous: current ? { fileName: current.fileName, bytes: current.bytes } : null,
      normalized: { changed: normalized.changed, note: normalized.note ?? '' },
      ...describeAll(next, home),
    })
  }))

  route(`${ROUTE_PREFIX}/clear-ref`, wrap(async (req, res) => {
    if (!method(req, res, ['POST'])) return
    const body = await readBody(req)
    const kind = body.kind === 'sing' ? 'sing' : 'clone'
    const { settings } = getSettings()
    const tts = makeTts(settings, home)
    const removed = clearRefAudio(tts, kind)
    const { settings: next } = saveSettings(home, { tts: kind === 'sing' ? { singRef: null } : { clone: null } })
    logger.info(`参考音频已清除（${kind}）`)
    sendJson(res, 200, { ok: true, kind, removed, ...describeAll(next, home) })
  }))

  route(`${ROUTE_PREFIX}/ref-backup`, wrap(async (req, res) => {
    if (!method(req, res, ['POST'])) return
    const body = await readBody(req)
    const kind = body.kind === 'sing' ? 'sing' : 'clone'
    const action = ['clear', 'open'].includes(body.action) ? body.action : 'list'
    const { settings } = getSettings()
    const tts = makeTts(settings, home)
    const dir = kind === 'sing' ? tts.singRefDir : tts.cloneDir
    if (action === 'clear') {
      const result = clearRefBackups(tts, kind)
      sendJson(res, 200, { ok: true, kind, action, ...result, backups: listRefBackups(tts, kind) })
      return
    }
    if (action === 'open') {
      // 用系统文件管理器打开备份目录；不存在就先建一个空目录，别让按钮报错。
      fs.mkdirSync(dir, { recursive: true })
      const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      await new Promise((resolve, reject) => {
        execFile(opener, [dir], { windowsHide: false }, (error) => (error ? reject(error) : resolve()))
      })
      sendJson(res, 200, { ok: true, kind, action: 'open', dir, backups: listRefBackups(tts, kind) })
      return
    }
    sendJson(res, 200, { ok: true, kind, action: 'list', backups: listRefBackups(tts, kind), dir })
  }))

  route(`${ROUTE_PREFIX}/fetch-audio`, wrap(async (req, res) => {
    if (!method(req, res, ['POST'])) return
    const body = await readBody(req, { maxBytes: 256 * 1024 })
    const url = String(body.url ?? '').trim()
    if (!url) throw new Error('缺少音频 URL')
    const { settings } = getSettings()
    const tts = makeTts(settings, home)
    const result = await fetchAudioFromUrl(url, { allowPrivate: tts.allowPrivateFetch === true })
    sendJson(res, 200, {
      ok: true,
      url: result.finalUrl || url,
      bytes: result.bytes,
      mimeType: result.mimeType,
      looksAudio: result.looksAudio,
      dataBase64: result.dataBase64,
    })
  }))

  // ── 发语音 ──────────────────────────────────────────────────────────────
  route(`${ROUTE_PREFIX}/speak`, wrap(async (req, res) => {
    if (!method(req, res, ['POST'])) return
    const body = await readBody(req, { maxBytes: 512 * 1024 })
    const { settings } = getSettings()
    const startedAt = Date.now()
    const result = await speak({
      settings,
      home,
      text: body.text,
      target: body.target,
      style: body.style ?? null,
      voice: body.voice ?? null,
      sing: body.sing === true,
      format: body.format ?? null,
      label: body.label ?? '',
      verify: body.verify !== false,
      volume: body.volume === undefined || body.volume === null ? null : Number(body.volume),
      normalize: body.normalize === true,
      loudness: body.loudness ?? null,
    })
    logger.info(`语音已发送：${result.target} / messageId=${result.messageId} / ${Date.now() - startedAt}ms`)
    sendJson(res, 200, result)
  }))

  // ── 通道探活 / 导入 / 日志 ─────────────────────────────────────────────
  route(`${ROUTE_PREFIX}/ping`, wrap(async (req, res) => {
    if (!method(req, res, ['POST'])) return
    const { settings } = getSettings()
    const conn = resolveOneBot(settings, home)
    const info = await pingOneBot(conn)
    sendJson(res, 200, { ok: true, ...info })
  }))

  route(`${ROUTE_PREFIX}/import`, wrap(async (req, res) => {
    if (!method(req, res, ['POST'])) return
    const body = await readBody(req, { maxBytes: 64 * 1024 })
    const { settings } = importFromQqBridge(home, String(body.path ?? '').trim())
    logger.info(`已从 ${settings.importedFrom} 导入 TTS 配置`)
    sendJson(res, 200, { ok: true, importedFrom: settings.importedFrom, ...describeAll(settings, home) })
  }))

  route(`${ROUTE_PREFIX}/log`, wrap(async (req, res) => {
    if (!method(req, res, ['GET'])) return
    sendJson(res, 200, { ok: true, log: logger.list() })
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
    disposers.length = 0
  }
}

/**
 * 决定「保存并检查」该探活哪一套协议。
 *
 * 前端可以在 body.tts.checkStyle 里明确指定（面板上点的是哪个面板就查哪个）；
 * 没指定时按**实际路由**推断，而不是按 apiStyle —— apiStyle 只表示「控制台上次在编辑哪一套」，
 * 用户完全可能停留在小米面板、实际却用 routeMode='breeze' 走 Breeze。
 * 按 apiStyle 猜会拿错地址配错 Key，得到一个假的「Invalid API Key」。
 */
function pickCheckStyle(input, settings) {
  const explicit = String(input?.checkStyle ?? '').trim()
  if (API_STYLES.includes(explicit)) return explicit
  const routeMode = String(settings?.tts?.routeMode ?? '').trim()
  if (routeMode === 'breeze') return 'breeze'
  if (routeMode === 'mimo') return 'openai'
  // smart / 空串：跟随 apiStyle（与「实际会走哪套」的老行为一致）。
  return settings?.tts?.apiStyle === 'breeze' ? 'breeze' : 'openai'
}

/**
 * 按指定协议投影出一份探活用配置。
 * 复用 viewForStyle：它已经处理好了两套协议各自的 baseUrl / apiKey / headerTemplate，
 * 直接 makeTts 拿到的是按 apiStyle 投影的那一份，未必是用户想检查的那一套。
 */
function makeTtsForStyle(settings, home, style) {
  const base = makeTts(settings, home)
  return API_STYLES.includes(style) ? viewForStyle(base, style) : base
}

function sanitizeTtsPatch(input) {
  const patch = {}
  const strings = ['baseUrl', 'model', 'voice', 'format', 'style', 'styleMode', 'singStyle', 'design', 'prompt', 'headerTemplate', 'bodyTemplate']
  for (const key of strings) {
    if (Object.hasOwn(input, key)) patch[key] = input[key] === null ? '' : String(input[key])
  }
  if (Object.hasOwn(input, 'mode') && TTS_MODES.includes(input.mode)) patch.mode = input.mode
  if (Object.hasOwn(input, 'apiStyle') && API_STYLES.includes(input.apiStyle)) patch.apiStyle = input.apiStyle
  if (Object.hasOwn(input, 'routeMode')) {
    const value = String(input.routeMode ?? '').trim()
    if (value === '') patch.routeMode = ''
    else if (['mimo', 'breeze', 'smart', 'auto', 'length'].includes(value)) patch.routeMode = value === 'auto' || value === 'length' ? 'smart' : value
    else throw new Error('routeMode 只能是 mimo / breeze / smart（空串=跟随 apiStyle）')
  }
  if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
  if (typeof input.aiEnabled === 'boolean') patch.aiEnabled = input.aiEnabled
  if (typeof input.autoSendVoice === 'boolean') patch.autoSendVoice = input.autoSendVoice
  if (typeof input.allowPrivateFetch === 'boolean') patch.allowPrivateFetch = input.allowPrivateFetch
  if (Object.hasOwn(input, 'lengthThreshold')) patch.lengthThreshold = clampInt(input.lengthThreshold, 10, 2000)
  if (Object.hasOwn(input, 'durationThreshold')) patch.durationThreshold = clampInt(input.durationThreshold, 1, 600)
  if (Object.hasOwn(input, 'timeoutMs')) patch.timeoutMs = positiveNumber(input.timeoutMs, 180000)
  if (Object.hasOwn(input, 'maxChars')) patch.maxChars = clampInt(input.maxChars, 20, 100000)
  if (Object.hasOwn(input, 'singAttempts')) patch.singAttempts = clampInt(input.singAttempts, 1, 6)
  // apiKey：不带这个键 = 不改动；显式空串 = 清空（与 qq-bridge 的语义一致）。
  if (Object.hasOwn(input, 'apiKey')) patch.apiKey = String(input.apiKey ?? '')
  if (input.voiceSettings && typeof input.voiceSettings === 'object') patch.voiceSettings = input.voiceSettings
  if (input.breeze && typeof input.breeze === 'object') {
    const breeze = {}
    for (const key of ['baseUrl', 'model', 'voice', 'format', 'headerTemplate', 'bodyTemplate', 'apiKey']) {
      if (Object.hasOwn(input.breeze, key)) breeze[key] = input.breeze[key] === null ? '' : String(input.breeze[key])
    }
    if (Array.isArray(input.breeze.models)) breeze.models = input.breeze.models
    if (Array.isArray(input.breeze.voices)) breeze.voices = input.breeze.voices
    if (input.breeze.voiceSettings && typeof input.breeze.voiceSettings === 'object') breeze.voiceSettings = input.breeze.voiceSettings
    if (Object.keys(breeze).length) patch.breeze = breeze
  }
  if (input.variants && typeof input.variants === 'object' && !Array.isArray(input.variants)) {
    patch.variants = input.variants
  }
  if (Array.isArray(input.models)) patch.models = [...new Set(input.models.map((item) => String(item ?? '').trim()).filter(Boolean))]
  if (input.modelLabels && typeof input.modelLabels === 'object') patch.modelLabels = input.modelLabels
  return patch
}

function sanitizeVoicePatch(input) {
  const patch = {}
  if (Object.hasOwn(input, 'dir')) patch.dir = String(input.dir ?? '')
  if (Object.hasOwn(input, 'maxSeconds')) patch.maxSeconds = clampInt(input.maxSeconds, 1, 3600)
  if (Object.hasOwn(input, 'maxBytes')) patch.maxBytes = clampInt(input.maxBytes, 1024, 100 * 1024 * 1024)
  if (Object.hasOwn(input, 'maxPerMinute')) patch.maxPerMinute = clampInt(input.maxPerMinute, 1, 60)
  if (Object.hasOwn(input, 'maxPerHour')) patch.maxPerHour = clampInt(input.maxPerHour, 1, 600)
  if (Object.hasOwn(input, 'defaultVolume')) {
    const value = Number(input.defaultVolume)
    if (!Number.isFinite(value) || value < 0.1 || value > 4) throw new Error('defaultVolume 需在 0.1 ~ 4 之间')
    patch.defaultVolume = value
  }
  if (Object.hasOwn(input, 'loudness')) patch.loudness = String(input.loudness)
  if (Object.hasOwn(input, 'autoReadback')) patch.autoReadback = input.autoReadback === true
  if (Object.hasOwn(input, 'fileMode')) {
    const mode = String(input.fileMode ?? '')
    if (!RECORD_FILE_MODES.includes(mode)) throw new Error(`fileMode 只能是 ${RECORD_FILE_MODES.join(' / ')}`)
    patch.fileMode = mode
  }
  if (Object.hasOwn(input, 'ffmpegPath')) patch.ffmpegPath = String(input.ffmpegPath ?? '')
  return patch
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) throw new Error(`需要是数字，收到「${value}」`)
  return Math.min(max, Math.max(min, n))
}

/** 探活等待上限：默认 20s，允许面板传 body.timeoutMs 覆盖（1s ~ 120s）。 */
function probeTimeout(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 20000
  return Math.min(120000, Math.max(1000, Math.round(n)))
}

/**
 * 把探活失败包成带「打了哪个地址、等了多久、为什么」的错误。
 * 只回一个「超时」时，用户和日志都无从判断是网关卡住、地址写错还是 DNS 不解析。
 *
 * 0.3.12：文案与真实耗时对齐。这里有两处曾经互相矛盾：
 *  ① 以前 elapsedMs 是「首次 + 重试」两次之和，上限却写单次 timeoutMs，
 *     于是出现「在 10010ms 内没有响应（等待上限 20000ms）」——现在两次共用一份预算；
 *  ② 以前 timedOut 还去匹配 /超时|timeout|ETIMEDOUT/，把**连接层**的 ETIMEDOUT 也算作
 *     「等满了预算」，文案照抄「等待上限 20000ms」，可实际 10 秒就被上游掐断了。
 *     现在只有我们自己的硬截止（result.timedOut，来自 probeTimeout）才走「超时」文案，
 *     其它连接错误如实报错误码，不再硬套一个对不上的上限。
 */
function probeError(label, result, elapsedMs, timeoutMs) {
  const url = result?.url || ''
  const raw = String(result?.error || '')
  const timedOut = result?.timedOut === true
  let detail
  if (timedOut) {
    // spent 兜底夹到 timeoutMs：即便某条路径多跑了几毫秒，也别让「等了 20030ms
    // （上限 20000ms）」这种话再冒出来。
    const spent = Math.min(elapsedMs, timeoutMs)
    const retried = result?.triedFamilies ? '，已自动重试一次仍失败' : ''
    detail = `${label}超时：${url} 在 ${spent}ms 内没有响应（等待上限 ${timeoutMs}ms${retried}）`
  } else {
    const code = result?.code ? `（${result.code}）` : ''
    // 连接层报错时也带上真实耗时，但**不写**「等待上限」——那会暗示是等满了预算，
    // 而实际往往是对端提前掐断（ETIMEDOUT / ECONNRESET / TLS 握手失败）。
    const spent = elapsedMs > 0 ? `，耗时 ${Math.min(elapsedMs, timeoutMs)}ms` : ''
    detail = `${label}失败：${raw || (result?.status ? 'HTTP 错误' : '未知错误')}${code}${result?.status ? `（HTTP ${result.status}）` : ''}${spent}${url ? ` · ${url}` : ''}`
  }
  const error = new Error(detail)
  error.target = url
  error.elapsedMs = elapsedMs
  error.code = result?.code || ''
  error.timedOut = timedOut
  error.triedFamilies = result?.triedFamilies === true
  return error
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}