// UI 渲染冒烟：用最小 React shim 把 client.js 的设置页渲染成字符串，
// 防止「某个卡/试听区/保存按钮被改没了」这类回归。夹具是脱敏后的真实接口返回。
// 用法：node test/render-smoke.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf8"));
const code = fs.readFileSync(path.join(root, "client.js"), "utf8");

const REAL_CONFIG = fixture("config.json");
const REAL_STATE = fixture("state.json");
const REAL_LOG = fixture("log.json");

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failed += 1;
};

function runOnce(tab, overrides = {}) {
  // state 覆盖单独摘出来：混进 configJson 会被当成配置字段渲染。
  const { state: stateOverride, ...configExtra } = overrides;
  const configJson = { ...REAL_CONFIG, apiStyle: tab, ...configExtra };
  const stateJson = stateOverride ? { ...REAL_STATE, ...stateOverride } : REAL_STATE;
  const componentHooks = new Map();
  let activeHooks = null;
  let dirty = false;
  let pendingEffects = [];

  const makeReact = () => ({
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.flat() } }),
    useState: (init) => {
      const list = activeHooks;
      const i = list.idx++;
      if (!(i in list.vals)) list.vals[i] = typeof init === "function" ? init() : init;
      return [list.vals[i], (value) => {
        list.vals[i] = typeof value === "function" ? value(list.vals[i]) : value;
        dirty = true;
      }];
    },
    useRef: (value) => {
      const list = activeHooks;
      const i = list.idx++;
      if (!(i in list.vals)) list.vals[i] = { current: value };
      return list.vals[i];
    },
    useEffect: (fn) => {
      const list = activeHooks;
      const i = list.idx++;
      if (!(i in list.effects)) {
        list.effects[i] = true;
        pendingEffects.push(fn);
      }
    },
    useLayoutEffect(fn) { this.useEffect(fn); },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    Fragment: Symbol("Fragment"),
  });

  let collected = [];
  const render = (node) => {
    if (node === null || node === undefined || node === false || node === true) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(render).join("");
    if (typeof node.type === "function") {
      let list = componentHooks.get(node.type);
      if (!list) {
        list = { idx: 0, vals: [], effects: {} };
        componentHooks.set(node.type, list);
      }
      const saved = activeHooks;
      activeHooks = list;
      list.idx = 0;
      const out = node.type({ ...node.props });
      activeHooks = saved;
      return render(out);
    }
    collected.push(node);
    const children = (node.props && node.props.children) || [];
    return `<${String(node.type)}>` + children.map(render).join("") + `</${String(node.type)}>`;
  };

  const fakeFetch = async (url) => {
    const pathname = new URL(String(url), "http://127.0.0.1:50076").pathname.replace(/^\/dsh-tts/, "");
    // 允许夹具注入「这个接口必须失败」，用来验证失败提示也有出口（不会被吞掉）。
    // 夹具里写 __failping 就能让 /ping 返回失败。
    const failKey = `__fail${pathname.replace(/^\//, "")}`;
    if (configJson[failKey]) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error: String(configJson[failKey]) }),
        text: async () => JSON.stringify({ ok: false, error: String(configJson[failKey]) }),
      };
    }
    let body = { ok: true };
    if (pathname === "/config") body = configJson;
    else if (pathname === "/state") body = stateJson;
    else if (pathname === "/log") body = REAL_LOG;
    else if (pathname === "/models") body = { ok: true, count: 0, models: [], url: "mock" };
    else if (pathname === "/voices") body = { ok: true, count: 0, voices: [], url: "mock" };
    // /import 会 applyPanel：必须回一份完整配置，否则 routeReady 被抹掉、页面直接崩。
    else if (pathname === "/import") body = { ...configJson, importedFrom: "C:\\\\mock\\\\qq-bridge\\\\config.json" };
    else if (pathname === "/ping") body = { ok: true, nickname: "测试号", userId: 10001, httpUrl: "http://127.0.0.1:3000", source: "mock", actionPrefix: "" };
    // 试听：允许用 __previewWarnings 注入宿主/上游警告，验证警告确实渲染出来。
    else if (pathname === "/preview") {
      body = {
        ok: true,
        audioId: "mock-audio",
        route: "mimo",
        actuallySang: false,
        durationSec: 1.2,
        bytes: 1024,
        mimeType: "audio/wav",
        elapsedMs: 123,
        warnings: configJson.__previewWarnings || [],
        curl: "curl mock",
      };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

  let registered = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { registered = spec; } } },
    document: { createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }) },
    fetch: fakeFetch,
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    navigator: { userAgent: "node-smoke" },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "client.js" });
  if (!registered) throw new Error("client.js 没有调用 __ModuleLoader__.load");
  const plugin = registered.factory((name) => {
    if (name === "react") return makeReact();
    throw new Error(`未知模块 ${name}`);
  });

  let captured = null;
  plugin.apply({
    slots: {
      inject: (_name, cb) => { cb(); },
      register: (spec, component) => { captured = { spec, component }; },
    },
  });
  if (!captured) throw new Error("没有注册 settings.section 组件");

  return { spec: captured.spec, render: async () => {
    let html = "";
    for (let pass = 0; pass < 8; pass += 1) {
      dirty = false;
      pendingEffects = [];
      collected = [];
      html = render({ type: captured.component, props: { close: () => {} } });
      const effects = pendingEffects.splice(0);
      await Promise.all(effects.map(async (fn) => { try { await fn(); } catch { /* 冒烟忽略 */ } }));
      await new Promise((r) => setTimeout(r, 30));
      if (!dirty) break;
    }
    return { html, nodes: collected };
  } };
}

const openai = await runOnce("openai");
check(openai.spec.name === "settings.section" && openai.spec.id === "dsh-tts", "注册到 settings.section（id=dsh-tts）");
const { html: openaiHtml, nodes: openaiNodes } = await openai.render();
check(openaiHtml.includes("试听（小米 MiMo）"), "小米面板自带试听区");
check(openaiHtml.includes("保存小米配置并检查"), "小米面板保存按钮");
check(openaiHtml.includes("调用优先级"), "调用优先级区域");
// 用户 m03329：调用优先级卡片里的「跟随当前协议」要去掉，只留三种明确选择。
check(!openaiHtml.includes("跟随当前协议"), "调用优先级不再有「跟随当前协议」选项");
check(openaiHtml.includes("智能（达到分界走小米"), "智能选项文案说明分界走向（达到分界走小米）");
check(openaiHtml.includes("字数分界") && openaiHtml.includes("时长分界"), "分界项命名为字数分界 / 时长分界");
check(openaiHtml.includes("≥ 这个字数就走小米"), "字数分界 hint 写明达到即走小米");
check(openaiHtml.includes("AI 主动发起的语音也走这套分界"), "界面说明 AI 主动语音同样走分界");
check(openaiHtml.includes("参考音频"), "参考音频入口（克隆音色页）");
check(openaiHtml.includes("合成并发 QQ 语音"), "发 QQ 语音区");
check(openaiHtml.includes("点一下别处即自动保存"), "小米面板 API Key 自动保存提示（填完点一下别处）");
check(openaiHtml.indexOf("接口地址") < openaiHtml.indexOf("API Key"), "小米面板 API Key 在接口地址下方");

// 用户 m01494 的改法：Key 填完失焦即自动保存，不再有「保存 Key」按钮。
// 必须真走一遍 onChange → 重渲染 → onBlur，验证「填了就有反馈」，而不只是输入框存在。
const findKeyInput = (nodes) => nodes.find((n) => n.type === "input" && n.props.type === "password");
const mimoKeyInput = findKeyInput(openaiNodes);
check(Boolean(mimoKeyInput), "小米面板有 API Key 输入框");
check(Boolean(mimoKeyInput && typeof mimoKeyInput.props.onBlur === "function"), "小米面板 API Key 输入框带 onBlur");
if (mimoKeyInput) {
  mimoKeyInput.props.onChange({ target: { value: "sk-test-abc" } });
  const mid = await openai.render();
  const live = findKeyInput(mid.nodes);
  check(Boolean(live && live.props.value === "sk-test-abc"), "小米面板 Key 输入后受控值保留");
  if (live && typeof live.props.onBlur === "function") {
    await live.props.onBlur();
    const after = await openai.render();
    check(after.html.includes("已自动保存"), "小米面板失焦后自动保存并就近反馈");
  }
}

const breeze = await runOnce("breeze");
const { html: breezeHtml, nodes: breezeNodes } = await breeze.render();
check(breezeHtml.includes("试听（Breeze）"), "Breeze 面板自带试听区");
check(breezeHtml.includes("保存 Breeze 配置并检查"), "Breeze 面板保存按钮");
check(breezeHtml.includes("点一下别处即自动保存"), "Breeze 面板 API Key 自动保存提示（填完点一下别处）");
check(breezeHtml.indexOf("接口地址") < breezeHtml.indexOf("API Key"), "Breeze 面板 API Key 在接口地址下方");
check(breezeHtml.includes("人声增强"), "声音参数使用中文标签");
check(breezeHtml.indexOf("音量（volume") < breezeHtml.indexOf("人声增强"), "人声增强开关跟在音量输入框后面（同一行）");

const breezeKeyInput = findKeyInput(breezeNodes);
check(Boolean(breezeKeyInput), "Breeze 面板有 API Key 输入框");
if (breezeKeyInput) {
  breezeKeyInput.props.onChange({ target: { value: "brz-test-abc" } });
  const mid = await breeze.render();
  const live = findKeyInput(mid.nodes);
  check(Boolean(live && live.props.value === "brz-test-abc"), "Breeze 面板 Key 输入后受控值保留");
  if (live && typeof live.props.onBlur === "function") {
    await live.props.onBlur();
    const after = await breeze.render();
    check(after.html.includes("已自动保存"), "Breeze 面板失焦后自动保存并就近反馈");
  }
}

// 「保存配置并检查」必须给出结果（用户报过点了没反应）。
const findButton = (nodes, text) => nodes.find((n) => n.type === "button" && (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children || "")).includes(text));
const mimoFresh = await openai.render();
const mimoSave = findButton(mimoFresh.nodes, "保存小米配置并检查");
check(Boolean(mimoSave), "小米面板保存并检查按钮可点击");
if (mimoSave) {
  await mimoSave.props.onClick();
  const after = await openai.render();
  check(after.html.includes("配置已保存"), "小米「保存配置并检查」后就近返回结果");
}
const breezeFresh = await breeze.render();
const breezeSave = findButton(breezeFresh.nodes, "保存 Breeze 配置并检查");
check(Boolean(breezeSave), "Breeze 面板保存并检查按钮可点击");
if (breezeSave) {
  await breezeSave.props.onClick();
  const after = await breeze.render();
  check(after.html.includes("配置已保存"), "Breeze「保存配置并检查」后就近返回结果");
}

// 用户 m02401 的 bug：Key 存好了、只是没选模型，调用优先级却显示「还没填 Key」。
// 必须按 routeReadyDetail 缺哪项说哪项，不能再把「缺模型」说成「没填 Key」。
const noModel = await runOnce("breeze", {
  routeReady: { mimo: true, breeze: false },
  routeReadyDetail: {
    mimo: { baseUrl: true, apiKey: true, model: true, missing: [], ready: true },
    breeze: { baseUrl: true, apiKey: true, model: false, missing: ["model"], ready: false },
  },
  breeze: { ...REAL_CONFIG.breeze, model: "" },
});
const noModelHtml = (await noModel.render()).html;
check(noModelHtml.includes("还缺模型"), "Key 已存但缺模型时提示缺模型");
check(!noModelHtml.includes("还没填 Key"), "缺模型时不再误报「还没填 Key」");

// 试听成功后宿主/上游的警告（如「克隆模型不能念预设音色，这次已临时换成预置模型」）
// 必须真的渲染出来，否则用户又被蒙在鼓里。
const warned = await runOnce("openai", {
  __previewWarnings: ["当前模型 mimo-v2.5-tts-voiceclone 是克隆模型，这次试听已临时改用 mimo-v2.5-tts"],
});
const warnedBtn = findButton((await warned.render()).nodes, "试听");
check(Boolean(warnedBtn), "试听按钮存在（警告渲染用例）");
if (warnedBtn) {
  await warnedBtn.props.onClick();
  const after = await warned.render();
  check(after.html.includes("克隆模型"), "试听警告会渲染出来（克隆模型临时换模型）");
}

// 用户 m00715：明明用的是克隆，可每次试听音色语速都不太一样，像是调了预置音色。
// 实测根因是参考音频只有 2.91 秒（有效语音 2.35 秒），上游每次复现波动极大。
// 所以「有效语音太短」必须在面板上常驻警告，而不是等用户自己怀疑插件没走克隆。
const shortRef = await runOnce("openai", {
  clone: {
    ...REAL_CONFIG.clone,
    seconds: 2.91,
    speechSeconds: 2.35,
    tooShort: true,
  },
});
const shortHtml = (await shortRef.render()).html;
check(shortHtml.includes("参考音频过短"), "有效语音过短时面板常驻「参考音频过短」警告");
check(shortHtml.includes("2.4") || shortHtml.includes("2.3"), "警告里带上量出的有效语音秒数");
check(shortHtml.includes("10~30 秒"), "警告里给出「建议 10~30 秒」的具体动作");
check(shortHtml.includes("超过 30 秒会自动截取"), "警告里说明超长会自动截断");

// 达标时不该出现这条警告（否则天天红着，用户就学会无视了）
const goodRef = await runOnce("openai", {
  clone: {
    ...REAL_CONFIG.clone,
    seconds: 12.4,
    speechSeconds: 11.8,
    tooShort: false,
  },
});
const goodHtml = (await goodRef.render()).html;
check(!goodHtml.includes("参考音频过短"), "有效语音达标时不再显示过短警告");
check(goodHtml.includes("12.4") || goodHtml.includes("11.8"), "达标时仍显示参考音频时长");

// 用户 m00978：「只改小米模板」。Breeze 面板不该被这条改动波及 ——
// 它根本没有参考音频概念（音色是 voice_id），出现这段文案就说明改错了地方。
const breezeShort = await runOnce("breeze", {
  clone: { ...REAL_CONFIG.clone, seconds: 2.91, speechSeconds: 2.35, tooShort: true },
});
check(
  !(await breezeShort.render()).html.includes("参考音频过短"),
  "Breeze 面板不受影响（只改小米模板）",
);

// 用户 m03165：自定义风格词填完点「保存并检查」就消失。
// 根因：styleCustom 只是前端临时状态，保存时被合并进 tts.style，而 fromConfig 又把
// styleCustom 重置为空；再加上「保存并检查」会重新 fromConfig，输入框就清了。
const findInputByPlaceholder = (nodes, text) => nodes.find((n) => n.type === "input" && String(n.props.placeholder || "").includes(text));
const findSelect = (nodes) => nodes.find((n) => n.type === "select");
const styleFresh = await openai.render();
const styleInput = findInputByPlaceholder(styleFresh.nodes, "粤语");
check(Boolean(styleInput), "说话风格卡有自定义风格词输入框");
check(Boolean(styleInput && typeof styleInput.props.onBlur === "function"), "自定义风格词输入框带 onBlur（失焦自动保存）");
if (styleInput) {
  styleInput.props.onChange({ target: { value: "粤语" } });
  const mid = await openai.render();
  const live = findInputByPlaceholder(mid.nodes, "粤语");
  check(Boolean(live && live.props.value === "粤语"), "自定义风格词输入后受控值保留");
  if (live && typeof live.props.onBlur === "function") {
    await live.props.onBlur();
    const after = await openai.render();
    check(after.html.includes("已自动保存"), "自定义风格词失焦后自动保存并就近反馈");
    // 关键：保存后输入框不能被清空（这正是用户报的「填写的风格会消失」）
    const afterInput = findInputByPlaceholder(after.nodes, "粤语");
    check(Boolean(afterInput && afterInput.props.value === "粤语"), "自动保存后自定义风格词仍在输入框里（不再消失）");
  }
}

// 用户 m03165：OneBot 的 Access Token 框浮在 HTTP 地址右上角。
// 根因是 Access Token 用了 Field 的 hint（多一行），配合 Row 的 align:flex-end 把它顶上去。
check(
  breezeHtml.indexOf("HTTP 地址") < breezeHtml.indexOf("Access Token") || openaiHtml.indexOf("HTTP 地址") < openaiHtml.indexOf("Access Token"),
  "OneBot 卡片同时有 HTTP 地址与 Access Token",
);
const onebotHtml = openaiHtml;
check(!/已设置，留空不改<\/span><\/label><\/div>/.test(onebotHtml) || onebotHtml.includes("Access Token"), "Access Token 仍是独立输入框");
// 两者都不应带 hint 行（带 hint 才会被 align:flex-end 顶高）
check(!onebotHtml.includes("可选</span>") && !onebotHtml.includes("已设置，留空不改</span>"), "Access Token 不再带独立 hint 行（与 HTTP 地址底对齐）");

// 0.3.7：Token 里有非 ASCII 字符时，卡片只**说明**、不改内容。
// 用户原话：「不要自动改全角/半角字符，我的密码有『！』，而不是『!』」——
// 0.3.4 的自动纠正把密码改坏了。所以文案必须是「原样送出」而不是「已改成半角」。
const dirtyOnebot = await runOnce("openai", {
  state: {
    onebot: {
      httpUrl: "http://127.0.0.1:3000",
      tokenSet: true,
      source: "plugin-config",
      nonAscii: [{ index: 11, char: "！", code: 0xff01 }],
    },
  },
});
const dirtyHtml = (await dirtyOnebot.render()).html;
check(dirtyHtml.includes("非 ASCII 字符"), "OneBot 卡片说明 Token 里有非 ASCII 字符");
check(dirtyHtml.includes("第 12 个字「！」"), "提示点出是 Token 的第几个字");
check(dirtyHtml.includes("不会改动它们"), "明确说明插件不改 Token 内容");
// 必须不再出现「已自动转成半角」这类会误导用户去手改密码的说法
check(!dirtyHtml.includes("自动改成半角"), "不再宣称会自动转半角（那会把密码改坏）");
// 干净的配置不该出现这条说明
check(!openaiHtml.includes("非 ASCII 字符"), "配置干净时不显示非 ASCII 说明");

// 用户：把保存后成功或报错的通知信息放在对应的卡片中，而不是全在最上方。
// 做法是每条通知带 scope（哪张卡片触发的），卡片底部用 CardNote 就地渲染 role="status"。
// 这里断言「通知文本确实落在它那张卡片之后」，而不是只在页面顶部冒出来。
const nodeText = (node) => {
  const props = node.props || {};
  if (node.type === "input" || node.type === "textarea" || node.type === "select") return "";
  const kids = props.children;
  return (Array.isArray(kids) ? kids.join("") : String(kids ?? ""));
};
const findStatusNode = (nodes, text) =>
  nodes.findIndex((n) => n.props && n.props.role === "status" && nodeText(n).includes(text));
const findTitleNode = (nodes, text) =>
  nodes.findIndex((n) => n.type === "div" && nodeText(n).trim() === text);

const routeFresh = await openai.render();
const routeSave = findButton(routeFresh.nodes, "保存调用优先级");
check(Boolean(routeSave), "调用优先级卡有保存按钮");
if (routeSave) {
  await routeSave.props.onClick();
  const after = await openai.render();
  const noteAt = findStatusNode(after.nodes, "调用优先级已保存");
  const titleAt = findTitleNode(after.nodes, "调用优先级");
  check(noteAt >= 0, "调用优先级保存成功后有通知");
  check(noteAt > titleAt && titleAt >= 0, "通知落在「调用优先级」卡片之内（在卡片标题之后），不在页面最上方");
}

// OneBot 卡片的两条操作（保存通道、测试连接）也必须把结果落在自己的卡片里。
const onebotFresh = await openai.render();
const onebotTitleAt = findTitleNode(onebotFresh.nodes, "OneBot 通道");
check(onebotTitleAt >= 0, "OneBot 卡片有标题");
const pingBtn = findButton(onebotFresh.nodes, "测试连接");
check(Boolean(pingBtn), "OneBot 卡有测试连接按钮");
if (pingBtn) {
  await pingBtn.props.onClick();
  const after = await openai.render();
  const pingAt = findStatusNode(after.nodes, "OneBot 在线");
  check(pingAt >= 0, "测试连接结果有通知");
  check(pingAt > onebotTitleAt, "测试连接结果落在 OneBot 卡片之内，不在页面最上方");
}

// 顶部保留的那一条只给「整套设置加载失败」这类不属于任何卡片的消息用。
const topNoteAt = findStatusNode(routeFresh.nodes, "已保存开关");
check(topNoteAt === -1, "未触发操作时页面顶部不残留通知");

// 用户（0.3.5，别处安装）：「【OneBot 通道】卡片点击【测试连接】无任何反馈（成功或失败）」。
// 根因：0.3.5 重构给 run() 加 scope 时把 ping 传成了 null，而 flash 里 `if (!scope) return;`
// 于是成功和失败都被静默丢弃 —— OneBot 卡片自己又没有任何提示，点完就是一片死寂。
const pingFresh = await runOnce("openai", { __failping: "连不上 OneBot 网关（测试注入）" });
const pingNodes0 = (await pingFresh.render()).nodes;
const pingBtnFail = findButton(pingNodes0, "测试连接");
check(Boolean(pingBtnFail), "测试连接按钮可点击（失败用例）");
if (pingBtnFail) {
  await pingBtnFail.props.onClick();
  const after = await pingFresh.render();
  const failed = findStatusNode(after.nodes, "连不上 OneBot 网关（测试注入）");
  check(failed >= 0, "测试连接失败时必须给出提示（不能再一片死寂）");
  const onebotTitle = findTitleNode(after.nodes, "OneBot 通道");
  check(failed > onebotTitle && onebotTitle >= 0, "失败提示落在 OneBot 卡片内");
}

// 成功提示同样不能被抑制（用户明确要求「不要抑制成功提示」）。
const okPing = await runOnce("openai");
const okBtn = findButton((await okPing.render()).nodes, "测试连接");
if (okBtn) {
  await okBtn.props.onClick();
  const after = await okPing.render();
  check(after.html.includes("OneBot 在线") || findStatusNode(after.nodes, "OneBot 在线") >= 0, "测试连接成功时有成功提示");
}

// 每个会写配置/发消息的按钮，成功提示都必须有落点：
// 逐个点一遍「保存通道 / 从 QQ Bridge 导入」，确认都能在 OneBot 卡片内看到结果。
const impFresh = await runOnce("openai");
const impBtn = findButton((await impFresh.render()).nodes, "从 QQ Bridge 导入");
check(Boolean(impBtn), "从 QQ Bridge 导入按钮可点击");
if (impBtn) {
  await impBtn.props.onClick();
  const after = await impFresh.render();
  check(findStatusNode(after.nodes, "导入") >= 0, "导入操作有提示（成功或失败都行，不能没有）");
}

// OneBot 卡片的地址提示。
// 曾经写成「5099 是 WebUI、必须改 3000」，但用户那台 SnowLuma 的 OneBot 只绑 127.0.0.1，
// 从别的机器根本连不到 3000——正确的建议反而不可达。现在改为「照控制台显示填」+
// 「插件自动判断前缀」+「token 用 OneBot 那页的，不是 WebUI 登录密码」。
check(onebotHtml.includes("OneBot 连接"), "OneBot 卡片指向控制台的「OneBot 连接」页");
check(onebotHtml.includes("access token"), "卡片说明要填 OneBot 的 access token");
check(/不是 WebUI 的登录密码/.test(onebotHtml), "明确区分 OneBot token 与 WebUI 登录密码");
check(/自动判断|会自动/.test(onebotHtml), "说明前缀由插件自动判断");
// 不该再断言「5099 不能用」——那会把人引向一个从外部不可达的端口
check(!/填它必然连不上/.test(onebotHtml), "不再宣称某个端口必然连不上");

// 0.3.10：跨机器发语音要说明「自动改用 base64 内联，不会把本机路径发过去」。
// 用户现场报 ENOENT + 本机路径，根因就是路径被发到了另一台机器。
check(onebotHtml.includes("base64"), "发到 QQ 卡片说明跨机器改用 base64");
check(/本机网关则用路径|本机网关用路径/.test(onebotHtml), "说明本机网关仍用路径");

// 0.3.11：① 拉取模型的通知太靠底部，要放在【拉取模型】按钮后面（成功也要）；
//          ② 【使用手填】按钮离【手填 model_id】框太远，要紧跟其后。
// 断言用「节点下标」比较相对位置，而不是只查文本存在。
const fetchBtnAt = openaiNodes.findIndex((n) => n.type === "button"
  && String(Array.isArray(n.props.children) ? n.props.children.join("") : n.props.children || "").includes("拉取模型"));
const customInputAt = openaiNodes.findIndex((n) => n.type === "input" && String(n.props.placeholder || "").includes("mimo-v2.6-tts"));
const useCustomAt = openaiNodes.findIndex((n) => n.type === "button"
  && String(Array.isArray(n.props.children) ? n.props.children.join("") : n.props.children || "").includes("使用手填"));
check(fetchBtnAt >= 0, "小米面板有「拉取模型」按钮");
check(customInputAt >= 0, "小米面板有「手填模型 id」输入框");
check(useCustomAt >= 0, "小米面板有「使用手填」按钮");
// 「使用手填」必须紧跟在手填输入框之后（中间不隔别的输入控件）
check(useCustomAt > customInputAt, "「使用手填」在手填框之后");
check(useCustomAt - customInputAt <= 1, `「使用手填」紧跟手填框（实际间隔 ${useCustomAt - customInputAt}）`);

// 拉取模型的结果要渲染在按钮附近，而不是卡片底部那一行。
// 触发一次拉取，然后确认页面上出现了「拉到 N 个模型」的 status 节点。
const fetchBtn = findButton(openaiNodes, "拉取模型");
if (fetchBtn) {
  await fetchBtn.props.onClick();
  const after = await openai.render();
  const fetchNoteAt = findStatusNode(after.nodes, "拉到");
  const afterCustomAt = after.nodes.findIndex((n) => n.type === "input" && String(n.props.placeholder || "").includes("mimo-v2.6-tts"));
  check(fetchNoteAt >= 0, "拉取模型后有成功/失败通知（成功也要有）");
  // 通知在「手填框」之前 → 说明它跟按钮在一起，没飘到卡片底部
  check(fetchNoteAt >= 0 && afterCustomAt >= 0 && fetchNoteAt < afterCustomAt, "拉取通知在按钮附近（手填框之前），不在卡片底部");
}

// Breeze 面板同样两条：那里的字段叫「手填 model_id」（placeholder「breeze-tts-2」）。
const bzNodes = (await breeze.render()).nodes;
const bzFetchAt = bzNodes.findIndex((n) => n.type === "button"
  && String(Array.isArray(n.props.children) ? n.props.children.join("") : n.props.children || "").includes("拉取模型"));
const bzCustomAt = bzNodes.findIndex((n) => n.type === "input" && String(n.props.placeholder || "").includes("breeze-tts-2"));
const bzUseAt = bzNodes.findIndex((n) => n.type === "button"
  && String(Array.isArray(n.props.children) ? n.props.children.join("") : n.props.children || "").includes("使用手填"));
check(bzFetchAt >= 0, "Breeze 面板有「拉取模型」按钮");
check(bzCustomAt >= 0, "Breeze 面板有「手填 model_id」输入框");
check(bzUseAt >= 0, "Breeze 面板有「使用手填」按钮");
check(bzUseAt - bzCustomAt <= 1, `Breeze「使用手填」紧跟手填框（实际间隔 ${bzUseAt - bzCustomAt}）`);
const bzFetchBtn = findButton(bzNodes, "拉取模型");
if (bzFetchBtn) {
  await bzFetchBtn.props.onClick();
  const after = await breeze.render();
  const noteAt = findStatusNode(after.nodes, "拉到");
  const afterVoiceCustomAt = after.nodes.findIndex((n) => n.type === "input" && String(n.props.placeholder || "").includes("voc_38dpges5szfx"));
  check(noteAt >= 0, "Breeze 拉取模型后有成功/失败通知（成功也要有）");
  // 通知在「手填 voice_id」之前 → 说明它在卡片上半部跟着按钮，没沉到卡片底部
  check(noteAt >= 0 && afterVoiceCustomAt >= 0 && noteAt < afterVoiceCustomAt, "Breeze 拉取通知在按钮附近（手填 voice_id 之前）");
}

// 0.3.12：上面两条断言只比「节点下标」，所以 0.3.11 里测试全绿、浏览器里却仍然错位。
// 真正的根因是 flex 布局：
//   ① CardNote 是 Row 里的普通 flex 项，长文案撑开整行 → 手填框被挤到下一行，
//      看起来就像「通知跑到很下面」。修法：让 CardNote 成为 Row 的**兄弟节点**（独占一行）。
//   ② 手填 Field 没给 width → 落到默认 flex:"1 1 160px"，吃满整行剩余宽度，
//      输入框固定 180px 靠左、【使用手填】被顶到行尾。修法：给 width。
// 这里直接断言布局属性，才能真的防回归。
const fieldBoxOf = (nodes, placeholderPart) => {
  // 手填输入框外面包着 Field 渲染出的 <label>：取它的 style 才能看出布局。
  const inputAt = nodes.findIndex((n) => n.type === "input" && String(n.props.placeholder || "").includes(placeholderPart));
  if (inputAt < 0) return null;
  for (let i = inputAt - 1; i >= 0; i -= 1) {
    if (nodes[i].type === "label") return nodes[i].props.style || {};
  }
  return null;
};
const rowOf = (nodes, childType, placeholderPart) => {
  // 找到同时包含「指定输入框」的那个 flex 容器（Row 渲染成 div + display:flex）。
  const inputAt = nodes.findIndex((n) => n.type === "input" && String(n.props.placeholder || "").includes(placeholderPart));
  if (inputAt < 0) return null;
  for (let i = inputAt - 1; i >= 0; i -= 1) {
    const st = nodes[i].props && nodes[i].props.style;
    if (nodes[i].type === "div" && st && st.display === "flex" && st.flexWrap === "wrap") return i;
  }
  return null;
};

const mimoFieldBox = fieldBoxOf(openaiNodes, "mimo-v2.6-tts");
check(Boolean(mimoFieldBox), "小米面板手填框外层有 Field 容器");
check(mimoFieldBox && mimoFieldBox.width && mimoFieldBox.width !== "auto",
  `小米手填 Field 必须给固定 width（否则 flex:1 1 160px 吃满整行，按钮被顶到行尾）：实际 ${JSON.stringify(mimoFieldBox && mimoFieldBox.width)}`);
check(mimoFieldBox && String(mimoFieldBox.flex || "").startsWith("0 0"),
  `小米手填 Field 必须是 0 0 auto（不伸缩）：实际 ${JSON.stringify(mimoFieldBox && mimoFieldBox.flex)}`);

const bzFieldBox = fieldBoxOf(bzNodes, "breeze-tts-2");
check(bzFieldBox && bzFieldBox.width && bzFieldBox.width !== "auto",
  `Breeze 手填 Field 必须给固定 width：实际 ${JSON.stringify(bzFieldBox && bzFieldBox.width)}`);
check(bzFieldBox && String(bzFieldBox.flex || "").startsWith("0 0"),
  `Breeze 手填 Field 必须是 0 0 auto：实际 ${JSON.stringify(bzFieldBox && bzFieldBox.flex)}`);

const bzVoiceFieldBox = fieldBoxOf(bzNodes, "voc_38dpges5szfx");
check(bzVoiceFieldBox && bzVoiceFieldBox.width && bzVoiceFieldBox.width !== "auto",
  `Breeze 手填 voice_id 的 Field 也必须给固定 width：实际 ${JSON.stringify(bzVoiceFieldBox && bzVoiceFieldBox.width)}`);

// CardNote 必须是 Row 的兄弟：独占一行，长文案才不会把手填框挤下去。
// 注意：通知只在「点过拉取」之后才存在，所以这里要用点击后重新渲染的节点，
// 不能复用点击前的 openaiNodes / bzNodes 快照。
const mimoAfterNodes = (await openai.render()).nodes;
const bzAfterNodes = (await breeze.render()).nodes;

const noteStyleOf = (nodes, text) => {
  const n = nodes.find((x) => x.props && x.props.role === "status" && nodeText(x).includes(text));
  return n ? n.props.style || {} : null;
};
const mimoNoteStyle = noteStyleOf(mimoAfterNodes, "拉到");
const bzNoteStyle = noteStyleOf(bzAfterNodes, "拉到");
for (const [label, st] of [["小米", mimoNoteStyle], ["Breeze", bzNoteStyle]]) {
  check(Boolean(st), `${label} 拉取通知有样式`);
  check(Boolean(st && st.overflowWrap === "anywhere"), `${label} 拉取通知必须允许任意断行（长 URL 不撑破容器）：${JSON.stringify(st && st.overflowWrap)}`);
  check(Boolean(st && st.minWidth === 0), `${label} 拉取通知 minWidth 必须是 0（flex 子项才能收缩）：${JSON.stringify(st && st.minWidth)}`);
}

// 通知节点与手填框的相对顺序：通知必须在前（按钮附近），手填框在后。
const idxOf = (nodes, type, test) => nodes.findIndex((n) => n.type === type && test(n));
const mimoNoteAt = idxOf(mimoAfterNodes, "div", (n) => n.props && n.props.role === "status" && nodeText(n).includes("拉到"));
const mimoCustomAt = idxOf(mimoAfterNodes, "input", (n) => String(n.props.placeholder || "").includes("mimo-v2.6-tts"));
check(mimoNoteAt >= 0 && mimoCustomAt >= 0 && mimoNoteAt < mimoCustomAt,
  `小米拉取通知必须排在手填框之前（通知 ${mimoNoteAt} < 手填 ${mimoCustomAt}）`);
const bzNoteAt = idxOf(bzAfterNodes, "div", (n) => n.props && n.props.role === "status" && nodeText(n).includes("拉到"));
const bzVoiceAt = idxOf(bzAfterNodes, "input", (n) => String(n.props.placeholder || "").includes("voc_38dpges5szfx"));
check(bzNoteAt >= 0 && bzVoiceAt >= 0 && bzNoteAt < bzVoiceAt,
  `Breeze 拉取通知必须排在手填 voice_id 之前（通知 ${bzNoteAt} < 手填 ${bzVoiceAt}）`);

if (failed > 0) {
  console.error(`render-smoke: ${failed} failed`);
  process.exitCode = 1;
} else {
  console.log("render-smoke: 0 failed");
}