// 暴露给 AI 的两个工具：tts_speak（合成 / 合成并发 QQ 语音）、tts_voices（音色与状态）。
//
// 工具名刻意不带 qq_ 前缀：这套能力不只服务 QQ（target 为空时就是「合成一段音频」），
// 但发语音本身还是走 OneBot，所以 target 字段说明里写清楚格式。
import {
  SINGING_STYLE,
  SINGING_TAG,
  STYLE_PRESETS,
  cloneAudioInfo,
  synthesize,
} from './tts-lib.js'
import { makeTts, speak } from './speak.js'
import { resolveOneBot } from './onebot.js'

const STRING_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

function json(value) {
  return JSON.stringify(value, null, 2)
}

function errorResult(error) {
  return json({
    ok: false,
    error: String(error?.message ?? error),
    ...(error?.stage ? { stage: error.stage } : {}),
    ...(error?.summary ? { summary: error.summary } : {}),
  })
}

export function registerTools(ctx, deps) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'tts_speak',
    description:
      '把一段文字合成语音（小米 MiMo TTS / Breeze），可同时作为 QQ 语音发到指定群或好友。'
      + 'target 省略时只合成、不发送，返回 audioId 与同源试听地址 /dsh-tts/audio?id=…；'
      + 'target 写成 group:群号 或 private:QQ号 时，合成后直接通过本机 OneBot 网关发出并回读确认。'
      + '唱歌（sing=true）很慢（10~90 秒）且上游是概率性的，只在明确要求唱时使用。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要念出来的文字（不要带 Markdown、代码块或表情符号）。' },
        target: { type: 'string', description: '发送目标：group:群号 或 private:QQ号。省略=只合成不发送。' },
        style: { type: 'string', description: '风格词，如 开心 / 悲伤 / 东北话 / 悄悄话；留空用插件默认风格。' },
        voice: { type: 'string', description: '临时覆盖音色（预设模式下就是音色 id，如 冰糖 / 苏打）。留空用默认。' },
        sing: { type: 'boolean', description: 'true=唱歌。很慢且是概率性的，失败可重试一次。' },
        label: { type: 'string', description: '可选：写给 QQ 侧会话记录的说明（如「用语音说了句晚安」）。' },
        verify: { type: 'boolean', description: '发送后是否回读确认（默认 true）。' },
        volume: { type: 'number', description: '可选：本地音量倍数（0.1~4，1=原样）。' },
        normalize: { type: 'boolean', description: '可选：是否做响度归一（loudnorm）。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: STRING_OUTPUT,
    timeoutMs: 300000,
    async execute(args) {
      let settings
      try {
        settings = deps.getSettings().settings
      } catch (error) {
        return errorResult(error)
      }
      const tts = makeTts(settings, deps.home)
      if (!tts.enabled) return json({ ok: false, error: 'TTS 已被关闭（tts.enabled=false）：请让用户在 TTS 面板里打开' })
      if (!tts.aiEnabled) return json({ ok: false, error: 'AI 调用 TTS 已被关闭（tts.aiEnabled=false）：请让用户在 TTS 面板里打开' })
      const text = String(args?.text ?? '')
      if (!text.trim()) return json({ ok: false, error: 'text 不能为空' })

      try {
        if (!String(args?.target ?? '').trim()) {
          const syn = await synthesize(tts, {
            text,
            style: args?.style ?? null,
            voiceOverride: args?.voice ?? null,
            sing: args?.sing === true,
          })
          if (syn.sing && syn.actuallySang !== true) {
            return json({
              ok: false,
              stage: 'sing',
              error: `上游试了 ${syn.attempts ?? 1} 次都只是念白，这段可能没真的唱出来；可以再调用一次试试`,
              attempts: syn.attempts,
              durationSec: syn.durationSec,
              audioId: syn.audioId,
            })
          }
          return json({
            ok: true,
            route: syn.route,
            sing: syn.sing,
            actuallySang: syn.actuallySang,
            durationSec: syn.durationSec,
            attempts: syn.attempts,
            bytes: syn.bytes,
            mimeType: syn.mimeType,
            audioId: syn.audioId,
            audioUrl: `/dsh-tts/audio?id=${syn.audioId}`,
            warnings: syn.warnings,
          })
        }
        const result = await speak({
          settings,
          home: deps.home,
          text,
          target: args.target,
          style: args?.style ?? null,
          voice: args?.voice ?? null,
          sing: args?.sing === true,
          label: args?.label ?? '',
          verify: args?.verify !== false,
          volume: args?.volume === undefined || args?.volume === null ? null : Number(args.volume),
          normalize: args?.normalize === true,
        })
        return json(result)
      } catch (error) {
        return errorResult(error)
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'tts_voices',
    description:
      '查询 TTS 状态与可选音色：是否启用、当前模型/模式、预设音色列表、风格词表、克隆音色是否就绪、'
      + '以及发 QQ 语音的 OneBot 通道地址。在决定 tts_speak 用哪个 voice 之前可以先查一次。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: STRING_OUTPUT,
    async execute() {
      try {
        const settings = deps.getSettings().settings
        const tts = makeTts(settings, deps.home)
        const conn = resolveOneBot(settings, deps.home)
        // cloneReady 必须看参考音频是否真的还在：只信 mode==='clone' 会骗人。
        const cloneInfo = (() => { try { return cloneAudioInfo(tts) } catch { return null } })()
        return json({
          ok: true,
          enabled: tts.enabled,
          aiEnabled: tts.aiEnabled,
          apiKeySet: Boolean(tts.apiKey),
          model: tts.mimo.model,
          mode: tts.mode,
          format: tts.format,
          maxChars: tts.maxChars,
          voices: tts.presetVoices,
          stylePresets: STYLE_PRESETS,
          cloneReady: Boolean(cloneInfo),
          singing: { style: SINGING_STYLE, tag: SINGING_TAG, slowHint: '唱歌比念白慢 20~50 倍，且上游是概率性的' },
          onebot: { httpUrl: conn.httpUrl, tokenSet: Boolean(conn.accessToken), nonAscii: conn.nonAscii ?? [] },
          hint: '预设模式用 voices 里的 id（中文音色 id 就是中文名）；克隆模式忽略 voice 参数。',
        })
      } catch (error) {
        return errorResult(error)
      }
    },
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
