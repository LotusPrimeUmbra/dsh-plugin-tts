// dsh-tts — Host half.
//
// 把 qq-bridge 内嵌的 TTS 能力（小米 MiMo / Breeze 双协议、预设/音色设计/克隆三种模式、
// 唱歌、请求模板、参考音频、并发语音发送）剥出来，做成一个独立的 DSH 插件：
//
//   · 工具：tts_speak（合成 / 合成并发 QQ 语音）、tts_voices
//   · HTTP：/dsh-tts/*（配置、模型/音色探活、试听、克隆、发语音、日志）
//   · UI：  DSH 设置 → 「语音合成」独立一栏（settings.section）
//   · 数据：$DSH_HOME/dsh-tts/config.json（首次启动自动从 qq-bridge 配置导入）
import path from 'node:path'
import { dataDirOf, readSettings, resolveHome } from './lib/config.js'
import { createLogger } from './lib/logger.js'
import { makeTts } from './lib/speak.js'
import { registerRoutes } from './lib/routes.js'
import { registerTools } from './lib/tools.js'
import { pruneCacheOlder } from './lib/tts-lib.js'

/** tools 是硬依赖：没有它这个插件就没有对外能力。webServer 单独用 ctx.inject 等。 */
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const home = resolveHome(config)
  const logger = createLogger(path.join(dataDirOf(home), 'dsh-tts.log'))
  const getSettings = () => readSettings(home, config)

  // 首次启动：建配置（并尝试从 qq-bridge 导入）。失败只记日志，不阻止插件挂载。
  try {
    const { settings, importedFrom } = getSettings()
    logger.info(
      `TTS 插件已挂载：home=${home} enabled=${settings.tts.enabled} `
      + `model=${settings.tts.model} mode=${settings.tts.mode}`
      + (importedFrom ? ` 已从 ${importedFrom} 导入` : ''),
    )
  } catch (error) {
    logger.error(`读取配置失败：${error?.message ?? error}`)
  }

  const deps = { home, config, logger, getSettings }

  const disposeTools = registerTools(ctx, deps)
  ctx.effect(() => () => disposeTools(), 'dsh-tts: tools')

  ctx.inject(['webServer'], (scope) => registerRoutes(scope, deps))

  // 缓存兜底清理：每小时扫一次 state/tts-cache，避免进程重启丢定时器后旧音频长期残留。
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        pruneCacheOlder(makeTts(getSettings().settings, home))
      } catch {}
    }, 60 * 60 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-tts: cache prune')

  void ctx
}
