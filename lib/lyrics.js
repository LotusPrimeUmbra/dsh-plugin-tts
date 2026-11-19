/**
 * 翻唱用的「按歌名搜歌词」。
 *
 * 只调网易云音乐的两个公开接口（搜索 + 取 LRC），不登录、不带 cookie：
 *   GET https://music.163.com/api/search/get/web?s=<关键字>&type=1&limit=N
 *   GET https://music.163.com/api/song/lyric?id=<歌曲 id>&lv=1&kv=1&tv=-1
 *
 * 为什么放在服务端而不是浏览器里：浏览器直连会被 CORS 挡掉（对方没有给跨域头），
 * 而主进程本来就已经在替界面发各种外部请求了。目标域名是写死的常量，
 * 不接受调用方传 URL，因此不存在 SSRF 面。
 */

const SEARCH_URL = 'https://music.163.com/api/search/get/web';
const LYRIC_URL = 'https://music.163.com/api/song/lyric';
const MUSIC_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  referer: 'https://music.163.com/'
};
const QUERY_MAX_CHARS = 60;
const CANDIDATE_DEFAULT = 6;

/** LRC 里每一行开头可能有多个时间标签：[00:12.34][01:20.00]副歌 */
const TIME_TAG_RE = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g;
/** 歌词文件头部的制作人员信息，不是要唱的内容。 */
const CREDIT_RE = /^(?:[^：:]{0,10}(?:作词|作曲|编曲|制作|监制|出品|发行|统筹|企划|录音|混音|母带|合声|和声|和聲|吉他|贝斯|鼓|键盘|弦乐|配唱|助理|工程|编写|词|曲|Written|Composed|Arranged|Produced|Mixed|Mastered|Lyrics|Music|Guitar|Bass|Drums|Piano|Strings|Vocal|Recorded|Engineer)[^：:]{0,12})[：:]\s*\S/i;

function textOf(value) {
  return String(value ?? '').trim();
}

function statusError(message, status) {
  return Object.assign(new Error(message), { statusCode: status });
}

async function getJson(url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: MUSIC_HEADERS
    });
  } catch (error) {
    const code = error?.cause?.code || error?.name || error?.message || String(error);
    throw statusError(`歌词接口连不上：${code}（需要能访问 music.163.com）`, 502);
  }
  if (!res.ok) throw statusError(`歌词接口返回 HTTP ${res.status}`, 502);
  const text = await res.text();
  // 网易云在触发风控时会回 HTML 验证页而不是 JSON，直接给出可诊断的提示。
  try {
    return JSON.parse(text);
  } catch {
    throw statusError('歌词接口返回的不是 JSON（可能被风控拦截，稍后再试或换个歌名）', 502);
  }
}

/**
 * 把 LRC 洗成人能唱的一段纯歌词。
 *
 * 规则：去掉所有时间标签、去掉作词/作曲/编曲这类头部信息、丢掉空行、
 * 合并**连续**重复行（同一句常因时间轴被拆成两行，但副歌在不同位置重复时必须保留）。
 */
export function cleanLrc(raw) {
  const out = [];
  let last = '';
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    // 全局正则的 lastIndex 会在多次 test 之间残留，这里用完立刻归零。
    TIME_TAG_RE.lastIndex = 0;
    const text = line.replace(TIME_TAG_RE, '').trim();
    if (!text) continue;
    // 制作人员 / 录音信息行：命中制作术语 + 冒号 + 值，且整行短、没有句读 —— 那不是歌词。
    if (text.length <= 40 && !/[，。？！、]/.test(text) && CREDIT_RE.test(text)) continue;
    // 首行常是「歌名 - 歌手 (艺人)」这种标题行（网易云也会给它挂时间标签），别让人把它唱出来。
    if (out.length === 0 && !/[，。？！、]/.test(text)
      && /^[^-–—]{1,24}\s[-–—]\s[^-–—]{1,24}(\s*\([^)]{0,24}\))?$/.test(text)) continue;
    if (text === last) continue;
    last = text;
    out.push(text);
  }
  return out.join('\n');
}

function normalizeSong(hit) {
  const id = Number(hit?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  // 新旧两套接口字段名不同：老的叫 artists / album，新的叫 ar / al。
  const artists = Array.isArray(hit.artists) ? hit.artists : Array.isArray(hit.ar) ? hit.ar : [];
  const album = hit.album ?? hit.al ?? {};
  const durationMs = Number(hit.duration ?? hit.dt ?? 0);
  return {
    id,
    name: textOf(hit.name),
    artist: artists.map((a) => textOf(a?.name)).filter(Boolean).join(' / '),
    album: textOf(album?.name),
    durationSec: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : 0
  };
}

/** 按关键字搜歌，返回候选列表（最多 limit 条，已过滤掉没有 id 的脏数据）。 */
export async function searchSongs(query, { limit = CANDIDATE_DEFAULT, timeoutMs = 8000 } = {}) {
  const q = textOf(query);
  if (!q) throw statusError('歌名不能为空', 400);
  if ([...q].length > QUERY_MAX_CHARS) throw statusError(`歌名太长（上限 ${QUERY_MAX_CHARS} 字）`, 400);
  const n = Math.min(20, Math.max(1, Math.round(Number(limit) || CANDIDATE_DEFAULT)));
  const url = `${SEARCH_URL}?s=${encodeURIComponent(q)}&type=1&limit=${n}&offset=0`;
  const data = await getJson(url, timeoutMs);
  if (Number(data?.code) !== 200) {
    throw statusError(`歌词搜索失败：${textOf(data?.message) || `code ${data?.code ?? '?'}`}`, 502);
  }
  const songs = Array.isArray(data?.result?.songs) ? data.result.songs : [];
  return songs.map(normalizeSong).filter(Boolean).slice(0, n);
}

/** 取一首歌的歌词正文（优先原文 LRC，没有原文时退回翻译版）。 */
export async function fetchSongLyrics(songId, { timeoutMs = 8000 } = {}) {
  const id = Number(songId);
  if (!Number.isFinite(id) || id <= 0) throw statusError('歌曲 id 不合法', 400);
  const url = `${LYRIC_URL}?id=${id}&lv=1&kv=1&tv=-1`;
  const data = await getJson(url, timeoutMs);
  if (Number(data?.code) !== 200) {
    throw statusError(`取歌词失败：${textOf(data?.message) || `code ${data?.code ?? '?'}`}`, 502);
  }
  const original = cleanLrc(data?.lrc?.lyric);
  const translated = cleanLrc(data?.tlyric?.lyric);
  return {
    id,
    lyrics: original || translated,
    hasTranslation: Boolean(original && translated),
    translated: original ? translated : ''
  };
}

/**
 * 一次拿到「填进输入框就能唱」的结果：候选列表 + 第一条候选的歌词。
 *
 * 这样前端点一次「搜歌词」就能直接用（符合「我不想手动添加」），
 * 候选列表只是备选，命中不对时点另一条再取。
 */
export async function resolveLyrics({ query = '', songId = 0, limit = CANDIDATE_DEFAULT, timeoutMs = 8000 } = {}) {
  const id = Number(songId);
  if (Number.isFinite(id) && id > 0) {
    const detail = await fetchSongLyrics(id, { timeoutMs });
    return { query: textOf(query), candidates: [], song: { ...detail, name: '', artist: '', album: '', durationSec: 0 } };
  }
  const candidates = await searchSongs(query, { limit, timeoutMs });
  if (!candidates.length) {
    throw statusError(`没搜到「${textOf(query)}」的歌词：换个写法（歌名 + 歌手）再试`, 404);
  }
  const first = candidates[0];
  let lyrics = '';
  let hasTranslation = false;
  try {
    const detail = await fetchSongLyrics(first.id, { timeoutMs });
    lyrics = detail.lyrics;
    hasTranslation = detail.hasTranslation;
  } catch {
    // 某一首取不到歌词（无版权/纯音乐）不影响候选列表：让用户自己点别的。
  }
  return {
    query: textOf(query),
    candidates,
    song: { ...first, lyrics, hasTranslation: Boolean(lyrics && hasTranslation) }
  };
}