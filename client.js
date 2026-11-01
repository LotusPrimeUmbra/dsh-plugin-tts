/**
 * dsh-tts — Client half.
 *
 * 设置页里的独立一栏（settings.section），结构与交互对齐 qq-bridge 控制台里的 TTS 页面：
 * 协议切换（小米 MiMo / Breeze）、启用开关、调用优先级、模型/音色/风格、四种模式
 * （预置音色 / 音色设计 / 克隆音色 / 自定义）、参考音频上传与剪辑、请求模板、试听、发 QQ 语音。
 *
 * 数据全部走 Host 半注册的 /dsh-tts/*（同源 fetch），不依赖 Host RPC。
 * 样式只用 --dsw-alias-* 主题变量，跟随宿主明暗主题。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-tts",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = "/dsh-tts";

    const tone = {
      text: "var(--dsw-alias-label-primary)",
      dim: "var(--dsw-alias-label-secondary)",
      faint: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))",
      border: "var(--dsw-alias-border-l1)",
      borderStrong: "var(--dsw-alias-border-l2)",
      surface: "var(--dsw-alias-bg-layer-1)",
      surface2: "var(--dsw-alias-bg-layer-2)",
      brand: "var(--dsw-alias-brand-primary)",
      ok: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      error: "var(--dsw-alias-state-error-primary)",
    };

    const mono = "ui-monospace, SFMono-Regular, Consolas, monospace";

    /* ------------------------------------------------------------ transport */

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, options);
      const payload = await response.json().catch(() => null);
      if (payload === null || payload.ok !== true) {
        const message = (payload && payload.error) || `HTTP ${response.status}`;
        const error = new Error(message);
        if (payload && payload.needsConfirm) error.needsConfirm = true;
        throw error;
      }
      return payload;
    }

    function post(path, body) {
      return api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    }

    // 「还差哪一样」必须说清是哪一样：Key 已经存上、只差模型时，不能报成「还没填 Key」。
    // Host 的 routeReadyDetail.missing 是唯一口径（/config 与 /state 同一个函数算出）。
    const MISSING_LABEL = { apiKey: "Key", baseUrl: "接口地址", model: "模型" };

    function missingHint(detail, draftKey, panelLabel) {
      if (!detail || detail.ready) return null;
      if (!detail.apiKey) {
        return draftKey ? `（${panelLabel} Key 已填，点一下别处即自动保存）` : `（${panelLabel}还没填 Key）`;
      }
      const missing = Array.isArray(detail.missing) ? detail.missing : [];
      if (missing.includes("model")) return "（Key 已保存，还缺模型：点「拉取模型」选一个，或手填 model_id）";
      if (missing.includes("baseUrl")) return "（Key 已保存，还缺接口地址）";
      return `（${panelLabel}配置还没齐）`;
    }

    // 占位渲染：不满足就返回 null（React 不会渲染 null）。
    function hintSpan(detail, draftKey, panelLabel) {
      const text = missingHint(detail, draftKey, panelLabel);
      return text ? h("span", { style: { fontSize: 10, color: tone.warn } }, text) : null;
    }

    function gapText(detail) {
      const missing = detail && Array.isArray(detail.missing) ? detail.missing : [];
      return missing.map((key) => MISSING_LABEL[key] || key).join("、");
    }

    function guessMode(model) {
      const id = String(model || "");
      if (/voiceclone|voice-clone|-clone\b/i.test(id)) return "clone";
      if (/voicedesign|voice-design|-design\b/i.test(id)) return "voicedesign";
      if (/^mimo.*tts/i.test(id)) return "preset";
      return "custom";
    }

    /**
     * 切「合成模式」时要连带切到的模型。
     *
     * 模型和合成模式是同一件事的两个说法：只改其中一个就会分叉，而分叉的后果很具体 ——
     * 选了「克隆音色」但模型还是预置音色 TTS，参考音频会被当成音色名发出去（上游 400），
     * 用户听到的就是「明明选了克隆，念出来还是预置语音」。所以模式一变就把模型一起换掉。
     *
     * 只在当前模型是**官方模型**时替换：用户手填的自定义模型名不能被悄悄改掉。
     * @returns {string} 该模式对应的官方模型 id；没有就返回空串（表示不动模型）。
     */
    function modelForMode(mode, officialModels, currentModel) {
      const list = Array.isArray(officialModels) ? officialModels : [];
      const current = list.find((m) => m.id === currentModel);
      if (!current) return ""; // 手填模型：尊重用户，不替换
      return (list.find((m) => m.mode === mode) || {}).id || "";
    }

    function fmtBytes(bytes) {
      const n = Number(bytes) || 0;
      if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
      if (n >= 1024) return `${Math.round(n / 1024)} KB`;
      return `${n} B`;
    }

    function errText(err) {
      return String((err && err.message) || err || "未知错误");
    }

    /* --------------------------------------------------------- audio helpers */

    function audioContext() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error("浏览器没有 WebAudio，无法剪辑参考音频（可以关掉裁剪直接上传）");
      return new Ctx();
    }

    const TARGET_RATE = 24000;

    /** 解码任意音频 → 单声道 Float32（24kHz），浏览器负责重采样。 */
    async function decodeMono(file) {
      const buffer = await file.arrayBuffer();
      const ctx = audioContext();
      let decoded;
      try {
        decoded = await ctx.decodeAudioData(buffer.slice(0));
      } finally {
        void ctx.close();
      }
      const channels = decoded.numberOfChannels;
      let monoData;
      if (channels === 1) {
        monoData = decoded.getChannelData(0).slice(0);
      } else {
        monoData = new Float32Array(decoded.length);
        for (let c = 0; c < channels; c += 1) {
          const data = decoded.getChannelData(c);
          for (let i = 0; i < data.length; i += 1) monoData[i] += data[i] / channels;
        }
      }
      const rate = decoded.sampleRate;
      if (rate === TARGET_RATE) return { mono: monoData, rate: TARGET_RATE };
      const outLen = Math.max(1, Math.round((monoData.length * TARGET_RATE) / rate));
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i += 1) {
        const src = (i * rate) / TARGET_RATE;
        const i0 = Math.floor(src);
        const i1 = Math.min(monoData.length - 1, i0 + 1);
        const t = src - i0;
        out[i] = monoData[i0] * (1 - t) + monoData[i1] * t;
      }
      return { mono: out, rate: TARGET_RATE };
    }

    function rmsAt(monoData, start, size) {
      let sum = 0;
      const end = Math.min(monoData.length, start + size);
      if (end <= start) return 0;
      for (let i = start; i < end; i += 1) sum += monoData[i] * monoData[i];
      return Math.sqrt(sum / (end - start));
    }

    /** 找第一个「持续有声」的位置（跳过前奏/空白），找不到就 0。 */
    function findSpeechStart(monoData, rate) {
      const frame = Math.max(1, Math.round(rate * 0.05));
      const minRun = Math.round(rate * 0.15);
      let run = 0;
      for (let i = 0; i + frame <= monoData.length; i += frame) {
        if (rmsAt(monoData, i, frame) > 0.012) {
          run += frame;
          if (run >= minRun) return Math.max(0, i - (minRun - frame));
        } else {
          run = 0;
        }
      }
      return 0;
    }

    /** 两端去静音（阈值 0.008，最多保留 60ms 余量）。 */
    function trimSilence(monoData, rate) {
      const frame = Math.max(1, Math.round(rate * 0.02));
      let start = 0;
      let end = monoData.length;
      while (start + frame < end && rmsAt(monoData, start, frame) < 0.008) start += frame;
      while (end - frame > start && rmsAt(monoData, end - frame, frame) < 0.008) end -= frame;
      start = Math.max(0, start - Math.round(rate * 0.06));
      end = Math.min(monoData.length, end + Math.round(rate * 0.06));
      return monoData.subarray(start, end);
    }

    function sliceMono(monoData, rate, { startSec, lengthSec }) {
      const from = Math.max(0, Math.round((Number(startSec) || 0) * rate));
      const length = Math.max(1, Math.round((Number(lengthSec) || 0) * rate));
      return monoData.subarray(from, Math.min(monoData.length, from + length));
    }

    /** 参考音频的硬上限：上游对超长参考音频会直接拒（实测 30 秒以内都正常），超了自动截断。 */
    const REF_MAX_SECONDS = 30;
    /** 有效语音低于这个秒数，克隆音色复现会明显不稳（实测 2.9 秒时长变异 40.8%，8 秒降到 12.9%）。 */
    const REF_MIN_SPEECH_SECONDS = 5;

    /**
     * 统计「有效语音」秒数：只算音量过阈值的帧，静音段不计。
     *
     * 为什么单独量这个：文件总时长会把首尾静音、停顿一起算进去。用户传一段 6 秒的录音，
     * 真正说话的可能只有 2 秒，克隆效果照样差 —— 判断「够不够长」必须看有效语音。
     * 阈值与 trimSilence 对齐（0.008），避免两处口径不一致。
     */
    function measureSpeechSeconds(monoData, rate) {
      const frame = Math.max(1, Math.round(rate * 0.02));
      let voiced = 0;
      let total = 0;
      for (let i = 0; i + frame <= monoData.length; i += frame) {
        total += 1;
        if (rmsAt(monoData, i, frame) >= 0.008) voiced += 1;
      }
      if (!total) return 0;
      return (voiced / total) * (monoData.length / rate);
    }

    function concatMono(parts) {
      let total = 0;
      for (const part of parts) total += part.length;
      const out = new Float32Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }

    /** Float32 → 16-bit PCM WAV。 */
    function encodeWav(monoData, rate) {
      const dataSize = monoData.length * 2;
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);
      const write = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
      };
      write(0, "RIFF");
      view.setUint32(4, 36 + dataSize, true);
      write(8, "WAVE");
      write(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      write(36, "data");
      view.setUint32(40, dataSize, true);
      let offset = 44;
      for (let i = 0; i < monoData.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, monoData[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
      return new Uint8Array(buffer);
    }

    function bytesToBase64(bytes) {
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    function base64ToBlob(b64, mimeType) {
      const binary = atob(String(b64 || ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mimeType || "application/octet-stream" });
    }

    function blobName(blob, fallback) {
      const type = String(blob.type || "");
      if (type.includes("mpeg")) return `${fallback}.mp3`;
      if (type.includes("wav")) return `${fallback}.wav`;
      return `${fallback}.mp3`;
    }

    /** 把用户选的若干音频文件剪成一段 24kHz 单声道 WAV（多段按顺序拼接）。 */
    async function buildReferenceWav(files, options) {
      const parts = [];
      let counted = 0;
      for (const file of files) {
        const decoded = await decodeMono(file);
        let data = decoded.mono;
        if (options.trimSilence !== false) data = trimSilence(data, decoded.rate);
        parts.push(data);
        counted += 1;
      }
      let merged = parts.length === 1 ? parts[0] : concatMono(parts);
      if (options.autoPick) {
        const start = findSpeechStart(merged, TARGET_RATE);
        merged = merged.subarray(start);
      }
      const startSec = Number(options.startSec) || 0;
      const lengthSec = Number(options.lengthSec) || 0;
      if (startSec > 0 || lengthSec > 0) {
        merged = sliceMono(merged, TARGET_RATE, {
          startSec: options.autoPick ? 0 : startSec,
          lengthSec: lengthSec > 0 ? lengthSec : Math.max(1, merged.length / TARGET_RATE),
        });
      }
      // 上游对超长参考音频会拒（HTTP 414 URI Too Long 一类），统一截到 30 秒以内。
      // 先量再截：截断后有效语音可能变得更短，警告要按最终这段来算。
      const beforeSec = merged.length / TARGET_RATE;
      if (beforeSec > REF_MAX_SECONDS) {
        merged = sliceMono(merged, TARGET_RATE, { startSec: 0, lengthSec: REF_MAX_SECONDS });
      }
      const seconds = merged.length / TARGET_RATE;
      const speechSeconds = measureSpeechSeconds(merged, TARGET_RATE);
      const wav = encodeWav(merged, TARGET_RATE);
      return {
        bytes: wav,
        seconds,
        speechSeconds,
        trimmed: beforeSec > REF_MAX_SECONDS,
        originalSeconds: beforeSec,
        files: counted,
      };
    }

    /* --------------------------------------------------------------- controls */

    const inputStyle = {
      width: "100%",
      boxSizing: "border-box",
      padding: "6px 9px",
      fontSize: 12,
      color: tone.text,
      background: tone.surface2,
      border: `1px solid ${tone.border}`,
      borderRadius: 6,
      outline: "none",
      fontFamily: "inherit",
      lineHeight: 1.5,
      // 让 select 下拉、number 步进器等原生控件跟随深浅色
      colorScheme: "light dark",
    };

    function Card({ title, desc, extra, children }) {
      return h(
        "section",
        {
          style: {
            border: `1px solid ${tone.border}`,
            borderRadius: 10,
            background: tone.surface,
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          },
        },
        title || extra
          ? h(
              "div",
              { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
              title ? h("div", { style: { fontSize: 13, fontWeight: 600, color: tone.text } }, title) : null,
              desc ? h("div", { style: { fontSize: 11, color: tone.faint } }, desc) : null,
              h("div", { style: { flex: "1 1 auto" } }),
              extra || null,
            )
          : null,
        children,
      );
    }

    // 卡片内的结果行：保存成功 / 失败就近显示在触发它的那张卡片底部。
    // 文案为空时不占位；kind=error 用作色，其余走 ok 色。
    // overflowWrap:anywhere —— 探活失败文案里带完整 URL（https://api.breeze.blue/v1/models），
    // 没有断行机会时会撑破容器、把同一行的其它控件顶到下一行去。
    function CardNote({ note }) {
      if (!note || !note.text) return null;
      return h(
        "div",
        {
          role: "status",
          style: {
            fontSize: 11,
            lineHeight: 1.55,
            minWidth: 0,
            overflowWrap: "anywhere",
            wordBreak: "break-word",
            color: note.kind === "error" ? tone.error : note.kind === "warn" ? tone.warn : tone.ok,
          },
        },
        note.text,
      );
    }

    function Field({ label, hint, children, width }) {
      return h(
        "label",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 4,
            minWidth: 0,
            width: width || "auto",
            flex: width ? "0 0 auto" : "1 1 160px",
          },
        },
        h("span", { style: { fontSize: 11, color: tone.dim } }, label),
        children,
        hint ? h("span", { style: { fontSize: 10, color: tone.faint, lineHeight: 1.45 } }, hint) : null,
      );
    }

    function Row({ children, gap = 10, align = "flex-start" }) {
      return h("div", { style: { display: "flex", gap, flexWrap: "wrap", alignItems: align } }, children);
    }

    function Switch({ checked, onChange, label, disabled, hint }) {
      const on = checked === true;
      return h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": on,
          disabled,
          onClick: () => {
            if (!disabled) onChange(!on);
          },
          title: hint || "",
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: disabled ? "not-allowed" : "pointer",
            color: tone.text,
            fontSize: 12,
            opacity: disabled ? 0.5 : 1,
          },
        },
        h(
          "span",
          {
            style: {
              width: 32,
              height: 19,
              borderRadius: 10,
              background: on ? tone.brand : tone.borderStrong,
              position: "relative",
              transition: "background .15s",
              flex: "0 0 auto",
            },
          },
          h("span", {
            style: {
              position: "absolute",
              top: 2,
              left: on ? 15 : 2,
              width: 15,
              height: 15,
              borderRadius: 8,
              // 品牌色在深色主题里是「反色」（深色模式下 brand 为亮白），
              // 所以开关圆钮必须用 bg-base，不能写死 #fff，否则深色下白底白点。
              background: "var(--dsw-alias-bg-base)",
              transition: "left .15s",
              boxShadow: "0 1px 2px rgba(0,0,0,.25)",
            },
          }),
        ),
        label,
      );
    }

    function Btn({ children, onClick, disabled, kind = "normal", title }) {
      const primary = kind === "primary";
      const danger = kind === "danger";
      return h(
        "button",
        {
          type: "button",
          onClick,
          disabled,
          title: title || "",
          style: {
            padding: "6px 12px",
            fontSize: 12,
            borderRadius: 6,
            cursor: disabled ? "not-allowed" : "pointer",
            border: `1px solid ${primary ? tone.brand : danger ? tone.error : tone.border}`,
            background: primary ? tone.brand : "transparent",
            // 文字用 bg-base：浅色主题下 brand 是深底、bg-base 是白字；
            // 深色主题下 brand 是白底、bg-base 是深字，写死 #fff 会白底白字。
            color: primary ? "var(--dsw-alias-bg-base)" : danger ? tone.error : tone.text,
            opacity: disabled ? 0.5 : 1,
            whiteSpace: "nowrap",
            fontFamily: "inherit",
          },
        },
        children,
      );
    }

    function Tabs({ items, value, onChange }) {
      return h(
        "div",
        { style: { display: "flex", gap: 4, borderBottom: `1px solid ${tone.border}`, paddingBottom: 6, flexWrap: "wrap" } },
        items.map((item) =>
          h(
            "button",
            {
              key: item.value,
              type: "button",
              onClick: () => onChange(item.value),
              style: {
                padding: "5px 11px",
                fontSize: 12,
                borderRadius: 6,
                border: `1px solid ${value === item.value ? tone.brand : "transparent"}`,
                background: value === item.value ? tone.surface2 : "transparent",
                color: value === item.value ? tone.text : tone.dim,
                cursor: "pointer",
                fontFamily: "inherit",
              },
            },
            item.label,
          ),
        ),
      );
    }

    function Note({ children, kind = "hint" }) {
      const color = kind === "error" ? tone.error : kind === "ok" ? tone.ok : kind === "warn" ? tone.warn : tone.faint;
      return h("div", { style: { fontSize: 11, color, lineHeight: 1.55 } }, children);
    }

    function Dot({ color }) {
      return h("span", { style: { width: 8, height: 8, borderRadius: 4, background: color, flex: "0 0 auto", display: "inline-block" } });
    }

    /* ------------------------------------------------------------ voice grid */

    function VoiceGrid({ voices, current, onUse, onPreview, busy }) {
      return h(
        "div",
        { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 } },
        (voices || []).map((voice) => {
          const active = current === voice.id;
          return h(
            "div",
            {
              key: voice.id,
              style: {
                border: `1px solid ${active ? tone.brand : tone.border}`,
                background: active ? tone.surface2 : "transparent",
                borderRadius: 8,
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 5,
              },
            },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 6 } },
              active ? h(Dot, { color: tone.brand }) : null,
              h("span", { style: { fontSize: 12, color: tone.text, fontWeight: active ? 600 : 400 } }, voice.name || voice.id),
              h("span", { style: { fontSize: 10, color: tone.faint } }, voice.lang || ""),
            ),
            voice.note ? h("div", { style: { fontSize: 10, color: tone.faint, lineHeight: 1.4 } }, voice.note) : null,
            h(
              "div",
              { style: { display: "flex", gap: 6, marginTop: 2 } },
              h(Btn, { onClick: () => onPreview(voice.id), disabled: busy, title: "用这个音色试听当前文本" }, "试听"),
              h(
                Btn,
                {
                  kind: active ? "normal" : "primary",
                  onClick: () => onUse(voice.id),
                  disabled: busy || active,
                },
                active ? "使用中" : "使用",
              ),
            ),
          );
        }),
      );
    }

    /* ------------------------------------------------------- template editor */

    function TemplateBlock({ kind, config, form, busy, onSave, onReset }) {
      const [header, setHeader] = useState(form.headerTemplate);
      const [body, setBody] = useState(form.bodyTemplate);
      const [open, setOpen] = useState(false);
      const defaults = kind === "breeze"
        ? (config.styleDefaults && config.styleDefaults.breeze) || {}
        : (config.styleDefaults && config.styleDefaults.openai) || {};
      const placeholders = Array.isArray(config.placeholders) ? config.placeholders : [];

      useEffect(() => {
        setHeader(form.headerTemplate);
        setBody(form.bodyTemplate);
      }, [form.headerTemplate, form.bodyTemplate]);

      const save = () => onSave({ headerTemplate: header, bodyTemplate: body });
      const reset = () => {
        const nextHeader = defaults.headerTemplate || "";
        const nextBody = defaults.bodyTemplate || "";
        setHeader(nextHeader);
        setBody(nextBody);
        onSave({ headerTemplate: nextHeader, bodyTemplate: nextBody });
      };

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8 } },
        h(
          "button",
          {
            type: "button",
            onClick: () => setOpen((v) => !v),
            style: {
              alignSelf: "flex-start",
              border: "none",
              background: "transparent",
              color: tone.dim,
              fontSize: 11,
              cursor: "pointer",
              padding: 0,
              fontFamily: "inherit",
            },
          },
          open ? "▾ 请求头 / 请求体模板（高级）" : "▸ 请求头 / 请求体模板（高级）",
        ),
        open
          ? h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 8 } },
              h(
                Row,
                { gap: 10 },
                h(
                  Field,
                  { label: "请求头模板", hint: "每行一个 Header，用 {{API_KEY}} 等占位符。留空 = 用内置默认。" },
                  h("textarea", {
                    value: header,
                    rows: 4,
                    spellCheck: false,
                    onChange: (e) => setHeader(e.target.value),
                    style: { ...inputStyle, fontFamily: mono, fontSize: 11, resize: "vertical" },
                  }),
                ),
                h(
                  Field,
                  { label: "请求体模板", hint: "必须能拼成合法 JSON；文本用 {{SPEECH}}（含风格标签）。" },
                  h("textarea", {
                    value: body,
                    rows: 8,
                    spellCheck: false,
                    onChange: (e) => setBody(e.target.value),
                    style: { ...inputStyle, fontFamily: mono, fontSize: 11, resize: "vertical" },
                  }),
                ),
              ),
              h(
                Row,
                { gap: 8, align: "center" },
                h(Btn, { kind: "primary", onClick: save, disabled: busy }, "保存模板"),
                h(Btn, { onClick: reset, disabled: busy }, "恢复内置默认"),
                h("span", { style: { fontSize: 10, color: tone.faint, lineHeight: 1.5 } },
                  `可用占位符：${placeholders.join(" / ")}（都可加 _JSON 后缀做 JSON 转义）`),
              ),
            )
          : null,
      );
    }

    /* -------------------------------------------------------- reference block */

    function RefBlock({ kind, config, busy, onUpload, onClear, onBackup, onFetchUrl, note }) {
      const info = kind === "sing" ? config.singRef : config.clone;
      const layout = (config.refLayout && config.refLayout[kind === "sing" ? "sing" : "clone"]) || {};
      const [files, setFiles] = useState([]);
      // lengthSec 默认 0 = 整段（后端统一截到 30 秒以内）：克隆需要尽量多的有效语音，
      // 默认截 6 秒会把一段 20 秒的录音白白砍掉三分之二，反而更容易出现音色不稳。
      const [options, setOptions] = useState({ autoPick: true, lengthSec: "0", startSec: "0", trim: true });
      const [url, setUrl] = useState("");
      const fileRef = useRef(null);
      const audioRef = useRef(null);
      const ready = Boolean(info && info.ready);
      const label = kind === "sing" ? "唱歌参考" : "说话音色";
      const playing = useRef(false);

      const upload = async () => {
        const picked = (fileRef.current && fileRef.current.files && Array.from(fileRef.current.files)) || files;
        if (!picked || !picked.length) return;
        const result = await onUpload(kind, picked, {
          autoPick: options.autoPick,
          lengthSec: Number(options.lengthSec) || 0,
          startSec: Number(options.startSec) || 0,
          trimSilence: options.trim,
        });
        // 上传成功后清空选择，避免再点一次重复上传同一份文件
        if (result) {
          setFiles([]);
          if (fileRef.current) fileRef.current.value = "";
        }
      };

      const fromUrl = () => {
        if (!String(url).trim()) return;
        void onFetchUrl(kind, String(url).trim(), {
          autoPick: options.autoPick,
          lengthSec: Number(options.lengthSec) || 0,
          startSec: Number(options.startSec) || 0,
          trimSilence: options.trim,
        });
      };

      return h(
        "div",
        {
          style: {
            border: `1px solid ${tone.border}`,
            borderRadius: 8,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 9,
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h(Dot, { color: ready ? tone.ok : tone.faint }),
          h("span", { style: { fontSize: 12, color: tone.text, fontWeight: 600 } }, label),
          ready
            ? h("span", { style: { fontSize: 11, color: tone.dim } }, `${info.fileName} · ${fmtBytes(info.bytes)}`)
            : h("span", { style: { fontSize: 11, color: tone.faint } }, "未上传"),
          ready && info.seconds
            ? h(
                "span",
                { style: { fontSize: 11, color: tone.dim } },
                `· ${info.seconds.toFixed(1)} 秒`
                  + (info.speechSeconds ? `（有效语音 ${info.speechSeconds.toFixed(1)} 秒）` : ""),
              )
            : null,
          h("span", { style: { flex: "1 1 auto" } }),
          ready ? h(Btn, { onClick: () => onClear(kind), disabled: busy }, "清除") : null,
          ready ? h(Btn, { onClick: () => onBackup(kind, "list"), disabled: busy }, "备份列表") : null,
          h(Btn, { onClick: () => onBackup(kind, "open"), disabled: busy }, "打开目录"),
          ready && info.backups && info.backups.count ? h(Btn, { kind: "danger", onClick: () => onBackup(kind, "clear"), disabled: busy }, "清空备份") : null,
        ),
        // 说话音色的有效语音太短：常驻提示，不是上传那一秒闪一下。
        // 克隆是拿这段音频去复刻音色和语速的，样本太短时上游每次的复现都不同，
        // 用户听到的就是「每次合成声音都不太一样」，很容易误以为是没走克隆。
        kind !== "sing" && info && info.tooShort
          ? h(
              "div",
              {
                role: "alert",
                style: {
                  fontSize: 11,
                  lineHeight: 1.55,
                  color: tone.warn,
                  background: tone.surface2,
                  border: `1px solid ${tone.warn}`,
                  borderRadius: 6,
                  padding: "6px 9px",
                  overflowWrap: "anywhere",
                },
              },
              `参考音频过短：有效语音仅 ${info.speechSeconds.toFixed(1)} 秒，克隆效果会不稳定`
                + `（同一句话每次合成的语速和音色都会有出入）。建议重新上传一段 10~30 秒连续说话的录音，`
                + `超过 30 秒会自动截取前 30 秒。`,
            )
          : null,
        h(
          "div",
          { style: { fontSize: 10, color: tone.faint, lineHeight: 1.5 } },
          kind === "sing"
            ? "唱歌参考只当歌词 / 音调 / 旋律的素材参考，不会被写进音色；唱歌时音色始终来自说话音色。"
            : "只有参考音频里的音色被复刻。建议上传 10~30 秒连续说话的录音：太短（有效语音 < 5 秒）会让克隆出的音色和语速每次都不同，超过 30 秒会自动截取前 30 秒。",
          layout.dir ? ` 目录：${layout.dir}` : "",
          info && info.backups && info.backups.count
            ? ` ｜ 备份 ${info.backups.count} 份 / ${fmtBytes(info.backups.bytes)}（最多保留 ${info.backups.keepLimit || 30} 份）`
            : "",
        ),
        h(
          Row,
          { gap: 8, align: "center" },
          h(
            "label",
            {
              style: {
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 11px",
                borderRadius: 6,
                cursor: busy ? "default" : "pointer",
                border: `1px solid ${tone.border}`,
                background: tone.surface2,
                color: tone.text,
                fontSize: 12,
              },
            },
            "选择文件",
            h("input", {
              ref: fileRef,
              type: "file",
              accept: ".mp3,.wav,audio/mpeg,audio/wav",
              multiple: true,
              onChange: (e) => setFiles(Array.from(e.target.files || [])),
              style: { display: "none" },
            }),
          ),
          h(
            "span",
            {
              style: {
                fontSize: 11,
                color: files.length ? tone.text : tone.faint,
                maxWidth: 190,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
              title: files.map((f) => f.name).join("\n"),
            },
            files.length ? files.map((f) => f.name).join("、") : "未选择文件",
          ),
          h(Btn, { kind: "primary", onClick: upload, disabled: busy || !files.length }, busy === `upload-${kind}` ? "上传中…" : "上传 / 替换"),
          h(
            "label",
            { style: { fontSize: 11, color: tone.dim, display: "inline-flex", gap: 4, alignItems: "center" } },
            h("input", {
              type: "checkbox",
              checked: options.trim,
              onChange: (e) => setOptions((prev) => ({ ...prev, trim: e.target.checked })),
            }),
            "去静音",
          ),
          h(
            "label",
            { style: { fontSize: 11, color: tone.dim, display: "inline-flex", gap: 4, alignItems: "center" } },
            h("input", {
              type: "checkbox",
              checked: options.autoPick,
              onChange: (e) => setOptions((prev) => ({ ...prev, autoPick: e.target.checked })),
            }),
            "自动找起点",
          ),
          h(
            "label",
            { style: { fontSize: 11, color: tone.dim, display: "inline-flex", gap: 4, alignItems: "center" } },
            "截取",
            h("input", {
              type: "number",
              min: 0,
              step: 1,
              value: options.startSec,
              onChange: (e) => setOptions((prev) => ({ ...prev, startSec: e.target.value })),
              style: { ...inputStyle, width: 62, padding: "3px 6px" },
              title: "起始秒数（自动找起点时忽略）",
            }),
            "秒起",
            h("input", {
              type: "number",
              min: 0,
              step: 1,
              value: options.lengthSec,
              onChange: (e) => setOptions((prev) => ({ ...prev, lengthSec: e.target.value })),
              style: { ...inputStyle, width: 62, padding: "3px 6px" },
              title: "截取时长（0 = 整段）",
            }),
            "秒",
          ),
        ),
        h(
          Row,
          { gap: 8, align: "center" },
          h("input", {
            value: url,
            placeholder: "从链接导入音频（http/https，mp3 / wav）",
            onChange: (e) => setUrl(e.target.value),
            style: { ...inputStyle, flex: "1 1 260px", maxWidth: 420 },
          }),
          h(Btn, { onClick: fromUrl, disabled: busy }, busy === `url-${kind}` ? "下载中…" : "导入链接"),
          ready
            ? h(Btn, {
                onClick: () => {
                  const audio = audioRef.current;
                  if (!audio) return;
                  if (playing.current) {
                    audio.pause();
                    playing.current = false;
                  } else {
                    audio.src = `${API}/ref-audio?kind=${kind === "sing" ? "sing" : "clone"}&t=${Date.now()}`;
                    void audio.play().then(() => { playing.current = true; }).catch(() => {});
                  }
                },
                disabled: busy,
              }, "播放参考")
            : null,
        ),
        h("audio", { ref: audioRef, style: { width: "100%", height: 0, opacity: 0 }, onEnded: () => { playing.current = false; } }),
        // 上传 / 清除 / 备份 / 链接导入的结果就近显示在这一块里。
        h(CardNote, { note }),
      );
    }

    /* --------------------------------------------------------------- panels */

    function MimoPanel({ config, form, setForm, busy, actions, note, fetchNote, refNotes }) {
      const f = form.mimo;
      const patch = (value) => setForm((prev) => ({ ...prev, mimo: { ...prev.mimo, ...value } }));
      const [msg, setMsg] = useState(null);
      const [pvText, setPvText] = useState("你好，我是 DeepSeek，这是「小米 MiMo」的试听。");
      const [pvSing, setPvSing] = useState(false);
      const [pvResult, setPvResult] = useState(null);
      // Key 的保存结果就近显示在输入框下面：结果跑到页面别处时，用户会以为没反应。
      // 现在 Key 填完失焦即自动保存，不用再点按钮。
      const [keyMsg, setKeyMsg] = useState(null);
      // 自定义风格词的保存结果，同样就近显示在输入框下面。
      const [styleMsg, setStyleMsg] = useState(null);
      const autoSaveKeyNow = async () => {
        const key = String(f.apiKey || "").trim();
        if (!key) return;
        setKeyMsg({ ok: true, text: "保存中…" });
        const payload = await actions.autoSaveKey("mimo", key);
        if (!payload || payload.ok === false) {
          setKeyMsg({ ok: false, text: payload ? payload.error : "保存失败，看页面顶部提示" });
          return;
        }
        setKeyMsg({ ok: true, text: `已自动保存并生效${payload.apiKeyHint ? `（当前 ${payload.apiKeyHint}）` : ""}` });
      };
      const runPreview = async (voice, extra = {}) => {
        const payload = await actions.preview({ kind: "openai", text: pvText, sing: pvSing, voice, ...extra });
        if (!payload) return;
        setPvResult(payload.ok === false ? { ok: false, error: payload.error } : { ok: true, payload });
      };
      // 自定义风格词：失焦即自动落盘（与 API Key 同一套交互）。
      // 只提交 style 一个字段，不跑模型检查、不碰其它配置。
      const autoSaveStyleNow = async () => {
        const custom = String(f.styleCustom || "").trim();
        // 输入框为空时把风格落回下拉选中的值（用户清空自定义词 = 想用下拉那个）。
        const value = custom || String(f.style || "").trim();
        if (value === String(config.style || "")) return; // 没变化就不打请求
        setStyleMsg({ ok: true, text: "保存中…" });
        const payload = await actions.saveMimo({ check: false, silent: true, patch: { style: value } });
        if (!payload || payload.ok === false) {
          setStyleMsg({ ok: false, text: payload ? payload.error : "保存失败" });
          return;
        }
        setStyleMsg({ ok: true, text: value ? `已自动保存「${value}」` : "已清空风格" });
      };
      const saveWithCheck = async () => {
        setMsg(null);
        // 输入框里可能还有没来得及失焦保存的 Key：先落盘，再保存配置，避免两次请求抢跑。
        if (String(f.apiKey || "").trim()) await autoSaveKeyNow();
        const payload = await actions.saveMimo({ check: true, patch: {} });
        if (!payload) return;
        if (payload.ok === false) { setMsg({ ok: false, text: payload.error }); return; }
        const detail = payload.routeReadyDetail && payload.routeReadyDetail.mimo;
        const keyState = detail && detail.apiKey
          ? `Key 已自动保存并生效（${payload.apiKeyHint || "已保存"}）`
          : "Key 未生效：先在上方填 Key，失焦后会自动保存";
        const lack = detail && gapText(detail);
        const modelState = payload.check
          ? (payload.check.ok ? `模型拉取正常（${payload.check.count} 个）` : `模型检查失败：${payload.check.error}`)
          : "已跳过模型检查";
        setMsg({ ok: !payload.check || payload.check.ok, text: `配置已保存 · ${modelState} · ${keyState}${lack ? ` · 还缺 ${lack}` : ""}` });
      };
      const modelOptions = [];
      for (const item of config.officialModels || []) modelOptions.push({ id: item.id, label: `${item.label}（${item.id}）` });
      for (const id of config.models || []) if (!modelOptions.some((m) => m.id === id)) modelOptions.push({ id, label: id });
      if (f.model && !modelOptions.some((m) => m.id === f.model)) modelOptions.push({ id: f.model, label: f.model });
      const styleGroups = Array.isArray(config.stylePresets) ? config.stylePresets : [];

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 10 } },

        h(
          Card,
          { title: "接口与模型", desc: "MiMo（OpenAI 风格 /chat/completions）" },
          h(
            Row,
            { gap: 10 },
            h(Field, { label: "接口地址", width: 320 }, h("input", {
              value: f.baseUrl,
              spellCheck: false,
              onChange: (e) => patch({ baseUrl: e.target.value }),
              placeholder: "https://api.xiaomimimo.com/v1/chat/completions",
              style: inputStyle,
            })),
          ),
          // Key 输入框单独一行、失焦即自动保存：不再有「保存 Key」按钮，
          // 也不会被其它保存动作清空（用户报过点了没反应、Key 白填）。
          h(Field, { label: "API Key", width: 320, hint: f.apiKeyHint ? `当前：${f.apiKeyHint}（重新填写会覆盖）` : "还没有设置" },
            h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              h("input", {
                type: "password",
                value: f.apiKey,
                onChange: (e) => patch({ apiKey: e.target.value }),
                onBlur: () => { void autoSaveKeyNow(); },
                placeholder: "粘贴后点一下别处（失焦即自动保存）",
                style: { ...inputStyle, flex: "1 1 auto", minWidth: 0 },
              }),
              keyMsg
                ? h("span", { style: { fontSize: 10, color: keyMsg.ok ? tone.ok : tone.error } }, keyMsg.text)
                : h("span", { style: { fontSize: 10, color: tone.dim } }, "填完点一下别处即自动保存"),
            ),
          ),
          // 第一行：模型下拉 + 拉取按钮。
          h(
            Row,
            { gap: 10, align: "flex-end" },
            h(Field, { label: "模型", width: 320 }, h(
              "select",
              { value: f.model, onChange: (e) => {
                const model = e.target.value;
                patch({ model, mode: guessMode(model) });
              }, style: inputStyle },
              modelOptions.map((m) => h("option", { key: m.id, value: m.id }, m.label)),
            )),
            h(Btn, { onClick: () => actions.fetchModels("openai"), disabled: busy }, busy === "models-openai" ? "拉取中…" : "拉取模型"),
          ),
          // 拉取结果**独占一行**、紧跟在【拉取模型】按钮下面（成功/失败都显示）。
          // 以前把它当成 Row 里的一个普通 flex 项：长文案（拉到 N 个模型：a / b / c，
          // 或带完整 URL 的超时报错）会撑开整行，把手填框挤到下一行，看起来就像
          // 「通知跑到很下面去了」。独占一行后它永远在按钮正下方。
          h(CardNote, { note: fetchNote }),
          // 第二行：手填框与它的【使用手填】必须挨在一起，中间不隔任何控件。
          h(
            Row,
            { gap: 10, align: "flex-end" },
            // 手填 Field 必须给 width：不给就落到默认的 flex:"1 1 160px"，
            // 容器会吃满整行剩余宽度，输入框固定 180px 靠左、按钮被顶到行尾。
            h(Field, { label: "手填模型 id（可选）", width: 200 }, h("input", {
              value: f.modelCustom,
              placeholder: "如 mimo-v2.6-tts",
              onChange: (e) => patch({ modelCustom: e.target.value }),
              style: { ...inputStyle, width: 190 },
            })),
            // 「使用手填」紧跟在手填框后面，别被格式等无关控件隔开。
            h(Btn, {
              onClick: () => { if (f.modelCustom.trim()) patch({ model: f.modelCustom.trim(), mode: guessMode(f.modelCustom.trim()) }); },
              disabled: busy || !f.modelCustom.trim(),
            }, "使用手填"),
            h(Field, { label: "格式", width: 110 }, h(
              "select",
              { value: f.format, onChange: (e) => patch({ format: e.target.value }), style: inputStyle },
              ["wav", "mp3", "pcm16", "pcm"].map((fmt) => h("option", { key: fmt, value: fmt }, fmt)),
            )),
            h(Field, { label: "单次上限（字符）", width: 130 }, h("input", {
              type: "number",
              min: 20,
              value: f.maxChars,
              onChange: (e) => patch({ maxChars: e.target.value }),
              style: inputStyle,
            })),
          ),
          h(Note, null, `当前模型模式：${f.mode === "preset" ? "预置音色" : f.mode === "voicedesign" ? "音色设计" : f.mode === "clone" ? "克隆音色" : "自定义"}`
            + ` ｜ 小米延迟均值 ${(config.latency && config.latency.mimo && config.latency.mimo.avgMs) ? `${Math.round(config.latency.mimo.avgMs)} ms` : "暂无样本"}`),
        ),

        h(
          Card,
          { title: "说话风格" },
          h(
            Row,
            { gap: 10 },
            h(Field, { label: "风格词", width: 200 }, h(
              "select",
              {
                value: f.style,
                // 从下拉里选一个 = 想用这个预置风格，所以顺手清掉自定义词；
                // 否则自定义词一直「优先于下拉」，选了也没反应，又是一个「点了没用」。
                onChange: (e) => { patch({ style: e.target.value, styleCustom: "" }); setStyleMsg(null); },
                style: inputStyle,
              },
              h("option", { value: "" }, "（无）"),
              styleGroups.map((group) =>
                h("optgroup", { key: group.group, label: group.group },
                  (group.items || []).map((item) => h("option", { key: item, value: item }, item))),
              ),
            )),
            h(Field, { label: "自定义风格词（优先于下拉）", hint: "填完点一下别处即自动保存" },
              h("input", {
                value: f.styleCustom,
                placeholder: "如 开心 / 粤语 / 悄悄话",
                onChange: (e) => patch({ styleCustom: e.target.value }),
                // 与 API Key 一致：填完失焦即落盘。以前只在点「保存并检查」时才合并进 style，
                // 而保存成功后 fromConfig 又会把输入框重置成空，看起来就是「填了又消失」。
                onBlur: () => { void autoSaveStyleNow(); },
                style: { ...inputStyle, minWidth: 220 },
              }),
              styleMsg
                ? h("span", { style: { fontSize: 10, color: styleMsg.ok ? tone.ok : tone.error } }, styleMsg.text)
                : null),
            h(Field, { label: "风格落位", width: 220 }, h(
              "select",
              { value: f.styleMode, onChange: (e) => patch({ styleMode: e.target.value }), style: inputStyle },
              h("option", { value: "user" }, "填进提示词（user 角色）"),
              h("option", { value: "inline" }, "直接拼在文本最前面"),
            )),
            h(Field, { label: "唱歌风格词", width: 150, hint: "必须含「唱歌」" }, h("input", {
              value: f.singStyle,
              onChange: (e) => patch({ singStyle: e.target.value }),
              style: inputStyle,
            })),
          ),
          h(Note, null, "唱歌是独立风格：唱歌时代码强制把唱歌风格写在文本开头、并独占风格位，不会与说话风格混用。"),
        ),

        h(
          Card,
          { title: "合成模式", desc: "预置音色 / 音色设计 / 克隆音色 / 自定义" },
          h(Tabs, {
            value: f.mode,
            // 切换模式必须连模型一起切，否则「克隆音色 + 预置模型」这种分叉会让参考音频
            // 被当成音色名发出去（上游 400），表现就是「选了克隆却念成预置语音」。
            onChange: (value) => {
              const model = modelForMode(value, config.officialModels, f.model);
              patch(model ? { mode: value, model } : { mode: value });
            },
            items: [
              { value: "preset", label: "预置音色" },
              { value: "voicedesign", label: "音色设计" },
              { value: "clone", label: "克隆音色" },
              { value: "custom", label: "自定义" },
            ],
          }),
          f.mode === "preset"
            ? h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 8 } },
                h(VoiceGrid, {
                  voices: config.presetVoices || [],
                  current: f.voice,
                  busy,
                  onUse: (id) => {
                    // 用预置音色 = 切回预置音色模式，模型也要跟着回到预置模型，
                    // 否则会留下「预置音色 + 克隆模型」的分叉（同样 400）。
                    const model = modelForMode("preset", config.officialModels, f.model);
                    const nextPatch = model ? { voice: id, mode: "preset", model } : { voice: id, mode: "preset" };
                    patch(nextPatch);
                    void actions.saveMimo({ check: false, silent: true, patch: nextPatch });
                  },
                  onPreview: (id) => { void runPreview(id); },
                }),
                f.voice ? h(Note, null, `当前音色：${f.voice}`) : h(Note, { kind: "warn" }, "还没有选音色。"),
              )
            : null,
          f.mode === "voicedesign"
            ? h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 8 } },
                h(Field, { label: "音色描述", hint: "用一段话描述想要的声音：年龄、性别、音色、语气、语速……" }, h("textarea", {
                  value: f.design,
                  rows: 4,
                  onChange: (e) => patch({ design: e.target.value }),
                  placeholder: "例：一位二十多岁的年轻女性，声音清亮温柔，语速稍快，带一点笑意。",
                  style: { ...inputStyle, resize: "vertical", lineHeight: 1.6 },
                })),
                h(Btn, { onClick: () => { void runPreview(undefined, { design: f.design }); }, disabled: busy }, "用这段描述试听"),
              )
            : null,
          f.mode === "clone"
            ? h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 8 } },
                h(RefBlock, {
                  kind: "clone",
                  config,
                  busy,
                  note: refNotes ? refNotes["ref-clone"] : null,
                  onUpload: actions.uploadRef,
                  onClear: actions.clearRef,
                  onBackup: actions.refBackup,
                  onFetchUrl: actions.fetchRefUrl,
                }),
                h(RefBlock, {
                  kind: "sing",
                  config,
                  busy,
                  note: refNotes ? refNotes["ref-sing"] : null,
                  onUpload: actions.uploadRef,
                  onClear: actions.clearRef,
                  onBackup: actions.refBackup,
                  onFetchUrl: actions.fetchRefUrl,
                }),
              )
            : null,
          f.mode === "custom"
            ? h(Note, null, "自定义模式：用你在「请求头 / 请求体模板」里写的模板直接请求上游，适用于自建或第三方兼容接口。"
              + " 模型 id 手填、音色用 {{VOICE}} 自行拼接，代码不会替你猜参数。")
            : null,
        ),

        h(
          Card,
          { title: "请求模板", desc: "改模板前先试听一次，确认能通" },
          h(TemplateBlock, {
            kind: "mimo",
            config,
            form: f,
            busy,
            // 模板编辑是组件内部状态，保存时必须把刚编辑的值作为 patch 一起提交，
            // 不能只靠 setForm（异步），否则会被 form 里的旧模板覆盖。
            onSave: (patchValue) => { void actions.saveMimo({ check: false, patch: patchValue }); },
            onReset: (patchValue) => { void actions.saveMimo({ check: false, patch: patchValue }); },
          }),
        ),

        h(PreviewBlock, {
          label: "小米 MiMo",
          busy,
          text: pvText,
          onText: setPvText,
          sing: pvSing,
          onSing: setPvSing,
          result: pvResult,
          onRun: () => runPreview(),
        }),

        h(
          Row,
          { gap: 8, align: "center" },
          h(Btn, {
            kind: "primary",
            onClick: () => { void saveWithCheck(); },
            disabled: busy,
          }, busy === "save-mimo" ? "保存并检查中…" : "保存小米配置并检查"),
          h(Btn, { onClick: () => actions.load(), disabled: busy }, "重新读取"),
        ),
        msg ? h("div", { style: { fontSize: 11, color: msg.ok ? tone.ok : tone.error } }, msg.text) : null,
        // 拉取模型 / 保存配置的成功失败也落在本面板底部，不再跑到页面最上方。
        h(CardNote, { note }),
      );
    }

    function BreezePanel({ config, form, setForm, busy, actions, note, fetchNote, voicesNote }) {
      const f = form.breeze;
      const patch = (value) => setForm((prev) => ({ ...prev, breeze: { ...prev.breeze, ...value } }));
      const patchVs = (value) => setForm((prev) => ({
        ...prev,
        breeze: { ...prev.breeze, voiceSettings: { ...prev.breeze.voiceSettings, ...value } },
      }));
      const [msg, setMsg] = useState(null);
      const [pvText, setPvText] = useState("你好，我是 DeepSeek，这是「Breeze」的试听。");
      const [pvSing, setPvSing] = useState(false);
      const [pvResult, setPvResult] = useState(null);
      const [keyMsg, setKeyMsg] = useState(null);
      const autoSaveKeyNow = async () => {
        const key = String(f.apiKey || "").trim();
        if (!key) return;
        setKeyMsg({ ok: true, text: "保存中…" });
        const payload = await actions.autoSaveKey("breeze", key);
        if (!payload || payload.ok === false) {
          setKeyMsg({ ok: false, text: payload ? payload.error : "保存失败，看页面顶部提示" });
          return;
        }
        setKeyMsg({ ok: true, text: `已自动保存并生效${payload.breeze && payload.breeze.apiKeyHint ? `（当前 ${payload.breeze.apiKeyHint}）` : ""}` });
      };
      const runPreview = async (voice, extra = {}) => {
        const payload = await actions.preview({ kind: "breeze", text: pvText, sing: pvSing, voice, ...extra });
        if (!payload) return;
        setPvResult(payload.ok === false ? { ok: false, error: payload.error } : { ok: true, payload });
      };
      const saveWithCheck = async () => {
        setMsg(null);
        // 输入框里可能还有没来得及失焦保存的 Key：先落盘，再保存配置，避免两次请求抢跑。
        if (String(f.apiKey || "").trim()) await autoSaveKeyNow();
        const payload = await actions.saveBreeze({ silent: false, check: true, patch: {} });
        if (!payload) return;
        if (payload.ok === false) { setMsg({ ok: false, text: payload.error }); return; }
        const detail = payload.routeReadyDetail && payload.routeReadyDetail.breeze;
        const keyState = detail && detail.apiKey
          ? `Key 已自动保存并生效（${payload.breeze && payload.breeze.apiKeyHint ? payload.breeze.apiKeyHint : "已保存"}）`
          : "Key 未生效：先在上方填 Key，失焦后会自动保存";
        const lack = detail && gapText(detail);
        const modelState = payload.check
          ? (payload.check.ok ? `模型拉取正常（${payload.check.count} 个）` : `模型检查失败：${payload.check.error}`)
          : "已跳过模型检查";
        setMsg({ ok: !payload.check || payload.check.ok, text: `配置已保存 · ${modelState} · ${keyState}${lack ? ` · 还缺 ${lack}` : ""}` });
      };
      const modelOptions = (f.models || []).slice();
      if (f.model && !modelOptions.includes(f.model)) modelOptions.unshift(f.model);
      const voiceOptions = (f.voices || []).map((v) => (typeof v === "string" ? { id: v, name: v } : v));
      if (f.voice && !voiceOptions.some((v) => v.id === f.voice)) voiceOptions.unshift({ id: f.voice, name: f.voice });
      const vs = f.voiceSettings || {};

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 10 } },

        h(
          Card,
          { title: "接口与模型", desc: "Breeze（xi-api-key）" },
          h(
            Row,
            { gap: 10 },
            h(Field, { label: "接口地址", width: 320 }, h("input", {
              value: f.baseUrl,
              spellCheck: false,
              onChange: (e) => patch({ baseUrl: e.target.value }),
              placeholder: "https://api.breeze.blue/v1",
              style: inputStyle,
            })),
          ),
          h(Field, { label: "API Key", width: 320, hint: f.apiKeyHint ? `当前：${f.apiKeyHint}（重新填写会覆盖）` : "还没有设置" },
            h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              h("input", {
                type: "password",
                value: f.apiKey,
                onChange: (e) => patch({ apiKey: e.target.value }),
                onBlur: () => { void autoSaveKeyNow(); },
                placeholder: "粘贴后点一下别处（失焦即自动保存）",
                style: { ...inputStyle, flex: "1 1 auto", minWidth: 0 },
              }),
              keyMsg
                ? h("span", { style: { fontSize: 10, color: keyMsg.ok ? tone.ok : tone.error } }, keyMsg.text)
                : h("span", { style: { fontSize: 10, color: tone.dim } }, "填完点一下别处即自动保存"),
            ),
          ),
          // 第一行：模型下拉 + 拉取按钮。
          h(
            Row,
            { gap: 10, align: "flex-end" },
            h(Field, { label: "模型 model_id", width: 300 }, h("select", {
              value: f.model,
              onChange: (e) => patch({ model: e.target.value }),
              style: inputStyle,
            }, modelOptions.length
              ? modelOptions.map((id) => h("option", { key: id, value: id }, id))
              : h("option", { value: "" }, "（先拉取或手填）"))),
            h(Btn, { onClick: () => actions.fetchModels("breeze"), disabled: busy }, busy === "models-breeze" ? "拉取中…" : "拉取模型"),
          ),
          // 拉取结果**独占一行**，紧跟在【拉取模型】按钮下面（成功/失败都显示）。
          // 塞进 Row 里当普通 flex 项时，长文案会把同一行的手填框挤到下一行，
          // 看起来就像「通知跑到很下面去了」。
          h(CardNote, { note: fetchNote }),
          // 第二行：手填框与它的【使用手填】必须挨在一起，中间不隔任何控件。
          h(
            Row,
            { gap: 10, align: "flex-end" },
            // 手填 Field 必须给 width：不给就落到默认的 flex:"1 1 160px"，
            // 容器吃满整行剩余宽度，输入框固定 180px 靠左、按钮被顶到行尾。
            h(Field, { label: "手填 model_id", width: 200 }, h("input", {
              value: f.modelCustom,
              placeholder: "如 breeze-tts-2",
              onChange: (e) => patch({ modelCustom: e.target.value }),
              style: { ...inputStyle, width: 180 },
            })),
            // 「使用手填」紧跟在手填框后面。
            h(Btn, {
              onClick: () => { if (f.modelCustom.trim()) patch({ model: f.modelCustom.trim() }); },
              disabled: busy || !f.modelCustom.trim(),
            }, "使用手填"),
          ),
          // 音色行同理：拉取音色的结果独占一行，手填 voice_id 与【使用手填】紧挨着。
          h(
            Row,
            { gap: 10, align: "flex-end" },
            h(Field, { label: "音色 voice_id", width: 300 }, h("select", {
              value: f.voice,
              onChange: (e) => patch({ voice: e.target.value }),
              style: inputStyle,
            }, voiceOptions.length
              ? voiceOptions.map((v) => h("option", { key: v.id, value: v.id }, `${v.name || v.id}${v.name && v.name !== v.id ? `（${v.id}）` : ""}`))
              : h("option", { value: "" }, "（先拉取或手填）"))),
            h(Btn, { onClick: () => actions.fetchVoices(), disabled: busy }, busy === "voices-breeze" ? "拉取中…" : "拉取音色"),
          ),
          h(CardNote, { note: voicesNote }),
          h(
            Row,
            { gap: 10, align: "flex-end" },
            h(Field, { label: "手填 voice_id", width: 200 }, h("input", {
              value: f.voiceCustom,
              placeholder: "如 voc_38dpges5szfx",
              onChange: (e) => patch({ voiceCustom: e.target.value }),
              style: { ...inputStyle, width: 180 },
            })),
            h(Btn, {
              onClick: () => { if (f.voiceCustom.trim()) patch({ voice: f.voiceCustom.trim() }); },
              disabled: busy || !f.voiceCustom.trim(),
            }, "使用手填"),
            h(Field, { label: "格式", width: 110 }, h(
              "select",
              { value: f.format, onChange: (e) => patch({ format: e.target.value }), style: inputStyle },
              ["mp3", "wav"].map((fmt) => h("option", { key: fmt, value: fmt }, fmt)),
            )),
          ),
        ),

        h(
          Card,
          { title: "声音参数", desc: "写进 {{VOICE_SETTINGS_JSON}}" },
          h(
            Row,
            { gap: 10 },
            h(Field, { label: "引导强度（guidance_scale，1~10）", width: 210 }, h("input", {
              type: "number", min: 1, max: 10, step: 0.5, value: vs.guidanceScale ?? 4,
              onChange: (e) => patchVs({ guidanceScale: Number(e.target.value) }),
              style: inputStyle,
            })),
            h(Field, { label: "语速（speed，0.5~2）", width: 170 }, h("input", {
              type: "number", min: 0.5, max: 2, step: 0.05, value: vs.speed ?? 1,
              onChange: (e) => patchVs({ speed: Number(e.target.value) }),
              style: inputStyle,
            })),
            // 人声增强开关跟音量放同一行、紧跟音量输入框后面（不再被挤到卡片右上方）。
            h(Field, { label: "音量（volume，0.01~2）", width: 300 },
              h(Row, { gap: 10, align: "center" },
                h("input", {
                  type: "number", min: 0.01, max: 2, step: 0.05, value: vs.volume ?? 1,
                  onChange: (e) => patchVs({ volume: Number(e.target.value) }),
                  style: { ...inputStyle, width: 90 },
                }),
                h(Switch, {
                  checked: vs.useSpeakerBoost !== false,
                  label: "人声增强（use_speaker_boost）",
                  onChange: (value) => patchVs({ useSpeakerBoost: value }),
                }),
              ),
            ),
          ),
        ),

        h(
          Card,
          { title: "请求模板" },
          h(TemplateBlock, {
            kind: "breeze",
            config,
            form: f,
            busy,
            onSave: (patchValue) => { void actions.saveBreeze({ silent: false, patch: patchValue }); },
            onReset: (patchValue) => { void actions.saveBreeze({ silent: false, patch: patchValue }); },
          }),
        ),

        h(PreviewBlock, {
          label: "Breeze",
          busy,
          text: pvText,
          onText: setPvText,
          sing: pvSing,
          onSing: setPvSing,
          result: pvResult,
          onRun: () => runPreview(),
        }),

        h(
          Row,
          { gap: 8, align: "center" },
          h(Btn, {
            kind: "primary",
            onClick: () => { void saveWithCheck(); },
            disabled: busy,
          }, busy === "save-breeze" ? "保存并检查中…" : "保存 Breeze 配置并检查"),
          h(Btn, { onClick: () => actions.load(), disabled: busy }, "重新读取"),
        ),
        msg ? h("div", { style: { fontSize: 11, color: msg.ok ? tone.ok : tone.error } }, msg.text) : null,
        h(CardNote, { note }),
      );
    }

    /* 每个协议面板各自的试听区（受控展示，状态放在面板内部，互不串用） */
    function PreviewBlock({ label, busy, text, onText, sing, onSing, result, onRun }) {
      return h(
        Card,
        { title: `试听（${label}）`, desc: "只用这块面板的接口与音色合成，不发送到 QQ" },
        h(Field, { label: "试听文本" }, h("textarea", {
          value: text,
          rows: 2,
          onChange: (e) => onText(e.target.value),
          style: { ...inputStyle, resize: "vertical", lineHeight: 1.6 },
        })),
        h(
          Row,
          { gap: 8, align: "center" },
          h(Btn, { kind: "primary", onClick: () => { void onRun(); }, disabled: busy }, busy === "preview" ? "合成中…" : "试听"),
          h(Switch, { checked: sing, label: "唱歌", onChange: onSing }),
          result && result.ok
            ? h("span", { style: { fontSize: 11, color: tone.ok } },
                `${result.payload.route} · ${result.payload.actuallySang ? "唱歌" : "念白"} · ${result.payload.durationSec ?? "?"} 秒 · ${fmtBytes(result.payload.bytes)} · ${result.payload.elapsedMs ?? "?"}ms`)
            : result && !result.ok
              ? h("span", { style: { fontSize: 11, color: tone.error } }, result.error || "试听失败")
              : null,
        ),
        result && result.ok && result.payload.audioId
          ? h("audio", {
              key: result.payload.audioId,
              controls: true,
              autoPlay: true,
              src: `${API}/audio?id=${encodeURIComponent(result.payload.audioId)}`,
              style: { width: "100%", height: 34 },
            })
          : null,
        // 上游/宿主的警告要看得见：比如「克隆模型不能念预设音色，这次已临时换成预置模型试听」。
        result && result.ok && Array.isArray(result.payload.warnings) && result.payload.warnings.length
          ? h("ul", { style: { margin: "4px 0 0", paddingLeft: 16, fontSize: 10, lineHeight: 1.6, color: tone.dim } },
              result.payload.warnings.map((w, i) => h("li", { key: i }, String(w))))
          : null,
        result && result.ok && result.payload.curl
          ? h(
              "details",
              { style: { fontSize: 10, color: tone.dim } },
              h("summary", { style: { cursor: "pointer" } }, "看这次实际发出的请求（已脱敏）"),
              h("pre", { style: { whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: mono, fontSize: 10, lineHeight: 1.5, color: tone.faint, margin: "6px 0 0" } }, result.payload.curl),
            )
          : null,
      );
    }

    /* ------------------------------------------------------------ main page */

    function fromConfig(config) {
      const vs = (config.breeze && config.breeze.voiceSettings) || config.voiceSettings || {};
      // 自定义风格词与下拉共用同一个落盘字段 tts.style：保存时 styleCustom 会覆盖 style。
      // 读回来时如果存的值不在预置风格表里，说明当初填的是自定义词 —— 放回输入框，
      // 否则它会「消失」（下拉里没有这个选项，value 匹配不上就显示空白）。
      const presetStyles = new Set();
      for (const group of Array.isArray(config.stylePresets) ? config.stylePresets : []) {
        for (const item of group.items || []) presetStyles.add(item);
      }
      const savedStyle = String(config.style || "");
      const styleIsCustom = savedStyle !== "" && !presetStyles.has(savedStyle);
      return {
        enabled: config.enabled === true,
        aiEnabled: config.aiEnabled !== false,
        apiStyle: config.apiStyle === "breeze" ? "breeze" : "openai",
        routeMode: config.routeMode || "",
        lengthThreshold: String(config.lengthThreshold ?? 100),
        durationThreshold: String(config.durationThreshold ?? 20),
        mimo: {
          baseUrl: (config.mimo && config.mimo.baseUrl) || config.baseUrl || "",
          apiKey: "",
          apiKeyHint: (config.mimo && config.mimo.apiKeyHint) || config.apiKeyHint || "",
          model: (config.mimo && config.mimo.model) || config.model || "",
          modelCustom: "",
          format: (config.mimo && config.mimo.format) || config.format || "wav",
          style: styleIsCustom ? "" : savedStyle,
          styleCustom: styleIsCustom ? savedStyle : "",
          styleMode: config.styleMode || "user",
          singStyle: config.singStyle || "唱歌",
          design: config.design || "",
          mode: config.mode || "preset",
          voice: config.mode === "clone" || config.mode === "voicedesign" ? "" : (config.voice || ""),
          maxChars: String(config.maxChars ?? 2000),
          headerTemplate: config.headerTemplate || "",
          bodyTemplate: config.bodyTemplate || "",
        },
        breeze: {
          baseUrl: (config.breeze && config.breeze.baseUrl) || "",
          apiKey: "",
          apiKeyHint: (config.breeze && config.breeze.apiKeyHint) || "",
          model: (config.breeze && config.breeze.model) || "",
          modelCustom: "",
          voice: (config.breeze && config.breeze.voice) || "",
          voiceCustom: "",
          format: (config.breeze && config.breeze.format) || "wav",
          models: (config.breeze && config.breeze.models) || [],
          voices: (config.breeze && config.breeze.voices) || [],
          voiceSettings: {
            guidanceScale: vs.guidanceScale ?? 4,
            speed: vs.speed ?? 1,
            volume: vs.volume ?? 1,
            useSpeakerBoost: vs.useSpeakerBoost !== false,
          },
          headerTemplate: (config.breeze && config.breeze.headerTemplate) || "",
          bodyTemplate: (config.breeze && config.breeze.bodyTemplate) || "",
        },
        onebot: {
          httpUrl: (config.onebot && config.onebot.httpUrl) || "",
          accessToken: "",
        },
      };
    }

    function TtsSettingsPage() {
      const [config, setConfig] = useState(null);
      const [state, setState] = useState(null);
      const [form, setForm] = useState(null);
      const [tab, setTab] = useState("openai");
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      // 操作结果按「哪张卡片触发的」分开存：保存成功/失败都显示在对应卡片里。
      // 以前所有消息都堆在页面最上方，卡片在可视区外时用户会以为没反应。
      // key 约定：top（顶栏开关）/ route / mimo / breeze / onebot / speak / ref-clone / ref-sing。
      const [notes, setNotes] = useState({});
      const [sendText, setSendText] = useState("");
      const [target, setTarget] = useState("group:");
      const [sendResult, setSendResult] = useState(null);
      const [logOpen, setLogOpen] = useState(false);
      const [backups, setBackups] = useState(null);

      const mounted = useRef(true);
      useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);

      const load = useCallback(async () => {
        try {
          const [configPayload, statePayload] = await Promise.all([api("/config"), api("/state")]);
          if (!mounted.current) return;
          setConfig(configPayload);
          setState(statePayload);
          setForm(fromConfig(configPayload));
          setError("");
          setTab(configPayload.apiStyle === "breeze" ? "breeze" : "openai");
        } catch (err) {
          if (mounted.current) setError(errText(err));
        }
      }, []);

      // 保存成功后再拉一次 /state：顶栏摘要与「运行状态」卡用的是它，
      // 不刷新的话刚填完 Key 仍会显示缺 Key（routeReady 也改读保存返回的 /config）。
      const refreshState = useCallback(async () => {
        try {
          const next = await api("/state");
          if (mounted.current) setState(next);
        } catch {
          /* 状态条不是关键路径，失败就保留旧值 */
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      // 通知落在触发它的卡片里（scope 见 state 注释）。
      // 每条都写，不因为「调用方已经就地提示过」而抑制：成功与失败都要有出口。
      // scope 缺省 → 页面顶部（只给不属于任何卡片的加载失败兜底）。
      const flash = (text, kind, scope = "top") => {
        const target = scope || "top";
        setNotes((prev) => ({ ...prev, [target]: { text, kind: kind || "ok" } }));
      };
      const clearNote = (scope) => {
        setNotes((prev) => {
          if (!prev[scope]) return prev;
          const next = { ...prev };
          delete next[scope];
          return next;
        });
      };

      const run = async (name, fn, okText, scope = "top") => {
        setBusy(name);
        clearNote(scope || "top");
        try {
          const result = await fn();
          if (okText) flash(okText, "ok", scope);
          return result;
        } catch (err) {
          const text = errText(err);
          // 失败必须有出口：落在触发的卡片里，没有 scope 就兜底到页面顶部。
          // 0.3.5 曾经让某个 scope 值把错误一起吞掉，表现就是「点了完全没反应」。
          flash(text, "error", scope);
          return { ok: false, error: text };
        } finally {
          if (mounted.current) setBusy("");
        }
      };

      const applyPanel = (payload) => {
        if (!payload) return;
        setConfig(payload);
        setForm(fromConfig(payload));
      };

      /* -------- actions -------- */

      const saveFlags = (enabled, aiEnabled) => {
        void run("save-flags", async () => {
          const payload = await post("/config", { tts: { enabled, aiEnabled } });
          applyPanel(payload);
          void refreshState();
        }, "已保存开关", "top");
      };

      const saveRoute = () => {
        void run("save-route", async () => {
          // Key 已经由输入框失焦时单独保存，这里只管路由参数。
          const payload = await post("/config", {
            tts: {
              routeMode: form.routeMode,
              lengthThreshold: Number(form.lengthThreshold) || 100,
              durationThreshold: Number(form.durationThreshold) || 20,
            },
          });
          applyPanel(payload);
          void refreshState();
        }, "调用优先级已保存", "route");
      };

      const saveMimo = (options = {}) => run("save-mimo", async () => {
        const f = form.mimo;
        const tts = {
          baseUrl: String(f.baseUrl || "").trim(),
          model: String(f.model || "").trim(),
          mode: f.mode,
          format: f.format,
          style: String(f.styleCustom || "").trim() || f.style,
          styleMode: f.styleMode,
          singStyle: String(f.singStyle || "").trim() || "唱歌",
          design: f.design,
          maxChars: Number(f.maxChars) || 2000,
          headerTemplate: f.headerTemplate,
          bodyTemplate: f.bodyTemplate,
          ...(options.patch || {}),
        };
        if (f.mode !== "clone" && f.mode !== "voicedesign" && f.voice) tts.voice = f.voice;
        // Key 只走输入框失焦自动保存；「保存配置并检查」不再顺手改 Key。
        // 明确告诉后端「查小米这一套」：不指定的话后端只能靠 apiStyle / routeMode 猜，
        // 而用户在小米面板上点按钮、实际路由却是 breeze 时，猜错就会拿 Breeze 的地址配
        // 小米的 Key，回一个假的「Invalid API Key」。
        if (options.check === true) { tts.check = true; tts.checkStyle = "openai"; }
        const payload = await post("/config", { tts });
        if (mounted.current) {
          setConfig(payload);
          setForm((prev) => {
            const next = fromConfig(payload);
            return {
              ...prev,
              // 保留用户刚填进 Key 框的内容：保存配置不该顺手把它清掉，否则用户会以为 Key 丢了（它会在失焦时自动落盘）。
              // 自定义风格词同理：静默保存后输入框必须还在，否则看起来就是「填了又没了」。
              mimo: {
                ...next.mimo,
                modelCustom: prev.mimo.modelCustom,
                apiKey: prev.mimo.apiKey,
                ...(options.silent && options.patch && Object.hasOwn(options.patch, "style")
                  ? { styleCustom: prev.mimo.styleCustom }
                  : {}),
              },
              enabled: next.enabled,
              aiEnabled: next.aiEnabled,
              apiStyle: next.apiStyle,
            };
          });
          if (payload.check) {
            flash(payload.check.ok
              ? `配置已保存，上游模型 ${payload.check.count} 个：${payload.check.models.slice(0, 6).join(" / ")}${payload.check.models.length > 6 ? " …" : ""}`
              : `配置已保存，但拉取模型失败：${payload.check.error}`, payload.check.ok ? "ok" : "warn", "mimo");
          } else if (!options.silent) {
            flash("配置已保存", "ok", "mimo");
          }
        }
        void refreshState();
        return payload;
      }, null, "mimo");

      const saveBreeze = (options = {}) => run("save-breeze", async () => {
        const f = form.breeze;
        const breeze = {
          baseUrl: String(f.baseUrl || "").trim(),
          model: String(f.model || "").trim(),
          voice: String(f.voice || "").trim(),
          format: f.format,
          models: f.models,
          voices: f.voices,
          voiceSettings: f.voiceSettings,
          headerTemplate: f.headerTemplate,
          bodyTemplate: f.bodyTemplate,
          ...(options.patch || {}),
        };
        // Key 只走输入框失焦自动保存；「保存配置并检查」不再顺手改 Key。
        // 同上：明确声明查 Breeze 这一套，别让后端按 apiStyle 猜成小米的地址。
        const payload = await post("/config", { tts: { breeze, ...(options.check ? { check: true, checkStyle: "breeze" } : {}) } });
        if (mounted.current) {
          setConfig(payload);
          setForm((prev) => {
            const next = fromConfig(payload);
            return {
              ...prev,
              breeze: { ...next.breeze, modelCustom: prev.breeze.modelCustom, voiceCustom: prev.breeze.voiceCustom, apiKey: prev.breeze.apiKey },
            };
          });
          if (payload.check) {
            flash(payload.check.ok ? `Breeze 配置已保存，可用模型 ${payload.check.count} 个` : `Breeze 配置已保存，但模型检查失败：${payload.check.error}`, payload.check.ok ? "ok" : "warn", "breeze");
          } else if (!options.silent) {
            flash("Breeze 配置已保存", "ok", "breeze");
          }
        }
        void refreshState();
        return payload;
      }, null, "breeze");

      const saveOnebot = (options = {}) => run("save-onebot", async () => {
        const onebot = { httpUrl: String(form.onebot.httpUrl || "").trim() };
        if (String(form.onebot.accessToken || "").trim()) onebot.accessToken = String(form.onebot.accessToken).trim();
        const payload = await post("/config", { onebot });
        applyPanel(payload);
        void refreshState();
        if (!options.silent) {
          const odd = Array.isArray(payload.onebotNonAscii) ? payload.onebotNonAscii : [];
          flash(
            odd.length
              ? `OneBot 通道已保存。Token 里有 ${odd.length} 个非 ASCII 字符（${odd.map((f) => `第 ${f.index + 1} 个字「${f.char}」`).join("，")}），已原样保存、原样发送，没有改动它。`
              : "OneBot 通道已保存",
            odd.length ? "warn" : "ok",
            "onebot",
          );
        }
        return payload;
      }, null, "onebot");

      const fetchModels = (style) => run(`models-${style}`, async () => {
        const payload = await post("/models", {
          apiStyle: style,
          baseUrl: style === "breeze" ? form.breeze.baseUrl : form.mimo.baseUrl,
          apiKey: style === "breeze" ? form.breeze.apiKey : form.mimo.apiKey,
          headerTemplate: style === "breeze" ? form.breeze.headerTemplate : form.mimo.headerTemplate,
        });
        const ids = payload.models.map((m) => m.id);
        const cost = payload.elapsedMs ? `（${payload.elapsedMs}ms）` : "";
        const note = payload.note ? ` · ${payload.note}` : "";
        if (style === "breeze") {
          // 拉到的模型直接落盘：不落盘的话刷新页面就丢，「拉取模型」等于白点。
          // 当前选中的 model_id 还在新列表里就保留，否则取第一个。
          const nextModel = ids.includes(String(form.breeze.model || "").trim())
            ? form.breeze.model
            : (ids[0] || form.breeze.model);
          setForm((prev) => ({ ...prev, breeze: { ...prev.breeze, models: ids, model: nextModel } }));
          const saved = await post("/config", { tts: { breeze: { models: ids, model: nextModel } } });
          if (mounted.current) setConfig(saved);
          flash(`拉到 ${payload.count} 个模型${cost}${note}：${ids.join(" / ")}`, "ok", "fetch-breeze");
        } else {
          setConfig((prev) => (prev ? { ...prev, models: ids } : prev));
          flash(`拉到 ${payload.count} 个模型${cost}${note}：${ids.join(" / ")}`, "ok", "fetch-mimo");
        }
        return payload;
      }, null, style === "breeze" ? "fetch-breeze" : "fetch-mimo");

      const fetchVoices = () => run("voices-breeze", async () => {
        const payload = await post("/voices", {
          apiStyle: "breeze",
          baseUrl: form.breeze.baseUrl,
          apiKey: form.breeze.apiKey,
        });
        const ids = (payload.voices || []).map((v) => v.id);
        // 同上：音色列表也落盘，拉完即生效。
        const nextVoice = ids.includes(String(form.breeze.voice || "").trim())
          ? form.breeze.voice
          : (ids[0] || form.breeze.voice);
        setForm((prev) => ({ ...prev, breeze: { ...prev.breeze, voices: payload.voices, voice: nextVoice } }));
        if (ids.length) {
          const saved = await post("/config", { tts: { breeze: { voices: payload.voices, voice: nextVoice } } });
          if (mounted.current) setConfig(saved);
        }
        const cost = payload.elapsedMs ? `（${payload.elapsedMs}ms）` : "";
        const vNote = payload.note ? ` · ${payload.note}` : "";
        flash(`拉到 ${payload.count} 个音色${cost}${vNote}${ids[0] ? `，已自动填上 ${nextVoice}` : ""}`, "ok", "fetch-voices");
        return payload;
      }, null, "fetch-voices");

      // Key 在输入框失焦时自动保存：只动这一把 Key，不跑模型检查，也不碰其它字段。
      const autoSaveKey = (kind, rawValue) => run(`key-${kind}-auto`, async () => {
        const key = String(rawValue || "").trim();
        if (!key) return { ok: true, skipped: true };
        const payload = await post("/config", { tts: kind === "breeze" ? { breeze: { apiKey: key } } : { apiKey: key } });
        if (mounted.current) {
          setConfig(payload);
          // 保存成功后清空输入框：hint 里已经有新掩码，明文 Key 不必停在页面上。
          setForm((prev) => (kind === "breeze"
            ? { ...prev, breeze: { ...prev.breeze, apiKey: "" } }
            : { ...prev, mimo: { ...prev.mimo, apiKey: "" } }));
        }
        void refreshState();
        return payload;
      }, null, kind === "breeze" ? "breeze" : "mimo");

      // 试听按「当前所在面板」分别构造参数：小米面板只带小米的接口/音色/风格，
      // Breeze 面板只带 Breeze 的接口/音色，互不串用。
      const preview = (options = {}) => run("preview", () => {
        const kind = options.kind === "breeze" ? "breeze" : "openai";
        const text = String(options.text ?? "").trim();
        if (!text) throw new Error("试听文本不能为空");
        if (kind === "breeze") {
          return post("/preview", {
            text,
            apiStyle: "breeze",
            format: form.breeze.format,
            baseUrl: form.breeze.baseUrl,
            apiKey: form.breeze.apiKey,
            headerTemplate: form.breeze.headerTemplate,
            bodyTemplate: form.breeze.bodyTemplate,
            voice: options.voice || form.breeze.voice || undefined,
            sing: options.sing === true,
          });
        }
        return post("/preview", {
          text,
          apiStyle: "openai",
          format: form.mimo.format,
          baseUrl: form.mimo.baseUrl,
          apiKey: form.mimo.apiKey,
          headerTemplate: form.mimo.headerTemplate,
          bodyTemplate: form.mimo.bodyTemplate,
          style: options.style ?? (form.mimo.styleCustom.trim() || form.mimo.style || undefined),
          design: options.design ?? (form.mimo.mode === "voicedesign" ? form.mimo.design : undefined),
          voice: options.voice,
          sing: options.sing === true,
        });
      }, null, options.kind === "breeze" ? "breeze" : "mimo");

      const speakNow = () => run("speak", async () => {
        if (!String(target).trim()) throw new Error("先填发送目标：group:群号 或 private:QQ号");
        const text = String(sendText ?? "").trim() || "你好，我是 DeepSeek，这是一条语音。";
        const payload = await post("/speak", {
          text,
          target: String(target).trim(),
          sing: false,
        });
        setSendResult(payload);
        // 成功不必再写一条：卡片里的 sendResult 已经显示目标 / messageId / 时长 / 回读结果。
        return payload;
      }, null, "speak");

      // 参考音频上传后的提示文案。说话音色（clone）额外检查「有效语音够不够长」：
      // 实测同一句话连合成 6 次，2.9 秒参考音频的时长变异 40.8%、8 秒的只有 12.9%，
      // 用户感知就是「每次音色/语速都不一样」。与其让他自己猜，不如上传当场说清楚。
      const refMessage = (kind, built) => {
        const label = kind === "sing" ? "唱歌参考" : "说话音色";
        const head = `${label}已上传：${built.seconds.toFixed(1)} 秒 / ${fmtBytes(built.bytes.length)}`;
        const parts = [head];
        if (built.trimmed) {
          parts.push(`已自动截取前 ${REF_MAX_SECONDS} 秒（原长 ${built.originalSeconds.toFixed(1)} 秒）`);
        }
        if (kind !== "sing" && built.speechSeconds < REF_MIN_SPEECH_SECONDS) {
          parts.push(
            `⚠ 参考音频过短：有效语音仅 ${built.speechSeconds.toFixed(1)} 秒，克隆效果会不稳定`
            + `（同一句话每次的语速和音色都会有出入）。建议上传 10~30 秒连续说话的录音，`
            + `超过 30 秒会自动截取前 30 秒。`
          );
        }
        return {
          text: parts.join(" ｜ "),
          kind: kind !== "sing" && built.speechSeconds < REF_MIN_SPEECH_SECONDS ? "warn" : "ok",
        };
      };

      const uploadRef = (kind, files, options) => run(`upload-${kind}`, async () => {
        const built = await buildReferenceWav(files, options);
        const name = `${files[0].name.replace(/\.[^.]+$/, "") || "reference"}.wav`;
        const payload = await post("/clone", {
          fileName: name,
          kind,
          dataBase64: bytesToBase64(built.bytes),
          overwrite: true,
          // 时长由浏览器解码时顺便算出（服务端没装 ffmpeg 就量不了）。
          // 存进配置后，面板就能一直显示「这段到底多长、有效语音够不够」。
          seconds: built.seconds,
          speechSeconds: built.speechSeconds,
        });        if (mounted.current) {
          // 用 applyPanel 而不是 setConfig：上传说话音色后后端会把 mode 切成 clone，
          // 只有重建 form 才能让「合成模式」tab 跟着跳过去。
          applyPanel(payload);
          const msg = refMessage(kind, built);
          flash(msg.text, msg.kind, kind === "sing" ? "ref-sing" : "ref-clone");
        }
        return payload;
      }, null, kind === "sing" ? "ref-sing" : "ref-clone");

      const clearRef = (kind) => run(`clear-${kind}`, async () => {
        const payload = await post("/clear-ref", { kind });
        if (mounted.current) setConfig(payload);
        flash(kind === "sing" ? "唱歌参考已清除" : "说话音色已清除", "ok", kind === "sing" ? "ref-sing" : "ref-clone");
        return payload;
      }, null, kind === "sing" ? "ref-sing" : "ref-clone");

      const refBackup = (kind, action) => run(`backup-${kind}-${action}`, async () => {
        const payload = await post("/ref-backup", { kind, action });
        if (mounted.current) setBackups(payload);
        const refScope = kind === "sing" ? "ref-sing" : "ref-clone";
        if (action === "list") flash(`备份 ${payload.backups.length} 份${payload.dir ? `：${payload.dir}` : ""}`, "ok", refScope);
        else if (action === "open") flash(`已打开目录：${payload.dir}`, "ok", refScope);
        else flash("备份已清空", "ok", refScope);
        return payload;
      }, null, kind === "sing" ? "ref-sing" : "ref-clone");

      const fetchRefUrl = (kind, url, options) => run(`url-${kind}`, async () => {
        const fetched = await post("/fetch-audio", { url });
        if (!fetched.looksAudio) throw new Error(`这个链接看起来不像音频（${fetched.mimeType}）`);
        const blob = base64ToBlob(fetched.dataBase64, fetched.mimeType);
        const name = blobName(blob, "imported");
        const file = new File([blob], name, { type: fetched.mimeType || "audio/mpeg" });
        const built = await buildReferenceWav([file], options);
        const payload = await post("/clone", {
          fileName: `${name.replace(/\.[^.]+$/, "")}.wav`,
          kind,
          dataBase64: bytesToBase64(built.bytes),
          overwrite: true,
          seconds: built.seconds,
          speechSeconds: built.speechSeconds,
        });
        if (mounted.current) applyPanel(payload);
        const msg = refMessage(kind, built);
        flash(msg.text.replace(/^(说话音色|唱歌参考)已上传/, "已从链接导入参考音频"), msg.kind, kind === "sing" ? "ref-sing" : "ref-clone");
        return payload;
      }, null, kind === "sing" ? "ref-sing" : "ref-clone");

      const ping = () => run("ping", async () => {
        const payload = await post("/ping");
        // 带 /api 前缀的网关以前每个 action 都 404。把这次实际打通的路径前缀写出来，
        // 用户一眼能看懂自己那台是哪种部署。
        const prefix = String(payload.actionPrefix ?? "");
        const via = prefix ? ` ｜ action 路径：${prefix}/xxx` : " ｜ action 路径：/xxx";
        flash(`OneBot 在线：${payload.nickname || ""}（${payload.userId || "?"}）@ ${payload.httpUrl}${via}`, "ok", "onebot");
        return payload;
      }, null, "onebot");

      const importConfig = () => run("import", async () => {
        const payload = await post("/import");
        applyPanel(payload);
        flash(`已从 ${payload.importedFrom} 导入配置`, "ok", "onebot");
        return payload;
      }, null, "onebot");

      const actions = { load, saveMimo, saveBreeze, autoSaveKey, saveOnebot, fetchModels, fetchVoices, preview, speakNow, uploadRef, clearRef, refBackup, fetchRefUrl, ping, importConfig };
      // 每张卡片的通知：面板组件按 scope 取自己的那条。
      const noteOf = (scope) => notes[scope] || null;
      // 「拉取模型」这类按钮的结果要**紧跟按钮**显示，不能落到卡片最底部（离得太远看不见）。
      // 用独立 scope：fetch-mimo / fetch-breeze / fetch-voices，面板从这里取。
      const fetchNoteOf = (style) => notes[`fetch-${style}`] || null;

      if (!config || !form || !state) {
        return h("div", { style: { padding: "18px 0", fontSize: 12, color: error ? tone.error : tone.dim } },
          error ? `TTS 插件不可用：${error}` : "TTS 设置加载中…");
      }

      const enabled = form.enabled;
      // 顶部状态按「任一边配好」判断：只用 Breeze 的人不该因为小米没填 Key 被判成未配置。
      const keyReady = config.routeReady.mimo || config.routeReady.breeze;
      const ready = enabled && keyReady;
      const summary = !enabled
        ? "TTS 已关闭"
        : !keyReady
          ? "还没有配置 API Key（小米或 Breeze 任一边）"
          : `${state.mode === "clone" ? "克隆音色" : state.voice} · ${state.model}`;

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12, paddingBottom: 8, colorScheme: "light dark" } },

        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          h(Dot, { color: !enabled ? tone.faint : keyReady ? tone.ok : tone.warn }),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
            h("div", { style: { fontSize: 14, fontWeight: 600, color: tone.text } }, "语音合成"),
            h("div", { style: { fontSize: 11, color: tone.dim } }, summary)),
          h("div", { style: { flex: "1 1 auto" } }),
          h(Switch, {
            checked: form.enabled,
            label: "启用 TTS",
            onChange: (value) => { setForm((prev) => ({ ...prev, enabled: value })); saveFlags(value, form.aiEnabled); },
          }),
          h(Switch, {
            checked: form.aiEnabled,
            label: "允许 AI 调用",
            onChange: (value) => { setForm((prev) => ({ ...prev, aiEnabled: value })); saveFlags(form.enabled, value); },
          }),
        ),

        // 页面级错误只留给「整套设置加载失败」；保存/操作的成功失败都进各自卡片。
        error ? h("div", { style: { fontSize: 12, color: tone.error, lineHeight: 1.5 } }, error) : null,
        h(CardNote, { note: noteOf("top") }),

        h(
          Card,
          { title: "调用优先级", desc: "智能路由只在两边都配置好的时候才生效" },
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 6 } },
            // 「跟随当前协议（不启用路由）」已按用户要求去掉：调用优先级只留三种明确选择。
            // 老配置里 routeMode='' 仍被后端接受（行为等同「跟随 apiStyle」），这里给一句说明，
            // 免得三个选项都没选中时看起来像坏了。
            form.routeMode === ""
              ? h("span", { style: { fontSize: 11, color: tone.warn } }, "当前未设置路由（按协议走）：选一个选项并保存即生效")
              : null,
            [
              ["mimo", "只走小米 MiMo"],
              ["breeze", "只走 Breeze"],
              ["smart", "智能（达到分界走小米，没到按合成延迟自动选；失败自动换另一边）"],
            ].map(([value, label]) =>
              h(
                "label",
                { key: value, style: { display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: tone.text } },
                h("input", {
                  type: "radio",
                  name: "dsh-tts-route",
                  value,
                  checked: form.routeMode === value,
                  onChange: () => setForm((prev) => ({ ...prev, routeMode: value })),
                }),
                label,
                // 提示必须说清缺的是哪一样：Key 已存但没选模型时，报「还没填 Key」会让人以为 Key 没保存。
                value === "mimo"
                  ? hintSpan(config.routeReadyDetail && config.routeReadyDetail.mimo, String(form.mimo.apiKey || "").trim(), "小米面板")
                  : null,
                value === "breeze"
                  ? hintSpan(config.routeReadyDetail && config.routeReadyDetail.breeze, String(form.breeze.apiKey || "").trim(), "Breeze 面板")
                  : null,
              ),
            ),
          ),
          h(
            Row,
            { gap: 10, align: "flex-end" },
            h(Field, { label: "字数分界", width: 160, hint: "≥ 这个字数就走小米" }, h("input", {
              type: "number", min: 10, max: 2000, value: form.lengthThreshold,
              onChange: (e) => setForm((prev) => ({ ...prev, lengthThreshold: e.target.value })),
              style: inputStyle,
            })),
            h(Field, { label: "时长分界（秒）", width: 180, hint: "≥ 这个时长就走小米（按 4 字/秒 估算）" }, h("input", {
              type: "number", min: 1, max: 600, value: form.durationThreshold,
              onChange: (e) => setForm((prev) => ({ ...prev, durationThreshold: e.target.value })),
              style: inputStyle,
            })),
            h(Btn, { kind: "primary", onClick: saveRoute, disabled: busy }, busy === "save-route" ? "保存中…" : "保存调用优先级"),
            h("span", { style: { fontSize: 11, color: tone.faint, paddingBottom: 6 } },
              `当前生效：${state.routeModeEffective === "mimo" ? "小米" : state.routeModeEffective === "breeze" ? "Breeze" : "智能"}`),
          ),
          h(Note, null, "智能：字数 ≥ 分界 或 估算时长 ≥ 分界 时走小米（长内容小米更稳）；两个都没到，按最近的成功合成耗时选更快的一边。AI 主动发起的语音也走这套分界。"),
          h(CardNote, { note: noteOf("route") }),
        ),

        h(Tabs, {
          value: tab,
          onChange: setTab,
          items: [
            { value: "openai", label: "小米 MiMo" },
            { value: "breeze", label: "Breeze" },
          ],
        }),

        tab === "openai"
          ? h(MimoPanel, { config, form, setForm, busy, actions, note: noteOf("mimo"), fetchNote: fetchNoteOf("mimo"), refNotes: notes })
          : h(BreezePanel, { config, form, setForm, busy, actions, note: noteOf("breeze"), fetchNote: fetchNoteOf("breeze"), voicesNote: fetchNoteOf("voices"), refNotes: notes }),

        h(
          Card,
          { title: "发到 QQ", desc: "合成后直接通过 OneBot 发一条语音" },
          h(
            Row,
            { gap: 8, align: "flex-end" },
            h(Field, { label: "要说的内容", hint: "留空 = 默认一句问候", width: 300 }, h("input", {
              value: sendText,
              placeholder: "你好，我是 DeepSeek。",
              onChange: (e) => setSendText(e.target.value),
              style: inputStyle,
            })),
            h(Field, { label: "发送目标", hint: "group:群号 或 private:QQ号" }, h("input", {
              value: target,
              placeholder: "group:123456789",
              onChange: (e) => setTarget(e.target.value),
              style: { ...inputStyle, width: 230 },
            })),
            h(Btn, { onClick: speakNow, disabled: busy }, busy === "speak" ? "发送中…" : "合成并发 QQ 语音"),
          ),
          sendResult
            ? h(Note, { kind: "ok" },
                `已发送到 ${sendResult.target} · messageId=${sendResult.messageId} · ${sendResult.durationSec ?? "?"} 秒 · 回读${sendResult.verified ? "成功" : "未确认"}`
                + (Array.isArray(sendResult.warnings) && sendResult.warnings.length ? ` · ${sendResult.warnings.join("；")}` : ""))
            : null,
          h(CardNote, { note: noteOf("speak") }),
          // 跨机器发语音的说明：插件在这台机器合成，OneBot 可能在另一台。
          // 传本机路径过去远端读不到（ENOENT），所以跨机器时自动改用 base64 内联。
          h(Note, null, "跨机器发语音（插件装在这台、OneBot 在另一台）会自动改用 base64 内联发送，不会把本机路径发过去；本机网关则用路径、更省流量。"),
        ),

        h(
          Card,
          { title: "OneBot 通道", desc: "发语音走 SnowLuma 的 OneBot HTTP（本机默认 127.0.0.1:3000；也可直接填 SnowLuma 控制台里 OneBot 连接所在的端口）" },
          h(
            Row,
            { gap: 10, align: "flex-end" },
            // 不用 Field 的 hint：hint 会把这个 Field 撑高一行，配合 Row 的 align:flex-end
            // 会把旁边的 Access Token 顶成不齐。端口说明放到卡片底部的 Note 里。
            h(Field, { label: "HTTP 地址", width: 300 }, h("input", {
              value: form.onebot.httpUrl,
              placeholder: "留空 = 自动探测（http://127.0.0.1:3000）",
              onChange: (e) => setForm((prev) => ({ ...prev, onebot: { ...prev.onebot, httpUrl: e.target.value } })),
              style: inputStyle,
            })),
            // hint 会把 Field 撑高一行，align:flex-end 于是把这个框顶到 HTTP 地址的「上沿」，
            // 看起来像浮在右上角。这里不用 Field 的 hint，改成与输入框同行的灰字，
            // 两个输入框就自然底对齐了。
            h("label", {
              style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: "1 1 200px" },
            },
              h("span", { style: { fontSize: 11, color: tone.dim } }, "Access Token"),
              h("input", {
                type: "password",
                value: form.onebot.accessToken,
                placeholder: state.onebot.tokenSet ? "已设置，留空不改" : "可选，留空 = 不改动",
                onChange: (e) => setForm((prev) => ({ ...prev, onebot: { ...prev.onebot, accessToken: e.target.value } })),
                style: inputStyle,
              }),
            ),
            h(Btn, { onClick: saveOnebot, disabled: busy }, "保存通道"),
            h(Btn, { onClick: ping, disabled: busy }, busy === "ping" ? "探测中…" : "测试连接"),
            h(Btn, { onClick: importConfig, disabled: busy }, busy === "import" ? "导入中…" : "从 QQ Bridge 导入"),
          ),
          h(Note, null, `当前：${state.onebot.httpUrl}${state.onebot.tokenSet ? "（带 token）" : "（无 token）"} ｜ 来源：${state.onebot.source}`),
          // 端口/前缀不是靠猜的：填 SnowLuma 控制台「OneBot 连接」那一页显示的地址即可。
          // SnowLuma 可以在同一个端口上同时提供 WebUI 和 OneBot（action 挂在 /api 下），
          // 插件会自动尝试无前缀与 /api 两种路径，所以填哪个都对。
          h(Note, null, "填 SnowLuma 控制台「OneBot 连接」里显示的 HTTP 地址即可。插件会自动判断 action 挂在根路径还是 /api 下；token 用那一页显示的 access token（不是 WebUI 的登录密码）。"),
          // Token 里有非 ASCII 字符时只做说明，不改内容——那是用户的密码（可能是真的「！」）。
          // 传输层会按 UTF-8 字节原样送出，网关能正确还原，所以这里不该标红。
          ...((Array.isArray(state.onebot.nonAscii) ? state.onebot.nonAscii : []).length
            ? [h("div", { style: { fontSize: 11, color: tone.dim, lineHeight: 1.6, marginTop: 4 } },
              `Token 里有 ${state.onebot.nonAscii.length} 个非 ASCII 字符（${state.onebot.nonAscii.map((f) => `第 ${f.index + 1} 个字「${f.char}」`).join("，")}）。`
              + "插件不会改动它们：发送时按 UTF-8 字节原样送出，网关能正确还原。"
              + "若测试连接失败，请核对 Token 与网关侧是否一致（不要因为「看起来像全角」就手改密码）。")] 
            : []),
          h(CardNote, { note: noteOf("onebot") }),
        ),

        h(
          Card,
          { title: "运行状态" },
          h(
            "div",
            { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 6, fontSize: 11, color: tone.dim, lineHeight: 1.6 } },
            h("div", null, `配置：${state.configPath}`),
            h("div", null, `数据：${config.storage.dataDir}`),
            h("div", null, `缓存：${config.storage.cacheDir}`),
            h("div", null, `克隆参考：${config.clone.ready ? "已有" : "无"} ｜ 唱歌参考：${config.singRef.ready ? "已有" : "无"}`),
            h("div", null, `小米 Key：${config.mimo.apiKeySet ? config.mimo.apiKeyHint : "未设置"} ｜ Breeze Key：${config.breeze.apiKeySet ? config.breeze.apiKeyHint : "未设置"}`),
            h("div", null, `调用上限：${config.maxChars} 字符 ｜ 超时：${Math.round((config.timeoutMs || 180000) / 1000)}s`),
          ),
          h(
            "button",
            {
              type: "button",
              onClick: () => setLogOpen((v) => !v),
              style: { alignSelf: "flex-start", border: "none", background: "transparent", color: tone.dim, fontSize: 11, cursor: "pointer", padding: 0, fontFamily: "inherit" },
            },
            logOpen ? "▾ 最近日志" : "▸ 最近日志",
          ),
          logOpen
            ? h(
                "div",
                { style: { fontFamily: mono, fontSize: 10, color: tone.faint, lineHeight: 1.6, maxHeight: 180, overflow: "auto", background: tone.surface2, borderRadius: 6, padding: "8px 10px" } },
                ...(state.log || []).slice(-20).map((entry, index) =>
                  h("div", { key: `${entry.at}-${index}`, style: { color: entry.kind === "error" ? tone.error : tone.faint } },
                    `${new Date(entry.at).toLocaleTimeString()} [${entry.kind}] ${entry.message}`)),
              )
            : null,
        ),

        backups
          ? h(Note, null, `备份目录：${backups.dir || ""} ｜ 文件 ${(backups.backups || []).length} 个`)
          : null,
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "dsh-tts", order: 40, label: "语音合成" },
            TtsSettingsPage,
          ),
        );
      },
    };
  },
});