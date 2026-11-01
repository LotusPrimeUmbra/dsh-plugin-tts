// 「合成 → 落盘 → 限流 → 发 OneBot → 回读 → 清理」的完整编排。
//
// 与 qq-bridge 的 /api/socialV2/tts-speak 保持同样的顺序和语义，但去掉了 QQ 会话鉴权那一层
// （本插件在 DSH 里跑，鉴权交给 DSH 的同源策略 + 会话本身）。
import path from 'node:path'
import fs from 'node:fs'
import {
  CACHE_MAX_AGE_MS,
  isStyleConfigured,
  pruneCacheOlder,
  pruneStagedAudio,
  readAudioCache,
  resolveRouteStyle,
  scheduleDelete,
  stageAudioToLibrary,
  synthesize,
  ttsCfg,
  viewForStyle,
} from './tts-lib.js'
import { processAudioVolume } from './voice-core.js'
import {
  budgetCheck,
  budgetCommit,
  isLocalGateway,
  looksLikeCrossMachineMissingFile,
  resolveOneBot,
  sendVoiceRecord,
  targetToParams,
  verifyVoiceSent,
} from './onebot.js'
import { dataDirOf } from './config.js'

/** 把设置投影成 tts-lib 需要的运行时配置（rootDir 决定 state/ 与参考音频目录）。 */
export function makeTts(settings, home) {
  return ttsCfg(settings?.tts ?? {}, { rootDir: dataDirOf(home) })
}

/**
 * 立即删掉本次发送产生的临时文件（暂存的 tts-*.wav，以及音量/响度处理后产生的中间文件）。
 * 只删我们自己刚生成的那两个具体路径，不做目录扫描，避免误删用户放进来的音频。
 */
function cleanupStaged(...paths) {
  for (const p of paths) {
    if (!p) continue
    try {
      fs.rmSync(String(p), { force: true })
    } catch {
      // 删不掉不该影响发送结果（Windows 上偶发占用），留给 pruneStagedAudio 兜底。
    }
  }
}

export function voiceLibraryDir(settings, home) {
  const configured = String(settings?.voice?.dir ?? '').trim()
  return configured ? path.resolve(configured) : path.join(dataDirOf(home), 'voice')
}

function extFromMime(mimeType) {
  if (mimeType === 'audio/mpeg') return '.mp3'
  if (mimeType === 'audio/L16') return '.pcm'
  return '.wav'
}

/**
 * 合成并尝试发送。返回给工具 / HTTP 层的结果对象。
 *
 * @param {object} opts
 *   settings  插件设置（tts / onebot / voice）
 *   home      DSH_HOME
 *   text      文本
 *   target    "group:123" / "private:456"
 *   style, voice, sing, format, label, verify
 *   volume, normalize, loudness  本地音量处理（可选）
 */
export async function speak({ settings, home, text, target, style = null, voice = null, sing = false, format = null, label = '', verify = true, volume = null, normalize = false, loudness = null }) {
  const tts = makeTts(settings, home)
  if (!tts.enabled) throw new Error('TTS 已关闭（tts.enabled=false）：请先在 TTS 面板里打开')
  if (!tts.aiEnabled) throw new Error('AI 调用 TTS 已关闭（tts.aiEnabled=false）：请先在 TTS 面板里打开')
  const body = String(text ?? '')
  if (!body.trim()) throw new Error('要合成的文本不能为空')
  if (tts.maxChars > 0 && body.length > tts.maxChars) {
    throw new Error(`文本过长：${body.length} 字，上限 ${tts.maxChars} 字（tts.maxChars 可调）`)
  }
  const dest = targetToParams(target)
  const voiceCfg = settings?.voice ?? {}
  budgetCheck(dest.key, voiceCfg)

  const synArgs = { text: body, style, voiceOverride: voice, sing: sing === true, format }
  const planned = resolveRouteStyle(tts, { text: body, sing: sing === true })
  let syn
  let failoverNote = ''
  try {
    syn = await synthesize(tts, synArgs)
  } catch (error) {
    const alternate = planned === 'breeze' ? 'mimo' : 'breeze'
    const code = Number(error?.upstreamStatus ?? 0)
    const canFailover = tts.routeMode === 'smart' && sing !== true
      && (code === 0 || code >= 500)
      && isStyleConfigured(tts, alternate)
    if (!canFailover) throw error
    syn = await synthesize(
      { ...viewForStyle(tts, alternate), routeMode: alternate === 'breeze' ? 'breeze' : 'mimo' },
      synArgs,
    )
    failoverNote = `原定 ${planned} 合成失败（${code || '网络错误'}），本次已自动切到 ${alternate}`
  }

  if (syn.sing && syn.actuallySang !== true) {
    const error = new Error(`上游试了 ${syn.attempts ?? 1} 次都只是念白，这段可能没真的唱出来（唱腔是概率性的，可以再发一次试试）`)
    error.stage = 'sing'
    error.summary = { ok: false, stage: 'sing', sing: syn.sing, actuallySang: syn.actuallySang, attempts: syn.attempts, durationSec: syn.durationSec, audioId: syn.audioId }
    throw error
  }

  const startedAt = Date.now()
  const voiceDir = voiceLibraryDir(settings, home)
  pruneCacheOlder(tts, { maxAgeMs: CACHE_MAX_AGE_MS })
  const cached = readAudioCache(tts, syn.audioId)
  const ext = extFromMime(syn.mimeType)
  const staged = stageAudioToLibrary(voiceDir, cached.buffer, ext, 'tts')
  pruneStagedAudio(voiceDir, { keep: 20 })

  let processed = null
  let sendPath = staged.path
  const effectiveVolume = volume === null || volume === undefined ? Number(voiceCfg.defaultVolume ?? 1) : Number(volume)
  const wantLoudness = normalize === true
  if (wantLoudness || Math.abs(effectiveVolume - 1) > 1e-9) {
    processed = await processAudioVolume(staged.path, {
      volume: effectiveVolume,
      normalize: wantLoudness,
      loudness: loudness ?? voiceCfg.loudness ?? 'normal',
      ffmpegPath: voiceCfg.ffmpegPath || null,
    })
    sendPath = processed.path
  }

  const conn = resolveOneBot(settings, home)
  let sent
  try {
    // fileMode：跨机器时必须用 base64 内联，否则远端 OneBot 会 stat 一个我们本机的路径。
    sent = await sendVoiceRecord(conn, dest, sendPath, { fileMode: voiceCfg.fileMode || 'auto' })
  } catch (error) {
    // 发送失败也要清掉本机临时音频：它已经没用了，留着只占磁盘。
    cleanupStaged(staged.path, processed?.path)
    const message = String(error?.message ?? error)
    // 跨机器时最容易踩这个：合成成功、发送失败，报 ENOENT + 一个本机路径。
    // 直接把「为什么」和「怎么改」写进错误里，而不是丢一个 Node 的原始报错。
    const hint = looksLikeCrossMachineMissingFile(message) && !isLocalGateway(conn.httpUrl)
      ? `（提示：OneBot 在 ${conn.httpUrl}，与本插件不在同一台机器。`
        + '你看到的那个路径是**本机**的临时音频，远端读不到。'
        + '插件默认已在跨机器时改用 base64 内联发送；若仍报这条，请把「录音文件发送方式」设为 base64 再试。）'
      : ''
    const wrapped = new Error(`音频已经合成好了，但发送失败：${message}${hint}`)
    wrapped.stage = 'send'
    wrapped.audioId = syn.audioId
    throw wrapped
  }
  budgetCommit(dest.key)

  const verification = verify === false || voiceCfg.autoReadback === false
    ? null
    : await verifyVoiceSent(conn, sent.messageId)

  const routeView = viewForStyle(tts, syn.route === 'breeze' ? 'breeze' : 'openai')
  const voiceLabel = tts.mode === 'clone'
    ? '（克隆音色）'
    : tts.mode === 'voicedesign'
      ? '（音色设计）'
      : String(routeView.voice ?? tts.voice ?? '')

  const warnings = [failoverNote, ...(syn.warnings ?? [])].filter(Boolean)
  if (processed?.converted === false && processed?.applied === false) {
    // 原样发送，不产生 warning。
  } else if (processed?.detail) {
    warnings.push(processed.detail)
  }

  // 发送完立刻清掉本机临时合成文件，不留残留。
  // 以前是 scheduleDelete(60s 延迟)，用户在「发到QQ」里能看到 voice/ 目录堆着 tts-*.wav。
  // 现在改为：发送成功 → 立即删；发送失败也在 finally 里删（音频已无用，留着只占地）。
  // cached.path 是合成缓存（同一音频重复发送可复用），保留原有时限策略，不在此处删。
  cleanupStaged(staged.path, processed?.path)
  scheduleDelete(cached.path)

  return {
    ok: true,
    target: dest.key,
    messageId: sent.messageId,
    text: body.length > 120 ? `${body.slice(0, 120)}…` : body,
    route: syn.route,
    sing: syn.sing,
    actuallySang: syn.actuallySang,
    durationSec: syn.durationSec ?? verification?.duration ?? null,
    attempts: syn.attempts,
    voice: syn.sing ? `${voiceLabel}·唱歌` : voiceLabel,
    bytes: syn.bytes,
    mimeType: syn.mimeType,
    elapsedMs: Date.now() - startedAt,
    label: String(label ?? ''),
    verified: verification?.confirmed === true,
    warnings,
  }
}
