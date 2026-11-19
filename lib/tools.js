// 暴露给 AI 的两个工具：tts_speak（合成 / 合成并发 QQ 语音）、tts_voices（音色与状态）。
//
// 工具名刻意不带 qq_ 前缀：这套能力不只服务 QQ（target 为空时就是「合成一段音频」），
// 但发语音本身还是走 OneBot，所以 target 字段说明里写清楚格式。
import {
  DEFAULT_MODEL,
  OFFICIAL_MODELS,
  PRESET_VOICES,
  SINGING_STYLE,
  SINGING_TAG,
  STYLE_PRESETS,
  cloneAudioInfo,
  synthesize,
} from './tts-lib.js'
import { makeTts, speak } from './speak.js'
import { resolveOneBot } from './onebot.js'
import { resolveLyrics } from './lyrics.js'

/**
 * 把整首歌词裁到一次合成能吃的长度。
 *
 * 上游一次请求有 maxChars 上限，整首歌词（尤其带重复副歌的）经常超；
 * 按整行裁比硬切字更不容易把一句词唱到一半断掉。
 */
export function clipLyrics(text, maxChars) {
  const raw = String(text ?? '').trim()
  const limit = Math.max(40, Number(maxChars) || 0)
  if ([...raw].length <= limit) return { text: raw, clipped: false, totalLines: raw ? raw.split('\n').length : 0 };
  const lines = raw.split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const len = [...line].length + 1;
    if (used + len > limit) break;
    kept.push(line);
    used += len;
  }
  if (!kept.length) kept.push([...lines[0]].slice(0, limit).join(''));
  return { text: kept.join('\n'), clipped: true, totalLines: lines.length, keptLines: kept.length };
}

const STRING_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/** 唱歌一次最多唱多少字：整首歌词会超时，先唱一段最稳。 */
const SONG_MAX_CHARS = 600

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
      + '用户让你唱歌 / 翻唱时：直接传 song（歌名，可带歌手，如「晴天 周杰伦」），插件会自己联网搜歌词并唱，'
      + '不需要也不应该向用户索要歌词。也可以直接传 text 当歌词（sing=true）。'
      + '唱歌很慢（短句几十秒，整首歌词 3~6 分钟）且上游是概率性的，只在明确要求唱时使用。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要念出来的文字（不要带 Markdown、代码块或表情符号）。唱歌时就是歌词。' },
        song: { type: 'string', description: '唱歌用：歌名（可带歌手）。给了 song 会自动联网搜歌词并唱，此时不用再传 text。' },
        target: { type: 'string', description: '发送目标：group:群号 或 private:QQ号。省略=只合成不发送。' },
        style: { type: 'string', description: '风格词，如 开心 / 悲伤 / 东北话 / 悄悄话；留空用插件默认风格。' },
        voice: { type: 'string', description: '临时覆盖音色（预设模式下就是音色 id，如 冰糖 / 苏打）。留空用默认。' },
        sing: { type: 'boolean', description: 'true=唱歌。很慢且是概率性的，失败可重试一次。传了 song 默认就是唱歌。' },
        label: { type: 'string', description: '可选：写给 QQ 侧会话记录的说明（如「用语音说了句晚安」）。' },
        verify: { type: 'boolean', description: '发送后是否回读确认（默认 true）。' },
        volume: { type: 'number', description: '可选：本地音量倍数（0.1~4，1=原样）。' },
        normalize: { type: 'boolean', description: '可选：是否做响度归一（loudnorm）。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: STRING_OUTPUT,
    // 唱整首歌词要 3~6 分钟，工具超时跟唱歌超时对齐，别让它在唱到一半时被掐断。
    timeoutMs: 600000,
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

      const song = String(args?.song ?? '').trim()
      let text = String(args?.text ?? '').trim()
      let songInfo = null
      let searchNote = ''
      if (!text && !song) return json({ ok: false, error: 'text 或 song 至少要给一个' })
      // 只给歌名时，服务端替 AI 把歌词搜回来 —— 这就是「让 AI 自己搜翻唱」的那一步。
      if (!text && song) {
        let resolved
        try {
          resolved = await resolveLyrics({ query: song, limit: 6 })
        } catch (error) {
          return errorResult(error)
        }
        const found = String(resolved?.song?.lyrics ?? '').trim()
        if (!found) {
          return json({
            ok: false,
            error: `搜到「${resolved?.song?.name || song}」但没取到能唱的歌词（可能是纯音乐 / 没版权），换个歌名再试`,
            song: { name: resolved?.song?.name ?? '', artist: resolved?.song?.artist ?? '' },
          })
        }
        text = found
        songInfo = {
          name: resolved?.song?.name ?? '',
          artist: resolved?.song?.artist ?? '',
          lines: found.split('\n').length,
        }
        // 网易云同名结果很多（原唱 / 翻唱 / Live）。这里只取第一条，但把情况告诉模型，
        // 它下次可以连歌手一起传，用户不必自己纠错。
        const others = Array.isArray(resolved?.candidates) ? resolved.candidates.length : 0
        if (others > 1) {
          searchNote = `搜到 ${others} 条同名结果，这次用了第一条「${songInfo.name}${songInfo.artist ? ` - ${songInfo.artist}` : ''}」；不对的话把歌手名一起传给 song`
        }
      }
      const wantsSing = song ? args?.sing !== false : args?.sing === true
      const warnings = []
      if (searchNote) warnings.push(searchNote)
      if (wantsSing) {
        // 整首歌词经常几千字，一次合成必超时；唱歌先唱到一个能稳定返回的长度，
        // 想继续就把后面的段落再发一次（AI 自己知道歌词，不需要用户手动剪）。
        const cap = Math.min(tts.maxChars, SONG_MAX_CHARS)
        const clipped = clipLyrics(text, cap)
        if (clipped.clipped) {
          text = clipped.text
          warnings.push(`歌词较长（${clipped.totalLines} 行），这次只唱了前 ${clipped.keptLines} 行；想接着唱后面的段落，再调用一次并把那段歌词作为 text 传入`)
        }
      }

      try {
        if (!String(args?.target ?? '').trim()) {
          const syn = await synthesize(tts, {
            text,
            style: args?.style ?? null,
            voiceOverride: args?.voice ?? null,
            sing: wantsSing,
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
            ...(songInfo ? { song: songInfo } : {}),
            warnings: [...(syn.warnings ?? []), ...warnings],
          })
        }
        const result = await speak({
          settings,
          home: deps.home,
          text,
          target: args.target,
          style: args?.style ?? null,
          voice: args?.voice ?? null,
          sing: wantsSing,
          label: args?.label ?? (songInfo?.name ? `唱了《${songInfo.name}》` : ''),
          verify: args?.verify !== false,
          volume: args?.volume === undefined || args?.volume === null ? null : Number(args.volume),
          normalize: args?.normalize === true,
        })
        return json({
          ...result,
          ...(songInfo ? { song: songInfo } : {}),
          ...(warnings.length ? { warnings: [...(result.warnings ?? []), ...warnings] } : {}),
        })
      } catch (error) {
        // 失败也把「搜到了哪首歌、唱了哪几句」带回去，AI 才能判断该换歌名还是重试。
        return json({
          ok: false,
          error: String(error?.message ?? error),
          ...(error?.stage ? { stage: error.stage } : {}),
          ...(error?.summary ? { summary: error.summary } : {}),
          ...(songInfo ? { song: songInfo } : {}),
          ...(warnings.length ? { warnings } : {}),
        })
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
          singing: {
            style: SINGING_STYLE,
            tag: SINGING_TAG,
            slowHint: '唱歌比念白慢 20~50 倍，且上游是概率性的',
            songHint: '让 AI 唱歌时直接传 song（歌名，可带歌手），插件会自己联网搜歌词；不要向用户索要歌词。',
            // 能力差异：只有预置音色模型会唱，另两个模型唱出来基本是念白。
            models: OFFICIAL_MODELS.map((m) => ({
              id: m.id,
              mode: m.mode,
              sing: m.mode === 'preset',
              note: m.mode === 'preset' ? '唯一支持唱歌的模型' : '不支持唱歌，唱出来基本是念白',
            })),
            defaultModel: DEFAULT_MODEL,
            modelHint: '唱歌只有 mimo-v2.5-tts（预置音色）真的会唱；克隆 / 音色设计模型唱出来基本是念白。插件在唱歌时会自动改用 mimo-v2.5-tts。',
            voices: PRESET_VOICES.map((v) => ({ id: v.id, name: v.name })),
          },
          onebot: { httpUrl: conn.httpUrl, tokenSet: Boolean(conn.accessToken), nonAscii: conn.nonAscii ?? [] },
          hint: '预设模式用 voices 里的 id（中文音色 id 就是中文名）；克隆模式忽略 voice 参数。唱歌用 song 而不是自己写歌词。',
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
