// 轻量日志：内存 ring buffer（给 UI 看最近 100 条）+ 追加文件（排查历史问题）。
import fs from 'node:fs'
import path from 'node:path'

const LIMIT = 100

export function createLogger(file) {
  const entries = []
  const push = (kind, message) => {
    const item = { at: Date.now(), kind, message: String(message) }
    entries.push(item)
    if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${new Date(item.at).toISOString()} [${kind}] ${item.message}\n`, 'utf8')
    } catch {}
  }
  return {
    info(message) {
      push('info', message)
    },
    warn(message) {
      push('warn', message)
    },
    error(message) {
      push('error', message)
    },
    list() {
      return entries.slice()
    },
  }
}
