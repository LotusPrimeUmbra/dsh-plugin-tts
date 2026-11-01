// TTS（文字转语音）能力库：配置归一化、请求模板渲染、原始字节请求、音频缓存、克隆样本管理。
//
// 设计要点（严格对齐控制台的约定）：
//  1. 请求头模板 / 请求体模板都以**用户原文**落盘保存（config.json 的 tts 段），
//     读出后**只做占位符替换**；
//  2. 替换后的请求体**原样按字节发送**：不 JSON.parse 再序列化、不 pretty-print、不加前后缀；
//  3. 请求头解析成键值后**原样发送**：不自动补 Content-Type、不自动补 Authorization。
//
// 为做到 2/3，这里刻意用 node:http / node:https 的原生 request，并且把 headers 传成
// `[name, value, name, value]` 数组形式 —— 这种形式下 Node 不做任何合并、规范化或补全。
// 用 fetch 做不到：undici 的 Headers 会小写化并合并同名头，还会自动塞 Content-Type，
// 与「原样字节」的要求直接冲突。
//
// 唯一被自动补上的头是 Host：HTTP/1.1 强制要求，缺了服务端直接 400，属于传输层而非业务头。
//
// 契约来源（小米 MiMo 官方文档 mimo.mi.com，2026-07）：
//  - POST {base}/v1/chat/completions 是**唯一** TTS 通道（/v1/audio/speech 等全部 404）；
//  - 要念的文本放 role:"assistant" 的 content，role:"user" 是风格指令；
//  - 输出参数在**小米自定义的 audio 对象**里：{format, voice, optimize_text_preview}；
//  - 音频回包是 base64：非流式 choices[0].message.audio.data，流式 choices[0].delta.audio.data；
//  - choices[0].message.content 是空串，**永远不要**去那里找音频。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

/** 官方默认接口地址（MiMo 的 TTS 走 OpenAI 兼容的 chat/completions）。 */
export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1/chat/completions';

/** Breeze / ElevenLabs 风格的默认接口地址（只到 /v1，合成时再拼 /text-to-speech/{voice_id}）。 */
export const DEFAULT_BREEZE_BASE_URL = 'https://api.breeze.blue/v1';
/** 官方当前在架的音色合成模型（旧 mimo-v2-tts 已不在 /v1/models 列表里）。 */
export const DEFAULT_MODEL = 'mimo-v2.5-tts';

/** 三个官方 TTS 模型 → 控制台面板形态。 */
export const OFFICIAL_MODELS = [
  { id: 'mimo-v2.5-tts', mode: 'preset', label: '预置音色 TTS', note: '9 个官方音色，支持唱歌模式' },
  { id: 'mimo-v2.5-tts-voicedesign', mode: 'voicedesign', label: '音色设计 TTS', note: '用一段文字描述你想要的音色' },
  { id: 'mimo-v2.5-tts-voiceclone', mode: 'clone', label: '语音克隆 TTS', note: '上传 mp3 / wav 参考音频复刻音色' }
];

/**
 * 官方预设音色表（来源：mimo.mi.com「预置音色列表」+ API 参考的 voice 枚举，两处交叉验证）。
 *
 * ⚠️ 中文音色的 **voice id 就是中文名本身**（不是拼音、不是 voice_01）。
 * ⚠️ `mimo_default` 的实际音色随集群变化（中国集群 = 冰糖，其它集群 = Mia），
 *    所以显示名写「MiMo 默认（中国集群为冰糖）」，别只写「默认」让人误以为是男声。
 */
export const PRESET_VOICES = [
  { id: 'mimo_default', name: 'MiMo 默认音色', lang: '中英混合', note: '随集群而定：中国集群为冰糖（女），其它集群为 Mia（女）' },
  { id: '冰糖', name: '冰糖', lang: '中文', note: '中文女声，清亮' },
  { id: '茉莉', name: '茉莉', lang: '中文', note: '中文女声，柔和' },
  { id: '苏打', name: '苏打', lang: '中文', note: '中文男声' },
  { id: '白桦', name: '白桦', lang: '中文', note: '中文男声，低沉' },
  { id: 'Mia', name: 'Mia（英文女声）', lang: '英文', note: '英文女声' },
  { id: 'Chloe', name: 'Chloe（英文女声）', lang: '英文', note: '英文女声' },
  { id: 'Milo', name: 'Milo（英文男声）', lang: '英文', note: '英文男声' },
  { id: 'Dean', name: 'Dean（英文男声）', lang: '英文', note: '英文男声' }
];

/** 官方文档列出的风格标签（非穷举，界面上允许自由填写）。 */
export const STYLE_PRESETS = [
  { group: '情绪', items: ['开心', '悲伤', '生气', '紧张', '疲惫'] },
  { group: '语速', items: ['语速加快', '语速放慢'] },
  { group: '方言', items: ['东北话', '粤语', '四川话', '河南话'] },
  { group: '风格', items: ['悄悄话', '夹子音', '台湾腔'] },
  { group: '场景', items: ['唱歌'] }
];

/** 唱歌标签：官方要求写在**文本最开头**，且不能与其它风格混用。 */
export const SINGING_TAG = '(唱歌)';

/** 唱歌风格词本身（官方唯一写法，大小写与语种都不要改成 sing）。 */
export const SINGING_STYLE = '唱歌';

/**
 * 唱一次比念一句慢一个数量级（实测克隆音色唱 15 字歌词要 85 秒，念白只要 1.7 秒）。
 * 所以唱歌时的超时下限单独抬高，避免用户照默认 180 秒刚好卡在边界上。
 */
export const SINGING_TIMEOUT_MS = 240000;

// 官方只认「唱歌」这个词，但模型/人可能写成「唱一首歌」「唱首歌」「(唱歌)」——都当唱歌处理，
// 统一归一成「唱歌」再发给上游，避免看起来在唱其实只是念白。
const SINGING_STYLE_RE = /唱歌|唱一首歌|唱首歌|唱一?曲/;

/** 这段风格词里是否要求唱歌（容忍「唱歌」「唱一首歌」「(唱歌)」等写法）。 */
export function isSingingStyle(style) {
  return SINGING_STYLE_RE.test(String(style ?? ''));
}

/**
 * 决定「风格词放哪里」——唱歌是特例，必须走 inline 且独占。
 *
 * 官方两条硬约束：
 *   ① 唱歌要求写在**文本最开头**（即 inline 的 `(唱歌)歌词`），放 user.content 里不会唱；
 *   ② 唱歌不能与其它风格混用（`(开心 唱歌)` 会被服务端忽略或报错）。
 * 因此只要这次要唱歌，就强制 inline + 纯「唱歌」，并把被丢掉的风格词作为 warning 返回，
 * 让调用方（控制台 / AI 工具）能明确提示，而不是静默改词。
 *
 * @param {object} cfg ttsCfg() 结果
 * @param {object} opts { style, sing }
 * @returns {{styleName: string, inline: boolean, sing: boolean, warnings: string[]}}
 */
export function resolveStylePlacement(cfg, { style = null, sing = false } = {}) {
  const rawStyle = String(style === null ? cfg.style : style ?? '').trim();
  const wantSing = sing === true || isSingingStyle(rawStyle);
  const warnings = [];
  if (wantSing) {
    const extras = rawStyle.split(/[\s,，、;；|/]+/).filter((x) => x && !SINGING_STYLE_RE.test(x));
    if (extras.length) warnings.push(`唱歌不能与其它风格混用，已忽略：${extras.join(' ')}`);
    // 唱歌走独立的 cfg.singStyle（与说话风格互不影响）；里面没写「唱歌」等同于不触发，按「唱歌」发。
    const singStyleName = String(cfg?.singStyle ?? '').trim() || SINGING_STYLE;
    let styleName = singStyleName;
    if (!SINGING_STYLE_RE.test(styleName)) {
      warnings.push(`唱歌风格里没有「${SINGING_STYLE}」，已按「${SINGING_STYLE}」发送，否则上游只会念白`);
      styleName = SINGING_STYLE;
    }
    if (cfg.styleMode !== 'inline') warnings.push('唱歌会自动改用 inline 放置（写进文本开头），否则不会真的唱');
    return { styleName, inline: true, sing: true, warnings };
  }
  return { styleName: rawStyle, inline: Boolean(cfg.styleMode === 'inline' && rawStyle), sing: false, warnings };
}

/** 四种工作模式：决定控制台显示哪个分面板，也决定音色取什么值。 */
export const TTS_MODES = ['preset', 'voicedesign', 'clone', 'custom'];

/**
 * 默认请求头模板。官方主推 `api-key`，也支持 `Authorization: Bearer`；
 * 这里默认写主推的 api-key，用户可以在界面上随便改成别的（模板原样保存）。
 */
export const DEFAULT_HEADER_TEMPLATE = [
  'api-key: {{API_KEY}}',
  'Content-Type: application/json'
].join('\n');

/**
 * 默认请求体模板（预置音色版）。
 *
 * 为什么用 {{XXX_JSON}}：模板本身是一段 JSON 文本，而待合成文本来自用户输入
 * （可能含引号、换行、反斜杠）。{{TEXT}} 是原样插入，{{TEXT_JSON}} 是把值做 JSON
 * 字符串转义后再插入（**不**加外层引号）。默认模板用 _JSON 版本，避免用户输入
 * 一个引号就 400。需要绝对原样的场合可以自己改成 {{TEXT}}。
 */
export const DEFAULT_BODY_TEMPLATE = [
  '{',
  '  "model": {{MODEL_JSON}},',
  '  "messages": [',
  '    { "role": "user", "content": {{STYLE_JSON}} },',
  '    { "role": "assistant", "content": {{SPEECH_JSON}} }',
  '  ],',
  '  "audio": { "format": {{FORMAT_JSON}}, "voice": {{VOICE_JSON}} }',
  '}'
].join('\n');

/** 音色设计模型：**不能**传 voice 字段，user.content 就是音色描述。 */
export const DEFAULT_BODY_TEMPLATE_VOICEDESIGN = [
  '{',
  '  "model": {{MODEL_JSON}},',
  '  "messages": [',
  '    { "role": "user", "content": {{DESIGN_JSON}} },',
  '    { "role": "assistant", "content": {{SPEECH_JSON}} }',
  '  ],',
  '  "audio": { "format": {{FORMAT_JSON}} }',
  '}'
].join('\n');

/**
 * 支持的合成协议。
 *
 * - `openai`：POST {baseUrl}（chat/completions），音频在 JSON 的 base64 字段里。
 * - `breeze`：ElevenLabs 风格 —— POST {base}/text-to-speech/{voice_id}?output_format=…，
 *   直接返回二进制音频字节。模型列表也长得不一样（顶层数组 + model_id）。
 */
export const API_STYLES = ['openai', 'breeze'];

/**
 * 调用优先级（tts.routeMode）：
 *  - `mimo`   ：固定走小米 MiMo（顶层配置，OpenAI 协议）；
 *  - `breeze` ：固定走 Breeze / ElevenLabs（tts.breeze 子对象，二进制音频）；
 *  - `auto`   ：两边都配置齐全时，按最近成功合成的平均耗时自动选更快的一边。
 * 唱歌只能走 mimo（Breeze 协议没有唱歌参数），auto 下也会强制选 mimo。
 */
export const ROUTE_MODES = ['mimo', 'breeze', 'smart'];
// 「智能分界」的默认阈值：字数 >= lengthThreshold 或 估算时长 >= durationThreshold 时走小米
// （长内容小米更稳），都不到就按合成延迟挑更快的一边。
export const DEFAULT_LENGTH_THRESHOLD = 100;
export const DEFAULT_DURATION_THRESHOLD = 20;
/** 估算语音时长用：中文 TTS 实测约 4 字/秒（克隆音色 71 字 ≈ 18 秒）。 */
export const ESTIMATE_CHARS_PER_SECOND = 4;
/** 老配置的 routeMode 值归一：auto / length 合并成 smart。 */
export function normalizeRouteMode(value) {
  const v = String(value ?? '').trim();
  if (ROUTE_MODES.includes(v)) return v;
  if (v === 'auto' || v === 'length') return 'smart';
  return '';
}

/** 延迟统计落盘位置（相对 rootDir）。只存 EMA 平均值与样本数，不存任何请求内容。 */
export const LATENCY_FILE = 'state/tts-latency.json';

/**
 * Breeze / ElevenLabs 风格的默认请求头模板。
 *
 * 这类服务认 `xi-api-key`（也兼容 `Authorization: Bearer`），不需要 chat/completions
 * 那套 messages 结构：文本字段直接叫 text、模型叫 model_id、音色 id 写在 URL 上。
 */
export const DEFAULT_HEADER_TEMPLATE_BREEZE = [
  'xi-api-key: {{API_KEY}}',
  'Content-Type: application/json'
].join('\n');

/** Breeze 风格的默认请求体模板（voice_settings 由控制台四个参数拼成 {{VOICE_SETTINGS_JSON}}）。 */
export const DEFAULT_BODY_TEMPLATE_BREEZE = [
  '{',
  '  "text": {{SPEECH_JSON}},',
  '  "model_id": {{MODEL_JSON}},',
  '  "voice_settings": {{VOICE_SETTINGS_JSON}}',
  '}'
].join('\n');

/** Breeze 的 voice_settings 默认值（官方区间：guidance_scale 1–10、speed 0.5–2、volume 0.01–2）。 */
export const DEFAULT_VOICE_SETTINGS = { guidanceScale: 4, speed: 1, volume: 1, useSpeakerBoost: true };

/** 缓存目录（合成结果，供控制台同源试听）。 */
export const CACHE_DIR_NAME = 'state/tts-cache';
/** 克隆参考音频目录。 */
export const CLONE_DIR_NAME = 'state/tts-clone';
/**
 * 唱歌参考音频目录。
 *
 * 和说话音色参考**彻底分开**：唱歌常用一段歌曲片段（带旋律/伴奏），拿它当说话音色会毁掉嗓音；
 * 说话音色参考也绝不能被唱歌素材覆盖。两边各有各的目录、各自的 backup/、各自的 409 确认闸门。
 */
export const SING_REF_DIR_NAME = 'state/tts-sing-ref';
/** 两组参考音频的类别名：clone = 说话音色，sing = 唱歌。 */
export const REF_KINDS = ['clone', 'sing'];

const AUDIO_MIME_BY_EXT = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pcm': 'audio/L16'
};

/** 克隆参考音频只接受 mp3 / wav（官方硬限制）。 */
export const CLONE_ALLOWED_EXT = ['.wav', '.mp3'];
/** 官方限制：参考音频 Base64 编码后的**字符串长度**不超过 10 MB。 */
export const CLONE_MAX_BASE64_BYTES = 10 * 1024 * 1024;
/** 参考音频规范化目标：24kHz / 16bit / 单声道 PCM（与官方输出同规格）。 */
export const REF_TARGET_RATE = 24000;
/** 参考音频最多留这么久（长音频只会把每次请求撑到 10MB，还容易被上游判 400）。 */
export const REF_MAX_SECONDS = 30;
/** 参考音频规范化阈值：原始文件超过这个体积就转码压一压。 */
export const REF_MAX_BYTES = 2.5 * 1024 * 1024;
/**
 * 有效语音低于这个秒数，克隆音色的复现就会明显不稳。
 * 实测（同一句话连合成 6 次，小米 mimo-v2.5-tts-voiceclone）：
 * 2.91 秒参考音频 → 时长变异 40.8%；同一段拼到 8 秒 → 12.9%。
 * 官方建议 10~30 秒，这里取 5 秒作为「明显不够」的下限。
 */
export const REF_MIN_SPEECH_SECONDS = 5;

export function mimeFromExt(ext) {
  return AUDIO_MIME_BY_EXT[String(ext ?? '').toLowerCase()] || 'application/octet-stream';
}

/** 请求的 audio.format → 回包 MIME。官方支持 wav / mp3 / pcm / pcm16。 */
export function mimeFromFormat(format) {
  const f = String(format ?? '').trim().toLowerCase();
  if (f === 'mp3') return 'audio/mpeg';
  if (f === 'pcm' || f === 'pcm16') return 'audio/L16';
  return 'audio/wav';
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 从 PCM WAV 头里量出「总时长 / 有效语音时长」。
 *
 * 为什么要服务端自己量一遍：时长本来是浏览器解码时顺便算的（服务端常常没装 ffmpeg），
 * 但那样只有「新上传」的文件才有数，已经存在的参考音频永远量不出来，警告也就永远不触发。
 * WAV 头里的 fmt/data 块足够算出总时长；有效语音再按 RMS 过一遍 PCM 就行，不需要任何外部工具。
 *
 * 只处理 16bit PCM（插件自己生成的参考音频就是这种，也是唯一保证能解析的形态）。
 * 解析不了就返回 null，调用方按「时长未知」处理，绝不猜。
 */
export function measureWavSpeech(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
    let pos = 12;
    let fmt = null;
    let data = null;
    while (pos + 8 <= buffer.length) {
      const id = buffer.toString('ascii', pos, pos + 4);
      const size = buffer.readUInt32LE(pos + 4);
      const body = pos + 8;
      if (id === 'fmt ') {
        fmt = {
          format: buffer.readUInt16LE(body),
          channels: buffer.readUInt16LE(body + 2),
          rate: buffer.readUInt32LE(body + 4),
          bits: buffer.readUInt16LE(body + 14)
        };
      } else if (id === 'data') {
        data = buffer.subarray(body, Math.min(buffer.length, body + size));
      }
      pos = body + size + (size % 2);
    }
    if (!fmt || !data) return null;
    if (fmt.format !== 1 || fmt.bits !== 16) return null;
    if (!(fmt.rate > 0) || !(fmt.channels > 0)) return null;
    const frames = Math.floor(data.length / 2 / fmt.channels);
    if (frames <= 0) return null;
    const seconds = frames / fmt.rate;
    // 与浏览器端 measureSpeechSeconds 同口径：20ms 一帧，RMS >= 0.008 算有声。
    const frameFrames = Math.max(1, Math.round(fmt.rate * 0.02));
    const stride = 2 * fmt.channels;
    let voiced = 0;
    let total = 0;
    for (let f = 0; f + frameFrames <= frames; f += frameFrames) {
      let sum = 0;
      for (let i = 0; i < frameFrames; i += 1) {
        let acc = 0;
        for (let c = 0; c < fmt.channels; c += 1) {
          acc += data.readInt16LE((f + i) * stride + c * 2);
        }
        const sample = acc / fmt.channels / 32768;
        sum += sample * sample;
      }
      total += 1;
      if (Math.sqrt(sum / frameFrames) >= 0.008) voiced += 1;
    }
    if (!total) return { seconds, speechSeconds: 0 };
    return { seconds, speechSeconds: (voiced / total) * seconds };
  } catch {
    return null;
  }
}

/**
 * 依据模型名猜出「这个模型属于哪种 TTS 形态」。
 * 只用于控制台决定显示哪块面板（预设音色 / 音色设计 / 语音克隆 / 自定义），不参与请求构造。
 *
 * 判定顺序很重要：先排掉克隆与音色设计，再认「MiMo 的 tts 家族」，
 * **其余一律算自定义**。早先写成 `/tts/` 就把 `my-custom-tts`、`tts-1` 这类
 * 第三方模型也认成预设音色了，于是控制台给出一张 MiMo 特有的中文音色表，
 * 用户照着挑完发出去只会 400。
 */
export function guessModeForModel(model) {
  const m = String(model ?? '').toLowerCase();
  if (/voiceclone|voice-clone|clone/.test(m)) return 'clone';
  if (/voicedesign|voice-design|design/.test(m)) return 'voicedesign';
  if (/mimo/.test(m) && /tts/.test(m)) return 'preset';
  return 'custom';
}

/**
 * 把 mode 与 model 收敛成一对自洽的值。
 *
 * 为什么不各自独立：两个字段描述的是同一件事（这个模型属于哪种 TTS 形态），
 * 一旦分叉就会出现互相打架的请求 ——
 *   · mode=clone + 预置模型  → 把参考音频 DataURL 当音色名发出去，上游 400
 *     `Unknown voice: data:audio/wav;base64,…`（报错里还会列一串预置音色名，
 *     看起来就像「非要你先选个预置音色」，实际是模型和模式对不上）；
 *   · mode=preset + 克隆模型 → 把音色名发给克隆模型，上游同样 400。
 *
 * 规则：**克隆优先**。只要 mode 或 model 有一个说克隆，就按克隆收敛。
 * 理由很实际 —— 克隆是用户上传过参考音频才有的形态，是明确的、需要成本的选择；
 * 而「回到预置语音」恰恰就是分叉时把克隆那半边丢掉造成的。宁可多保住克隆，
 * 也不能让用户上传完音色、点个试听就变回预置嗓音。要退回预置也很简单：控制台上
 * 选预置音色卡或换模型时，前端会把 mode 和 model 成对写成 preset，两边一致就不再触发。
 *
 * 只对**官方模型**做替换：手填的自定义模型名一律原样保留，绝不因为 mode 被悄悄改掉。
 *
 * @returns {{ mode: string, model: string, changed: boolean }}
 */
export function reconcileModeModel(mode, model) {
  const wanted = TTS_MODES.includes(mode) ? mode : '';
  const byModel = guessModeForModel(model);
  const official = OFFICIAL_MODELS.find((m) => m.id === model);
  const officialOf = (target) => OFFICIAL_MODELS.find((m) => m.mode === target)?.id ?? '';
  // 1) 克隆优先：任一字段说克隆就按克隆走。
  if (wanted === 'clone' || byModel === 'clone') {
    // 模型自己就是克隆模型（含用户手填的克隆模型名）→ 保持不动，只把 mode 对齐。
    if (byModel === 'clone') return { mode: 'clone', model, changed: wanted !== 'clone' };
    // 模型是预置/设计模型但用户选了克隆 → 换成克隆模型，否则参考音频发不出去。
    if (official) return { mode: 'clone', model: officialOf('clone'), changed: true };
    // 手填的非官方模型：不敢动它，只把 mode 记成 clone。
    return { mode: 'clone', model, changed: wanted !== 'clone' };
  }
  // 2) 自定义模型：尊重用户，只补一个缺失的 mode。
  if (byModel === 'custom') return { mode: wanted || byModel, model, changed: false };
  // 3) 已经自洽。
  if (!wanted || wanted === byModel) return { mode: byModel, model, changed: false };
  // 4) 其余分叉（如 voicedesign ↔ 预置）：按 mode 换到该形态的官方模型。
  if (official) {
    const target = officialOf(wanted);
    if (target) return { mode: wanted, model: target, changed: true };
  }
  return { mode: byModel, model, changed: true };
}

/** 官方三模型的默认变体模板：切换模型就有不一样的选择项，落在数据层即各自一套模板。 */
export function defaultVariants() {
  return {
    'mimo-v2.5-tts': { headerTemplate: DEFAULT_HEADER_TEMPLATE, bodyTemplate: DEFAULT_BODY_TEMPLATE },
    'mimo-v2.5-tts-voicedesign': { headerTemplate: DEFAULT_HEADER_TEMPLATE, bodyTemplate: DEFAULT_BODY_TEMPLATE_VOICEDESIGN },
    'mimo-v2.5-tts-voiceclone': { headerTemplate: DEFAULT_HEADER_TEMPLATE, bodyTemplate: DEFAULT_BODY_TEMPLATE }
  };
}

/**
 * 配置归一化。**不写盘**，只把 config.json 里可能缺失/类型不对的字段收敛成可用值。
 * 与 bridge.js 里 socialV2.voice 的处理风格一致：永远能返回一个结构完整的对象。
 */
export function ttsCfg(raw, { rootDir = process.cwd() } = {}) {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawModel = String(t.model ?? '').trim() || DEFAULT_MODEL;
  // mode 与 model 必须是一对自洽的值（见 reconcileModeModel）。历史配置里两者经常分叉：
  // 上传参考音频只写 mode='clone' 不改 model，「合成模式」下拉也只改 mode，于是出现
  // 「选了克隆模式、模型还是预置音色 TTS」—— 请求要么把参考音频 DataURL 当音色名发出去
  // （上游 400 `Unknown voice: data:audio/wav;base64,…`），要么干脆念成预置音色。
  // 这里以 mode 为准把 model 拉回正轨，下游拿到的 cfg 永远是一对自洽的值。
  const reconciled = reconcileModeModel(
    TTS_MODES.includes(t.mode) ? t.mode : guessModeForModel(rawModel),
    rawModel
  );
  const model = reconciled.model;
  const variants = mergeVariants(t.variants);
  const modelVariant = variants[model] && typeof variants[model] === 'object' ? variants[model] : {};
  // 模板优先级：该模型自己的变体 > 顶层模板 > 内置默认。这样「切换模型有不一样的选择项」
  // 落在数据层就是每个模型各自一套请求头/请求体。
  const apiStyle = API_STYLES.includes(t.apiStyle) ? t.apiStyle : 'openai';
  const mode = reconciled.mode;
  // 两套协议各存一份配置，互不覆盖：openai（小米 MiMo，自有音色/克隆）用顶层字段，
  // breeze（线上拉音色，ElevenLabs 风格）用 t.breeze 子对象。谁生效由 apiStyle 决定。
  const breezeRaw = t.breeze && typeof t.breeze === 'object' && !Array.isArray(t.breeze) ? t.breeze : {};
  const isBreeze = apiStyle === 'breeze';
  // 老配置里 Breeze 的字段曾写在顶层（还没有 t.breeze 子对象），这里做一次兼容回填：
  // 缺 breeze.X 时取顶层的同名值。模板不回填 —— 顶层那套多半是小米的模板，套到 Breeze 上只会 401。
  const breezeLegacy = isBreeze ? t : {};
  const breezeCfg = {
    baseUrl: String(breezeRaw.baseUrl ?? breezeLegacy.baseUrl ?? '').trim() || DEFAULT_BREEZE_BASE_URL,
    apiKey: String(breezeRaw.apiKey ?? breezeLegacy.apiKey ?? ''),
    model: String(breezeRaw.model ?? breezeLegacy.model ?? '').trim(),
    models: Array.isArray(breezeRaw.models) ? breezeRaw.models.map(String) : [],
    // 拉到的音色列表存进配置，下次开页面不用重新拉；只保留 id/name。
    voices: Array.isArray(breezeRaw.voices)
      ? breezeRaw.voices
        .map((v) => ({ id: String(v?.id ?? v ?? '').trim(), name: String(v?.name ?? '') }))
        .filter((v) => v.id)
      : [],
    voice: String(breezeRaw.voice ?? breezeLegacy.voice ?? '').trim(),
    // Breeze 的输出格式走 URL 的 output_format：mp3 是官方默认，wav 也行。
    format: (breezeRaw.format ?? breezeLegacy.format) === 'wav' ? 'wav' : 'mp3',
    voiceSettings: normalizeVoiceSettings(breezeRaw.voiceSettings ?? breezeLegacy.voiceSettings),
    headerTemplate: pickTemplate('', breezeRaw.headerTemplate, DEFAULT_HEADER_TEMPLATE_BREEZE),
    bodyTemplate: pickTemplate('', breezeRaw.bodyTemplate, DEFAULT_BODY_TEMPLATE_BREEZE)
  };
  // 小米那份自己的模板：顶层 + 该模型变体 + 小米默认。必须单独算一份 —— 按 apiStyle 投影后的
  // headerTemplate/bodyTemplate 在「正在编辑 Breeze」时是 Breeze 的，拿它发给小米必然 400。
  // 老配置里 Breeze 的模板曾写在顶层（那时还没有 t.breeze 子对象），甚至被写进了某个模型的变体里。
  // 切回「只用小米」时会拿 Breeze 的请求体（model_id / voice_settings）去请求小米，上游只会回
  // Unsupported model。这里按特征识别并跳过，回落到小米默认模板。
  const looksBreezeTmpl = (header, body) => /\bmodel_id\b|\bvoice_settings\b/.test(String(body ?? ''))
    || /^\s*xi-api-key\s*:/im.test(String(header ?? ''));
  const topLooksBreeze = looksBreezeTmpl(t.headerTemplate, t.bodyTemplate);
  const variantLooksBreeze = looksBreezeTmpl(modelVariant.headerTemplate, modelVariant.bodyTemplate);
  const mimoHeader = pickTemplate(
    variantLooksBreeze ? '' : modelVariant.headerTemplate,
    topLooksBreeze ? '' : t.headerTemplate,
    DEFAULT_HEADER_TEMPLATE
  );
  const mimoBody = pickTemplate(
    variantLooksBreeze ? '' : modelVariant.bodyTemplate,
    topLooksBreeze ? '' : t.bodyTemplate,
    mode === 'voicedesign' ? DEFAULT_BODY_TEMPLATE_VOICEDESIGN : DEFAULT_BODY_TEMPLATE
  );
  // breeze（ElevenLabs 风格）的请求形状与 OpenAI 完全不同，默认模板按协议各给一套。
  const fallbackHeader = apiStyle === 'breeze' ? DEFAULT_HEADER_TEMPLATE_BREEZE : DEFAULT_HEADER_TEMPLATE;
  const fallbackBody = apiStyle === 'breeze'
    ? DEFAULT_BODY_TEMPLATE_BREEZE
    : mode === 'voicedesign' ? DEFAULT_BODY_TEMPLATE_VOICEDESIGN : DEFAULT_BODY_TEMPLATE;
  const headerTemplate = pickTemplate(modelVariant.headerTemplate, t.headerTemplate, fallbackHeader);
  const bodyTemplate = pickTemplate(modelVariant.bodyTemplate, t.bodyTemplate, fallbackBody);
  const voiceList = normalizeVoiceList(t.presetVoices);
  const clone = t.clone && typeof t.clone === 'object' && !Array.isArray(t.clone) ? t.clone : {};
  const singRef = t.singRef && typeof t.singRef === 'object' && !Array.isArray(t.singRef) ? t.singRef : {};
  return {
    enabled: t.enabled === true,
    // AI 通道（qq_tts_speak 工具）的独立闸门：即便 enabled 打开，也可以只让控制台用。
    aiEnabled: t.aiEnabled !== false,
    // breeze 生效时这些字段取自 t.breeze；小米 MiMo 那份原样保留、不会被覆盖。
    baseUrl: isBreeze ? breezeCfg.baseUrl : (String(t.baseUrl ?? '').trim() || DEFAULT_BASE_URL),
    apiKey: isBreeze ? breezeCfg.apiKey : String(t.apiKey ?? ''),
    breeze: breezeCfg,
    // 合成协议：openai = chat/completions + base64；breeze = ElevenLabs 风格 + 二进制音频。
    // 注意：apiStyle 只表示「控制台当前在编辑哪一套」，真正决定合成走谁的是 routeMode。
    apiStyle,
    // 调用优先级：mimo / breeze / smart（smart = 长内容走小米，其余按最近成功合成的平均耗时挑更快的一边）。
    // 空串 = 没显式选过优先级，沿用老行为（由 apiStyle 决定走谁），避免升级后悄悄改变现有配置的行为。
    // 老的 auto / length 读进来归一成 smart，写出去统一成 smart。
    routeMode: normalizeRouteMode(t.routeMode),
    // 「智能分界」：字数 >= lengthThreshold 或 估算时长 >= durationThreshold 时走小米，都不到才按延迟挑边。
    lengthThreshold: Math.min(2000, Math.max(10, positiveNumber(t.lengthThreshold, DEFAULT_LENGTH_THRESHOLD))),
    durationThreshold: Math.min(600, Math.max(1, positiveNumber(t.durationThreshold, DEFAULT_DURATION_THRESHOLD))),
    // 小米那套的原始视图（不受 apiStyle 切换影响）：路由到 mimo 时用它，也用于 describe 回显。
    mimo: {
      baseUrl: String(t.baseUrl ?? '').trim() || DEFAULT_BASE_URL,
      apiKey: String(t.apiKey ?? ''),
      model,
      models: normalizeModelList(t.models, model),
      mode,
      format: normalizeFormat(t.format),
      voice: String(t.voice ?? '').trim() || PRESET_VOICES[0].id,
      // 这里必须用小米自己那份模板（见上面的 mimoHeader/mimoBody），不能用投影后的值。
      headerTemplate: mimoHeader,
      bodyTemplate: mimoBody
    },
    model: isBreeze ? breezeCfg.model : model,
    models: isBreeze ? breezeCfg.models : normalizeModelList(t.models, model),
    mode: isBreeze ? 'custom' : mode,
    voice: isBreeze ? breezeCfg.voice : (String(t.voice ?? '').trim() || PRESET_VOICES[0].id),
    format: isBreeze ? breezeCfg.format : normalizeFormat(t.format),
    // Breeze / ElevenLabs 的 voice_settings（guidance_scale / speed / volume / use_speaker_boost）。
    voiceSettings: isBreeze ? breezeCfg.voiceSettings : normalizeVoiceSettings(t.voiceSettings),
    // 风格：默认放 user.content（官方推荐）；styleMode='inline' 时改为在文本前加 (风格) 标签。
    style: String(t.style ?? ''),
    styleMode: t.styleMode === 'inline' ? 'inline' : 'user',
    // 唱歌专用风格：与说话风格完全分开存，互不影响。默认「唱歌」——没有这个词上游只会念白。
    singStyle: String(t.singStyle ?? SINGING_STYLE).trim() || SINGING_STYLE,
    // 音色设计模型的音色描述（voicedesign 的 user.content）。
    design: String(t.design ?? ''),
    // 可选的表现力/语气指令（自定义模式下想单独喂给 user.content 时用）。
    prompt: String(t.prompt ?? ''),
    headerTemplate: isBreeze ? breezeCfg.headerTemplate : headerTemplate,
    bodyTemplate: isBreeze ? breezeCfg.bodyTemplate : bodyTemplate,
    variants,
    presetVoices: voiceList,
    clone: {
      fileName: String(clone.fileName ?? ''),
      mimeType: String(clone.mimeType ?? ''),
      bytes: positiveNumber(clone.bytes, 0),
      savedAt: positiveNumber(clone.savedAt, 0),
      seconds: positiveNumber(clone.seconds, 0),
      speechSeconds: positiveNumber(clone.speechSeconds, 0)
    },
    // 唱歌参考音频：独立一份，说话音色绝不拿它，它也不覆盖说话音色。
    singRef: {
      fileName: String(singRef.fileName ?? ''),
      mimeType: String(singRef.mimeType ?? ''),
      bytes: positiveNumber(singRef.bytes, 0),
      savedAt: positiveNumber(singRef.savedAt, 0),
      seconds: positiveNumber(singRef.seconds, 0),
      speechSeconds: positiveNumber(singRef.speechSeconds, 0)
    },
    timeoutMs: positiveNumber(t.timeoutMs, 180000),
    maxChars: positiveNumber(t.maxChars, 2000),
    // 唱歌是概率性的：同一份请求上游有时真唱、有时只念白（实测命中率约一半）。命中「疑似念白」时最多试几次。
    singAttempts: Math.min(6, positiveNumber(t.singAttempts, 5)),
    cacheDir: path.resolve(rootDir, String(t.cacheDir ?? CACHE_DIR_NAME)),
    cloneDir: path.resolve(rootDir, String(t.cloneDir ?? CLONE_DIR_NAME)),
    singRefDir: path.resolve(rootDir, String(t.singRefDir ?? SING_REF_DIR_NAME)),
    // 合成后是否顺手发一条 QQ 语音（qq_tts_speak 的默认行为开关）。
    autoSendVoice: t.autoSendVoice !== false,
    // 素材导入默认只能抓公网地址，防止这个接口被当成 SSRF 跳板。
    allowPrivateFetch: t.allowPrivateFetch === true,
    modelLabels: t.modelLabels && typeof t.modelLabels === 'object' && !Array.isArray(t.modelLabels) ? t.modelLabels : {},
    // 仓库根目录：延迟统计（state/tts-latency.json）之类的运行期数据都按它定位。
    rootDir: path.resolve(rootDir)
  };
}

function normalizeFormat(value) {
  const f = String(value ?? '').trim().toLowerCase();
  return ['wav', 'mp3', 'pcm', 'pcm16'].includes(f) ? f : 'wav';
}

// ── 调用优先级（mimo / breeze / auto）────────────────────────────────────────

/** 延迟统计（state/tts-latency.json）。坏文件当空处理 —— 统计坏了不能拖垮合成。 */
export function readRouteLatency(rootDir) {
  const empty = { mimo: null, breeze: null };
  try {
    const obj = JSON.parse(fs.readFileSync(path.resolve(rootDir, LATENCY_FILE), 'utf8'));
    const one = (v) => {
      if (!v || typeof v !== 'object') return null;
      const avgMs = positiveNumber(v.avgMs, 0);
      const samples = positiveNumber(v.samples, 0);
      if (!(avgMs > 0) || !(samples > 0)) return null;
      return { avgMs: Math.round(avgMs), samples: Math.round(samples), at: positiveNumber(v.at, 0) };
    };
    return { mimo: one(obj?.mimo), breeze: one(obj?.breeze) };
  } catch {
    return empty;
  }
}

/**
 * 记一次**成功**合成的耗时：EMA（旧值权重 0.7），样本数封顶 50 ——
 * 免得早期某次抖动永远压住后面的真实水平。
 */
export function recordRouteLatency(rootDir, style, elapsedMs) {
  const ms = positiveNumber(elapsedMs, 0);
  if (!(ms > 0)) return readRouteLatency(rootDir);
  const bucket = style === 'breeze' ? 'breeze' : 'mimo';
  const cur = readRouteLatency(rootDir);
  const old = cur[bucket];
  const avgMs = old ? old.avgMs * 0.7 + ms * 0.3 : ms;
  const next = {
    ...cur,
    [bucket]: { avgMs: Math.round(avgMs), samples: Math.min(50, (old?.samples ?? 0) + 1), at: Date.now() }
  };
  try {
    const file = path.resolve(rootDir, LATENCY_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // 写不进去不影响合成，下次照样重新估。
  }
  return next;
}

/**
 * 这套配置还缺哪几样。
 *
 * 为什么单独拆出来：isStyleConfigured 只回一个是/否，控制台拿它当「没填 Key」用，
 * 于是「Key 填好了、只是没选模型」也会被显示成「还没填 Key」——用户会以为 Key 没存上。
 * 判定口径必须唯一：这里算出的 missing 就是唯一事实，别处不要再各写一套。
 */
export function styleReadiness(cfg, style) {
  const view = (style === 'breeze' ? cfg.breeze : cfg.mimo) ?? {};
  const flags = {
    baseUrl: Boolean(String(view.baseUrl ?? '').trim()),
    apiKey: Boolean(String(view.apiKey ?? '').trim()),
    model: Boolean(String(view.model ?? '').trim())
  };
  const missing = Object.keys(flags).filter((key) => !flags[key]);
  return { ...flags, missing, ready: missing.length === 0 };
}

/** 这套配置配好了没：地址 + 密钥 + 模型齐了才算（缺一个就别指望能合成）。 */
export function isStyleConfigured(cfg, style) {
  const view = style === 'breeze' ? cfg.breeze : cfg.mimo;
  if (!view) return false;
  return Boolean(
    String(view.baseUrl ?? '').trim()
    && String(view.apiKey ?? '').trim()
    && String(view.model ?? '').trim()
  );
}

/**
 * 估算这段文本念出来大概几秒（按 4 字/秒，够用来做「长语音」分界判断，不需要精确）。
 */
export function estimateSpeechSeconds(text) {
  const chars = [...String(text ?? '').trim()].length;
  return chars / ESTIMATE_CHARS_PER_SECOND;
}

/**
 * 决定这一次合成走哪套协议。
 * @param {{ sing?: boolean, latency?: object|null, text?: string }} opts
 *   text 只有 routeMode='smart' 时才需要（按字数/估算时长分界）。
 * @returns {'openai'|'breeze'}
 */
export function resolveRouteStyle(cfg, { sing = false, latency = null, text = '' } = {}) {
  const mode = normalizeRouteMode(cfg.routeMode) || (cfg.apiStyle === 'breeze' ? 'breeze' : 'mimo');
  // 唱歌只有小米那套支持（Breeze 协议没有唱歌参数），smart 下也直接选它。
  if (sing) return 'openai';
  if (mode === 'mimo') return 'openai';
  if (mode === 'breeze') return 'breeze';
  const mimoOk = isStyleConfigured(cfg, 'mimo');
  const breezeOk = isStyleConfigured(cfg, 'breeze');
  // smart：长内容（字数 >= lengthThreshold 或 估算时长 >= durationThreshold）走小米，短内容按延迟挑边。
  if (mode === 'smart') {
    const chars = [...String(text ?? '').trim()].length;
    const estSec = chars / ESTIMATE_CHARS_PER_SECOND;
    const long = chars > 0 && (chars >= cfg.lengthThreshold || estSec >= cfg.durationThreshold);
    if (long) return mimoOk ? 'openai' : (breezeOk ? 'breeze' : 'openai');
  }
  if (!mimoOk && !breezeOk) return 'openai';
  if (!breezeOk) return 'openai';
  if (!mimoOk) return 'breeze';
  // 两边都能用：谁的最近平均耗时低走谁；都还没测过就先偏小米（默认那套，行为更可预期）。
  const lat = latency ?? readRouteLatency(cfg.rootDir);
  const a = lat?.mimo?.avgMs ?? 0;
  const b = lat?.breeze?.avgMs ?? 0;
  if (!a && !b) return 'openai';
  if (!a) return 'breeze';
  if (!b) return 'openai';
  return b < a ? 'breeze' : 'openai';
}

/** 按目标协议把配置「投影」成一套具体字段（返回新对象，不改原配置）。 */
export function viewForStyle(cfg, style) {
  if (style === 'breeze') {
    // Breeze 的音色自带风格（风格由 voice_id 决定），不吃小米那套风格词：这里一律清空 style，
    // 否则会把「(沉稳 稳定 优雅 …)」当成正文前缀念出来。两套因此完全独立。
    if (cfg.apiStyle === 'breeze') return { ...cfg, style: '' };
    const b = cfg.breeze ?? {};
    return {
      ...cfg,
      apiStyle: 'breeze',
      mode: 'custom',
      baseUrl: b.baseUrl,
      apiKey: b.apiKey,
      model: b.model,
      voice: b.voice,
      format: b.format ?? 'mp3',
      voiceSettings: b.voiceSettings,
      headerTemplate: b.headerTemplate,
      bodyTemplate: b.bodyTemplate,
      style: ''
    };
  }
  if (cfg.apiStyle === 'openai') return cfg;
  const m = cfg.mimo ?? {};
  return {
    ...cfg,
    apiStyle: 'openai',
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    model: m.model,
    mode: m.mode ?? cfg.mode,
    voice: m.voice,
    format: m.format ?? 'wav',
    headerTemplate: m.headerTemplate,
    bodyTemplate: m.bodyTemplate
  };
}

/**
 * 收敛用户存下来的「每模型变体」。
 *
 * **只保留用户真的写过的东西**（headerTemplate / bodyTemplate 字符串），绝不预填内置默认值。
 * 这一点很关键：如果这里把内置默认填进 modelVariant，那么 pickTemplate 的第一顺位
 * （该模型变体）就永远命中内置默认，用户写在**顶层**的模板会被静默忽略 —— 表现就是
 * 「我改了请求头，但发出去的还是 Content-Type: application/json」。内置默认只由
 * pickTemplate 的最后一顺位负责。
 */
function mergeVariants(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [model, v] of Object.entries(input)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const entry = {};
    if (typeof v.headerTemplate === 'string') entry.headerTemplate = v.headerTemplate;
    if (typeof v.bodyTemplate === 'string') entry.bodyTemplate = v.bodyTemplate;
    if (Object.keys(entry).length) out[model] = entry;
  }
  return out;
}

function pickTemplate(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return '';
}

function normalizeVoiceList(input) {
  const seen = new Set();
  const out = [];
  const push = (item) => {
    if (!item) return;
    const id = String(item.id ?? item.voice ?? '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      name: String(item.name ?? item.label ?? id).trim() || id,
      lang: String(item.lang ?? '').trim(),
      note: String(item.note ?? '').trim(),
      builtin: item.builtin === true
    });
  };
  for (const v of PRESET_VOICES) push({ ...v, builtin: true });
  if (Array.isArray(input)) for (const v of input) push(v);
  return out;
}

/**
 * Breeze 的 voice_settings。四个字段各带官方区间，越界就夹回区间内——
 * 用户填 0 或 100 时上游只会回一个语焉不详的 400，不如这里先兜住。
 */
export function normalizeVoiceSettings(input) {
  const v = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    guidanceScale: clamp(v.guidanceScale ?? v.guidance_scale, 1, 10, DEFAULT_VOICE_SETTINGS.guidanceScale),
    speed: clamp(v.speed, 0.5, 2, DEFAULT_VOICE_SETTINGS.speed),
    volume: clamp(v.volume, 0.01, 2, DEFAULT_VOICE_SETTINGS.volume),
    useSpeakerBoost: (v.useSpeakerBoost ?? v.use_speaker_boost) !== false
  };
}

function normalizeModelList(input, current) {
  const list = Array.isArray(input) ? input.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  if (!list.includes(current)) list.unshift(current);
  return [...new Set(list)];
}

/** 占位符：{{ NAME }}，允许内部有空格，名字大小写不敏感（会被 uppercase 后查表）。 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * 只做占位符替换，其余字节一律原样保留。
 * 未知占位符**保持原样**并计入 missing —— 让用户在自己的模板里一眼看出拼错了哪个词，
 * 而不是被悄悄替换成空串（那会变成很难查的「请求体莫名其妙少一段」）。
 */
export function renderTemplate(template, vars) {
  const missing = new Set();
  const text = String(template ?? '').replace(PLACEHOLDER_RE, (match, rawKey) => {
    const key = rawKey.toUpperCase();
    if (Object.hasOwn(vars, key)) return String(vars[key] ?? '');
    missing.add(rawKey);
    return match;
  });
  return { text, missing: [...missing] };
}

/**
 * JSON 字符串转义（不含外层引号），用于 {{X_JSON}} 占位符。
 */
export function jsonEscape(value) {
  return JSON.stringify(String(value ?? '')).slice(1, -1);
}

/** 模板里能用的占位符名单（报错时原样列给用户，省得他去翻文档）。 */
export const PLACEHOLDER_NAMES = [
  'API_KEY', 'BASE_URL', 'MODEL', 'VOICE', 'VOICE_ID', 'FORMAT',
  'STYLE', 'DESIGN', 'PROMPT', 'TEXT', 'SPEECH', 'SING',
  'VOICE_SETTINGS', 'VOICE_SETTINGS_JSON', 'GUIDANCE_SCALE', 'SPEED', 'VOLUME', 'USE_SPEAKER_BOOST'
];

/**
 * 组装占位符变量表。
 *
 * @param {object} cfg ttsCfg() 的结果
 * @param {object} opts { text, style, design, prompt, voiceOverride, format }
 */
export function buildVars(cfg, { text = '', style = null, design = null, prompt = null, voiceOverride = null, format = null, sing = false } = {}) {
  const styleName = String(style === null ? cfg.style : style ?? '').trim();
  const designText = String(design === null ? cfg.design : design ?? '').trim();
  const promptText = String(prompt === null ? cfg.prompt : prompt ?? '').trim();
  const voiceValue = resolveVoiceValue(cfg, voiceOverride, { sing: sing === true || isSingingStyle(styleName) });
  const fmt = normalizeFormat(format ?? cfg.format);
  const vs = normalizeVoiceSettings(cfg.voiceSettings);
  const breezeVoiceSettings = {
    guidance_scale: vs.guidanceScale,
    speed: vs.speed,
    volume: vs.volume,
    use_speaker_boost: vs.useSpeakerBoost
  };

  // 风格落位：user 模式 → {{STYLE}} 进 user.content，文本保持原样；
  //          inline 模式 → 文本前加 (风格) 标签（官方唱歌就是这种写法），user 留空。
  //          唱歌（sing=true 或 style 含「唱歌」）由 resolveStylePlacement 强制成 inline 独占。
  const placement = resolveStylePlacement(cfg, { style: styleName, sing });
  const inline = placement.inline;
  const effectiveStyle = placement.styleName;
  const speechText = inline ? `${parenTag(effectiveStyle)}${String(text ?? '')}` : String(text ?? '');
  const styleForUser = inline ? '' : effectiveStyle;
  // 音色设计模型的 user.content：优先用本次传的 design，其次用 style 当描述，最后用 cfg.design。
  const designForUser = designText || (!inline ? effectiveStyle : '') || promptText;
  const singingText = placement.sing ? SINGING_STYLE : '';

  const vars = {
    API_KEY: cfg.apiKey,
    BASE_URL: cfg.baseUrl,
    MODEL: cfg.model,
    VOICE: voiceValue,
    FORMAT: fmt,
    STYLE: styleForUser,
    DESIGN: designForUser,
    PROMPT: promptText,
    TEXT: String(text ?? ''),
    SPEECH: speechText,
    SING: singingText,
    // JSON 安全版（推荐模板使用）
    API_KEY_JSON: JSON.stringify(cfg.apiKey),
    BASE_URL_JSON: JSON.stringify(cfg.baseUrl),
    MODEL_JSON: JSON.stringify(cfg.model),
    VOICE_JSON: JSON.stringify(voiceValue),
    FORMAT_JSON: JSON.stringify(fmt),
    STYLE_JSON: JSON.stringify(styleForUser),
    DESIGN_JSON: JSON.stringify(designForUser),
    PROMPT_JSON: JSON.stringify(promptText),
    TEXT_JSON: JSON.stringify(String(text ?? '')),
    SPEECH_JSON: JSON.stringify(speechText),
    SING_JSON: JSON.stringify(singingText),
    // Breeze / ElevenLabs 用：音色 id 走 URL，voice_settings 是对象。
    // 官方字段名是 snake_case（guidance_scale / use_speaker_boost），配置内部用 camelCase，
    // 只在拼请求体时转一次 —— 发 camelCase 过去会被服务端静默忽略、参数看起来「没生效」。
    VOICE_ID: voiceValue,
    VOICE_SETTINGS: JSON.stringify(breezeVoiceSettings),
    VOICE_SETTINGS_JSON: JSON.stringify(breezeVoiceSettings),
    GUIDANCE_SCALE: String(vs.guidanceScale),
    SPEED: String(vs.speed),
    VOLUME: String(vs.volume),
    USE_SPEAKER_BOOST: String(vs.useSpeakerBoost)
  };
  return vars;
}

/** 官方风格标签写法之一：<style>风格</style>（v2 文档） */
export function styleTag(style) {
  const s = String(style ?? '').trim();
  return s ? `<style>${s}</style>` : '';
}

/** 官方 v2.5 的 inline 写法：(风格)文本 */
export function parenTag(style) {
  const s = String(style ?? '').trim();
  return s ? `(${s})` : '';
}

/**
 * 音色取值：预设模式是音色 id，克隆模式是 data URI（**唱歌也只用说话音色**），自定义模式听用户的。
 *
 * 唱歌参考音频（state/tts-sing-ref）**不参与音色克隆**：它只当「歌词 / 音调 / 声调 / 旋律」的素材参考，
 * 绝不写进 audio.voice。否则唱出来的音色会变成那首歌里歌手的声音，而不是你上传的说话音色。
 */
export function resolveVoiceValue(cfg, voiceOverride = null, { sing = false } = {}) {
  void sing; // 唱歌与念白取同一个音色，参数保留只为兼容调用方。
  const override = voiceOverride !== null && voiceOverride !== undefined && String(voiceOverride).trim() !== ''
    ? String(voiceOverride).trim()
    : '';
  // 上游是按**模型**决定 voice 该长什么样的，不是按控制台的「合成模式」下拉：
  // 只要 model 是 voiceclone，voice 就必须是参考音频的 DataURL，传预设音色名一律
  // 400 Param Incorrect（audio.voice must be a DataURL for voice clone model）。
  // 两个字段本来就可能不一致（用户只改了下拉、没改模型），所以这里以模型为准兜底。
  const cloneModel = cfg.mode === 'clone' || guessModeForModel(cfg.model) === 'clone';
  if (cloneModel) {
    // 显式传入的 DataURL（调用方自带一段参考音频）优先，其余一律用已保存的参考音频。
    if (override && /^data:audio\//i.test(override)) return override;
    const uri = cloneAudioDataUri(cfg);
    if (!uri) {
      throw new Error(
        `模型 ${cfg.model || '(未填)'} 是克隆模型：audio.voice 必须是参考音频的 DataURL。`
        + '请在「合成模式 → 克隆音色」里上传一段 mp3 / wav，或把模型换成预置音色模型'
      );
    }
    return uri;
  }
  if (override) return override;
  if (cfg.mode === 'voicedesign') return '';
  return cfg.voice;
}

/** 某一类参考音频（clone=说话音色，sing=唱歌）的落盘位置与配置段。 */
function refSpecOf(cfg, kind) {
  return kind === 'sing'
    ? { kind: 'sing', dir: path.resolve(cfg.singRefDir), ref: cfg.singRef ?? {}, prefix: 'sing' }
    : { kind: 'clone', dir: path.resolve(cfg.cloneDir), ref: cfg.clone ?? {}, prefix: 'clone' };
}

/**
 * 把已保存的参考音频读成 data URI。
 * MIME 必须是样本的真实格式：wav → audio/wav，mp3 → audio/mpeg（官方要求，写错会被拒）。
 */
export function refAudioDataUri(cfg, kind = 'clone') {
  const info = refAudioInfo(cfg, kind);
  if (!info) return '';
  const buf = fs.readFileSync(info.path);
  return `data:${info.mimeType};base64,${buf.toString('base64')}`;
}

/** 读取参考音频的落盘信息（不存在就返回 null，不抛错）。 */
export function refAudioInfo(cfg, kind = 'clone') {
  const spec = refSpecOf(cfg, kind);
  const fileName = String(spec.ref.fileName ?? '').trim();
  if (!fileName) return null;
  const safe = path.basename(fileName);
  const dir = spec.dir;
  const full = path.join(dir, safe);
  // 防穿越：解析后的路径必须仍在（对应的）参考音频目录内。
  if (!full.startsWith(dir + path.sep) && full !== dir) return null;
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const mimeType = String(spec.ref.mimeType ?? '').trim() || mimeFromExt(path.extname(full));
  return { kind: spec.kind, path: full, fileName: safe, bytes: stat.size, mimeType, savedAt: stat.mtimeMs };
}

/** 说话音色参考（保留旧名字，很多调用点与测试用它）。 */
export function cloneAudioDataUri(cfg) {
  return refAudioDataUri(cfg, 'clone');
}

export function cloneAudioInfo(cfg) {
  return refAudioInfo(cfg, 'clone');
}

/**
 * 保存克隆参考音频。只允许 mp3 / wav，且 Base64 后不超过 10 MB（官方硬限制）。
 * 返回落盘信息，交给调用方记进 config.json。
 */
// ── 素材导入：从链接下载一段音频，交给前端截取成 3~5 秒的参考音频 ──
// 只做「代理下载」，不做解码/截取：截取在浏览器里用 Web Audio 完成，服务端不依赖 ffmpeg。
export const IMPORT_MAX_BYTES = 25 * 1024 * 1024;
export const IMPORT_TIMEOUT_MS = 30000;
/** 发送成功后，合成音频与临时落盘的清除延迟（毫秒）。留一分钟让 QQ 侧把语音读完，又不至于攒文件。 */
export const CLEANUP_DELAY_MS = 60000;
/** 没有发送动作兜底时，缓存音频的最长保留时间（毫秒）。 */
export const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

// 内网/本机/链路本地地址：默认拒绝，避免这个接口被当成 SSRF 跳板
const PRIVATE_HOST_RE = /^(localhost|127\.|0\.0\.0\.0$|::1$|169\.254\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

export function assertImportUrl(rawUrl, { allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(String(rawUrl ?? '').trim());
  } catch {
    throw Object.assign(new Error('地址不是合法的 URL（要带 http:// 或 https://）'), { statusCode: 400 });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error(`只支持 http / https（收到 ${u.protocol}）`), { statusCode: 400 });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate && (PRIVATE_HOST_RE.test(host) || host.endsWith('.local') || host.endsWith('.internal'))) {
    throw Object.assign(new Error('拒绝下载内网 / 本机地址；确实要抓本机素材就设 tts.allowPrivateFetch=true'), { statusCode: 403 });
  }
  return u;
}

/**
 * 下载一段音频（mp3 / wav / 任意可解码格式），返回原始字节。
 * 只校验协议、目标主机与体积，不校验格式——格式由调用方解码后再判断。
 */
export async function fetchAudioFromUrl(rawUrl, { maxBytes = IMPORT_MAX_BYTES, timeoutMs = IMPORT_TIMEOUT_MS, allowPrivate = false } = {}) {
  const u = assertImportUrl(rawUrl, { allowPrivate });
  let res;
  try {
    res = await fetch(u, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'qq-bridge-tts/1.0 (+local)' }
    });
  } catch (error) {
    const code = error?.cause?.code || error?.name || error?.message || String(error);
    throw Object.assign(new Error(`下载失败：${code}`), { statusCode: 502 });
  }
  // 跟随重定向后落点也要校验一遍，否则 https 公网域名可以 302 到 127.0.0.1
  assertImportUrl(res.url || String(u), { allowPrivate });
  if (!res.ok) throw Object.assign(new Error(`下载失败：HTTP ${res.status}`), { statusCode: 502 });

  const contentType = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw Object.assign(new Error(`文件太大：${(declared / 1024 / 1024).toFixed(1)} MB，上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MB`), { statusCode: 413 });
  }

  const chunks = [];
  let total = 0;
  const reader = res.body?.getReader?.();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* 已经断了就算了 */ }
        throw Object.assign(new Error(`文件太大：已下载 ${(total / 1024 / 1024).toFixed(1)} MB，上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MB`), { statusCode: 413 });
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    total = buf.length;
    chunks.push(buf);
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw Object.assign(new Error('下载到的内容是空的'), { statusCode: 502 });
  return {
    url: String(u),
    finalUrl: res.url || String(u),
    buffer,
    bytes: buffer.length,
    mimeType: contentType || 'application/octet-stream',
    looksAudio: contentType.startsWith('audio/') || contentType === 'application/octet-stream' || contentType === 'video/mp4'
  };
}

/**
 * 参考音频的「保险」层。
 *
 * 参考音频不是临时文件：它是你唯一的声音素材，一旦被清掉就很难再要回来。
 * 所以这里守两条规矩：
 *   1. 同目录只留「当前生效」的一份；被换下来的旧文件**不删**，而是移进 backup/ 子目录长期保存；
 *   2. 任何清理逻辑（试听缓存、语音库临时件）都不许碰 state/tts-clone，只留 backup 保留上限兜底磁盘。
 */
export const CLONE_BACKUP_KEEP = 30;

export function cloneBackupDir(cloneDir) {
  return path.join(cloneDir, 'backup');
}

function cloneAudioFilesIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && CLONE_ALLOWED_EXT.includes(path.extname(e.name).toLowerCase()))
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
  } catch {
    return [];
  }
}

/** 把某个参考目录里现有的参考音频全部归档进 backup/（移动，不删）。返回归档后的文件名数组。 */
function archiveExistingIn(dir) {
  const backupDir = cloneBackupDir(dir);
  const keeps = cloneAudioFilesIn(dir);
  if (!keeps.length) return { archived: [], backupDir };
  fs.mkdirSync(backupDir, { recursive: true });
  const archived = [];
  for (const k of keeps) {
    const src = path.join(dir, k.name);
    let target = path.join(backupDir, k.name);
    if (fs.existsSync(target)) {
      const stem = path.basename(k.name, path.extname(k.name));
      target = path.join(backupDir, `${stem}-${Date.now().toString(36)}${path.extname(k.name)}`);
    }
    try {
      fs.renameSync(src, target);
    } catch {
      try {
        fs.copyFileSync(src, target);
        fs.rmSync(src, { force: true });
      } catch {
        continue; // 被播放器占用等情况优先保住原文件，下次上传再归档
      }
    }
    archived.push(path.basename(target));
  }
  // 备份只保留最近 CLONE_BACKUP_KEEP 份，更早的才删；正常用量下永远到不了这一层。
  const backups = cloneAudioFilesIn(backupDir).sort((a, b) => b.mtime - a.mtime);
  for (const b of backups.slice(CLONE_BACKUP_KEEP)) {
    try { fs.rmSync(path.join(backupDir, b.name), { force: true }); } catch { /* ignore */ }
  }
  return { archived, backupDir };
}

/** 读一眼备份目录（给配置描述 / 控制台展示用）。kind: clone=说话音色，sing=唱歌。 */
export function listRefBackups(cfg, kind = 'clone') {
  const spec = refSpecOf(cfg, kind);
  const dir = cloneBackupDir(spec.dir);
  const files = cloneAudioFilesIn(dir).sort((a, b) => b.mtime - a.mtime);
  const latest = files[0] ?? null;
  let bytes = 0;
  for (const f of files) {
    try { bytes += fs.statSync(path.join(dir, f.name)).size; } catch { /* ignore */ }
  }
  return {
    kind: spec.kind,
    dir,
    count: files.length,
    bytes,
    keepLimit: CLONE_BACKUP_KEEP,
    latest: latest ? { fileName: latest.name, savedAt: Math.round(latest.mtime) } : null
  };
}

/** 删掉某类参考音频的全部历史备份。只动 backup/ 里的归档，当前正在用的参考音频不受影响。 */
export function clearRefBackups(cfg, kind = 'clone') {
  const spec = refSpecOf(cfg, kind);
  const dir = cloneBackupDir(spec.dir);
  const files = cloneAudioFilesIn(dir);
  const deleted = [];
  let bytes = 0;
  for (const f of files) {
    const full = path.join(dir, f.name);
    try {
      const size = fs.statSync(full).size;
      fs.rmSync(full, { force: true });
      deleted.push(f.name);
      bytes += size;
    } catch {
      // 被播放器占用等情况跳过，不因为一个文件失败而中断整批
    }
  }
  return { kind: spec.kind, dir, deleted, removed: deleted.length, bytes };
}

/** 兼容旧名字：说话音色的备份信息。 */
export function listCloneBackups(cfg) {
  return listRefBackups(cfg, 'clone');
}

/** ffmpeg 可执行文件：优先 env，其次配置，最后碰运气用 PATH 里的 ffmpeg。 */
export function ffmpegBin(cfg = null) {
  return String(process.env.FFMPEG_PATH || cfg?.voice?.ffmpegPath || '').trim() || 'ffmpeg';
}

/** ffprobe 可执行文件：优先 env，其次跟 ffmpeg 同目录找，最后用 PATH。 */
export function ffprobeBin(cfg = null) {
  const fromEnv = String(process.env.FFPROBE_PATH || '').trim();
  if (fromEnv) return fromEnv;
  const ff = ffmpegBin(cfg);
  if (ff !== 'ffmpeg' && path.isAbsolute(ff)) {
    const sibling = path.join(path.dirname(ff), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(sibling)) return sibling;
  }
  return 'ffprobe';
}

const PCM_CODECS = ['pcm_s16le', 'pcm_u8', 'pcm_f32le', 'pcm_s24le', 'pcm_s32le'];

function runBin(file, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const tail = String(stderr || error.message || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
        reject(new Error(tail || '调用外部程序失败'));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * 用 ffprobe 读音频**真实**规格（扩展名不可信：这个项目真遇到过「.wav 里装的是 17 分钟 AAC」）。
 * 读不到就返回 null，不抛错——没装 ffprobe 时调用方自己决定怎么退。
 */
export async function probeAudioSpec(cfg, filePath) {
  try {
    const { stdout } = await runBin(ffprobeBin(cfg), [
      '-hide_banner', '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration',
      '-of', 'json', filePath
    ], { timeoutMs: 30000 });
    const parsed = JSON.parse(stdout || '{}');
    const stream = parsed?.streams?.[0] ?? {};
    const seconds = Number(parsed?.format?.duration);
    return {
      codec: String(stream.codec_name ?? ''),
      sampleRate: Number(stream.sample_rate) || 0,
      channels: Number(stream.channels) || 0,
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0
    };
  } catch {
    return null;
  }
}

/**
 * 把参考音频规范化成官方最认的规格：24kHz / 16bit / 单声道 PCM wav，最长 30 秒。
 *
 * 为什么必须做：参考音频会被 base64 塞进 `audio.voice`，原样上传一段 17 分钟的双声道
 * 48kHz 音频（哪怕扩展名是 .wav）会让每次合成请求涨到 10MB 级别、耗时 20 秒以上，
 * 上游还会直接回 `400 Param Incorrect`。转成 24k 单声道 30 秒后通常在 1MB 上下。
 *
 * 返回 { buffer, ext, changed, spec, note }；规格本来就没问题时 changed=false 原样返回。
 */
export async function normalizeRefAudio(cfg, { buffer, ext }) {
  const suffix = CLONE_ALLOWED_EXT.includes(ext) ? ext : '.bin';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-ref-'));
  const src = path.join(dir, `in${suffix}`);
  try {
    fs.writeFileSync(src, buffer);
    const spec = await probeAudioSpec(cfg, src);
    if (!spec) {
      return { buffer, ext, changed: false, spec: null, note: '没装 ffprobe，无法检查参考音频规格（装了 ffmpeg 后重传可自动规范化）' };
    }
    const isPcmWav = PCM_CODECS.includes(spec.codec) && suffix === '.wav';
    const okRate = spec.sampleRate === REF_TARGET_RATE;
    const okChannels = spec.channels === 1;
    const okLength = spec.seconds > 0 && spec.seconds <= REF_MAX_SECONDS;
    const okSize = buffer.length <= REF_MAX_BYTES;
    if (isPcmWav && okRate && okChannels && okLength && okSize) {
      return { buffer, ext, changed: false, spec, note: null };
    }
    const out = path.join(dir, 'out.wav');
    await runBin(ffmpegBin(cfg), [
      '-hide_banner', '-v', 'error', '-y', '-i', src,
      '-t', String(REF_MAX_SECONDS),
      '-vn', '-ac', '1', '-ar', String(REF_TARGET_RATE), '-c:a', 'pcm_s16le', out
    ]);
    const normalized = fs.readFileSync(out);
    const reasons = [];
    if (!isPcmWav) reasons.push(`实际编码 ${spec.codec || '未知'}${suffix === '.wav' ? '（扩展名写的是 wav）' : ''}`);
    if (!okRate) reasons.push(spec.sampleRate ? `${spec.sampleRate}Hz` : '采样率未知');
    if (!okChannels) reasons.push(spec.channels ? `${spec.channels} 声道` : '声道数未知');
    if (!okLength && spec.seconds) reasons.push(`${spec.seconds.toFixed(1)} 秒`);
    if (!okSize) reasons.push(`${(buffer.length / 1024 / 1024).toFixed(2)}MB`);
    return {
      buffer: normalized,
      ext: '.wav',
      changed: true,
      spec,
      note: `参考音频已自动规范化：${reasons.join('、')} → 24kHz/16bit/单声道 wav（${(normalized.length / 1024 / 1024).toFixed(2)}MB，最多 ${REF_MAX_SECONDS} 秒）`
    };
  } catch (error) {
    throw new Error(`参考音频处理失败：${error?.message ?? String(error)}（可先用 ffmpeg 转成 24kHz 单声道 wav 再传）`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 保存参考音频。kind='clone' 存进 state/tts-clone，kind='sing' 存进 state/tts-sing-ref。
 * 两边各自归档、各自 backup/，绝不互相覆盖。
 */
export function saveRefAudio(cfg, { buffer, fileName, kind = 'clone', seconds = 0, speechSeconds = 0 }) {
  const spec = refSpecOf(cfg, kind);
  const ext = path.extname(String(fileName ?? '')).toLowerCase();
  if (!CLONE_ALLOWED_EXT.includes(ext)) {
    throw new Error(`参考音频只支持 mp3 / wav（收到 ${ext || '无扩展名'}）`);
  }
  const b64Len = Math.ceil(buffer.length / 3) * 4;
  if (b64Len > CLONE_MAX_BASE64_BYTES) {
    throw new Error(`参考音频过大：Base64 后 ${(b64Len / 1024 / 1024).toFixed(2)} MB，官方上限 10 MB（约原始 7.5 MB）`);
  }
  fs.mkdirSync(spec.dir, { recursive: true });
  // 只归档、不删除：旧参考音频进 backup/，误传/测试上传都还能退回来。
  const { archived, backupDir } = archiveExistingIn(spec.dir);
  // 固定前缀 + 时间戳，避免 Windows 上「文件被占用」导致覆盖失败（试听时可能正在播放）。
  const safeName = `${spec.prefix}-${Date.now().toString(36)}${ext}`;
  const full = path.join(spec.dir, safeName);
  fs.writeFileSync(full, buffer);
  // 时长优先用服务端自己量的（浏览器报的数只在量不出来时兜底）：
  // 服务端量的是真正落盘的那份，浏览器量的是「准备上传的那份」，两者可能因为
  // 规范化（重采样/截断）而不一致。这里以落盘文件为准，避免面板显示和实际不符。
  const measured = measureWavSpeech(buffer);
  const finalSeconds = measured ? measured.seconds : positiveNumber(seconds, 0);
  const finalSpeech = measured ? measured.speechSeconds : positiveNumber(speechSeconds, 0);
  return {
    kind: spec.kind,
    fileName: safeName,
    path: full,
    mimeType: mimeFromExt(ext),
    bytes: buffer.length,
    savedAt: Date.now(),
    // 时长只给人看（面板显示 + 「过短」警告），不参与请求构造，量不出来就存 0。
    seconds: finalSeconds,
    speechSeconds: finalSpeech,
    archived,
    backupDir
  };
}

/** 兼容旧名字：保存说话音色参考。 */
export function saveCloneAudio(cfg, { buffer, fileName }) {
  return saveRefAudio(cfg, { buffer, fileName, kind: 'clone' });
}

/**
 * 清除某一类参考音频（kind: clone=说话音色，sing=唱歌）。
 *
 * 只清「当前这份」：文件从 state/tts-clone 或 state/tts-sing-ref 删掉，调用方再把配置里
 * 指向它的字段置空。backup/ 里的历史归档**不动**——那是保险层，想彻底清盘得自己进目录删。
 * 没有任何已上传文件时返回 removed=null，让调用方仍能把配置里的失效引用清掉。
 */
export function clearRefAudio(cfg, kind = 'clone') {
  const spec = refSpecOf(cfg, kind);
  const info = refAudioInfo(cfg, kind);
  if (!info) return { kind: spec.kind, removed: null, bytes: 0 };
  try {
    fs.rmSync(info.path, { force: true });
  } catch (error) {
    throw new Error(`删除参考音频失败：${error?.message ?? String(error)}（文件可能正被播放器占用，关掉试听再试一次）`);
  }
  return { kind: spec.kind, removed: info.fileName, bytes: info.bytes };
}

/**
 * 把克隆音频转存进语音库，供「合成 → 发送语音条」使用。
 * 语音库目录由调用方给（socialV2.voice.dir），文件名做安全化处理。
 */
export function stageAudioToLibrary(dir, buffer, ext = '.wav', prefix = 'tts') {
  fs.mkdirSync(dir, { recursive: true });
  const safeExt = AUDIO_MIME_BY_EXT[String(ext).toLowerCase()] ? String(ext).toLowerCase() : '.wav';
  const name = `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}${safeExt}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, buffer);
  return { name, path: full, bytes: buffer.length };
}

/** 清掉语音库里过期的合成产物（只删我们自己 tts- 前缀的，绝不碰用户放的音频）。 */
export function pruneStagedAudio(dir, { keep = 20 } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const ours = names
    .filter((n) => n.startsWith('tts-'))
    .map((n) => {
      const full = path.join(dir, n);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {}
      return { full, mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  if (ours.length <= keep) return;
  for (const item of ours.slice(0, ours.length - keep)) {
    try {
      fs.rmSync(item.full, { force: true });
    } catch {}
  }
}

/** 从完整 chat/completions 地址推导出 OpenAI 兼容的 /models 地址。 */
export function deriveModelsUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim();
  if (!raw) throw new Error('接口地址为空');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`接口地址不是合法 URL：${raw}`);
  }
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/\/chat\/completions$/i, '');
  if (!p) p = '/v1';
  u.pathname = `${p}/models`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * 推导 Breeze / ElevenLabs 的合成地址：`{base}/text-to-speech/{voice_id}?output_format=…`。
 *
 * 用户填的接口地址可能已经是 `https://api.breeze.blue/v1`，也可能是从别处粘来的
 * 完整 chat/completions 地址；两种都收敛到同一形状，切协议时不用再改一遍地址。
 * 音色 id 必须放在路径里 —— 这是它跟 OpenAI 协议最大的结构差异。
 */
export function breezeTtsUrl(cfg, voiceId, format = null) {
  const raw = String(cfg?.baseUrl ?? '').trim() || DEFAULT_BASE_URL;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`接口地址不是合法 URL：${raw}`);
  }
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/\/chat\/completions$/i, '');
  p = p.replace(/\/text-to-speech(\/.*)?$/i, '');
  if (!/\/v\d+$/i.test(p)) p = `${p || ''}/v1`;
  const fmt = normalizeFormat(format ?? cfg?.format);
  // 它的 output_format 只认 mp3 / wav / pcm 一类，pcm16 归一成 pcm。
  const q = fmt === 'pcm16' ? 'pcm' : fmt;
  u.pathname = `${p}/text-to-speech/${encodeURIComponent(String(voiceId ?? '').trim())}`;
  u.search = `?output_format=${encodeURIComponent(q)}`;
  u.hash = '';
  return u.toString();
}

/** 推导 Breeze / ElevenLabs 的音色列表地址：`{base}/voices`。 */
export function breezeVoicesUrl(cfg) {
  const raw = String(cfg?.baseUrl ?? '').trim() || DEFAULT_BASE_URL;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`接口地址不是合法 URL：${raw}`);
  }
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/\/chat\/completions$/i, '').replace(/\/text-to-speech(\/.*)?$/i, '');
  if (!/\/v\d+$/i.test(p)) p = `${p || ''}/v1`;
  u.pathname = `${p}/voices`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * 解析请求头模板。
 *
 * 规则（对齐「原样发送」的要求）：
 *  - 按行切分，跳过空行与以 # 开头的注释行；
 *  - 每行按**第一个** : 或 = 切开（值里可以再出现冒号，比如 URL）；
 *  - 只做占位符替换；**绝不**在这里补 Content-Type 或 Authorization。
 */
export function parseHeaderTemplate(template, vars) {
  const lines = String(template ?? '').split(/\r?\n/);
  const headers = [];
  const problems = [];
  const missing = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (!rawLine.trim()) continue;
    if (/^\s*#/.test(rawLine)) continue;
    const m = rawLine.match(/^\s*([^:=]+?)\s*[:=]\s*(.*)$/);
    if (!m) {
      problems.push({ line: i + 1, text: rawLine, error: '这一行不是「名称: 值」格式，已跳过' });
      continue;
    }
    const nameRender = renderTemplate(m[1], vars);
    const valueRender = renderTemplate(m[2], vars);
    for (const k of nameRender.missing) missing.add(k);
    for (const k of valueRender.missing) missing.add(k);
    const name = nameRender.text.trim();
    if (!name) {
      problems.push({ line: i + 1, text: rawLine, error: '头部名称为空，已跳过' });
      continue;
    }
    // HTTP 头值不允许 CR/LF（Node 会直接拒绝并抛错），这里提前压成一行并给出提示。
    if (/[\r\n]/.test(valueRender.text)) {
      problems.push({ line: i + 1, text: name, error: '头部值里出现了换行（可能是占位符内容带换行），已折叠为空格' });
    }
    headers.push([name, valueRender.text.replace(/[\r\n]+/g, ' ').trim()]);
  }
  return { headers, problems, missing: [...missing] };
}

/**
 * 发一次原始字节请求。
 *
 * @returns {Promise<{ok:boolean,status:number,statusText:string,contentType:string,headers:object,bodyBuffer:Buffer,elapsedMs:number,sentHeaders:string[]}>}
 */
export function ttsRawRequest({
  url,
  headers,
  bodyBuffer,
  timeoutMs = 180000,
  maxResponseBytes = 64 * 1024 * 1024
}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`接口地址不是合法 URL：${url}`));
      return;
    }
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const isHttps = u.protocol === 'https:';
    if (!isHttps && u.protocol !== 'http:') {
      reject(new Error(`接口地址只支持 http / https（收到 ${u.protocol}）`));
      return;
    }
    const mod = isHttps ? https : http;

    // 展平成 [name, value, name, value] —— Node 在这种形式下原样发送，不合并、不规范化、不补全。
    const flat = [];
    const sentHeaders = [];
    for (const [name, value] of headers) {
      flat.push(name, value);
      // 审计用的展示串里抹掉密钥值，避免控制台/日志出现明文 key。
      const shown = isSecretHeader(name) ? redactSecret(value) : value;
      sentHeaders.push(`${name}: ${shown}`);
    }
    const hasHost = headers.some(([n]) => String(n).toLowerCase() === 'host');
    if (!hasHost) {
      // 只补 Host（HTTP/1.1 强制）；其它业务头一个都不补。
      flat.push('Host', u.host);
      sentHeaders.push(`Host: ${u.host}`);
    }

    const startedAt = Date.now();
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: flat,
        servername: isHttps ? u.hostname : undefined
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxResponseBytes) {
            req.destroy(new Error(`响应体超过 ${Math.round(maxResponseBytes / 1024 / 1024)} MB，已中止`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          done(resolve, {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || '',
            contentType: String(res.headers['content-type'] ?? ''),
            headers: res.headers,
            bodyBuffer: Buffer.concat(chunks),
            elapsedMs: Date.now() - startedAt,
            requestBytes: bodyBuffer.length,
            sentHeaders
          });
        });
        res.on('error', (error) => done(reject, error));
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：对方一直没有响应`));
    });
    req.on('error', (error) => done(reject, error));
    // 原样写出字节：不追加换行、不加 BOM、不重新序列化。
    req.end(bodyBuffer);
  });
}

function isSecretHeader(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return false;
  // 不能只列死名字：各家鉴权头叫法不一样（api-key / x-api-key / xi-api-key / bearer-token / x-auth-key…），
  // 漏一个就会把明文密钥写进审计串、日志和控制台。凡是「…key / …token / …secret」一律当密钥处理。
  if (n === 'authorization' || n === 'proxy-authorization' || n === 'password') return true;
  return n.endsWith('key') || n.endsWith('token') || n.endsWith('secret');
}

/** 把密钥值替换成「前 4 位…后 4 位」，用于任何要展示给界面的地方。 */
export function redactSecret(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * 从响应里取出音频字节。
 * 兼容三种常见形态：
 *  1) Content-Type 直接是 audio/* —— 响应体就是音频；
 *  2) OpenAI 兼容的 chat/completions —— choices[0].message.audio.data（base64）；
 *  3) 流式变体 —— choices[0].delta.audio.data / 其它 audio.data（base64）。
 */
/**
 * 读 WAV 时长（秒）；不是 WAV 或头不完整就返回 null。
 *
 * 用途只有一个：判断这次到底是「唱」还是「念」。同一句歌词，唱出来通常比念白长好几倍，
 * 而时长是唯一不需要听就能拿到的客观信号。
 */
export function audioDurationSec(buffer, mimeType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  const mime = String(mimeType ?? '').toLowerCase();
  const looksWav =
    (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WAVE') ||
    mime.includes('wav');
  if (!looksWav) return null;
  try {
    const channels = buffer.readUInt16LE(22);
    const rate = buffer.readUInt32LE(24);
    const bits = buffer.readUInt16LE(34);
    const bps = (rate * channels * bits) / 8;
    if (!(bps > 0)) return null;
    // 逐块找 data：不能假设它紧跟 fmt（有些实现会插 LIST/fact 块）。
    let off = 12;
    while (off + 8 <= buffer.length) {
      const id = buffer.slice(off, off + 4).toString('ascii');
      const size = buffer.readUInt32LE(off + 4);
      if (id === 'data') {
        const bytes = Math.min(size, buffer.length - off - 8);
        return Number((bytes / bps).toFixed(2));
      }
      off += 8 + size + (size % 2);
    }
    return null;
  } catch {
    return null;
  }
}

export function extractAudioFromResponse({ bodyBuffer, contentType }, { format = 'wav' } = {}) {
  const ct = String(contentType ?? '').toLowerCase();
  if (ct.startsWith('audio/')) {
    const mime = ct.split(';')[0].trim() || mimeFromFormat(format);
    return { ok: true, buffer: bodyBuffer, mimeType: mime, via: 'raw-audio' };
  }
  const textBody = bodyBuffer.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(textBody);
  } catch {
    return { ok: false, error: '响应既不是音频，也不是 JSON', excerpt: textBody.slice(0, 400) };
  }
  const candidates = [
    ['choices[0].message.audio.data', parsed?.choices?.[0]?.message?.audio?.data],
    ['choices[0].delta.audio.data', parsed?.choices?.[0]?.delta?.audio?.data],
    ['choices[0].audio.data', parsed?.choices?.[0]?.audio?.data],
    ['audio.data', parsed?.audio?.data]
  ];
  for (const [via, cand] of candidates) {
    if (typeof cand === 'string' && cand.trim()) {
      const buf = Buffer.from(cand, 'base64');
      if (!buf.length) continue;
      return { ok: true, buffer: buf, mimeType: mimeFromFormat(format), via };
    }
  }
  // 没有音频字段：把服务端的错误说明透出来（这是排查 400/401 的唯一线索）。
  // 小米的 400 形如 {code, message:"Param Incorrect", param:"audio.voice must be a DataURL ..."}：
  // **真正有用的信息在 param 里**，只取 message 会得到一句毫无指向性的「Param Incorrect」。
  const errMsg =
    parsed?.error?.message ||
    (typeof parsed?.error === 'string' ? parsed.error : '') ||
    parsed?.message ||
    parsed?.choices?.[0]?.message?.content ||
    '';
  const errParam =
    parsed?.error?.param ||
    parsed?.param ||
    parsed?.error?.code ||
    '';
  return {
    ok: false,
    error: errMsg ? String(errMsg) : '响应里没有找到音频数据（choices[0].message.audio.data）',
    // 上游指出的具体字段（如 audio.voice）：拼进报错，用户才知道该改哪里。
    errorParam: errParam ? String(errParam) : '',
    excerpt: textBody.slice(0, 400)
  };
}

/** 把音频写进缓存目录，返回一个短 id（控制台用同源 /api/tts/audio?id=xxx 播放）。 */
export function saveAudioCache(cfg, buffer, { mimeType = 'audio/wav' } = {}) {
  fs.mkdirSync(cfg.cacheDir, { recursive: true });
  const ext = Object.keys(AUDIO_MIME_BY_EXT).find((e) => AUDIO_MIME_BY_EXT[e] === mimeType) || '.wav';
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const full = path.join(cfg.cacheDir, `${id}${ext}`);
  fs.writeFileSync(full, buffer);
  pruneCache(cfg);
  // 顺手清掉一小时前没人管的历史缓存（比如进程重启丢了延迟删除的定时器）。
  pruneCacheOlder(cfg);
  return { id, path: full, bytes: buffer.length, mimeType, ext };
}

/** 读缓存音频；id 做白名单式校验（只允许 [a-z0-9-]），杜绝路径穿越。 */
export function readAudioCache(cfg, id) {
  const clean = String(id ?? '').trim();
  if (!/^[a-z0-9-]{1,64}$/i.test(clean)) throw new Error('音频 id 不合法');
  const dir = path.resolve(cfg.cacheDir);
  let hit = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.replace(/\.[^.]+$/, '') === clean) {
        hit = path.join(dir, name);
        break;
      }
    }
  } catch {
    throw new Error('音频缓存目录不存在');
  }
  if (!hit) throw new Error('音频已过期或不存在（缓存会定期清理，请重新合成）');
  const buf = fs.readFileSync(hit);
  return { buffer: buf, mimeType: mimeFromExt(path.extname(hit)), bytes: buf.length, path: hit };
}

/**
 * 延迟删除一个文件（发送成功后用来清掉合成产物，避免 state 越攒越大）。
 * unref 掉定时器：进程退出时不因为等它而卡住；进程重启则由 pruneCacheOlder 兜底。
 */
export function scheduleDelete(filePath, delayMs = CLEANUP_DELAY_MS) {
  if (!filePath) return null;
  const target = String(filePath);
  const timer = setTimeout(() => {
    try { fs.rmSync(target, { force: true }); } catch {}
  }, Math.max(0, Number(delayMs) || 0));
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/** 删掉缓存目录里超过 maxAgeMs 的音频（兜底：进程重启丢了定时器也不会长期残留）。 */
export function pruneCacheOlder(cfg, { maxAgeMs = CACHE_MAX_AGE_MS } = {}) {
  let names;
  try {
    names = fs.readdirSync(cfg.cacheDir);
  } catch {
    return 0;
  }
  const deadline = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
  let removed = 0;
  for (const name of names) {
    const full = path.join(cfg.cacheDir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.mtimeMs > deadline) continue;
    try { fs.rmSync(full, { force: true }); removed += 1; } catch {}
  }
  return removed;
}

/** 缓存最多留 40 个文件（一个 wav 可能好几 MB，别把 state 撑爆）。 */
function pruneCache(cfg) {
  const MAX_FILES = 40;
  let names;
  try {
    names = fs.readdirSync(cfg.cacheDir);
  } catch {
    return;
  }
  const audio = names.filter((n) => AUDIO_MIME_BY_EXT[path.extname(n).toLowerCase()]);
  if (audio.length <= MAX_FILES) return;
  const withTime = audio.map((n) => {
    const full = path.join(cfg.cacheDir, n);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {}
    return { full, mtimeMs };
  });
  withTime.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const item of withTime.slice(0, withTime.length - MAX_FILES)) {
    try {
      fs.rmSync(item.full, { force: true });
    } catch {}
  }
}

/**
 * 一次完整合成：渲染模板 → 原样发送 → 取音频。
 * 失败时抛出带上下文的错误（控制台直接把 message 显示给用户）。
 */
export async function synthesize(baseCfg, { text, style = null, design = null, prompt = null, voiceOverride = null, format = null, sing = false } = {}) {
  const body = String(text ?? '');
  if (!body.trim()) throw new Error('待合成文本不能为空');
  if (baseCfg.maxChars > 0 && body.length > baseCfg.maxChars) {
    throw new Error(`文本过长：${body.length} 字，上限 ${baseCfg.maxChars} 字（tts.maxChars 可调）`);
  }
  // 先定路由（唱歌只能走小米那套），再按目标协议把配置投影成一套具体字段。
  const wantSing = sing === true || isSingingStyle(String(style ?? baseCfg.style ?? ''));
  const route = resolveRouteStyle(baseCfg, { sing: wantSing, text: body });
  const cfg = viewForStyle(baseCfg, route);
  const placement = resolveStylePlacement(cfg, { style, sing });
  const fmt = normalizeFormat(format ?? cfg.format);
  const vars = buildVars(cfg, { text: body, style, design, prompt, voiceOverride, format: fmt, sing: placement.sing });
  const headerParsed = parseHeaderTemplate(cfg.headerTemplate, vars);
  const bodyParsed = renderTemplate(cfg.bodyTemplate, vars);
  if (!headerParsed.headers.length) throw new Error('请求头模板是空的：至少需要一行「名称: 值」');
  if (!bodyParsed.text.trim()) throw new Error('请求体模板是空的');
  // 不认识的占位符直接拦下：模板是「原样发送」的，拼错的 {{TEXTX}} 会被一字不改地发出去，
  // 服务端只会回一个语焉不详的 400。这里提前把可用占位符列出来，省得去猜。
  const unknown = [...new Set([...headerParsed.missing, ...bodyParsed.missing])];
  if (unknown.length) {
    throw new Error(
      `模板里有不认识的占位符：${unknown.map((k) => `{{${k}}}`).join('、')}`
      + `（可用：${PLACEHOLDER_NAMES.join('、')}，每个都可加 _JSON 后缀做 JSON 转义）`
    );
  }

  const bodyBuffer = Buffer.from(bodyParsed.text, 'utf8');
  // 两种协议的差别主要就在这一行：OpenAI 的地址就是 baseUrl 本身，
  // Breeze 把音色 id 与输出格式塞进路径/查询串。
  let reqUrl = cfg.baseUrl;
  if (cfg.apiStyle === 'breeze') {
    const voiceId = String(vars.VOICE ?? '').trim();
    if (!voiceId) throw new Error('Breeze 协议需要在「音色 / voice_id」里填一个音色 id（可点「拉取音色」选）');
    reqUrl = breezeTtsUrl(cfg, voiceId, fmt);
  }
  const startedAt = Date.now();
  // 唱歌时上游要「作曲 + 演唱」，实测同长度文本比念白慢 20~50 倍，超时下限单独抬高。
  const timeoutMs = placement.sing ? Math.max(cfg.timeoutMs, SINGING_TIMEOUT_MS) : cfg.timeoutMs;

  // 唱歌是**概率性**的：同一份请求，上游有时真唱（时长是念白的几倍），有时只是把词念一遍。
  // 调用方既然明确要「唱歌」，就用「疑似念白」的时长特征重试几次，最后交最长的那条。
  const maxAttempts = placement.sing ? Math.max(1, cfg.singAttempts) : 1;
  // 念白实测约 0.26 秒/字（15 字 5.3~6.4 秒）；真唱至少慢一倍（15 字 9.1 秒、38 字 20.6~76 秒）。
  // 阈值故意压到「宁严勿宽」：误判成唱会让调用方以为发了唱歌，漏判只是多重试几次。下限 6 秒防短句误判。
  const singMinSec = placement.sing ? Math.max(6, body.length * 0.6) : 0;
  let attempts = 0;
  let best = null;
  while (attempts < maxAttempts) {
    attempts += 1;
    const res = await ttsRawRequest({
      url: reqUrl,
      headers: headerParsed.headers,
      bodyBuffer,
      timeoutMs
    });
    const audio = extractAudioFromResponse(res, { format: fmt });
    const durationSec = audio.ok ? audioDurationSec(audio.buffer, audio.mimeType) : null;
    // 拿不到时长（mp3/pcm）就只能当作成功 —— 宁可漏判，也别把正常请求打成失败。
    const actuallySang = placement.sing ? (durationSec === null ? true : durationSec >= singMinSec) : false;
    const summary = {
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
      apiStyle: cfg.apiStyle,
      sentUrl: reqUrl,
      requestBytes: bodyBuffer.length,
      responseBytes: res.bodyBuffer.length,
      sentHeaders: res.sentHeaders,
      sing: placement.sing,
      actuallySang,
      durationSec,
      attempts,
      styleWarnings: placement.warnings,
      missingPlaceholders: [...new Set([...headerParsed.missing, ...bodyParsed.missing])],
      headerProblems: headerParsed.problems,
      requestBodyPreview: bodyParsed.text.length > 1200 ? `${bodyParsed.text.slice(0, 1200)}…` : bodyParsed.text
    };
    if (!audio.ok) {
      const hint = [];
      // 上游已经在 param 里点名了字段，就照着说，别让用户去猜「模板哪里拼错了」。
      const param = audio.errorParam;
      const paramHint = paramHintFor(param, cfg)
      if (res.status === 400 && paramHint) hint.push(paramHint)
      else if (res.status === 400) hint.push('400：请求体格式不对（模板里的 JSON 拼错，或参考音频体积/规格超限——控制台重新上传一次会自动规范化成 24kHz 单声道 30 秒内）');
      if (res.status === 401) hint.push('401：API Key 不对或没带上（检查请求头模板里的 api-key / Authorization 行）');
      if (res.status === 402) hint.push('402：账户余额不足');
      if (res.status === 403) hint.push('403：Key 没有该模型权限，或地区/风控限制');
      if (res.status === 404) hint.push('404：接口地址不存在，或该模型不支持这种能力');
      if (res.status === 415) hint.push('415：请求头里缺少正确的 Content-Type（本项目不会替你补，需要在模板里写）');
      if (res.status === 421) hint.push('421：内容被拦截（检查待合成文本）');
      if (res.status === 429) hint.push('429：限流或额度用尽（官方 TTS 模型 RPM 100 / TPM 10M）');
      const detail = [audio.error, audio.errorParam ? `字段：${audio.errorParam}` : '', hint.join('；')].filter(Boolean).join(' ｜ ');
      const error = new Error(`合成失败（HTTP ${res.status}）：${detail}`);
      // 上游状态码原样带出去：路由层据此决定回 429 / 502，而不是把所有失败都压成 400。
      error.statusCode = res.status === 429 ? 429 : res.status >= 500 ? 502 : 400;
      error.upstreamStatus = res.status;
      error.upstreamParam = audio.errorParam || '';
      error.summary = { ...summary, excerpt: audio.excerpt, upstreamParam: audio.errorParam || '' };
      throw error;
    }
    const candidate = { audio, summary, durationSec, actuallySang };
    if (!best || (candidate.durationSec ?? 0) > (best.durationSec ?? 0)) best = candidate;
    if (!placement.sing || actuallySang) break;
  }
  const { audio, summary, actuallySang } = best;
  let { durationSec } = best;
  let finalAudio = audio;
  const warnings = [...placement.warnings];
  if (cfg.apiStyle === 'breeze' && placement.sing) {
    warnings.push('Breeze / ElevenLabs 协议没有「唱歌」参数：这里只能把「唱歌」当普通文本念，真要唱得换支持歌唱的模型');
  }
  if (placement.sing) {
    if (!actuallySang) {
      warnings.push(`试了 ${attempts} 次，上游都只像念白（最长 ${durationSec ?? '?'} 秒）——这段可能没真的唱`);
    } else if (attempts > 1) {
      warnings.push(`第 ${attempts} 次才真的唱出来（前几次上游只念白，已丢弃）`);
    }
  }
  const cached = saveAudioCache(cfg, finalAudio.buffer, { mimeType: finalAudio.mimeType });
  const routeName = cfg.apiStyle === 'breeze' ? 'breeze' : 'mimo';
  // 记下这次的成功耗时：auto 模式就是靠它判断「哪边更快」。
  const latency = recordRouteLatency(baseCfg.rootDir, routeName, Date.now() - startedAt);
  return {
    audioId: cached.id,
    bytes: cached.bytes,
    mimeType: cached.mimeType,
    via: audio.via,
    sing: placement.sing,
    actuallySang,
    durationSec,
    attempts,
    // 这次实际走的是哪一套（auto 模式下由延迟统计决定）。
    route: routeName,
    routeMode: baseCfg.routeMode,
    latency,
    warnings,
    summary: { ...summary, route: routeName, routeMode: baseCfg.routeMode }
  };
}

/**
 * 探活用的 GET：一次 DNS 可能同时给出 IPv4 / IPv6 两条路，其中一条不通时
 * Node 的 happy-eyeballs 会先卡在那条上。实测 api.breeze.blue：IPv4 约 1s 通，
 * IPv6 直接 8s 超时 —— 用户看到的「在 20015ms 内没有响应」就是这么来的。
 *
 * 重试策略（0.3.12 修正）：
 *  - 先用**默认双栈**发一次（Node 的 happy-eyeballs 会自己挑通的那条）；
 *  - 只有超时才重试一次，而且**不钉地址族**（family 留空）。
 *    0.3.11 及以前重试时钉死 family:4，理由来自一次「IPv6 不通、IPv4 通」的实测；
 *    但实测本机到 api.breeze.blue 恰好相反（IPv4 连 15s 都不通、默认双栈 1.5s 通），
 *    钉死 v4 等于把「可能能通」换成「必然等满一整轮」。留空让 happy-eyeballs 重新
 *    选一次，任何网络下都不会比第一次更差。
 *
 * 时间预算（0.3.12 修正）：两次尝试共用**同一个** timeoutMs 预算，而不是各给一份。
 * 以前总耗时是 2×timeoutMs，用户却看到「在 10010ms 内没有响应（等待上限 20000ms）」
 * 这种自相矛盾的文案：elapsedMs 是两次之和，上限写的是单次。现在第二次只拿剩下的
 * 预算，剩余不足 1s 就直接放弃重试，保证「等待上限 N ms」这句话始终为真。
 */
async function probeGet(targetUrl, headers, timeoutMs) {
  const attempt = (family, budgetMs) => new Promise((resolve) => {
    // 只靠 req.setTimeout 是不够的：它按「socket 空闲」计时，连接阶段双栈
    // 会各等一轮，用户设 2500ms 实际要等 5000ms，报错里写「等待上限 2500ms」就对不上了。
    // 这里再加一个从发出请求起算的整体硬截止，超时文案和真实等待才能对齐。
    let settled = false;
    let deadline = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    let u;
    try {
      u = new URL(targetUrl);
    } catch {
      settled = true;
      resolve({ ok: false, error: `地址不合法：${targetUrl}` });
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const flat = [];
    for (const [n, v] of headers) flat.push(n, v);
    if (!headers.some(([n]) => String(n).toLowerCase() === 'host')) flat.push('Host', u.host);
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: flat,
        ...(family ? { family } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => finish({ ok: false, error: e?.message ?? String(e) }));
      }
    );
    deadline = setTimeout(() => req.destroy(Object.assign(new Error('超时'), { probeTimeout: true })), budgetMs);
    req.setTimeout(budgetMs, () => req.destroy(Object.assign(new Error('超时'), { probeTimeout: true })));
    // 把底层错误码（ECONNRESET / ETIMEDOUT / ENOTFOUND …）一起带出去：
    // 只回一句「超时」时，用户分不清是网关卡住、地址写错还是 DNS 不解析。
    //
    // timedOut 只认**我们自己的硬截止**（probeTimeout）。以前这里还额外匹配
    // /timeout|超时/i，把连接层的 ETIMEDOUT 也算了进去 —— 于是出现「只等了 10 秒，
    // 却说等待上限 20 秒」这种自相矛盾的提示：其实是连接在 10 秒时被上游掐断
    // （ETIMEDOUT / ECONNRESET），根本不是等满了预算。两者必须分开报。
    req.on('error', (e) => finish({
      ok: false,
      error: e?.message ?? String(e),
      code: e?.code ?? '',
      timedOut: e?.probeTimeout === true,
    }));
    req.end();
  });

  const startedAt = Date.now();
  const first = await attempt(null, timeoutMs);
  if (first.ok || first.status) return first;
  // 只有「域名」才值得重试：IP 字面量（127.0.0.1、[::1]）没有第二条路可换。
  let hostname = '';
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return first;
  }
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  if (isIpLiteral) return first;
  // 两次尝试共用同一份预算：剩下的不够 1s 就不再重试，否则「等待上限 N ms」会变成谎话。
  const left = timeoutMs - (Date.now() - startedAt);
  if (left < 1000) return first;
  // 首次没拿到任何 HTTP 状态 → 不钉地址族再试一次，让 happy-eyeballs 重新选。
  // （0.3.11 及以前这里钉死 family:4，实测本机 IPv4 恰恰不可达，等于白等一轮。）
  const retry = await attempt(null, left);
  if (retry.ok || retry.status) {
    return { ...retry, note: '首次连接失败，已自动重试成功' };
  }
  // 两次都没通：错误文案要带「重试也失败」，别让人以为只发了一次请求。
  // timedOut 取两次的或：只要有一轮是真的等满了预算，就该按超时报。
  return {
    ...first,
    error: first.error === retry.error ? first.error : `${first.error}（自动重试也失败：${retry.error}）`,
    code: retry.code || first.code,
    timedOut: first.timedOut === true || retry.timedOut === true,
    triedFamilies: true,
  };
}

/**
 * 「保存并检查」用的轻量探活：GET {base}/models。
 * 用原生 request 是因为这里也要走用户自己的请求头模板 —— 有的中转服务只认自定义头。
 */
export async function fetchModelList(cfg, { timeoutMs = 20000 } = {}) {
  const modelsUrl = deriveModelsUrl(cfg.baseUrl);
  const vars = buildVars(cfg, { text: '', style: '', design: '' });
  const headerParsed = parseHeaderTemplate(cfg.headerTemplate, vars);
  const startedAt = Date.now();
  const result = await probeGet(modelsUrl, headerParsed.headers, timeoutMs);
  if (!result.ok) {
    return { ok: false, url: modelsUrl, status: result.status ?? null, code: result.code ?? '', timedOut: result.timedOut === true, triedFamilies: result.triedFamilies === true, error: result.error || summarizeHttpError(result.body), raw: String(result.body ?? '').slice(0, 400), elapsedMs: Date.now() - startedAt };
  }
  let ids = [];
  try {
    const parsed = JSON.parse(result.body);
    // 三种常见形状：OpenAI 的 {data:[{id}]}、{models:[...]}、以及 Breeze/ElevenLabs 的顶层数组
    // [{model_id,name,description,languages}]（见 /v1/models）。顶层数组必须单独认，否则只会得到空列表。
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.data) ? parsed.data
        : Array.isArray(parsed?.models) ? parsed.models : [];
    ids = arr.map((x) => (typeof x === 'string' ? x : x?.id ?? x?.model_id ?? x?.name)).filter(Boolean).map(String);
  } catch {
    return { ok: false, url: modelsUrl, status: result.status, error: 'models 返回的不是合法 JSON', raw: result.body.slice(0, 400), elapsedMs: Date.now() - startedAt };
  }
  return { ok: true, url: modelsUrl, status: result.status, models: ids, elapsedMs: Date.now() - startedAt, note: result.note ?? '' };
}

/**
 * 拉 Breeze / ElevenLabs 的音色列表：GET {base}/voices。
 *
 * 返回顶层数组 [{voice_id, name, labels:{accent,gender,age,…}, category}]；音色 id 要拼进
 * 合成 URL 的路径里，所以这里顺手整理成控制台下拉能直接用的 {id,name,lang,note}。
 */
export async function fetchVoiceList(cfg, { timeoutMs = 20000 } = {}) {
  const voicesUrl = breezeVoicesUrl(cfg);
  const vars = buildVars(cfg, { text: '', style: '', design: '' });
  const headerParsed = parseHeaderTemplate(cfg.headerTemplate, vars);
  const startedAt = Date.now();
  const result = await probeGet(voicesUrl, headerParsed.headers, timeoutMs);
  if (!result.ok) {
    return { ok: false, url: voicesUrl, status: result.status ?? null, code: result.code ?? '', timedOut: result.timedOut === true, triedFamilies: result.triedFamilies === true, error: result.error || summarizeHttpError(result.body), raw: String(result.body ?? '').slice(0, 400), elapsedMs: Date.now() - startedAt };
  }
  let voices = [];
  try {
    const parsed = JSON.parse(result.body);
    const arr = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.voices) ? parsed.voices
        : Array.isArray(parsed?.data) ? parsed.data : [];
    voices = arr.map((v) => {
      const id = String(v?.voice_id ?? v?.id ?? v?.voice ?? '').trim();
      if (!id) return null;
      const labels = v?.labels && typeof v.labels === 'object' ? v.labels : {};
      const extra = [labels.accent, labels.gender, labels.age].filter(Boolean).join('·');
      return {
        id,
        name: String(v?.name ?? v?.label ?? id).trim() || id,
        lang: String(v?.lang ?? labels.language ?? '').trim(),
        note: [v?.category, extra].filter(Boolean).join(' · ')
      };
    }).filter(Boolean);
  } catch {
    return { ok: false, url: voicesUrl, status: result.status, error: 'voices 返回的不是合法 JSON', raw: result.body.slice(0, 400), elapsedMs: Date.now() - startedAt };
  }
  return { ok: true, url: voicesUrl, status: result.status, voices, elapsedMs: Date.now() - startedAt, note: result.note ?? '' };
}

/**
 * 上游在 400 的 param 字段里点名了具体参数时，翻译成「用户下一步该改什么」。
 *
 * 小米实测的原文：
 *   audio.voice must be a DataURL for voice clone model
 *   audio.voice must not be empty for voice clone model
 *   invalid audio format, only mp3/flac/m4a/wav/ogg are supported
 * 这些都不是「模板拼错」，笼统地让用户去查模板只会把人带偏。
 */
function paramHintFor(param, cfg) {
  const p = String(param ?? '').toLowerCase()
  if (!p) return ''
  if (p.includes('audio.voice') && (p.includes('dataurl') || p.includes('clone'))) {
    return 'audio.voice 与模型不匹配：克隆模型（voiceclone）的 voice 必须是参考音频的 DataURL，'
      + '不能在克隆模式下传预设音色名。请切到「克隆音色」模式并上传参考音频，或在音色卡上改用预置模型试听'
  }
  if (p.includes('audio.voice') && p.includes('empty')) {
    return cfg.mode === 'clone'
      ? '克隆模型的 audio.voice 不能为空：当前是克隆模式，但没读到参考音频。请在「克隆音色」里上传一段 mp3 / wav'
      : 'audio.voice 为空：填一个音色（预设音色 id，或克隆模式下的参考音频）'
  }
  if (p.includes('audio.format')) {
    return 'audio.format 不受支持：只认 mp3 / flac / m4a / wav / ogg'
  }
  if (p.includes('audio')) return `上游指出问题出在 ${param}：检查模板里的音频参数`
  return ''
}

function summarizeHttpError(body) {
  try {
    const j = JSON.parse(body);
    return j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.message || 'HTTP 错误';
  } catch {
    return String(body ?? '').slice(0, 200) || 'HTTP 错误';
  }
}

/**
 * 控制台克隆上传用的 JSON body 读取。
 *
 * 为什么不用 bridge.js 里的 readBody：那个函数上限 1 MB，而克隆参考音频 Base64 后
 * 上限是 10 MB（官方限制），1 MB 会直接把正常样本拒掉。CSRF 又强制 application/json，
 * 所以 multipart 不可用 —— 只能走 JSON + base64 这一条路。
 */
export function readJsonBodyLarge(req, { maxBytes = 16 * 1024 * 1024, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(Object.assign(new Error(`请求体过大（${(declared / 1024 / 1024).toFixed(2)} MB，上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）`), { statusCode: 413 }));
      return;
    }
    const chunks = [];
    let total = 0;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      req.destroy();
      reject(Object.assign(new Error('请求体读取超时'), { statusCode: 408 }));
    }, timeoutMs);
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        clearTimeout(timer);
        req.destroy();
        reject(Object.assign(new Error(`请求体过大（上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）`), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(`请求体读取失败：${error?.message ?? error}`), { statusCode: 400 }));
    });
    req.on('aborted', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(Object.assign(new Error('请求体读取中断'), { statusCode: 400 }));
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(Object.assign(new Error('请求体必须是合法 JSON'), { statusCode: 400 }));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(Object.assign(new Error('请求体必须是 JSON 对象'), { statusCode: 400 }));
        return;
      }
      resolve(parsed);
    });
  });
}

/**
 * 参考音频的时长：优先用配置里记的，缺项就从落盘文件现量一遍。
 *
 * 老版本上传的参考音频没记过时长，如果只信配置，警告对它们永远不触发 ——
 * 而「已经传了一段 3 秒的音频」恰恰是最需要提示的场景。量一次不贵（读一个 140KB 文件）。
 * 只记了总时长、没记有效语音时也要补量：判「够不够长」看的是有效语音。
 */
function refDurationsOf(info, recordedSeconds, recordedSpeech) {
  if (recordedSeconds > 0 && recordedSpeech > 0) {
    return { seconds: recordedSeconds, speechSeconds: recordedSpeech };
  }
  if (!info?.path) return { seconds: recordedSeconds, speechSeconds: recordedSpeech };
  try {
    const measured = measureWavSpeech(fs.readFileSync(info.path));
    if (!measured) return { seconds: recordedSeconds, speechSeconds: recordedSpeech };
    return { seconds: measured.seconds, speechSeconds: measured.speechSeconds };
  } catch {
    return { seconds: recordedSeconds, speechSeconds: recordedSpeech };
  }
}

/** 控制台展示用：把当前生效的模板与派生信息一次性打包（不包含明文密钥）。 */
export function describeTtsConfig(cfg) {
  const cloneInfo = cloneAudioInfo(cfg);
  const singRefInfo = refAudioInfo(cfg, 'sing');
  const cloneDur = refDurationsOf(cloneInfo, cfg.clone?.seconds ?? 0, cfg.clone?.speechSeconds ?? 0);
  const singDur = refDurationsOf(singRefInfo, cfg.singRef?.seconds ?? 0, cfg.singRef?.speechSeconds ?? 0);
  return {
    enabled: cfg.enabled,
    aiEnabled: cfg.aiEnabled,
    // 下面这组「顶层」字段固定代表小米 MiMo 那一份，**不随 apiStyle 切换** —— Breeze 有自己的
    // breeze 子对象。早先这里用 cfg.baseUrl / cfg.model（apiStyle=breeze 时取的是 Breeze 的值），
    // 结果是控制台小米面板显示出 Breeze 的地址/模型/密钥，一保存就把两套配置搅在一起。
    baseUrl: cfg.mimo.baseUrl,
    modelsUrl: safeDerive(cfg.mimo.baseUrl),
    apiKeySet: Boolean(cfg.mimo.apiKey),
    apiKeyHint: redactSecret(cfg.mimo.apiKey),
    // 合成协议：openai（chat/completions）还是 breeze（ElevenLabs 风格，音色 id 在 URL 上）。
    apiStyle: cfg.apiStyle,
    apiStyles: API_STYLES,
    // 调用优先级：真正决定合成走哪一套的是它（apiStyle 只表示控制台当前在编辑哪一套）。
    routeMode: cfg.routeMode,
    routeModes: ROUTE_MODES,
    // routeMode='smart' 时的两条分界：字数 >= lengthThreshold 或 估算时长 >= durationThreshold 走小米，
    // 都不到才按合成延迟挑更快的一边。估算按 ESTIMATE_CHARS_PER_SECOND 字/秒。
    lengthThreshold: cfg.lengthThreshold,
    durationThreshold: cfg.durationThreshold,
    routeEstimate: { charsPerSecond: ESTIMATE_CHARS_PER_SECOND },
    // 这一刻真的会走哪一套（routeMode 为空时跟随 apiStyle；smart 时这里按「空文本」估算，
    // 即短文本那一侧 → 按延迟；实际以每次合成时的字数/估算时长决定）。
    routeModeEffective: resolveRouteStyle(cfg, {}),
    // 两套协议各自的内置默认模板：控制台「重置为内置默认」按钮用它填输入框。
    // （以前切协议时会自动换模板，现在两套面板各存各的，不再跨协议覆盖。）
    styleDefaults: {
      openai: { headerTemplate: DEFAULT_HEADER_TEMPLATE, bodyTemplate: DEFAULT_BODY_TEMPLATE },
      breeze: { headerTemplate: DEFAULT_HEADER_TEMPLATE_BREEZE, bodyTemplate: DEFAULT_BODY_TEMPLATE_BREEZE }
    },
    voiceSettings: cfg.voiceSettings,
    // 另一套协议（Breeze）的独立配置：前端用它填 Breeze 面板，与 MiMo 那份互不影响。
    breeze: {
      baseUrl: cfg.breeze.baseUrl,
      apiKeySet: Boolean(cfg.breeze.apiKey),
      apiKeyHint: redactSecret(cfg.breeze.apiKey),
      model: cfg.breeze.model,
      models: cfg.breeze.models,
      voices: cfg.breeze.voices,
      voice: cfg.breeze.voice,
      format: cfg.breeze.format,
      voiceSettings: cfg.breeze.voiceSettings,
      headerTemplate: cfg.breeze.headerTemplate,
      bodyTemplate: cfg.breeze.bodyTemplate
    },
    // 小米那套的原始视图（不受 apiStyle 影响）：优先级面板用它核对两边是否配好。
    mimo: {
      baseUrl: cfg.mimo.baseUrl,
      apiKeySet: Boolean(cfg.mimo.apiKey),
      apiKeyHint: redactSecret(cfg.mimo.apiKey),
      model: cfg.mimo.model,
      mode: cfg.mimo.mode,
      format: cfg.mimo.format,
      voice: cfg.mimo.voice
    },
    // 两边「最近一次成功合成」的平均耗时：auto 模式就是按它选更快的一边。
    latency: readRouteLatency(cfg.rootDir),
    // 两边各自的配置是否齐全（缺一个就谈不上「两边都设置 API」）。
    routeReady: {
      mimo: isStyleConfigured(cfg, 'mimo'),
      breeze: isStyleConfigured(cfg, 'breeze')
    },
    // routeReady 的明细：控制台据 missing 说清「到底缺 Key 还是缺模型」，
    // 不要一律显示成「还没填 Key」。
    routeReadyDetail: {
      mimo: styleReadiness(cfg, 'mimo'),
      breeze: styleReadiness(cfg, 'breeze')
    },
    // 同理：模型 / 音色 / 格式也都是小米那份的值，Breeze 的在上面的 breeze 子对象里。
    voiceHint: '这里是小米 MiMo 的音色名（如 冰糖 / 茉莉 / mimo_default）；Breeze 的音色在上面 Breeze 面板里选。',
    model: cfg.mimo.model,
    models: cfg.mimo.models,
    mode: cfg.mimo.mode,
    voice: cfg.mimo.voice,
    format: cfg.mimo.format,
    style: cfg.style,
    styleMode: cfg.styleMode,
    // 唱歌风格（与 style 分开，互不影响）；没配置时就是「唱歌」。
    singStyle: cfg.singStyle,
    design: cfg.design,
    prompt: cfg.prompt,
    // 模板同理：顶层这份是小米的，Breeze 的模板在 breeze.headerTemplate / bodyTemplate 里。
    headerTemplate: cfg.mimo.headerTemplate,
    bodyTemplate: cfg.mimo.bodyTemplate,
    variants: cfg.variants,
    // 内置默认模板（原封不动的出厂版）：供控制台「恢复默认」与未知模型回退用。
    // 不放进 config.json，永远来自代码，所以重置一定拿得到干净的一份。
    builtinTemplates: defaultVariants(),
    presetVoices: cfg.presetVoices,
    stylePresets: STYLE_PRESETS,
    officialModels: OFFICIAL_MODELS,
    clone: {
      fileName: cloneInfo?.fileName ?? '',
      bytes: cloneInfo?.bytes ?? 0,
      mimeType: cloneInfo?.mimeType ?? '',
      savedAt: cloneInfo?.savedAt ?? 0,
      // 总时长 / 有效语音时长（配置里记的优先，没有就从落盘文件现量）。
      seconds: cloneDur.seconds,
      speechSeconds: cloneDur.speechSeconds,
      // 有效语音太短时给出结论，让面板能一直挂着提示，而不是只在上传那一秒闪一下。
      tooShort: cloneDur.speechSeconds > 0 && cloneDur.speechSeconds < REF_MIN_SPEECH_SECONDS,
      ready: Boolean(cloneInfo),
      // 参考音频是「非临时」素材：换下来的旧文件全部归档在 backup/，不会被清理逻辑删。
      protected: true,
      backups: listCloneBackups(cfg)
    },
    // 唱歌参考音频：只作「歌词 / 音调 / 声调 / 旋律」素材参考，独立一份、独立目录、独立 backup/。
    // 它**不参与音色克隆**——唱歌的音色永远取上面那份说话音色参考。
    singRef: {
      fileName: singRefInfo?.fileName ?? '',
      bytes: singRefInfo?.bytes ?? 0,
      mimeType: singRefInfo?.mimeType ?? '',
      savedAt: singRefInfo?.savedAt ?? 0,
      seconds: singDur.seconds,
      speechSeconds: singDur.speechSeconds,
      ready: Boolean(singRefInfo),
      // 明确告诉界面：这份素材不进 audio.voice，别把它当成「唱歌音色」。
      usedForVoice: false,
      note: '唱歌参考只作歌词 / 音调 / 声调 / 旋律的素材参考，不会被写进 audio.voice；唱歌的音色始终来自说话音色参考。',
      protected: true,
      backups: listRefBackups(cfg, 'sing')
    },
    // 两份参考音频分别存在哪儿、各自的标识，一并交给界面，省得前端硬编码目录名。
    refLayout: {
      kinds: REF_KINDS,
      clone: { label: '说话音色', dir: path.resolve(cfg.cloneDir), backupDir: cloneBackupDir(path.resolve(cfg.cloneDir)) },
      sing: { label: '唱歌', dir: path.resolve(cfg.singRefDir), backupDir: cloneBackupDir(path.resolve(cfg.singRefDir)) },
      note: '两份参考音频完全分开：说话音色是合成时唯一的音色来源（念白与唱歌都用它），唱歌参考只当歌词 / 音调 / 声调 / 旋律的素材参考、不会写进 audio.voice；换任一份都不会覆盖另一份。'
    },
    timeoutMs: cfg.timeoutMs,
    maxChars: cfg.maxChars,
    autoSendVoice: cfg.autoSendVoice,
    modelLabels: cfg.modelLabels,
    cloneLimits: { allowedExt: CLONE_ALLOWED_EXT, maxBase64Bytes: CLONE_MAX_BASE64_BYTES },
    // 唱歌是官方风格词的特殊用法：必须 inline 独占；这里把规则一并交给界面，省得各处硬编码。
    singing: {
      style: SINGING_STYLE,
      singStyle: cfg.singStyle,
      tag: SINGING_TAG,
      timeoutMs: Math.max(cfg.timeoutMs, SINGING_TIMEOUT_MS),
      attempts: cfg.singAttempts,
      note: '唱歌用独立的「唱歌风格」（默认「唱歌」，与说话风格互不影响）；里面必须含「唱歌」才会真的唱。唱歌必须写在文本开头且不能与其它风格混用；请求头/请求体模板需用 {{SPEECH}}（含标签）才会真的唱，用 {{TEXT}} 只是念白。上游唱歌是概率性的（同一句词有时只念白），代码会按音频时长判定并自动重试，最多 singAttempts 次。'
    }
  };
}

function safeDerive(baseUrl) {
  try {
    return deriveModelsUrl(baseUrl);
  } catch {
    return '';
  }
}

/** 依据模板 + 变量生成等价 curl 文本（密钥脱敏），显示在控制台方便排查。 */
export function describeAsCurl(cfg, { text = '', style = null, design = null, prompt = null, voiceOverride = null, sing = false } = {}) {
  const vars = buildVars(cfg, { text, style, design, prompt, voiceOverride, sing });
  const headerParsed = parseHeaderTemplate(cfg.headerTemplate, vars);
  const bodyParsed = renderTemplate(cfg.bodyTemplate, vars);
  const lines = [`curl -X POST '${cfg.baseUrl}'`];
  for (const [name, value] of headerParsed.headers) {
    const shown = isSecretHeader(name) ? redactSecret(value) : value;
    lines.push(`  -H '${name}: ${shown}'`);
  }
  // 克隆模式下的 data URI 极长，展示时截断，避免撑爆界面。
  const bodyShown = bodyParsed.text.replace(/data:audio\/[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]{200,}/gi, (m) => `${m.slice(0, 60)}…（已截断，共 ${m.length} 字节）`);
  lines.push(`  --data-binary @- <<'EOF'`);
  lines.push(bodyShown);
  lines.push('EOF');
  return lines.join('\n');
}
