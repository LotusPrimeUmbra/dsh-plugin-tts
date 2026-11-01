// TTS 插件的配置存储。
//
// 落盘位置：$DSH_HOME/dsh-tts/config.json
//   {
//     "tts":     { ...与 qq-bridge config.json 的 tts 段同构，直接由 tts-lib 的 ttsCfg() 解释... },
//     "onebot":  { "httpUrl": "", "accessToken": "" },
//     "voice":   { ...发语音的限流/音量/缓存设置... },
//     "importedFrom": "", "importedAt": 0
//   }
//
// 为什么不用 ctx.settings：TTS 的配置项太多（模板 / 变体 / 参考音频元信息 / 双协议），
// 塞进 settings schema 会让 cordis.patch.yml 膨胀到不可读，而且参考音频是「运行时上传」的
// 二进制素材，本来就必须落在磁盘上。用插件自己的 JSON 文件最省事，UI 通过 /config 读写。
//
// 兼容旧部署：首次启动（config.json 还不存在时）自动探测 qq-bridge 的 config.json，
// 把 tts / snowluma / socialV2.voice 三段搬过来 —— 这样已经配好 TTS 的机器装完插件即可用。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  DEFAULT_BASE_URL,
  DEFAULT_BREEZE_BASE_URL,
  DEFAULT_MODEL,
  OFFICIAL_MODELS,
  PRESET_VOICES,
} from './tts-lib.js'

export const PLUGIN_ID = 'dsh-tts'

/** 可被 cordis config 覆写的 home（默认 $DSH_HOME，再退到 ~/.dsh）。 */
export function resolveHome(config = {}) {
  return path.resolve(config.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}

export function dataDirOf(home) {
  return path.join(home, PLUGIN_ID)
}

export function configPathOf(home) {
  return path.join(dataDirOf(home), 'config.json')
}

/** 默认配置：开箱 enabled，但没 apiKey —— 真正能合成还差「填 Key / 从 QQ Bridge 导入」这一步。 */
export function defaultSettings() {
  return {
    tts: {
      enabled: true,
      aiEnabled: true,
      baseUrl: DEFAULT_BASE_URL,
      apiKey: '',
      apiStyle: 'openai',
      routeMode: '',
      model: DEFAULT_MODEL,
      models: OFFICIAL_MODELS.map((m) => m.id),
      mode: 'preset',
      voice: '冰糖',
      format: 'wav',
      style: '',
      styleMode: 'user',
      singStyle: '唱歌',
      design: '',
      prompt: '',
      headerTemplate: '',
      bodyTemplate: '',
      lengthThreshold: 100,
      durationThreshold: 20,
      timeoutMs: 180000,
      maxChars: 2000,
      singAttempts: 5,
      autoSendVoice: true,
      allowPrivateFetch: false,
      voiceSettings: {},
      breeze: {
        baseUrl: DEFAULT_BREEZE_BASE_URL,
        model: '',
        voice: '',
        format: 'wav',
        models: [],
        voices: [],
        voiceSettings: {},
        headerTemplate: '',
        bodyTemplate: '',
        apiKey: '',
      },
      variants: {},
      presetVoices: PRESET_VOICES,
      modelLabels: {},
      clone: {},
      singRef: {},
    },
    onebot: { httpUrl: '', accessToken: '' },
    voice: {
      dir: '',
      maxSeconds: 300,
      maxBytes: 20 * 1024 * 1024,
      maxPerMinute: 2,
      maxPerHour: 10,
      defaultVolume: 1,
      loudness: 'normal',
      autoReadback: true,
      // record 段 file 的发送形式：
      //   auto   = 本机网关用路径、远程网关自动改 base64（默认，无需配置）
      //   path   = 强制路径（仅当插件与 OneBot 同机）
      //   base64 = 强制内联（跨机想稳妥时用）
      fileMode: 'auto',
      ffmpegPath: '',
    },
    importedFrom: '',
    importedAt: 0,
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 递归合并：patch 里出现的键才覆盖；数组整体替换；null 会原样保留（用于清空参考音频）。 */
export function mergeSettings(base, patch) {
  if (Array.isArray(patch)) return patch
  if (!isPlainObject(patch)) return patch === undefined ? base : patch
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value)) out[key] = mergeSettings(isPlainObject(out[key]) ? out[key] : {}, value)
    else out[key] = value
  }
  return out
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

// 参考音频的目录名：kind → state 下的子目录
const REF_DIRS = { clone: 'tts-clone', sing: 'tts-sing-ref' }

/**
 * 把参考音频「搬进插件自己的数据目录」。
 *
 * 导入 qq-bridge 配置时元数据里的 path 指向 qq-bridge 的 state/tts-clone，
 * 如果只搬元数据不搬文件，插件会显示「有参考音频」，但一合成就是「克隆参考缺失」。
 * 这里负责复制文件 + 改写 path/backupDir；源文件已经不在的，直接把元数据清空，
 * 让 UI 老实显示「未上传」，而不是给出一个必错的音色。
 */
function localizeRefMeta(home, kind, meta, sourceConfigPath = '') {
  if (!isPlainObject(meta) || !meta.fileName) return { meta: meta ?? {}, changed: false }
  const targetDir = path.join(dataDirOf(home), 'state', REF_DIRS[kind])
  const candidates = []
  if (typeof meta.path === 'string' && meta.path) candidates.push(meta.path)
  if (sourceConfigPath) candidates.push(path.join(path.dirname(sourceConfigPath), 'state', REF_DIRS[kind], String(meta.fileName)))
  const from = candidates.find((item) => {
    try {
      return fs.statSync(item).isFile()
    } catch {
      return false
    }
  })
  if (!from) return { meta: {}, changed: true }
  fs.mkdirSync(targetDir, { recursive: true })
  const to = path.join(targetDir, String(meta.fileName))
  if (path.resolve(from) !== path.resolve(to) && !fs.existsSync(to)) {
    fs.copyFileSync(from, to)
    // 旧版本的备份一起搬过去，方便回滚；单个文件失败不影响主参考。
    const srcBackup = meta.backupDir || path.join(path.dirname(from), 'backup')
    const dstBackup = path.join(targetDir, 'backup')
    try {
      if (fs.existsSync(srcBackup)) {
        fs.mkdirSync(dstBackup, { recursive: true })
        for (const name of fs.readdirSync(srcBackup)) {
          const src = path.join(srcBackup, name)
          const dst = path.join(dstBackup, name)
          try {
            if (fs.statSync(src).isFile() && !fs.existsSync(dst)) fs.copyFileSync(src, dst)
          } catch {}
        }
      }
    } catch {}
  }
  const next = {
    ...meta,
    path: to,
    backupDir: path.join(targetDir, 'backup'),
    archived: Array.isArray(meta.archived) ? meta.archived : [],
  }
  return { meta: next, changed: path.resolve(from) !== path.resolve(to) }
}

/** 对一份完整 settings 做参考音频本地化；返回 { settings, changed }。 */
function localizeRefs(home, settings, sourceConfigPath = '') {
  let changed = false
  for (const [kind, key] of [['clone', 'clone'], ['sing', 'singRef']]) {
    const result = localizeRefMeta(home, kind, settings.tts?.[key], sourceConfigPath)
    if (result.changed) {
      settings.tts[key] = result.meta ?? {}
      changed = true
    }
  }
  return { settings, changed }
}

/** 探测可以导入 QQ Bridge TTS 配置的来源（不存在的直接跳过）。 */
export function importCandidates(home, extra = '') {
  const list = []
  if (extra) list.push(String(extra))
  if (process.env.DSH_TTS_IMPORT_FROM) list.push(process.env.DSH_TTS_IMPORT_FROM)
  list.push(path.join(home, 'qq-bridge', 'config.json'))
  list.push(path.join(home, 'dsh-qq-bridge', 'config.json'))
  // qq-bridge 的源码部署位置因人而异，不写死任何绝对路径：
  // 需要时用 DSH_TTS_IMPORT_FROM 指定（上面已收集），或在面板里手动导入。
  const seen = new Set()
  const out = []
  for (const item of list) {
    const resolved = path.resolve(String(item))
    if (seen.has(resolved)) continue
    seen.add(resolved)
    try {
      if (fs.statSync(resolved).isFile()) out.push(resolved)
    } catch {}
  }
  return out
}

/**
 * 把一份 qq-bridge config.json 投影成本插件的配置补丁。
 * 只搬 TTS 相关：tts 段、snowluma.httpUrl/accessToken（发 QQ 语音的 OneBot 通道）、socialV2.voice。
 */
export function buildImportPatch(source) {
  if (!isPlainObject(source)) return null
  const patch = {}
  if (isPlainObject(source.tts)) patch.tts = source.tts
  const snow = isPlainObject(source.snowluma) ? source.snowluma : {}
  const voice = isPlainObject(source.socialV2?.voice) ? source.socialV2.voice : null
  patch.onebot = {
    httpUrl: String(snow.httpUrl ?? ''),
    accessToken: String(snow.accessToken ?? ''),
  }
  if (voice) patch.voice = voice
  return Object.keys(patch).length ? patch : null
}

/** 读取当前设置；首次运行时创建文件（并尝试自动导入 qq-bridge 配置）。 */
export function readSettings(home, config = {}) {
  const file = configPathOf(home)
  const existing = fs.existsSync(file) ? readJsonFile(file) : null
  if (isPlainObject(existing)) {
    const settings = mergeSettings(defaultSettings(), existing)
    // 兼容旧部署：早期导入只搬了元数据、没搬参考音频，这里顺手把文件搬进插件目录。
    const fixed = localizeRefs(home, settings)
    if (fixed.changed) writeJsonAtomic(file, fixed.settings)
    return { settings: fixed.settings, created: false, file }
  }
  const base = defaultSettings()
  let importedFrom = ''
  let importedAt = 0
  try {
    const candidates = importCandidates(home, config.importFrom)
    for (const candidate of candidates) {
      const source = readJsonFile(candidate)
      const patch = buildImportPatch(source)
      if (!patch) continue
      const merged = mergeSettings(base, patch)
      localizeRefs(home, merged, candidate)
      importedFrom = candidate
      importedAt = Date.now()
      merged.importedFrom = importedFrom
      merged.importedAt = importedAt
      writeJsonAtomic(file, merged)
      return { settings: merged, created: true, importedFrom, file }
    }
  } catch {
    // 导入失败不该挡住插件启动：落一份默认配置继续。
  }
  writeJsonAtomic(file, base)
  return { settings: base, created: true, importedFrom, file }
}

/** 保存补丁（局部合并）。返回保存后的完整设置。 */
export function saveSettings(home, patch, config = {}) {
  const current = readSettings(home, config)
  const next = mergeSettings(current.settings, patch)
  writeJsonAtomic(configPathOf(home), next)
  return { settings: next, file: configPathOf(home) }
}

/** 手动从某个 qq-bridge 配置导入，返回 { settings, source }；找不到可用来源时抛错。 */
export function importFromQqBridge(home, sourcePath = '') {
  const candidates = importCandidates(home, sourcePath)
  if (sourcePath && !candidates.length) throw new Error(`找不到配置文件：${sourcePath}`)
  for (const candidate of candidates) {
    const source = readJsonFile(candidate)
    const patch = buildImportPatch(source)
    if (!patch) continue
    const current = readSettings(home)
    const merged = mergeSettings(current.settings, patch)
    localizeRefs(home, merged, candidate)
    merged.importedFrom = candidate
    merged.importedAt = Date.now()
    writeJsonAtomic(configPathOf(home), merged)
    return { settings: merged, source: candidate }
  }
  throw new Error(
    '没有找到可导入的 QQ Bridge 配置（找过 $DSH_HOME/qq-bridge/config.json 与已知源码部署位置）',
  )
}

/** 密钥脱敏（只用于展示，永远不要用它覆盖真实值）。 */
export function maskKey(value) {
  const text = String(value ?? '')
  if (!text) return ''
  if (text.length <= 10) return `${text.slice(0, 2)}****${text.slice(-2)}`
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}
