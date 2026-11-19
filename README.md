# dsh-plugin-tts

一个 **DeepSeek Harness 插件**，把 TTS 语音合成做进 DSH 里：小米 MiMo / Breeze 双协议、预设音色 / 音色设计 / 语音克隆、翻唱（自动搜歌词 + 浏览器内混伴奏）、自定义请求模板（唱歌可单独一套）、参考音频自动裁切管理，合成后可直接发 QQ 语音。

## 支持的模型与 API

本插件使用的小米 MiMo 模型和 Breeze（BreezeBlue）的模型——**只测试过这两个**，理论上小米模板兼容 OpenAI 协议的其他音色克隆模型。

请**自行到对应官网注册账号获取 API**，插件不自带 Key。

**Breeze 模型在官网克隆以后在插件中直接拉取音色**，因此 Breeze 模板没有上传参考文件克隆功能。

本插件语音发送**直接走本机（云服务器）的 OneBot HTTP 网关**（SnowLuma 默认 `http://127.0.0.1:3000`）。如果你想让通过桥接接入的 QQ 聊天 AI（大肥鱼、小鲸鱼）发送语音消息，可能需要在对应的 QQ 桥接（比如 qqbridge）白名单里手动加入调用工具 **`tts_speak`** 和 **`tts_voices`**（可让 AI 在新开会话的完全权限的工作区里面自己加。例：把 tts_speak 、tts_voices 加入 qqbridge 桥接白名单）。具体做法是装好插件后让你的【鱼】测试一下，测不通它会告诉你需要把哪些工具加入白名单。

> **本插件全程由 AI 制作，如有 BUG，自行用 AI 修复。**

装好之后你会得到三样东西：

| 面 | 内容 |
| --- | --- |
| **UI** | 设置页「语音合成」一栏：开关、调用优先级、小米 / Breeze 双协议面板、参考音频（说话音色，自动去静音 + 截 15~60 秒）、翻唱（搜歌词 / 混伴奏）、请求模板（唱歌可单独一套）、试听、发 QQ 语音、通道探活、日志 |
| **AI 工具** | `tts_speak`（合成 / 合成并发 QQ 语音）、`tts_voices`（音色与通道状态） |
| **HTTP** | `/dsh-tts/*`：配置、模型/音色探活、试听、克隆参考音频、歌词搜索、发语音、日志 |

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

从本仓库的 **Releases** 页面下载 `dsh-plugin-tts-0.4.4.zip`，然后核对完整性：

**Windows（PowerShell）**

```powershell
Get-FileHash .\dsh-plugin-tts-0.4.4.zip -Algorithm SHA256
```

**macOS / Linux**

```bash
shasum -a 256 dsh-plugin-tts-0.4.4.zip
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
├── LICENSE
└── README.md
```

⚠️ **最常见的安装失败原因就是层级不对。**

```
❌ dsh-plugin-tts/dsh-plugin-tts/package.json     ← 多套了一层，错
⚠️ dsh-plugin-tts-0.4.4/package.json              ← 解压工具套了版本号目录，能用，但选目录时别选错外层
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
| 克隆音色每次都不一样 | 参考音频太短（有效语音 < 5 秒） | 重传 **15~60 秒**连续说话的录音；面板上会直接警告 |

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
| 小米设置 | 接口地址、API Key（填完失焦即自动保存并覆盖旧值，结果就地显示在输入框下方；「保存配置并检查」不改 Key，只保存配置并报 Key 是否已生效）、模型下拉 + 拉取模型 + 手填 model id、格式 wav/mp3、说话风格（分组预设 + 自定义 + 落位 user/inline）、唱歌风格、单次上限、模式页签（预置音色九张卡「试听/使用」、音色设计、克隆音色、翻唱合成、自定义）、请求头/请求体模板（保存 / 恢复内置默认）；面板底部自带「试听（小米 MiMo）」与「保存小米配置并检查」，保存结果就显示在按钮下方 |
| Breeze 设置 | baseUrl、Key（同样失焦即自动保存，结果就地显示）、model_id / voice_id（下拉拉取 + 手填，**拉取音色后会自动把 voice_id 填成第一个音色**）、mp3/wav、引导强度 / 语速 / 音量（人声增强开关就在音量输入框右边同一行）、模板；面板底部自带「试听（Breeze）」与「保存 Breeze 配置并检查」，保存结果同样就近显示 |
| 试听 | 每个面板各有一块试听区：小米只带小米的接口/音色/风格，Breeze 只带 Breeze 的接口/音色，互不串用；合成后就地播放并附脱敏 curl。两块试听区都不带「唱歌」开关（Breeze 协议本身不支持唱歌；翻唱统一走「合成模式 → 翻唱合成」页，生成完就地试听/下载） |
| 发语音 | 填「要说的内容」（留空用默认一句问候）与目标 `group:群号` / `private:QQ号`，点按钮直接合成并发送，回读结果就地显示 |
| 通道 | OneBot HTTP、Access Token；测试 OneBot；从 QQ Bridge 导入 |
| 克隆 | 只有一份「说话音色」，放在「合成模式 → 克隆音色」里；**选好文件后点「选择文件」旁的「上传 / 替换」**，选多个 mp3/wav/wave → 前端默认自动裁掉首尾静音、从干净人声开始，再自动截到 **15~60 秒**（超过 60 秒挑有效语音最集中的一段；不足 15 秒只提示不拦），拼成 24kHz 单声道 WAV → 上传；也可勾「原样上传」跳过裁切直接传 MP3（Base64 ≤10 MB）；同样支持从链接导入、备份目录可打开/清空 |
| 翻唱 | 「合成模式 → 翻唱合成」页：**歌名搜歌词（网易云公开接口，自动填入并去掉制作人/标题行）** → **可选模型 / 音色**（小米 MiMo 只有 `mimo-v2.5-tts` 真的会唱，卡片默认选它；克隆 / 音色设计模型唱出来基本是念白）→ 后端合成唱歌人声（开头 `(唱歌)` 由代码自动补）→ 浏览器内与伴奏混音 → 试听/下载 48kHz 立体声 WAV。可调风格词、人声/伴奏增益、淡出秒数；伴奏不上传，也不需要本机装 ffmpeg。**在对话里直接对 AI 说「唱一首晴天」也行**：`tts_speak` 传 `song` 就会自己搜歌词并唱 |
| 唱歌模板 | 「请求头 / 请求体模板（高级）」里除普通模板外，另有**唱歌请求头 / 唱歌请求体**两份，**默认已按小米协议自动填好**、与说话模板各自独立，通常不用改；只有想给翻唱单独换模型或加 audio 参数时才动这里，不影响说话音色 |
| 运行状态 | 配置/数据/缓存/参考目录、Key 提示、上限（秒数/体积/频率/字数）、日志 |

克隆说明：0.4.3 起**不再有单独的「唱歌参考」卡片**——翻唱默认走预置音色模型 `mimo-v2.5-tts`（官方只有它会唱）+ 卡片里选的预置音色，不再用说话音色的克隆参考；把模型切成 `mimo-v2.5-tts-voiceclone` 时卡片会改成「用说话音色里的克隆参考」，但克隆模型唱出来基本是念白。旧版 `singRef` 字段只为兼容旧配置保留，不参与合成。

> Key 是两把：小米 Key 填在「小米 MiMo」面板，Breeze Key 填在「Breeze」面板，互不通用。只填一边时另一边在「调用优先级」里仍会提示未填 Key，这是正常的；填完要点各自面板底部的保存按钮。

---

## AI 工具

### `tts_speak`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string | 要念的文字，不要 Markdown/代码块；唱歌时就是歌词 |
| `song` | string | **唱歌推荐用法**：歌名（可带歌手，如 `晴天 周杰伦`）。给了 `song` 就不用传 `text`，插件会自己联网搜歌词并唱 |
| `target` | string | `group:群号` 或 `private:QQ号`；省略 = 只合成不发送 |
| `style` | string | 风格词，如 `开心`、`东北话`、`悄悄话` |
| `voice` | string | 临时覆盖音色（预设模式用 id，如 `冰糖`、`苏打`） |
| `sing` | boolean | 唱歌。慢且上游概率性，失败可再调一次；传了 `song` 默认就是唱歌 |
| `label` | string | 写进发送结果的说明（传了 `song` 时默认「唱了《歌名》」） |
| `verify` | boolean | 发送后是否 `get_msg` 回读确认，默认 true |
| `volume` | number | 本地音量 0.1~4，1=原样 |
| `normalize` | boolean | 响度归一（需要 ffmpeg） |

- `text` 与 `song` 至少给一个；两个都没给会直接拒绝。
- **让 AI 自己搜翻唱**：在对话里说「唱一首晴天」，模型调 `tts_speak({song:"晴天", target:"…"})` 即可——服务端自己搜歌词、补 `(唱歌)` 前缀、合成、发送，全程不需要用户手动贴歌词。整首歌词太长时会按整行裁到 600 字左右先唱一段，返回的 `warnings` 会说明只唱了前几句。
- 没有 `target`：返回 `{ok, route, sing, actuallySang, durationSec, attempts, bytes, mimeType, audioId, audioUrl: "/dsh-tts/audio?id=…", song?, warnings}`。
- 有 `target`：返回 `{ok, target, messageId, text, route, sing, actuallySang, durationSec, attempts, voice, bytes, mimeType, elapsedMs, verified, warnings, song?}`。
- 唱歌时 `actuallySang !== true` 会返回 `stage:"sing"` 的失败（上游这次只念了没唱），再调一次通常就好。

### `tts_voices`

无参数，返回：`enabled / aiEnabled / apiKeySet / model / mode / format / maxChars / voices[9] / stylePresets / cloneReady / singing{style,tag,models,defaultModel,modelNote,voices,songHint} / onebot{httpUrl,tokenSet,source} / hint`。

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
| POST | `/dsh-tts/lyrics` | `{query}` 或 `{songId}` 搜歌词（唱歌用，网易云公开接口，无需登录），最多返回 6 条候选 |
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
    "baseUrl": "https://api.xiaomimimo.com/v1/chat/completions",  // 只填到 /v1 也行，插件会自动补 /chat/completions
    "apiKey": "",
    "apiStyle": "openai",       // openai | breeze（面板编辑哪套协议）
    "routeMode": "",            // ""=跟 apiStyle；mimo | breeze | smart
    "model": "mimo-v2.5-tts",
    "mode": "preset",           // preset | voicedesign | clone | custom
    "voice": "冰糖",
    "format": "wav",            // wav | mp3（pcm / pcm16 是裸流，已移除）
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
└── state/tts-sing-ref/  # 0.4.3 之前的旧唱歌参考（只为兼容保留，不再参与合成）
```

- 每次发送后用过的临时文件延迟 **60 秒**删除；缓存按 1 小时清理。
- 参考音频有旧版本时会自动归档到 `backups/`，面板的「ref-backup」可以列出/清空。

---

## 0.4.4 干净度复核修补

这一轮只修「文档/脚本声称做到了、实际没做到」的地方，合成链路一行没动：

- **`--pack` 的干净度原来靠人眼**：打包器只按黑名单跳过 `node_modules` / `.git` / `.DS_Store` / `.tmp`，`package.json` 的 `files` 字段没有实际作用。实测把 `note.log`、`_probe.tmp`、`config.json` 放进目录，打完包 27 个条目全被带上；而 `--check` 只查「该有的在不在」，带垃圾的包同样报「校验通过」。现在改为只拷贝 `files` 白名单（外加 `package.json`），`files` 里列了不存在的路径会直接中止并打印是哪一条，不留半个 zip。
- **`--check` 补反向检查**：目录里不在白名单里的条目会逐条列出（只提示、不判失败——开发中间态本来就会有）。
- **补回 `POST /dsh-tts/lyrics`**：0.4.3 就实现并上线了这条路由，但 HTTP 接口表、路由总数（现为 16 条）、自测覆盖描述都还写着 15 条。文档与代码现在对齐。
- **路由测试加反查**：`test/standalone.test.mjs` 的 expected 清单漏了 `/lyrics`，且只断言「expected 都在」，因此漏登记的路由永远不会被测出来。现在补进清单，并加 `assert.equal(routes.size, expected.length)`。
- **过期自检数字对齐**：README 里「77 passed」→ 98 passed（3 处），「23 个文件」→ 24 个文件（2 处）。

---

## 0.4.3 审查修补

这一轮把插件的合成、参考音频、翻唱、发语音四条链路整体过了一遍，修掉下面这些缺陷（都有回归测试或可复现路径）：

- **短句真唱被误判成念白**：唱歌最短时长口径原来是 `max(3.5, 字数×0.34)` 秒，4 个字真唱只有 2.6 秒，会被判「没唱」并白重试满 `singAttempts`(5) 次。改为 `max(2.5, 字数×0.30)`，真正的区分仍靠「每字有声时长 ≥ 0.33 秒」。
- **唱歌耗时污染 smart 路由**：整首歌合成要几分钟，原来会写进小米的延迟 EMA，把智能路由长期拉向小米。现在唱歌不写样本，且任何超过 120 秒的样本一律忽略。
- **格式下拉只有 wav / mp3**：`pcm` / `pcm16` 是裸流（没有容器头），浏览器 `<audio>` 和 QQ 语音都放不出来，所以下拉里已移除；旧配置里残留的 pcm 值会被归一成 wav。翻唱取人声时固定用 WAV（`decodeAudioData` 只吃得了带容器头的文件）。
- **点歌词候选后候选列表消失**：走 `songId` 分支时服务端只回歌词、`candidates` 为空，原代码会把列表清空，导致换不了歌。现在只在有候选时覆盖，提示里的歌名用刚点的那条补上。
- **参考音频上传失败后要重挑文件**：失败时不再清空文件选择，改个选项（比如去掉「原样上传」）就能直接重试。
- **61 秒音频挑不到最佳窗口**：最佳截取窗口原来每秒才滑一次，61 秒素材只能试 `from=0`；改为每 0.1 秒滑一次。
- **`/config` 的 `timeoutMs` 没有上限**：收敛到 1~600 秒；`voice.loudness` 只接受 `quiet` / `normal` / `loud` 或 -40~-5 的 LUFS 数字。
- **发语音失败时留下暂存文件**：`processAudioVolume` 抛错（如本机没装 ffmpeg 却开了响度归一）时先清理暂存 wav 再抛。

第二轮（接口入参 / 浏览器兼容）：

- **`/clear-ref` 传错 `kind` 会删掉「说话音色」**：原来非法 kind 一律当 `clone`，打错一个字就删错了参考音频。`/clone`、`/clear-ref`、`/ref-backup` 现在都严格校验 `kind`（`clone` / `sing`）与 `action`（`list` / `open` / `clear`），非法值直接 400。
- **`/clone` 对非法 Base64 宽松解码**：`Buffer.from(str,'base64')` 不报错，垃圾字符会变成几百字节的伪音频存进参考目录。现在先卡字符集，非法就回「dataBase64 不是合法的 Base64 字符串」。
- **`.wave` 参考音频的 MIME 是 `application/octet-stream`**：旧的扩展名表没有 `.wave`，`<audio>` 拿到这个类型不一定肯播。现在补成 `audio/wav`；旧配置里存过的 octet-stream 也会按扩展名纠正。同时 `.wave` 的 PCM 不再被无谓地转码（转码要 ffmpeg，没装就白失败）。
- **试听与发语音只出 wav / mp3**：服务端在 `/preview` 与 `/speak` 再兜一层——非 mp3 一律按 wav 处理（curl 里显示的是实际请求格式），旧配置里的 pcm 也不会漏出去。
- **`install --check` 没检查 `lib/lyrics.js`**：必检文件清单漏了它，打包漏文件也能「校验通过」；已补上。
- **歌词取不到正文时的提示**：原来固定说「搜到 N 首」，走 `songId` 分支时 N 就是 0；现在分开提示，纯音乐/没版权会说「换个歌名再试」。

## 已知限制

- **唱歌是概率性的**：上游有时只念不唱；插件按「每个字的有声时长」判定（念白约 0.23 秒/字，真唱约 0.45 秒/字），不达标就自动重试 `singAttempts` 次，仍失败返回 `stage:"sing"`，再调一次通常能成。唱歌明显更慢：短句几十秒，整首歌词 3~6 分钟（唱歌超时已抬到 10 分钟）；歌词太长建议分段唱。
- **克隆模式**：参考音频支持 `.wav` / `.wave` / `.mp3`（与小米 MiMo 官方一致），**只限 Base64 后 ≤ 10 MB**（约原始 7.5 MB）。前端默认自动裁掉首尾静音、从干净人声开始，并自动截到 15~60 秒（超过 60 秒挑「有效语音最集中」的一段，不足 15 秒只提示）；超过上限时会提示「改用 MP3 或剪短」，不会偷偷截断。有效语音 < 5 秒会在面板上常驻警告。克隆参考不能跨机器复用（存在数据目录里）。克隆模型的 `voice` 必须是参考音频的 DataURL，传预设音色名会被上游拒绝（已按模型自动兜底，见下条）。
- **Breeze 协议**：需要单独的 key，面板高级项与 `config.json` 的 `tts.breeze` 里填；`apiKeyHint` 只回显脱敏值。
- **音频处理**（音量/响度归一）依赖 ffmpeg；没装时 `volume`/`normalize` 会被跳过并在 `warnings` 里提示，不影响原样发送。
- **OneBot 必须是 HTTP 端口，且是 3000 不是 5099**。填成 WS 端口 3001 会报 426；填成 SnowLuma 的 WebUI 面板 5099 会拿到 WebUI 的 401 JSON（没有 retcode），插件会直接告诉你「这不是 OneBot，请改成 3000」。
- **拉取模型 / 音色失败会显示上游真实错误**（HTTP 状态码、超时、非 JSON 等）。看到错误时先检查对应面板的 Key 与接口地址。
- **超时报文会带目标地址与耗时**：如「模型探测超时：https://… 在 20013ms 内没有响应（等待上限 20000ms）」。等待上限默认 20 秒，请求体传 `timeoutMs`（1000~120000）可临时调整；这是从发出请求起算的整体硬截止，不会因为双栈连接各等一轮而变成两倍。
- **「调用优先级」里的就绪提示按缺项给出**：Key 存好了但没选模型时会明说「缺模型」，不会一律显示「还没填 Key」。`/state` 与 `/config` 用同一套判定（接口地址 + Key + 模型三项），并额外返回 `routeReadyDetail` 说明每项是否齐备。
- **克隆模型的 `voice` 只能是参考音频 DataURL**：上游按**模型**（不是控制台的「合成模式」下拉）判断，`mimo-v2.5-tts-voiceclone` 收到预设音色名会回 `400 Param Incorrect`。以模型为准兜底：只要模型是克隆模型，`voice` 一律换成参考音频；点预置音色卡上的「试听」时会临时切到预置音色模型（只影响这一次试听，不改保存的配置）并在界面上说明。
- **克隆参考音频「够不够长」看的是有效语音，不是文件时长**：一段 6 秒的录音里真正说话的常常只有 2 秒，按总时长会误判成「够长」。`measureWavSpeech` 按 20ms 帧 + RMS 阈值 0.008 统计有效语音（与前端 `measureSpeechSeconds` 同口径；上传时的自适应阈值只在切静音时用，判定「够不够长」仍用固定 0.008），有效语音 < 5 秒就在面板上常驻警告。判定依据是实测：2.91 秒参考音频的时长变异 40.8%，拼到 8 秒降到 12.9%，而预置音色只有 1.9%。**警告不代表克隆没生效**——音色确实来自参考音频（F0 差 34 Hz），是语速/时长在飘。
- **参考音频只限体积，但会主动截到 15~60 秒**：官方限制只有「Base64 后 ≤ 10 MB」，所以旧的 30 秒 / 2.5 MB 硬截断已删除；插件按「长一点克隆更准」的经验自己裁到 15~60 秒——超过 60 秒用前缀和找**有效语音最集中**的窗口（不是简单取前 60 秒），不足 15 秒只提示不拦。默认自动去静音是从「干净人声」开头的关键：先按 10% 分位估噪声底、噪声底 ×3 作阈值找首尾人声边界，两端各留 50ms，避免合成的语音开头带杂音。
- **翻唱在浏览器里混音**：桌面版 py 用 ffmpeg 做 `amix` + `loudnorm`；插件不能假设本机装了 ffmpeg（本机就没装），所以人声由后端合成、伴奏在浏览器用 `OfflineAudioContext` 混，输出 48kHz 立体声 WAV。`loudnorm` 用「峰值归一化到 -1.5 dBFS（只压不抬）+ 手动淡出」近似；伴奏循环到人声结束，不上传服务器。混音只在浏览器内完成，页面刷新即丢，需要保留请点「下载混音 WAV」。
- **歌词搜索靠网易云公开接口**：`POST /dsh-tts/lyrics` 由 DSH 主进程去请求 `music.163.com`（浏览器直连会被 CORS 挡），所以要能访问外网；取回后由 `cleanLrc` 去掉时间标签、作词/作曲/编曲/合声等制作人行与首行标题行，只留能唱的词。搜不到就换成「歌名 + 歌手」再试；也可以直接手贴歌词，开头的 `(唱歌)` 由代码自动补，手写一遍也不会重复。**AI 自己唱时走同一条链路**：`tts_speak` 收到 `song` 就替模型搜词、合成、发送，模型不需要向用户要歌词；整首歌词太长时会按整行裁到约 600 字先唱一段（`warnings` 里会说明），要接着唱就把后面的段落再发一次。
- **AI 唱歌是清唱**：服务端不混伴奏（本机没有 ffmpeg），QQ 语音发出去的就是干声；想要带伴奏的成品，请在「翻唱」卡片里混音后下载 WAV。伴奏混音只在浏览器内完成，无法由 AI 工具在后台代劳。
- **唱歌只有 `mimo-v2.5-tts` 会唱**：小米 MiMo 三个 TTS 模型里，只有预置音色模型 `mimo-v2.5-tts` 支持唱歌；`mimo-v2.5-tts-voiceclone` / `mimo-v2.5-tts-voicedesign` 唱出来基本是念白（官方没给这两个模型唱歌能力）。翻唱页默认就选它、并列出 9 个预置音色；如果你手动选了克隆 / 音色设计模型，页面上会标「（不支持唱歌）」并给红色警告。**AI 工具唱歌时也会自动改用 `mimo-v2.5-tts`**（用配置里的预置音色），并在 `warnings` 里说明临时换了模型；想坚持用某个模型就显式传 `model`。
- **唱歌模板开箱即用**：`tts.singHeaderTemplate` / `tts.singBodyTemplate` 默认就是小米官方那套协议（与说话模板分开存、互不影响），不配置也能直接唱，不需要手动改；只有想给唱歌单独换模型 / 加 `audio` 参数时才需要动这里。
- **参考音频时长由服务端自己量**：不依赖 ffmpeg（本机常常没装）。WAV 头 + PCM 足够算出总时长与有效语音；以**落盘文件**为准，浏览器报的数只在量不出来时兜底。参考音频没记过时长时，读取配置会从文件现量，不需要重新上传。非 16bit PCM 的 WAV 量不出来，按「时长未知」处理，绝不猜。
- **`mode` 与 `model` 现在会被强制收敛成一对**：这两个字段描述的是同一件事，独立存在时任何一处单改都会让请求自相矛盾——`mode=clone` + 预置模型会把参考音频 DataURL 当音色名发出去（`Unknown voice: data:audio/wav;base64,…`），反过来 `mode=preset` + 克隆模型会把音色名发给克隆模型。由 `reconcileModeModel` 统一收敛，**克隆优先**；手填的自定义模型不会被改掉，只补齐 `mode`。上传参考音频、「合成模式」Tab、预置音色卡「使用」三处都成对写入，不会制造分叉。
- **上游 400 会带出 `param` 字段并翻译成人话**：小米的报错形如 `{message:"Param Incorrect", param:"audio.voice must be a DataURL for voice clone model"}`，真正有用的信息在 `param` 里。报错会写明「字段：audio.voice …」并给出下一步该改什么，不只丢一句「Param Incorrect」。
- **试听失败会写日志**：`/preview` 失败会写 `试听失败：… / route=… / 上游 HTTP … / url=… / 上游原文=…`，排查不用再靠猜。
- **IPv6 不通时探活会自动改用 IPv4 重试一次**：实测某些网络到 `api.breeze.blue` 的 IPv6 直接超时、IPv4 约 1 秒通，表现为「在 20015ms 内没有响应」。只对域名生效；IP 字面量不重试（否则等待时间会翻倍）。重试成功时响应里会带一句说明。
- **自定义风格词是失焦自动保存**：与 API Key 同一套交互：填完点一下别处即落盘并就地提示；读回配置时如果 `tts.style` 不在预置风格表里，会认成自定义词填回输入框；从下拉里选一个预置风格会顺带清掉自定义词（否则「优先于下拉」会让下拉看着没反应）。
- **OneBot 的 Access Token 与 HTTP 地址底对齐**：不带单独的 hint 行，两个输入框同一行底对齐。
- **smart 智能路由的分界语义**：「字数 ≥ 字数分界 **或** 估算时长 ≥ 时长分界 → 小米；都不到才按延迟挑边」。选项文案、两个分界项的标签与 hint 都明说「达到即走小米」，卡片底部另有一句完整说明。没有「跟随当前协议（不启用路由）」这个选项；配置里 `routeMode=''` 仍被后端接受（行为等同按 `apiStyle` 走），界面会给一句提示引导选一个。
- **Token 里可能真的就是全角字符——插件绝不改它**：把 Token 里的全角标点自动转成半角会把密码改坏，网关直接回 `401 Token expired or invalid`。**一个字节都不动**：传输层把 UTF-8 字节映射成 Latin-1 字符交给 `fetch`（`！` → `EF BC 81` → `ï¼`），网关按 UTF-8 解码即还原原文，往返一致已用真实 HTTP 往返验证。设置页只**说明**「Token 里有 N 个非 ASCII 字符，已原样保存、原样发送」，不标红、不劝你改密码。真正的配置错误（HTTP 地址里有全角字符）仍然硬报错。
- **保存结果就近显示在触发的卡片里**：每条通知带一个 scope（`top` / `route` / `mimo` / `breeze` / `onebot` / `speak` / `cover` / `ref-clone` / `ref-sing`），用 `CardNote` 渲染在**对应卡片的底部**（`role="status"`）；页面顶部那条只留给「整套设置加载失败」这类不属于任何卡片的消息。API Key / 自定义风格词就在输入框下方就地提示。
- **跨机器发语音：自动改用 base64 内联**：插件可以装在 A 机、OneBot 在 B 机。把 record 段的 `file` 填成本机绝对路径时，B 机的 OneBot 会去 stat 一个不存在的文件：`ENOENT: no such file or directory, stat 'C:\Users\xxx\.dsh\dsh-tts\voice\tts-xxxx.wav'`——那个路径是 A 机的。按网关地址自动选择：本机回环（`127.0.0.1` / `localhost` / `::1`）用路径（省流量），其它一律用 `base64://` 内联（数据随请求走，对端不需要读我们的磁盘，体积约 1.33 倍）。也可在 `voice.fileMode` 里强制 `auto` / `path` / `base64`。
- **OneBot 到底在哪个端口：看 SnowLuma 控制台「OneBot 连接」，别猜**：SnowLuma 的 `5099` 是 WebUI 管理面板（密码登录），`/api/*` 是它的**全路径鉴权守卫**——连瞎编的 `/api/zzz_fake` 都回一模一样的 `Unauthorized` / `Token expired or invalid`，所以「打个 action 看有没有响应」判断不了任何事。真正的 OneBot 默认是 `3000`（HTTP）/ `3001`（WS），响应里**必带 `retcode`**（如 `{"status":"failed","retcode":1401,"wording":"unauthorized"}`），这就是唯一可靠的判据。另外注意：OneBot 默认**只绑 `127.0.0.1`**，从别的机器连会 `ECONNREFUSED`——要在远程用，得先在 SnowLuma 里把 `http-default` 适配器的监听地址改成 `0.0.0.0`（或在系统层做端口转发），并考虑配 token，因为那等于把 OneBot 暴露到网络上。插件的地址栏把本地 `127.0.0.1` 改为你的云服务器公网 IP（例 `http://公网IP:3000`），action 前缀（根路径还是 `/api`）由插件自动探测。
- **操作结果一定有出口**：不抑制任何结果：每条操作（含成功）都写进触发它的卡片；没有 scope 时兜底到页面顶部，绝不静默。
- 语音发送的审计（敏感信息拦截）沿用 OneBot 网关侧的策略；插件本身不做内容审查。

---

## 自测与打包

```bash
node test/standalone.test.mjs     # 离线自测（不联网、不启 DSH）→ 98 passed
node test/render-smoke.mjs        # UI 渲染冒烟（React shim + 脱敏 fixture）→ 0 failed
node bin/install.mjs --check      # 包完整性校验
node bin/install.mjs --pack [输出目录]   # 打 zip，默认到桌面
```

`--pack` **只打包 `package.json` 的 `files` 里列出的路径**（外加 `package.json` 本身）。隐藏项、`node_modules`、`*.zip`、`*.log`、`*.bak`、`_probe*` 这些不在白名单里的东西一律不会进包；`files` 里列了不存在的路径会**直接中止打包**并打印是哪一条，而不是打出一个缺文件的包。

> 早先这里是按黑名单过滤的，`files` 只是摆设——`*.log` / `*.bak` / `_probe*` 会被静默打进去，而 `--check` 当时只查「该有的在不在」，两边都拦不住。现在打包看白名单，`--check` 另外会提示「目录里有哪些条目不在白名单里」，两道闸门才算真的对上。

### 发布前干净度复核清单

打包前建议跑一遍这几项：

| 检查项 | 命令/方法 | 通过标准 |
| --- | --- | --- |
| 残留临时文件 | 目录树里搜 `_probe*`、`*.tmp`、`*.bak`、`*.log`、`node_modules` | 无 |
| 硬编码密钥 | 搜 `brz_`、`sk-`、`apiKey:` 的长字面量 | 只有测试用的 `sk-test-…` 这类明显假值 |
| 本机痕迹 | 搜 `C:\Users\<你的用户名>`、真实内网 IP、本机临时目录（`%TEMP%` 之类）、本机工作区绝对路径 | 无 |
| 参考音频痕迹 | 搜 `clone-*.wav`、长 base64 片段（≥200 字符） | 只有空字节占位文件，无真实音频内容；长 base64 片段无 |
| 真实 QQ 号 | 搜 9~11 位纯数字 | 只有 `123456789` 这类占位符 |
| 调试代码 | 搜 `debugger`、非测试文件里的 `console.log` | 可执行 JS 里无（README 里作为检查项列出的字样不算） |
| 文件编码 | 全部 UTF-8 无 BOM，换行统一 LF（`package.json` 也不例外） | 通过 |
| 完整性级别 | `icacls <目录>` 与逐文件 `icacls` 都不应出现 `Low Mandatory Level` | 全部 Medium |
| 白名单外条目 | `node bin/install.mjs --check` 会逐条列出不在 `files` 白名单里的条目 | 无 |
| 自测 | 两个测试文件 | **98 passed / 0 failed**（render-smoke 0 failed） |
| 路由登记 | 自测里的 `assert.equal(routes.size, expected.length)` | 16 条，与上面的 HTTP 接口表一致 |
| 元数据 | `node bin/install.mjs --check` | 校验通过 |

复核的实测结果（0.4.4）：24 个文件（解压后约 610 KB）；真实密钥前缀、本机用户目录、内网 IP、本机临时目录、工作区绝对路径、长 base64 片段全部无命中；可执行 JS 里 `debugger` 0 处；BOM 0 个、CR 0 个（全 LF，`package.json` 也是）；插件目录标签为 `Medium Mandatory Level`、逐文件 `icacls` 里 Low 0 项，zip 自身不带额外完整性标签（默认即 Medium）；`--check` 没有白名单外条目；16 条路由与接口表一致；解压后 24 个文件、顶层只有 `dsh-plugin-tts/`、`package.json` 直接同级。

上面这些数字是**对从 GitHub 下载回来的 Release 资产**复核出来的（不是对本地目录）：下载 → 重算 SHA256 → 解压 → 跑 `--check` 与两份自测，全部通过才认为这个包可以发。

命中的其余项均属文档/占位符误报：`192.0.2.10` 与 `203.0.113.7`（RFC 5737 文档专用段）、`123456789` 占位符、`maxBytes: 20971520` 这类配置数值被「长数字串」正则撞到、本清单里作为检查项写出的 `debugger` 字样、`bin/install.mjs:44` 的 `console.log(text)`（CLI 输出函数 `line()`，不是调试残留）。

### 关于文件完整性级别（Windows）

如果你在工作区里用 DSH 的沙箱改过这些文件，它们可能被写成 **Low 完整性级别**（`icacls` 里显示 `Mandatory Label\Low Mandatory Level`）。这不影响插件运行，但发布出去别人解压后会是正常级别——zip 不保存 NTFS 的 SACL，所以打包本身就是一次清洗。

想在本机把标签改回来，注意**光有文件所有权不够**：改完整性标签要求对目标持有 `WRITE_OWNER`，普通用户对自己拥有的文件默认只有 `WRITE_DAC`，直接 `icacls /setintegritylevel` 会报 `Access is denied`。正确顺序是：

```powershell
icacls <路径> /grant "$env:USERDOMAIN\$env:USERNAME:(WO)"   # 临时授予 WRITE_OWNER
icacls <路径> /setintegritylevel Medium                       # 改级别
icacls <路径> /remove "$env:USERDOMAIN\$env:USERNAME"         # 撤掉临时权限
```

自测覆盖：配置合并/脱敏/导入投影、16 条 HTTP 路由的注册与鉴权、配置写入校验、工具定义与 `execute` 边界、OneBot 目标解析与限流、`ttsCfg` 关键推导、上游探活失败回归、上游 400 的 `param` 透出与翻译、克隆模型 `voice` 以模型为准、**`reconcileModeModel` 的 mode/model 收敛（克隆优先、保护自定义模型）**、**参考音频时长度量与「过短」警告（`measureWavSpeech` 量 WAV 与异常输入、无时长配置现量、落盘优先于浏览器上报、`tooShort` 判定）**、`routeReady` 口径回归、探活超时诊断、全角字符回归、服务类型判别回归（looksLikeOneBot 认 retcode、looksLikeSnowLumaWebui 只认 success:false、5099 那种网关自动走 /api 并报 Token 问题、地址自带 /api 不额外探测）、跨机器发送回归（isLocalGateway 判本机回环、强制 base64 时 record.file 为 base64:// 且字节可还原、本机网关 auto 仍用路径、ENOENT 识别、非法 fileMode 回落 auto）；渲染冒烟检查小米 / Breeze 两面板各自带试听区与保存按钮、调用优先级、参考音频、发 QQ 区都在，真的走一遍「填 Key → 失焦 → 自动保存并就地反馈」和「保存配置并检查 → 就近返回结果」两条交互链，断言「Key 已存但缺模型」时提示缺模型而不是误报没填 Key，并验证试听警告（如克隆模型临时换模型）会真的渲染出来，以及**参考音频过短时面板常驻警告、达标时不警告、Breeze 面板不受影响**；同时覆盖「自定义风格词失焦自动保存后输入框不被清空」「OneBot 的 Access Token 不带独立 hint 行」「配置里有非半角字符时 OneBot 卡片先标红、干净时不显示」「保存/操作的通知落在触发它的那张卡片内部而不是页面最上方、且未操作时顶部不残留」「测试连接失败时也必须给出提示（不能一片死寂）」等 UI 回归，并断言调用优先级不出现「跟随当前协议」、分界项命名与 hint 明说「达到即走小米」。路由分界另有独立断言：字数达到分界走小米、时长达到（字数未达）走小米、两者都没到才按延迟挑边、唱歌恒走小米。

## 目录结构

```
dsh-plugin-tts/
├── package.json          # dsh.bundle.patch + dsh.client + meta
├── cordis.patch.yml      # - insert: [{id: dsh-tts, name: dsh-plugin-tts}]
├── index.js              # Host：tools + /dsh-tts 路由 + 缓存清理定时器
├── client.js             # UI：设置页「语音合成」一栏（settings.section）
├── lib/
│   ├── tts-lib.js        # TTS 引擎（双协议/模板/合成/缓存/唱歌标签）
│   ├── lyrics.js         # 网易云搜歌 + LRC 洗成能唱的歌词
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
## dsh-plugin-tts 0.4.4

**干净度复核修补：`--pack` 改按 `files` 白名单打包、`--check` 反向检查多余条目、补回 `POST /dsh-tts/lyrics` 的文档与测试。**

### 这个版本解决什么

1. **发布包不再靠人眼保证干净**：`--pack` 以前只按黑名单跳过 `node_modules` / `.git` / `.tmp`，`package.json` 的 `files` 字段没有实际作用，`*.log` / `*.bak` / `_probe*` 这类残留会被静默打进 zip（当时的 `--check` 只查「该有的在不在」，也拦不住）。现在只拷贝 `files` 白名单（外加 `package.json` 自身），`files` 里列了不存在的路径会直接中止打包并说明是哪一条。
2. **`--check` 补上反向检查**：目录里不在白名单里的条目会逐条列出（只提示、不判失败），打包与自检的口径终于一致。
3. **文档补回 `POST /dsh-tts/lyrics`**：HTTP 接口表、路由总数（16 条）、自测覆盖描述都补上了；顺带把过期的自检数字对齐（98 passed、24 个文件）。
4. **测试加反查**：路由用例新增 `assert.equal(routes.size, expected.length)`，以后漏登记路由不会再出现「仓库全绿」。

### 安装

1. 下载 `dsh-plugin-tts-0.4.4.zip`
2. **校验 SHA256**：

   ```bash
   # Windows
   Get-FileHash .\dsh-plugin-tts-0.4.4.zip -Algorithm SHA256
   # macOS / Linux
   shasum -a 256 dsh-plugin-tts-0.4.4.zip
   ```

   应为：`<该 Release 公布的 SHA256>`

3. **解压**，确认得到的 `dsh-plugin-tts/` 目录里**直接**有 `package.json`
4. DSH → **设置 → 插件管理 → 从本地安装**，选中那个 `dsh-plugin-tts` 目录
5. **刷新页面**，打开 **设置 → 语音合成**

### 验证

- `node test/standalone.test.mjs` → 98 passed, 0 failed
- `node test/render-smoke.mjs` → 0 failed
- 24 个文件，零 npm 依赖

---

下面这段是 0.4.3 的原文，留作存档：

## dsh-plugin-tts 0.4.3

**参考音频自动截到 15~60 秒（Base64 ≤10 MB）；唱歌有独立请求模板、(唱歌) 前缀自动补；「翻唱合成」页能自动搜歌词、选模型与预置音色（只有 `mimo-v2.5-tts` 会唱）。**

### 这个版本解决什么

1. **参考音频的旧限制和官方对不上**：旧版把上传的参考音频统一截到 30 秒 / 2.5 MB，用户传长音频会被悄悄砍掉。官方只要求 `.wav` / `.wave` / `.mp3` 且 Base64 后 ≤ 10 MB。现在：取消 30 秒截断与 2.5 MB 阈值，改为**自动截取 15~60 秒**（长一点克隆更准）——超过 60 秒不是简单取前 60 秒，而是找「有效语音最集中」的一段；不足 15 秒只提示不拦；超体积时明确说「Base64 后 X MB，上限 10 MB，可改用 MP3 或剪短」。默认自动按噪声底找首尾人声边界，从干净人声开始（避免合成开头带杂音）。
2. **唱歌参考卡片没有实际作用**：旧版「唱歌参考」只当歌词/音调素材、不进音色，还会让用户以为换它就能换唱歌音色。现在整张卡片删除，换成「合成模式 → 翻唱合成」页：**歌名自动搜歌词** → **选模型与预置音色**（小米只有 `mimo-v2.5-tts` 会唱，页面默认选它并列出 9 个预置音色；克隆 / 音色设计模型唱出来基本是念白）→ 后端合成唱歌人声（开头 `(唱歌)` 由代码自动补）→ 浏览器内与伴奏混音 → 试听/下载 48kHz 立体声 WAV。可调人声/伴奏增益与淡出；伴奏不上传、不需要本机装 ffmpeg。**AI 也能自己唱**：`tts_speak` 新增 `song` 参数，模型听到「唱一首晴天」时直接传歌名，服务端自己搜歌词、自己唱，不需要用户手动贴词。
3. **唱歌的请求模板现在自带**：请求模板里多了**唱歌请求头 / 唱歌请求体**两份，默认已按小米协议填好、与说话模板各自独立，不用手动配置；想给翻唱单独换模型或加 audio 参数时才需要动它。唱歌时文本开头的 `(唱歌)` 由代码自动补，自己写了也不会重复叠一层。

### 改动

- 参考音频支持 `.wav` / `.wave` / `.mp3`（与官方一致），**只限 Base64 ≤ 10 MB**
- 新增自动截取 15~60 秒：前端用前缀和找有效语音最集中的窗口；后端在有 ffmpeg 时对超长文件兜底 `-t 60`
- 删除「截取前 30 秒」的隐式截断；保留手动「起始/时长」输入框给需要的人（填了就不再自动截取）
- 新增自适应去静音：10% 分位估噪声底 → ×3 作阈值 → 两端各留 50ms
- 新增「原样上传」：不转码、不裁静音、不自动截取，直接传原文件（MP3 能放更长）
- 删除「唱歌参考」卡片；`singRef` 字段只为兼容旧配置保留，不参与合成
- 新增「合成模式 → 翻唱合成」页：搜歌词 / 歌词 / 风格词 / **模型与预置音色** / 伴奏 / 人声·伴奏增益 / 淡出 → 生成 → 试听 + 下载
- 翻唱页默认选 `mimo-v2.5-tts`（唯一支持唱歌的模型）并列出 9 个预置音色；选克隆 / 音色设计模型会标「不支持唱歌」并警告
- `synthesize` 新增单次 `model` 覆盖；唱歌没显式指定模型时自动改用 `mimo-v2.5-tts`（并在 `warnings` 说明），显式指定则尊重
- `tts_voices` 与 `/dsh-tts/config` 都暴露 `singing.models` / `singing.defaultModel` / `singing.voices`，控制台与 AI 看到的「谁能唱」口径一致
- 翻唱从独立卡片挪进「合成模式 → 翻唱合成」页（新页签），并删掉试听卡片里的「翻唱试听」：翻唱页本身生成后就地试听 + 下载
- `tts_speak` 新增 `song` 参数：AI 只给歌名，服务端自己搜歌词并唱（`text` 不再必填）；整首太长时按整行裁到约 600 字先唱一段，并在 `warnings` 里说明
- 新增 `POST /dsh-tts/lyrics`：网易云公开接口搜歌 + 取 LRC，`cleanLrc` 去掉时间标签、制作人行与标题行
- 新增 `tts.singHeaderTemplate` / `tts.singBodyTemplate`；唱歌时优先用它们，`(唱歌)` 前缀去重
- 混音走浏览器 `OfflineAudioContext`（零 ffmpeg 依赖），峰值归一化到 -1.5 dBFS、只压不抬
- 运行状态里的「唱歌音色」改为「唱歌：mimo-v2.5-tts（预置音色，只有它会唱）」

**只改小米模板**，Breeze 面板不受影响。

### 安装

1. 下载 `dsh-plugin-tts-0.4.3.zip`
2. **校验 SHA256**：

   ```bash
   # Windows
   Get-FileHash .\dsh-plugin-tts-0.4.3.zip -Algorithm SHA256
   # macOS / Linux
   shasum -a 256 dsh-plugin-tts-0.4.3.zip
   ```

   应为：`<该 Release 公布的 SHA256>`

3. **解压**，确认得到的 `dsh-plugin-tts/` 目录里**直接**有 `package.json`
4. DSH → **设置 → 插件管理 → 从本地安装**，选中那个 `dsh-plugin-tts` 目录
5. **刷新页面**，打开 **设置 → 语音合成**

详见 [README 的安装章节](README.md#安装)。

### 验证

- `node test/standalone.test.mjs` → 98 passed, 0 failed
- `node test/render-smoke.mjs` → 0 failed
- 24 个文件，零 npm 依赖
````