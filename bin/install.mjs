#!/usr/bin/env node
// dsh-plugin-tts 的安装 / 打包助手（不依赖任何 npm 包）。
//
//   node bin/install.mjs            打印安装指引 + 本机环境探测
//   node bin/install.mjs --check    校验插件包完整性（语法 / 元数据 / 必需文件）
//   node bin/install.mjs --pack     打 zip 到桌面（或 --pack <目录>）
//
// 安装动作本身由 DSH 的 plugin_manager 完成（GUI 插件管理或让 agent 执行 install_bundle），
// 这里只负责「校验 + 打包 + 告诉你在哪一步点哪个按钮」，避免脚本去手改 profile。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const REQUIRED = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'lib/tts-lib.js',
  'lib/voice-core.js',
  'lib/config.js',
  'lib/onebot.js',
  'lib/speak.js',
  'lib/routes.js',
  'lib/tools.js',
  'lib/lyrics.js',
  'lib/logger.js',
  'locale/zh.json',
  'locale/en.json',
  'icon.svg',
  'README.md',
]

function home() {
  return path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}

function line(text = '') {
  console.log(text)
}

function countFiles(dir) {
  let total = 0
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    total += item.isDirectory() ? countFiles(path.join(dir, item.name)) : 1
  }
  return total
}

function check() {
  const problems = []
  for (const rel of REQUIRED) {
    if (!fs.existsSync(path.join(root, rel))) problems.push(`缺少文件：${rel}`)
  }
  const pkgPath = path.join(root, 'package.json')
  let meta = null
  try {
    meta = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    problems.push(`package.json 不是合法 JSON：${error.message}`)
  }
  if (meta) {
    if (meta.name !== 'dsh-plugin-tts') problems.push(`package name 应为 dsh-plugin-tts，实际 ${meta.name}`)
    const patch = meta?.dsh?.bundle?.patch
    if (patch !== './cordis.patch.yml') problems.push('package.json 缺少 dsh.bundle.patch')
    if (meta?.dsh?.client?.platform !== 'web') problems.push('package.json 缺少 dsh.client.platform=web')
    if (!meta.exports?.['.']) problems.push('package.json 缺少 exports["."]')
    if (!meta.exports?.['./client']) problems.push('package.json 缺少 exports["./client"]')
    for (const rel of meta.files ?? []) {
      if (!fs.existsSync(path.join(root, rel))) problems.push(`files 里列了不存在的路径：${rel}`)
    }
  }
  const patchFile = path.join(root, 'cordis.patch.yml')
  if (fs.existsSync(patchFile)) {
    const text = fs.readFileSync(patchFile, 'utf8')
    if (!/insert:/.test(text) || !/dsh-tts/.test(text)) problems.push('cordis.patch.yml 缺少 insert / dsh-tts 条目')
  }
  for (const rel of ['locale/zh.json', 'locale/en.json']) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
      if (!value?.meta?.title) problems.push(`${rel} 缺少 meta.title`)
    } catch (error) {
      problems.push(`${rel} 不是合法 JSON：${error.message}`)
    }
  }
  const indexText = fs.existsSync(path.join(root, 'index.js')) ? fs.readFileSync(path.join(root, 'index.js'), 'utf8') : ''
  if (!/export function apply\s*\(/.test(indexText)) problems.push('index.js 缺少 export function apply(ctx, config)')
  const clientText = fs.existsSync(path.join(root, 'client.js')) ? fs.readFileSync(path.join(root, 'client.js'), 'utf8') : ''
  if (!clientText.includes('__ModuleLoader__.load')) problems.push('client.js 没有注册 __ModuleLoader__ 工厂')
  if (!clientText.includes('settings.section')) problems.push('client.js 没有挂到设置页 settings.section')
  if (clientText.includes('conversation.composer.dock')) problems.push('client.js 仍挂在聊天框 composer dock 上')

  // 语法检查：lib/*.js + index.js 用 node --check；client.js 是浏览器代码（有 window），也要过语法。
  const jsFiles = fs.readdirSync(path.join(root, 'lib'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(root, 'lib', name))
    .concat([path.join(root, 'index.js'), path.join(root, 'client.js')])
  for (const file of jsFiles) {
    const rel = path.relative(root, file)
    let result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    // 有些受限环境（例如禁止打开命名管道的沙箱）会让「捕获子进程输出」直接失败：
    // result.status 为 null、result.stderr 为 undefined，error.code 是 EPERM。
    // 以前这里直接 .trim() 会崩在自检脚本自己身上，报一个和插件无关的 TypeError。
    // 这类环境下退回「只看退出码、不捕获输出」的方式，语法检查仍然有效。
    if (result.error && (result.error.code === 'EPERM' || result.error.code === 'EACCES')) {
      result = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' })
      if (result.error) {
        problems.push(`语法检查未能执行：${rel}（${result.error.code || result.error.message}）`)
        continue
      }
      if (result.status !== 0) problems.push(`语法错误：${rel}（该环境下无法捕获详细报错，请手动运行 node --check ${rel}）`)
      continue
    }
    if (result.error) {
      problems.push(`语法检查未能执行：${rel}（${result.error.code || result.error.message}）`)
      continue
    }
    if (result.status !== 0) problems.push(`语法错误：${rel}\n${String(result.stderr || '').trim()}`)
  }

  // 反向检查：files 白名单之外的条目不会被打进包（--pack 已按白名单拷贝），
  // 但它们说明工作区里有不该发布的东西。只提示、不判失败 —— 开发中间态本来就会有。
  // 没有这一层时，「该有的在不在」永远是绿的，多出来的日志/备份/临时文件没人说话。
  const listed = Array.isArray(meta?.files) ? meta.files.map((rel) => String(rel).replace(/\\/g, '/').replace(/\/+$/, '')) : []
  const covered = (rel) => listed.some((entry) => rel === entry || rel.startsWith(`${entry}/`))
  const extra = []
  const walk = (dir, prefix) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) {
        if (item.name === 'node_modules' || item.name === '.git') continue
        walk(path.join(dir, item.name), rel)
        continue
      }
      if (rel === 'package.json' || covered(rel)) continue
      extra.push(rel)
    }
  }
  walk(root, '')

  line(`插件包：${root}`)
  line(`版本：${pkg.version}  名称：${pkg.name}`)
  if (extra.length) {
    line(`提示：${extra.length} 个条目不在 files 白名单里，不会被打进包：`)
    for (const rel of extra.slice(0, 10)) line(`  - ${rel}`)
    if (extra.length > 10) line(`  - …另有 ${extra.length - 10} 个`)
  }
  if (!problems.length) {
    line('校验通过：文件齐全、元数据完整、所有 JS 通过 node --check。')
    line('自测：node test/standalone.test.mjs && node test/render-smoke.mjs')
    return 0
  }
  line(`发现 ${problems.length} 个问题：`)
  for (const item of problems) line(`  - ${item}`)
  return 1
}

function printGuide() {
  line('dsh-plugin-tts — DeepSeek Harness 的 TTS 插件')
  line('')
  line(`DSH_HOME   ${home()}${fs.existsSync(home()) ? '（存在）' : '（不存在——先启动一次 DSH）'}`)
  line(`插件目录   ${root}`)
  line('')
  line('安装（选一种）：')
  line('  1) GUI：打开 DSH 设置 → 插件管理 → 从本地安装，选这个目录（或打好的 zip 解压后的目录）。')
  line('  2) 对话：对 DSH 说「安装本地插件包 <这个目录的绝对路径>」，由 plugin_manager install_bundle 完成。')
  line('  3) 校验：node bin/install.mjs --check')
  line('')
  line('安装后：')
  line('  · 打开 DSH 设置 → 「语音合成」，填 API Key / 试听 / 发语音。')
  line('  · AI 获得 tts_speak / tts_voices 两个工具；HTTP 接口挂在 /dsh-tts/*。')
  line('  · 数据目录：$DSH_HOME/dsh-tts/（config.json、voice/ 发送暂存、state/ 缓存与参考音频、dsh-tts.log）。')
  line('')
  line('打包：node bin/install.mjs --pack [输出目录，默认桌面]')
  return 0
}

function packExtra() {
  const arg = process.argv[3]
  const outDir = arg ? path.resolve(arg) : path.join(os.homedir(), 'Desktop')
  fs.mkdirSync(outDir, { recursive: true })
  const zipPath = path.join(outDir, `${pkg.name}-${pkg.version}.zip`)
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true })

  const staging = path.join(os.tmpdir(), `dsh-tts-pack-${Date.now()}`)
  const target = path.join(staging, pkg.name)
  fs.mkdirSync(target, { recursive: true })

  // 按 package.json 的 files 白名单拷贝（外加 package.json 本身——files 里通常不列它，
  // 但装插件必须有）。以前这里只按黑名单跳过 node_modules/.git/.tmp/*.zip，
  // 于是 *.log / *.bak / _probe* 这类残留会被静默打进发布包，而 --check 只查
  // 「该有的在不在」，两边都拦不住 —— 干净度就只剩人眼那一道。
  const listed = Array.isArray(pkg.files) ? pkg.files : []
  if (!listed.length) {
    line('打包中止：package.json 没有 files 白名单，无法保证包里没有残留。')
    fs.rmSync(staging, { recursive: true, force: true })
    return 1
  }
  const missing = []
  const copy = (rel) => {
    const from = path.join(root, rel)
    if (!fs.existsSync(from)) {
      missing.push(rel)
      return
    }
    fs.cpSync(from, path.join(target, rel), { recursive: true })
  }
  for (const rel of listed) copy(rel)
  if (!listed.includes('package.json')) copy('package.json')
  if (missing.length) {
    // 白名单写错的另一种表现：少打了文件，装上去才发现缺东西。
    line(`打包中止：files 里列了不存在的路径：${missing.join('、')}`)
    fs.rmSync(staging, { recursive: true, force: true })
    return 1
  }

  const ps = [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${target}' -DestinationPath '${zipPath}' -CompressionLevel Optimal`,
  ]
  const result = spawnSync(ps[0], ps.slice(1), { encoding: 'utf8' })
  const packed = countFiles(target)
  fs.rmSync(staging, { recursive: true, force: true })
  if (result.status !== 0) {
    line(`打包失败：${(result.stderr || result.stdout || '').trim()}`)
    return 1
  }
  const bytes = fs.statSync(zipPath).size
  line(`已打包：${zipPath}（${(bytes / 1024).toFixed(1)} KB，${packed} 个文件）`)
  line('把这个 zip 解压后，用插件管理器的「从本地安装」选择解压出来的 dsh-plugin-tts 目录。')
  return 0
}

if (process.argv.includes('--check')) {
  process.exitCode = check()
} else if (process.argv.includes('--pack')) {
  process.exitCode = packExtra()
} else {
  printGuide()
}
