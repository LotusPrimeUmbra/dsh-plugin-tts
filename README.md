# dsh-plugin-tts

一个 **DeepSeek Harness 插件**，把 TTS 语音合成做进 DSH 里：小米 MiMo / Breeze 双协议、预设音色 / 音色设计 / 语音克隆、唱歌、自定义请求模板、参考音频管理，合成后可直接发 QQ 语音。

## 支持的模型与 API

本插件使用的小米 MiMo 模型和 Breeze（BreezeBlue）的模型——**只测试过这两个**，理论上小米模板兼容 OpenAI 协议的其他音色克隆模型。

请**自行到对应官网注册账号获取 API**，插件不自带 Key。

**Breeze 模型在官网克隆以后在插件中直接拉取音色**，因此 Breeze 模板没有上传参考文件克隆功能。

本插件语音发送**直接走本机（云服务器）的 OneBot HTTP 网关**（SnowLuma 默认 `http://127.0.0.1:3000`）。如果你想让通过桥接接入的 QQ 聊天 AI（大肥鱼、小鲸鱼）发送语音消息，可能需要在对应的 QQ 桥接（比如 qqbridge）白名单里手动加入调用工具 **`tts_speak`** 和 **`tts_voices`**（可让 AI 在新开会话的完全权限的工作区里面自己加。例：把 tts_speak 、tts_voices 加入 qqbridge 桥接白名单）。具体做法是装好插件后让你的【鱼】测试一下，测不通它会告诉你需要把哪些工具加入白名单。

> **本插件全程由 AI 制作，如有 BUG，自行用 AI 修复。**

装好之后你会得到三样东西：

| 面 | 内容 |
| --- | --- |
| **UI** | 设置页「语音合成」一栏：开关、调用优先级、小米 / Breeze 双协议面板、参考音频（说话音色 + 唱歌）、请求模板、试听、发 QQ 语音、通道探活、日志 |
| **AI 工具** | `tts_speak`（合成 / 合成并发 QQ 语音）、`tts_voices`（音色与通道状态） |
| **HTTP** | `/dsh-tts/*`：配置、模型/音色探活、试听、克隆参考音频、发语音、日志 |

---

## 安装

> 这一节面向**从 GitHub Release 下载 zip 的人**。如果你是把源码目录直接指给 DSH 的开发者，跳到[方式 B](#方式-b让-dsh-自己装)。

### 前提

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DeepSeek Harness | 已装好，能正常打开「设置」 | 插件是 profile 级的，装进哪个 profile 就对该 profile 全部会话生效 |
| Node.js | **≥ 22.19.0** | 用到较新的 ESM 与全局 `fetch`。DSH 自带运行时通常已满足，无需另装 |
| 磁盘 | 约 1 MB（插件本体） | 配置、参考音频、缓存另算，在 `$DSH_HOME/dsh-tts/` |
| ffmpeg | **可选** | 只有「音量归一」「参考音频转码规整」需要。没装会自动跳过，合成与克隆照样能用 |
| 网络 | 能访问小米 MiMo / Breeze 的 API 域名 | 插件本身不需要联网构建 |

插件**零 npm 依赖**：不需要 `npm install`，不需要 `pnpm`，不需要编译，解压即用。

### 方式 A：从 Release 的 zip 安装（推荐）

#### 第 1 步：下载并校验

从本仓库的 **Releases** 页面下载 `dsh-plugin-tts-0.4.2.zip`，然后核对完整性：

**Windows（PowerShell）**

```powershell
Get-FileHash .\dsh-plugin-tts-0.4.2.zip -Algorithm SHA256
```

**macOS / Linux**

```bash
shasum -a 256 dsh-plugin-tts-0.4.2.zip
```

和 **Release 说明里公布的 SHA256** 比对（每个 Release 都会公布对应产物的哈希）。不一致就**不要装**——重新下载一次；仍不一致说明包在传输中被改动过。

> 这里不写死哈希是有意为之：README 会随包一起被打进 zip，而写死哈希会让「改文档 → 哈希变 → 再改文档」变成死循环。哈希的唯一权威来源是 Release 页面。

#### 第 2 步：解压

解压后必须得到**这样的结构**：

```
dsh-plugin-tts/              ← 选这一层目录
├── package.json
├── index.js
├── client.js
├── lib/
├── bin/
├── locale/
├── test/
├── cordis.patch.yml
├── icon.svg
└── README.md
```

⚠️ **最常见的安装失败原因就是层级不对。** 以下两种都是错的：

```
❌ dsh-plugin-tts/dsh-plugin-tts/package.json     ← 多套了一层
❌ dsh-plugin-tts-0.4.2/package.json              ← 用版本号目录名（不影响，但别选错）
```

判断方法很简单：**`package.json` 必须和你选中的那个目录直接同级**。

#### 第 3 步：装进 DSH

1. 打开 DSH → **设置 → 插件管理**
2. 点 **「从本地安装」**
3. 选中**解压出来的 `dsh-plugin-tts` 目录**（不是 zip 文件本身，也不是它的父目录）
4. 等提示安装成功

#### 第 4 步：刷新并确认

**刷新页面**（这一步不能省，客户端插件要重新加载），然后打开 **设置 → 语音合成**。

| 检查项 | 预期结果 |
| --- | --- |
| 设置侧边栏出现「语音合成」 | ✅ 有 |
| 状态点颜色 | 灰 = 插件关 / 黄 = 开了但没填 Key / 绿 = 可以合成 |
| AI 工具可用 | 对 DSH 说「有哪些 TTS 音色」，它会调用 `tts_voices` 返回 9 个内置音色与通道状态 |
| HTTP 面挂上 | 见下方命令 |

HTTP 面自检（把端口换成你自己的 DSH 端口）：

```bash
curl http://127.0.0.1:6831/dsh-tts/state
```

返回 `{"ok":true,...}` 说明 Host 半边起来了。**这一步能过，插件就是装好了**——剩下的只是填 Key。

#### 第 5 步：填 Key

插件装好是「空配置」状态，**不会自带任何密钥**。至少填一套：

- **小米 MiMo**：`设置 → 语音合成 → 小米模板`，填 API Key
- **Breeze**：`设置 → 语音合成 → Breeze`，填 API Key

两套可以都填（启用 `routeMode=smart` 时按延迟自动选路），也可以只填一套。

### 方式 B：让 DSH 自己装

如果目录已经在本地（比如你自己 clone 了仓库），把绝对路径直接告诉 DSH：

```
安装本地插件包 D:\path\to\dsh-plugin-tts
```

DSH 会调用 `plugin_manager install_bundle` 完成同样的动作。macOS / Linux 同理，换成 `/Users/you/...` 或 `/home/you/...`。

### 方式 C：先校验再装

装之前想确认包没坏，在解压出来的 `dsh-plugin-tts/` 目录里跑：

```bash
node bin/install.mjs --check
```

它会检查：

- 必需文件是否齐全（`REQUIRED` 清单）
- `package.json` 元数据：`name` / `version` / `dsh.bundle.patch` / `dsh.client.platform` / `exports` / `files` 指向的路径是否真实存在
- `cordis.patch.yml` 的 `insert` 条目
- 两个 locale JSON 是否合法
- `index.js` 是否导出 `apply(ctx, config)`
- `client.js` 是否注册了 `__ModuleLoader__` 工厂、是否挂在 `settings.section`（而不是旧的聊天框 dock）
- **所有 JS 的 `node --check`**

看到这一行就可以放心装：

```
校验通过：文件齐全、元数据完整、所有 JS 通过 node --check。
```

### 升级

用新版本的目录重新安装一次，插件管理器会覆盖旧文件。**配置、Key、参考音频都在数据目录里，不受影响**：

```
$DSH_HOME/dsh-tts/
├── config.json          你的所有设置
├── dsh-tts.log          运行日志
└── state/
    ├── tts-clone/       克隆参考音频
    ├── tts-cache/       合成结果缓存
    └── tts-latency.json 智能选路的延迟样本
```

跨小版本升级通常不需要重新填 Key。如果新版本改了配置结构，插件会自动迁移并保留未知字段。

### 卸载

设置 → 插件管理 → 停用或移除。

- **停用**：立即生效，配置全留着，重新启用即恢复。
- **移除**：从 profile 里摘掉，但 `$DSH_HOME/dsh-tts/` 的数据**不会被删**。
- **连数据一起清**：手动删 `$DSH_HOME/dsh-tts/`。⚠️ **不可恢复**——里面有你的 API Key、参考音频和缓存。

Windows 上如果移除后 `node_modules` 里还留着 `dsh-plugin-tts` 的 junction（符号链接），可以手动删掉那个链接（删链接不影响源码目录）：

```powershell
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-plugin-tts"
```

### 装不上时

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 插件管理里提示「找不到 package.json」 | 选错了层级 | 回去看第 2 步，确保选中的目录里**直接**有 `package.json` |
| 装完设置里没有「语音合成」 | 没刷新页面，或 client 没加载 | 硬刷新（`Ctrl+F5`）；仍没有就看 DSH 控制台有没有 `__ModuleLoader__` 报错 |
| 状态点一直是黄色 | Key 没填或填错 | 在对应模板里重新填 Key，点「测试连接」 |
| `curl .../dsh-tts/state` 返回 404 | Host 半边没起来 | 重启 DSH；还不行就用 `node bin/install.mjs --check` 查包完整性 |
| 合成报 401 / 403 | Key 无效或没权限 | 去上游控制台确认 Key 有效、账户有余额 |
| 合成报 400 `Unknown voice: data:audio/...` | `mode` 与 `model` 不一致 | 在「合成模式」页签里重新选一次，两者会自动对齐 |
| 克隆音色每次都不一样 | 参考音频太短（有效语音 < 5 秒） | 重传 **10~30 秒**连续说话的录音；面板上会直接警告 |

### 数据与隐私

- **插件不联网收集任何数据。** 所有请求只发往你自己填的上游 TTS 接口。
- API Key 以明文存在 `$DSH_HOME/dsh-tts/config.json`，和 DSH 其它配置同级别保护。**不要把这个文件提交到仓库或发给别人。**
- 参考音频、合成缓存全部留在本机 `$DSH_HOME/dsh-tts/state/`。
- 日志 `dsh-tts.log` 只记时间、字数、耗时、路由和错误摘要，**不记 Key，也不记正文**。

### 安全边界

- 插件以 DSH 的 profile 权限运行，能读写 `$DSH_HOME/dsh-tts/`。
- OneBot 发送走你自己配置的 HTTP 网关，插件不会主动连接任何外部服务。
- `voicePolicy.allowAbsolutePath` 默认 **false**，即禁止读任意绝对路径的音频文件。


### 装不上时

| 现象 | 原因与处理 |
| --- | --- |
| 插件管理里看不到「语音合成」 | 装的是 zip 本身或选错了层级。要选**解压后含 `package.json` 的那层目录**，然后刷新页面 |
| `install_bundle` 报找不到 bundle | 目录层级不对，或 `cordis.patch.yml` 被改坏。跑 `node bin/install.mjs --check` 看具体哪项不合格 |
| 装好但面板空白 / 报错 | 浏览器控制台看 `client.js` 的加载错误；多为 DSH 版本过旧，`dsh.client.inject` 的 `@deepseek-ai/dsh-client-ui-conversation` 不可用 |
| 状态点一直是黄 | 只说明没填 API Key，不是装坏了。见下面的「首次配置」 |

---

## 首次配置

### 1. 设置页里填（推荐）

打开 **DSH 设置 → 语音合成**（侧边栏「设置」里的独立一栏）：

- **API Key**：小米 MiMo 的 key（`https://api.xiaomimimo.com`）。**填完点一下别处（失焦）即自动保存**，重新填写会覆盖旧值；结果就地显示在输入框下方，不用再点按钮。
- **OneBot HTTP**：你的 OneBot 网关地址，留空则兜底 `http://127.0.0.1:3000`。填了以你填的为准。
- **Access Token**：SnowLuma 的 OneBot HTTP token（不是 WS token）。留空 = 不改动。
- **模型 / 音色 / 格式 / 路由 / 风格词**：改完点对应的「保存」按钮（小米与 Breeze 各自保存）。
- 点「测试 OneBot」会真的 `get_login_info`，失败会给出端口提示。

### 2. 环境变量（可选）

| 变量 | 作用 |
| --- | --- |
| `DSH_HOME` | 数据根目录，默认 `~/.dsh`；配置落在 `$DSH_HOME/dsh-tts/config.json` |

也可以在 `cordis.patch.yml` 的 insert 条目里写 `config: { home: "D:/dsh-home" }` 覆盖数据根目录。

---

## 设置页怎么用

打开 **DSH 设置 → 语音合成**（侧边栏「设置」里的独立一栏）。页面顶部状态点：

- 灰 = 插件关闭（`tts.enabled=false`）
- 黄 = 打开但没填 API Key
- 绿 = 可以合成

摘要文字是「当前音色 · 当前模型」。下面按卡片分区：

| 区块 | 能做什么 |
| --- | --- |
| 开关 | 启用 TTS / 允许 AI 调用（关掉后 `tts_speak` 直接拒绝），改动即保存 |
| 调用优先级 | 只走 MiMo / 只走 Breeze / smart 智能三选一。**smart 的分界**：字数 ≥ 字数分界 或 估算时长（4 字/秒）≥ 时长分界 → 走小米；两个都没到 → 按最近成功合成的平均耗时自动选更快的一边。分界可自己设：字数 10~2000、时长 1~600 秒。AI 主动发起的语音同样走这套分界（`speak()` 与 `synthesize()` 共用 `resolveRouteStyle`）。保存后显示「当前生效」。**没就绪时会按缺项精确提示**：没填 Key → 「还没填 Key」；Key 已存只是没选模型 → 「Key 已保存，还缺模型」；缺接口地址 → 「还缺接口地址」 |
| 协议页签 | 小米 MiMo 与 Breeze 两套接口，各配各的 |
| 小米设置 | 接口地址、API Key（填完失焦即自动保存并覆盖旧值，结果就地显示在输入框下方；「保存配置并检查」不改 Key，只保存配置并报 Key 是否已生效）、模型下拉 + 拉取模型 + 手填 model id、格式 wav/mp3/pcm16/pcm、说话风格（分组预设 + 自定义 + 落位 user/inline）、唱歌风格、单次上限、模式页签（预置音色九张卡「试听/使用」、音色设计、克隆音色、自定义）、请求头/请求体模板（保存 / 恢复内置默认）；面板底部自带「试听（小米 MiMo）」与「保存小米配置并检查」，保存结果就显示在按钮下方 |
| Breeze 设置 | baseUrl、Key（同样失焦即自动保存，结果就地显示）、model_id / voice_id（下拉拉取 + 手填，**拉取音色后会自动把 voice_id 填成第一个音色**）、mp3/wav、引导强度 / 语速 / 音量（人声增强开关就在音量输入框右边同一行）、模板；面板底部自带「试听（Breeze）」与「保存 Breeze 配置并检查」，保存结果同样就近显示 |
| 试听 | 每个面板各有一块试听区：小米只带小米的接口/音色/风格，Breeze 只带 Breeze 的接口/音色，互不串用；可勾唱歌，合成后就地播放并附脱敏 curl |
| 发语音 | 填「要说的内容」（留空用默认一句问候）与目标 `group:群号` / `private:QQ号`，点按钮直接合成并发送，回读结果就地显示 |
| 通道 | OneBot HTTP、Access Token；测试 OneBot；从 QQ Bridge 导入 |
| 克隆 | 说话音色与唱歌参考分开，都放在「合成模式 → 克隆音色」里；**选好文件后点「选择文件」旁的「上传 / 替换」**，选多个 mp3/wav → 前端剪成 24kHz WAV（可去静音、自动找人声起点、指定起点与时长）→ 上传；支持从链接导入；备份目录可打开/清空 |
| 运行状态 | 配置/数据/缓存/参考目录、Key 提示、上限（秒数/体积/频率/字数）、日志 |

克隆说明：说话音色与唱歌参考分开存。**唱歌参考只提供音调/节奏参考，不改变音色**；换音色还是靠说话音色克隆（模型切到 `mimo-v2.5-tts-voiceclone` 后生效，克隆模式下 `voice` 参数被忽略）。

> Key 是两把：小米 Key 填在「小米 MiMo」面板，Breeze Key 填在「Breeze」面板，互不通用。只填一边时另一边在「调用优先级」里仍会提示未填 Key，这是正常的；填完要点各自面板底部的保存按钮。

---

## AI 工具

### `tts_speak`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string，必填 | 要念的文字，不要 Markdown/代码块 |
| `target` | string | `group:群号` 或 `private:QQ号`；省略 = 只合成不发送 |
| `style` | string | 风格词，如 `开心`、`东北话`、`悄悄话` |
| `voice` | string | 临时覆盖音色（预设模式用 id，如 `冰糖`、`苏打`） |
| `sing` | boolean | 唱歌。慢且上游概率性，失败可再调一次 |
| `label` | string | 写进发送结果的说明 |
| `verify` | boolean | 发送后是否 `get_msg` 回读确认，默认 true |
| `volume` | number | 本地音量 0.1~4，1=原样 |
| `normalize` | boolean | 响度归一（需要 ffmpeg） |

- 没有 `target`：返回 `{ok, route, sing, actuallySang, durationSec, attempts, bytes, mimeType, audioId, audioUrl: "/dsh-tts/audio?id=…"}`。
- 有 `target`：返回 `{ok, target, messageId, text, route, sing, actuallySang, durationSec, attempts, voice, bytes, mimeType, elapsedMs, verified, warnings}`。
- 唱歌时 `actuallySang !== true` 会返回 `stage:"sing"` 的失败（上游这次只念了没唱），再调一次通常就好。

### `tts_voices`

无参数，返回：`enabled / aiEnabled / apiKeySet / model / mode / format / maxChars / voices[9] / stylePresets / cloneReady / singing{style,tag,slowHint} / onebot{httpUrl,tokenSet,source} / hint`。

---

## HTTP 接口

全部挂在 DSH Web 同一个 server 上（`http://127.0.0.1:<port>/dsh-tts/…`）。非 GET 要求同源 + `content-type: application/json`，否则 403 / 415。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-tts/state` | 开关、Key 是否设置、模型/音色、OneBot 状态、日志尾部 |
| GET | `/dsh-tts/config` | 完整脱敏描述 + 数据目录 + 示例 curl |
| POST | `/dsh-tts/config` | 局部保存 `{tts, onebot, voice}`；`apiKey` 不带键=不改，空串=清空 |
| POST | `/dsh-tts/models` | 拉上游模型列表 |
| POST | `/dsh-tts/voices` | 拉上游音色列表 |
| POST | `/dsh-tts/preview` | 单边协议合成，返回 `audioId` |
| GET | `/dsh-tts/audio?id=…` | 播放缓存音频 |
| GET | `/dsh-tts/ref-audio?kind=clone\|sing` | 下载当前参考音频 |
| POST | `/dsh-tts/clone` | `{fileName, kind, dataBase64, overwrite}`；已有参考且没 `overwrite` → 409 |
| POST | `/dsh-tts/clear-ref` | `{kind}` 清除参考 |
| POST | `/dsh-tts/ref-backup` | `{kind, action:"list"\|"clear"}` |
| POST | `/dsh-tts/fetch-audio` | 从 URL 取音频（默认禁内网，需 `tts.allowPrivateFetch=true`） |
| POST | `/dsh-tts/speak` | 同 `tts_speak` |
| POST | `/dsh-tts/ping` | OneBot `get_login_info` |
| POST | `/dsh-tts/import` | 从 qq-bridge 配置导入 |
| GET | `/dsh-tts/log` | 日志数组 |

`/speak` 示例：

```bash
curl -X POST http://127.0.0.1:<port>/dsh-tts/speak \
  -H "content-type: application/json" \
  -d '{"text":"你好，这是测试。","target":"private:123456"}'
```

---

## 配置结构（`$DSH_HOME/dsh-tts/config.json`）

```jsonc
{
  "tts": {
    "enabled": true,            // 总开关
    "aiEnabled": true,          // 是否允许 AI 工具调用
    "baseUrl": "https://api.xiaomimimo.com/v1/chat/completions",
    "apiKey": "",
    "apiStyle": "openai",       // openai | breeze（面板编辑哪套协议）
    "routeMode": "",            // ""=跟 apiStyle；mimo | breeze | smart
    "model": "mimo-v2.5-tts",
    "mode": "preset",           // preset | voicedesign | clone | custom
    "voice": "冰糖",
    "format": "wav",            // wav | mp3 | pcm | pcm16
    "style": "", "styleMode": "user", "singStyle": "唱歌",
    "lengthThreshold": 100, "durationThreshold": 20,
    "timeoutMs": 180000, "maxChars": 2000, "singAttempts": 5,
    "autoSendVoice": true, "allowPrivateFetch": false,
    "voiceSettings": {}, "headerTemplate": "", "bodyTemplate": "",
    "variants": {}, "presetVoices": [...], "modelLabels": {},
    "clone": {}, "singRef": {},
    "breeze": { "baseUrl": "https://api.breeze.blue/v1", "model": "", "voice": "", "apiKey": "", ... }
  },
  "onebot": { "httpUrl": "", "accessToken": "" },
  "voice": {
    "dir": "",                  // 发送暂存目录，默认 $DSH_HOME/dsh-tts/voice
    "maxSeconds": 300, "maxBytes": 20971520,
    "maxPerMinute": 2, "maxPerHour": 10,
    "defaultVolume": 1, "loudness": "normal",
    "autoReadback": true, "ffmpegPath": ""
  }
}
```

- 双协议、自定义模板、variants（按模型覆盖 header/body 模板）。
- `routeMode` 的 `smart` 会按文本长度/预估时长选边，5xx/网络错误自动换另一边重试一次并在 `warnings` 里注明。
- `voice.maxPerMinute / maxPerHour` 是**内存态**限流（按 `group:xxx` / `private:xxx` 分别计数），进程重启清零。

---

## 数据与清理

```
$DSH_HOME/dsh-tts/
├── config.json          # 全部配置
├── dsh-tts.log          # 运行日志
├── voice/               # 发送前暂存（tts-*.wav/mp3），保留最近 20 个
├── state/tts-cache/     # 合成缓存，1 小时过期；每小时扫一次
├── state/tts-clone/     # 说话音色参考音频 + backups/
└── state/tts-sing-ref/  # 唱歌参考音频 + backups/
```

- 每次发送后用过的临时文件延迟 **60 秒**删除；缓存按 1 小时清理。
- 参考音频有旧版本时会自动归档到 `backups/`，面板的「ref-backup」可以列出/清空。

---

## 已知限制

- **唱歌是概率性的**：上游有时只念不唱；插件会重试 `singAttempts` 次，仍失败返回 `stage:"sing"`，再调一次通常能成。唱歌明显更慢（10~90 秒）。
- **克隆模式**：参考音频要求 mp3/wav，单条超过 30 秒/2.5MB 会被规整/截断（前端一定会截到 30 秒内，装没装 ffmpeg 都一样）。**建议 10~30 秒连续说话**，有效语音 < 5 秒会在面板上常驻警告。克隆参考不能跨机器复用（存在数据目录里）。克隆模型的 `voice` 必须是参考音频的 DataURL，传预设音色名会被上游拒绝（已按模型自动兜底，见下条）。
- **Breeze 协议**：需要单独的 key，面板高级项与 `config.json` 的 `tts.breeze` 里填；`apiKeyHint` 只回显脱敏值。
- **音频处理**（音量/响度归一）依赖 ffmpeg；没装时 `volume`/`normalize` 会被跳过并在 `warnings` 里提示，不影响原样发送。
- **OneBot 必须是 HTTP 端口，且是 3000 不是 5099**。填成 WS 端口 3001 会报 426；填成 SnowLuma 的 WebUI 面板 5099 会拿到 WebUI 的 401 JSON（没有 retcode），插件会直接告诉你「这不是 OneBot，请改成 3000」。
- **拉取模型 / 音色失败会显示上游真实错误**（HTTP 状态码、超时、非 JSON 等）。看到错误时先检查对应面板的 Key 与接口地址。
- **超时报文会带目标地址与耗时**：如「模型探测超时：https://… 在 20013ms 内没有响应（等待上限 20000ms）」。等待上限默认 20 秒，请求体传 `timeoutMs`（1000~120000）可临时调整；这是从发出请求起算的整体硬截止，不会因为双栈连接各等一轮而变成两倍。
- **「调用优先级」里的就绪提示按缺项给出**：Key 存好了但没选模型时会明说「缺模型」，不会一律显示「还没填 Key」。`/state` 与 `/config` 用同一套判定（接口地址 + Key + 模型三项），并额外返回 `routeReadyDetail` 说明每项是否齐备。
- **克隆模型的 `voice` 只能是参考音频 DataURL**：上游按**模型**（不是控制台的「合成模式」下拉）判断，`mimo-v2.5-tts-voiceclone` 收到预设音色名会回 `400 Param Incorrect`。以模型为准兜底：只要模型是克隆模型，`voice` 一律换成参考音频；点预置音色卡上的「试听」时会临时切到预置音色模型（只影响这一次试听，不改保存的配置）并在界面上说明。
- **克隆参考音频「够不够长」看的是有效语音，不是文件时长**：一段 6 秒的录音里真正说话的常常只有 2 秒，按总时长会误判成「够长」。`measureWavSpeech` 按 20ms 帧 + RMS 阈值 0.008 统计有效语音（与前端 `measureSpeechSeconds`、`trimSilence` 同口径），有效语音 < 5 秒就在面板上常驻警告。判定依据是实测：2.91 秒参考音频的时长变异 40.8%，拼到 8 秒降到 12.9%，而预置音色只有 1.9%。**警告不代表克隆没生效**——音色确实来自参考音频（F0 差 34 Hz），是语速/时长在飘。
- **参考音频超过 30 秒会被自动截取前 30 秒**：上游对超长参考音频会直接拒，所以统一截断，并在提示里写明原长。截取选项默认「整段」，由后端统一截到 30 秒内——克隆需要尽量多的有效语音，默认砍到 6 秒反而更容易飘。
- **参考音频时长由服务端自己量**：不依赖 ffmpeg（本机常常没装）。WAV 头 + PCM 足够算出总时长与有效语音；以**落盘文件**为准，浏览器报的数只在量不出来时兜底。参考音频没记过时长时，读取配置会从文件现量，不需要重新上传。非 16bit PCM 的 WAV 量不出来，按「时长未知」处理，绝不猜。
- **`mode` 与 `model` 现在会被强制收敛成一对**：这两个字段描述的是同一件事，独立存在时任何一处单改都会让请求自相矛盾——`mode=clone` + 预置模型会把参考音频 DataURL 当音色名发出去（`Unknown voice: data:audio/wav;base64,…`），反过来 `mode=preset` + 克隆模型会把音色名发给克隆模型。由 `reconcileModeModel` 统一收敛，**克隆优先**；手填的自定义模型不会被改掉，只补齐 `mode`。上传参考音频、「合成模式」Tab、预置音色卡「使用」三处都成对写入，不会制造分叉。
- **上游 400 会带出 `param` 字段并翻译成人话**：小米的报错形如 `{message:"Param Incorrect", param:"audio.voice must be a DataURL for voice clone model"}`，真正有用的信息在 `param` 里。报错会写明「字段：audio.voice …」并给出下一步该改什么，不只丢一句「Param Incorrect」。
- **试听失败会写日志**：`/preview` 失败会写 `试听失败：… / route=… / 上游 HTTP … / url=… / 上游原文=…`，排查不用再靠猜。
- **IPv6 不通时探活会自动改用 IPv4 重试一次**：实测某些网络到 `api.breeze.blue` 的 IPv6 直接超时、IPv4 约 1 秒通，表现为「在 20015ms 内没有响应」。只对域名生效；IP 字面量不重试（否则等待时间会翻倍）。重试成功时响应里会带一句说明。
- **自定义风格词是失焦自动保存**：与 API Key 同一套交互：填完点一下别处即落盘并就地提示；读回配置时如果 `tts.style` 不在预置风格表里，会认成自定义词填回输入框；从下拉里选一个预置风格会顺带清掉自定义词（否则「优先于下拉」会让下拉看着没反应）。
- **OneBot 的 Access Token 与 HTTP 地址底对齐**：不带单独的 hint 行，两个输入框同一行底对齐。
- **smart 智能路由的分界语义**：「字数 ≥ 字数分界 **或** 估算时长 ≥ 时长分界 → 小米；都不到才按延迟挑边」。选项文案、两个分界项的标签与 hint 都明说「达到即走小米」，卡片底部另有一句完整说明。没有「跟随当前协议（不启用路由）」这个选项；配置里 `routeMode=''` 仍被后端接受（行为等同按 `apiStyle` 走），界面会给一句提示引导选一个。
- **Token 里可能真的就是全角字符——插件绝不改它**：把 Token 里的全角标点自动转成半角会把密码改坏，网关直接回 `401 Token expired or invalid`。**一个字节都不动**：传输层把 UTF-8 字节映射成 Latin-1 字符交给 `fetch`（`！` → `EF BC 81` → `ï¼`），网关按 UTF-8 解码即还原原文，往返一致已用真实 HTTP 往返验证。设置页只**说明**「Token 里有 N 个非 ASCII 字符，已原样保存、原样发送」，不标红、不劝你改密码。真正的配置错误（HTTP 地址里有全角字符）仍然硬报错。
- **保存结果就近显示在触发的卡片里**：每条通知带一个 scope（`top` / `route` / `mimo` / `breeze` / `onebot` / `speak` / `ref-clone` / `ref-sing`），用 `CardNote` 渲染在**对应卡片的底部**（`role="status"`）；页面顶部那条只留给「整套设置加载失败」这类不属于任何卡片的消息。API Key / 自定义风格词就在输入框下方就地提示。
- **跨机器发语音：自动改用 base64 内联**：插件可以装在 A 机、OneBot 在 B 机。把 record 段的 `file` 填成本机绝对路径时，B 机的 OneBot 会去 stat 一个不存在的文件：`ENOENT: no such file or directory, stat 'C:\Users\xxx\.dsh\dsh-tts\voice\tts-xxxx.wav'`——那个路径是 A 机的。按网关地址自动选择：本机回环（`127.0.0.1` / `localhost` / `::1`）用路径（省流量），其它一律用 `base64://` 内联（数据随请求走，对端不需要读我们的磁盘，体积约 1.33 倍）。也可在 `voice.fileMode` 里强制 `auto` / `path` / `base64`。
- **OneBot 到底在哪个端口：看 SnowLuma 控制台「OneBot 连接」，别猜**：SnowLuma 的 `5099` 是 WebUI 管理面板（密码登录），`/api/*` 是它的**全路径鉴权守卫**——连瞎编的 `/api/zzz_fake` 都回一模一样的 `Unauthorized` / `Token expired or invalid`，所以「打个 action 看有没有响应」判断不了任何事。真正的 OneBot 默认是 `3000`（HTTP）/ `3001`（WS），响应里**必带 `retcode`**（如 `{"status":"failed","retcode":1401,"wording":"unauthorized"}`），这就是唯一可靠的判据。另外注意：OneBot 默认**只绑 `127.0.0.1`**，从别的机器连会 `ECONNREFUSED`——要在远程用，得先在 SnowLuma 里把 `http-default` 适配器的监听地址改成 `0.0.0.0`（或在系统层做端口转发），并考虑配 token，因为那等于把 OneBot 暴露到网络上。插件的地址栏把本地 `127.0.0.1` 改为你的云服务器公网 IP（例 `http://公网IP:3000`），action 前缀（根路径还是 `/api`）由插件自动探测。
- **操作结果一定有出口**：不抑制任何结果：每条操作（含成功）都写进触发它的卡片；没有 scope 时兜底到页面顶部，绝不静默。
- 语音发送的审计（敏感信息拦截）沿用 OneBot 网关侧的策略；插件本身不做内容审查。

---

## 自测与打包

```bash
node test/standalone.test.mjs     # 离线自测（不联网、不启 DSH）→ 77 passed
node test/render-smoke.mjs        # UI 渲染冒烟（React shim + 脱敏 fixture）→ 0 failed
node bin/install.mjs --check      # 包完整性校验
node bin/install.mjs --pack [输出目录]   # 打 zip，默认到桌面
```

`--pack` 会自动排除 `node_modules`、`.git`、`.DS_Store`、`.tmp`、已有的 `*.zip` 和所有以 `.` 开头的隐藏项，只把 `package.json` 的 `files` 里列出的东西打进包。

### 发布前干净度复核清单

打包前建议跑一遍这几项：

| 检查项 | 命令/方法 | 通过标准 |
| --- | --- | --- |
| 残留临时文件 | 目录树里搜 `_probe*`、`*.tmp`、`*.bak`、`*.log`、`node_modules` | 无 |
| 硬编码密钥 | 搜 `brz_`、`sk-`、`apiKey:` 的长字面量 | 只有测试用的 `sk-test-…` 这类明显假值 |
| 本机痕迹 | 搜 `C:\Users\<你的用户名>`、真实内网 IP | 无 |
| 参考音频痕迹 | 搜 `clone-*.wav`、长 base64 片段 | 只有空字节占位文件，无真实音频内容；长 base64 片段无 |
| 真实 QQ 号 | 搜 9~11 位纯数字 | 只有 `123456789` 这类占位符 |
| 调试代码 | 搜 `debugger`、非测试文件里的 `console.log` | 无 |
| 文件编码 | 全部 UTF-8 无 BOM，换行统一 LF（`package.json` 也不例外） | 通过 |
| 完整性级别 | `icacls <目录>` 不应出现 `Low Mandatory Level` | 全部 Medium |
| 自测 | 两个测试文件 | **77 passed / 0 failed**（render-smoke 0 failed） |
| 元数据 | `node bin/install.mjs --check` | 校验通过 |

复核的实测结果：23 个文件；真实密钥前缀、本机用户目录、长 base64 片段全部无命中；BOM 0 个、CR 0 个（全 LF）；插件目录下 **Low 标签 0 项**；zip 本身是 `Medium Mandatory Level`。

命中的其余项均属文档/占位符误报：`192.0.2.10` 与 `203.0.113.7`（RFC 5737 文档专用段）、`123456789` 占位符、`maxBytes: 20971520` 这类配置数值被「长数字串」正则撞到、本清单里作为检查项写出的 `debugger` 字样、`bin/install.mjs:43` 的 `console.log(text)`（CLI 输出函数 `line()`，不是调试残留）。

### 关于文件完整性级别（Windows）

如果你在工作区里用 DSH 的沙箱改过这些文件，它们可能被写成 **Low 完整性级别**（`icacls` 里显示 `Mandatory Label\Low Mandatory Level`）。这不影响插件运行，但发布出去别人解压后会是正常级别——zip 不保存 NTFS 的 SACL，所以打包本身就是一次清洗。

想在本机把标签改回来，注意**光有文件所有权不够**：改完整性标签要求对目标持有 `WRITE_OWNER`，普通用户对自己拥有的文件默认只有 `WRITE_DAC`，直接 `icacls /setintegritylevel` 会报 `Access is denied`。正确顺序是：

```powershell
icacls <路径> /grant "$env:USERDOMAIN\$env:USERNAME:(WO)"   # 临时授予 WRITE_OWNER
icacls <路径> /setintegritylevel Medium                       # 改级别
icacls <路径> /remove "$env:USERDOMAIN\$env:USERNAME"         # 撤掉临时权限
```

自测覆盖：配置合并/脱敏/导入投影、15 条 HTTP 路由的注册与鉴权、配置写入校验、工具定义与 `execute` 边界、OneBot 目标解析与限流、`ttsCfg` 关键推导、上游探活失败回归、上游 400 的 `param` 透出与翻译、克隆模型 `voice` 以模型为准、**`reconcileModeModel` 的 mode/model 收敛（克隆优先、保护自定义模型）**、**参考音频时长度量与「过短」警告（`measureWavSpeech` 量 WAV 与异常输入、无时长配置现量、落盘优先于浏览器上报、`tooShort` 判定）**、`routeReady` 口径回归、探活超时诊断、全角字符回归、服务类型判别回归（looksLikeOneBot 认 retcode、looksLikeSnowLumaWebui 只认 success:false、5099 那种网关自动走 /api 并报 Token 问题、地址自带 /api 不额外探测）、跨机器发送回归（isLocalGateway 判本机回环、强制 base64 时 record.file 为 base64:// 且字节可还原、本机网关 auto 仍用路径、ENOENT 识别、非法 fileMode 回落 auto）；渲染冒烟检查小米 / Breeze 两面板各自带试听区与保存按钮、调用优先级、参考音频、发 QQ 区都在，真的走一遍「填 Key → 失焦 → 自动保存并就地反馈」和「保存配置并检查 → 就近返回结果」两条交互链，断言「Key 已存但缺模型」时提示缺模型而不是误报没填 Key，并验证试听警告（如克隆模型临时换模型）会真的渲染出来，以及**参考音频过短时面板常驻警告、达标时不警告、Breeze 面板不受影响**；同时覆盖「自定义风格词失焦自动保存后输入框不被清空」「OneBot 的 Access Token 不带独立 hint 行」「配置里有非半角字符时 OneBot 卡片先标红、干净时不显示」「保存/操作的通知落在触发它的那张卡片内部而不是页面最上方、且未操作时顶部不残留」「测试连接失败时也必须给出提示（不能一片死寂）」等 UI 回归，并断言调用优先级不出现「跟随当前协议」、分界项命名与 hint 明说「达到即走小米」。路由分界另有独立断言：字数达到分界走小米、时长达到（字数未达）走小米、两者都没到才按延迟挑边、唱歌恒走小米。

## 目录结构

```
dsh-plugin-tts/
├── package.json          # dsh.bundle.patch + dsh.client + meta
├── cordis.patch.yml      # - insert: [{id: dsh-tts, name: dsh-plugin-tts}]
├── index.js              # Host：tools + /dsh-tts 路由 + 缓存清理定时器
├── client.js             # UI：设置页「语音合成」一栏（settings.section）
├── lib/
│   ├── tts-lib.js        # TTS 引擎（双协议/模板/合成/缓存）
│   ├── voice-core.js     # 音量/响度/目标解析等音频工具
│   ├── config.js         # 配置读写、qq-bridge 导入、脱敏
│   ├── onebot.js         # OneBot 调用、限流、回读
│   ├── speak.js          # synthesize → 发送 的编排
│   ├── routes.js         # /dsh-tts/* HTTP 面
│   ├── tools.js          # tts_speak / tts_voices
│   └── logger.js         # 内存 ring + 文件日志
├── locale/{zh,en}.json   # 插件元数据
├── icon.svg
├── LICENSE               # MIT
├── bin/install.mjs
└── test/
    ├── standalone.test.mjs
    ├── render-smoke.mjs
    └── fixtures/{config,state,log}.json   # 脱敏后的真实接口返回
```

---

## 发布说明模板（GitHub Release 用）

发 Release 时把下面这段贴进 Release 描述，**记得把 SHA256 换成实际打包产物的哈希**：

````markdown
## dsh-plugin-tts 0.4.2

**参考音频过短的明确警告 + 超长自动裁剪。**

### 这个版本解决什么

克隆音色「每次试听都不一样」看起来像 bug，实测结论是**克隆一直正常**，问题是参考音频只有
2.91 秒（有效语音 2.35 秒），远低于官方建议的 10~30 秒。同一句话连合成 6 次的时长变异：

| 参考音频 | 时长变异 | F0 均值 |
| --- | --- | --- |
| 预置音色「冰糖」 | 1.9% | 265.6 Hz |
| 克隆，参考 2.91 秒 | 40.8% | 231.2 Hz |
| 克隆，同一段拼到 8 秒 | 12.9% | 225.0 Hz |

音色确实来自参考音频（F0 差 34 Hz），但样本太短会让语速和音色每次都飘。现在插件会直接说出来。

### 改动

- 上传参考音频时，有效语音 < 5 秒立即警告，建议 10~30 秒
- 参考音频卡常驻显示「X 秒（有效语音 Y 秒）」，过短时挂 `role="alert"` 警告条
- 超过 30 秒自动截取前 30 秒
- 新增 `measureWavSpeech()`，不依赖 ffmpeg 就能从 WAV 量时长
- 配置没记过时长时从文件现量，不需要重新上传就能看到警告

**只改小米模板**，Breeze 面板不受影响。

### 安装

1. 下载 `dsh-plugin-tts-0.4.2.zip`
2. **校验 SHA256**：

   ```bash
   # Windows
   Get-FileHash .\dsh-plugin-tts-0.4.2.zip -Algorithm SHA256
   # macOS / Linux
   shasum -a 256 dsh-plugin-tts-0.4.2.zip
   ```

   应为：`<该 Release 公布的 SHA256>`

3. **解压**，确认得到的 `dsh-plugin-tts/` 目录里**直接**有 `package.json`
4. DSH → **设置 → 插件管理 → 从本地安装**，选中那个 `dsh-plugin-tts` 目录
5. **刷新页面**，打开 **设置 → 语音合成**

详见 [README 的安装章节](README.md#安装)。

### 验证

- `node test/standalone.test.mjs` → 77 passed, 0 failed
- `node test/render-smoke.mjs` → 0 failed
- 23 个文件，零 npm 依赖
````