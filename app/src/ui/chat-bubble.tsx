import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { MarkdownRenderer } from './markdown-renderer';
import { sanitizeMarkdown } from './markdown-sanitize';
import {
  buildCharacterSystemPrompt,
  DEFAULT_CHARACTER_PERSONAS,
  resolveDefaultCharacterPersona,
  type CharacterPersona,
  type Emotion,
} from '../../shared/emotion-map';
import { useVoiceDictation } from '../render/use-voice-dictation';

/** OpenAI 多模态 content 单元 — 与 preload.ts 的 AIContentPart 同型。 */
type AIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  /** string = 纯文本(历史轮 / 普通消息);AIContentPart[] = 当前轮多模态(text + 图) */
  content: string | AIContentPart[];
  /** 推理模型(DeepSeek-R/V4 / o-series)的思考过程,仅 assistant 消息可能有 */
  thinking?: string;
}

/** JSON.stringify 兜底 + 截断,给 UI 展示工具参数/结果用 */
function safeStringify(v: unknown, limit = 400): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    s = String(v);
  }
  if (s.length > limit) s = s.slice(0, limit) + '…';
  return s;
}

/** content 可能是 string 或 AIContentPart[] — 渲染时统一成字符串。
 *  正常情况历史里 user 消息就是 placeholderText(string),assistant 也是 string;
 *  仅"当前要发给 LLM 的那一刻"才会临时替换成 array,不会落进 session.messages。 */
function contentToString(c: string | AIContentPart[]): string {
  if (typeof c === 'string') return c;
  return c.map((p) => (p.type === 'text' ? p.text : '[图片]')).join(' ');
}

interface Session {
  id: string;
  title: string;
  messages: AIMessage[];
  createdAt: number;
  /** 当前会话的"上下文起点":发给 LLM 的 messages 是 messages.slice(contextStartIdx)。
   *  用户说"换个话题/新问题/忘了前面"等触发 RESET_CONTEXT_RE 时,设为当时的 messages.length,
   *  之后 LLM 视角"翻篇"。messages 本身永远不删,用户翻历史看完整记录。
   *  缺省/旧数据 = 0(走老逻辑,全量当上下文)。 */
  contextStartIdx?: number;
}

const STORAGE_KEY_BASE = 'pet:chat-sessions-v1';
const STREAM_STATE_FLUSH_MS = 50;
/** 按角色 namespace 隔离 sessions:不同角色看到不同的会话历史。
 *  characterName 为 null/空 → 'default' 桶兜底 */
function storageKey(characterName?: string | null): string {
  return STORAGE_KEY_BASE + ':' + (characterName?.trim() || 'default');
}

function genId(): string {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function loadSessions(
  characterName?: string | null,
): { sessions: Session[]; activeId: string | null } {
  try {
    const raw = localStorage.getItem(storageKey(characterName));
    if (!raw) return { sessions: [], activeId: null };
    const j = JSON.parse(raw) as { sessions: Session[]; activeId: string | null };
    if (!Array.isArray(j.sessions)) return { sessions: [], activeId: null };
    return { sessions: j.sessions, activeId: j.activeId ?? null };
  } catch {
    return { sessions: [], activeId: null };
  }
}

function saveSessions(
  characterName: string | null | undefined,
  sessions: Session[],
  activeId: string | null,
): void {
  try {
    localStorage.setItem(storageKey(characterName), JSON.stringify({ sessions, activeId }));
  } catch {
    // ignore
  }
}

function makeTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 16 ? t.slice(0, 16) + '…' : t || '新对话';
}

/** 显式标签优先解析;识别不到再 fallback 到 emoji + 关键词。
 *  AI persona prompt 要求模型在结尾附 `[emotion: xxx]`,这里做权威解析。
 *  - STRIP_RE:**剥离**所有形如 `[emotion: 任意词]` 的标签(模型常自创 sheepish/embarrassed 等),
 *    避免泄漏到正文显示。
 *  - PARSE_RE:**只识别**白名单四种 → 触发动作;其它泛化标签忽略,不触发动作。 */
const EMOTION_TAG_STRIP_RE = /\[\s*emotion\s*[::]\s*[a-zA-Z_\u4e00-\u9fa5-]+\s*\]/gi;
const EMOTION_TAG_PARSE_RE = /\[\s*emotion\s*[::]\s*(happy|sad|angry|surprised)\s*\]/i;
function parseEmotionTag(text: string): Emotion | null {
  const m = text.match(EMOTION_TAG_PARSE_RE);
  if (!m) return null;
  return m[1].toLowerCase() as Emotion;
}
/** 把 `[emotion: xxx]` 标签、markdown 水平分隔线、各种破折号字符从显示文本里剥掉。
 *  - `---` / `***` / `___`(整行 3+ 连续)→ 删整行
 *  - 所有非 ASCII 的横杠类字符(U+2010~U+2015 / U+2212 / U+2E3A~U+2E3B / U+FE58 / U+FE63 / U+FF0D)→ 逗号
 *    覆盖:‐ ‑ ‒ – — ― − ⸺ ⸻ ﹘ ﹣ -(全角)
 *  - ASCII `--` 及更多(英文双连字符当破折号用)→ 逗号(单个 - 不动,保留 a-b 这种合法连字符)
 *  - 紧贴的连续标点合并 */
function stripEmotionTag(text: string): string {
  return text
    .replace(EMOTION_TAG_STRIP_RE, '')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    // 非 ASCII 横杠字符全替换成逗号
    .replace(/[\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]+/g, ',')
    // ASCII 双连字符:用逗号替换(单 - 不动,保留 a-b 合法连字符)
    .replace(/(?<!\w)-{2,}(?!\w)/g, ',')
    .replace(/,{2,}/g, ',')        // 合并连续逗号
    .replace(/,([,。!?])/g, '$1') // 逗号紧挨其它标点 → 删掉逗号
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
function detectEmotion(text: string): Emotion | null {
  const tag = parseEmotionTag(text);
  if (tag) return tag;
  if (/[😊😄😁😂🤣😆😍🥰😘😉🥳❤️♥💕✨🎉]/u.test(text)) return 'happy';
  if (/[😢😭😔😞💔]/u.test(text)) return 'sad';
  if (/[😡😠💢🤬]/u.test(text)) return 'angry';
  if (/[😱😲🤯😮]/u.test(text)) return 'surprised';
  if (/(开心|高兴|哈哈|哈哈哈|笑死|赞|很棒|不错|喜欢)/.test(text)) return 'happy';
  if (/(难过|伤心|哭|遗憾|可惜)/.test(text)) return 'sad';
  if (/(生气|烦|讨厌|气死)/.test(text)) return 'angry';
  if (/(惊讶|震惊|没想到|吃惊|哇)/.test(text)) return 'surprised';
  return null;
}

function dispatchPetState(kind: 'thinking' | 'talking' | 'idle'): void {
  window.dispatchEvent(new CustomEvent('pet:state', { detail: { kind } }));
}
function dispatchPetEmotion(emotion: string): void {
  window.dispatchEvent(new CustomEvent('pet:emotion', { detail: { emotion } }));
}

/** 极简线条图标 — 工具栏按钮专用,描边走 currentColor,跟着按钮颜色变。
 *  size 默认 16(普通工具栏);编码模式 codingMode 工具栏需要时传 15。 */
function ToolIcon({ name, size = 16 }: { name: 'mic' | 'camera' | 'image' | 'paperclip'; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    style: { display: 'block' as const },
  };
  switch (name) {
    case 'mic':
      return (
        <svg {...common}>
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 11v1a7 7 0 0 0 14 0v-1" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
      );
    case 'camera':
      return (
        <svg {...common}>
          <path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
      );
    case 'image':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.6" />
          <path d="M21 16l-5-5-9 9" />
        </svg>
      );
    case 'paperclip':
      return (
        <svg {...common}>
          <path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8.5-8.5" />
        </svg>
      );
  }
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** 模型腰线 Y(CSS 像素);默认气泡(compact)贴该位置 */
  anchorY: number | null;
  /** 编码(增强)模式:popup 切到屏幕底部居中紧凑条,隐藏历史按钮,让模型完整露出 */
  codingMode?: boolean;
  /** 当前角色名(Live2DCharacter.name)— 用于按角色注入 persona system prompt 与情绪映射。
   *  没设置或没在 emotion-map 里登记的角色,fallback 到全局 skill prompt + 关键词情绪检测。 */
  characterName?: string | null;
}

/**
 * Stardew 风格对话框 + 多会话管理 + 推理过程持久化(可折叠)。
 *
 * 两种显示模式:
 *   compact (默认):贴模型腰线的小气泡,只显示最新一轮(user + streaming/最新 assistant)
 *   history (≡ 按钮切换):大窗,完整历史滚动
 */
export function ChatBubble({ visible, onClose, anchorY, characterName, codingMode }: Props) {
  // sessions 全局共享(不随角色切换重置)
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 三种模式:qa-input(锁腰线输入框)/ qa-answer(锁腰线回答卡)/ history(大窗历史会话管理) */
  const [mode, setMode] = useState<'qa-input' | 'qa-answer' | 'history'>('qa-input');
  // 编码模式不允许 history 大窗(底部紧凑条放不下),自动回到 qa-input
  useEffect(() => {
    if (codingMode && mode === 'history') setMode('qa-input');
  }, [codingMode, mode]);
  /** 用户拖动后的 popup 自定义位置(只存 left/top;尺寸由浏览器 resize 自己写 inline,
   *  React 不接管,否则每次 render 会盖回 resize 结果) */
  const [popupRect, setPopupRect] = useState<{ left: number; top: number } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  /** 当前 skill 显示名(状态条用) */
  const [skillName, setSkillName] = useState('助手');
  /** 模型当前对话状态 — 用于顶部状态条 */
  const [petState, setPetState] = useState<'idle' | 'thinking' | 'talking'>('idle');

  const [input, setInput] = useState('');
  /** 当前轮要随消息发送的图片附件(dataURL 数组)。
   *  发送后清空。最多 4 张,单图 ≤ 8MB,持久化 sessions 时不存(占用太大)。 */
  const [attachments, setAttachments] = useState<string[]>([]);
  /** 当前轮文件附件 — 已解析为文本,发送时拼进 user content 的 text 块。
   *  text 已做大小截断(50KB)。 */
  const [fileAttachments, setFileAttachments] = useState<
    { name: string; sizeBytes: number; text: string }[]
  >([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 是否在 config 里启用了语音输入功能(决定 🎤 按钮是否显示) */
  const [voiceInputAvailable, setVoiceInputAvailable] = useState(false);
  /** 编码模式工具栏底部显示的"当前模型名" — 读 cfg.model,跟随设置变化 */
  const [modelLabel, setModelLabel] = useState('模型');
  /** 编码模式下拉:所有 provider profiles 的所有 modelPresets,按 profile 分组。
   *  选中后会同时切 active profile + 改 cfg.model。 */
  const [modelGroups, setModelGroups] = useState<
    Array<{ profileId: string; profileName: string; models: string[] }>
  >([]);
  /** 当前选中的 (profileId, model) 编码字符串 — `${profileId}::${model}`,select 的 value */
  const [activeModelKey, setActiveModelKey] = useState<string>('');
  /** 编码模式:右上角「历史」按钮的下拉菜单显隐 */
  const [showHistoryMenu, setShowHistoryMenu] = useState(false);
  /** 编码模式:正在重命名的会话 id + 临时输入。null = 无人在编辑。 */
  const [renamingSession, setRenamingSession] = useState<{ id: string; title: string } | null>(null);
  /** 用户当前是否在听写中 — 仅 true 时启动 mic + recognizer */
  const [dictating, setDictating] = useState(false);
  /** 听写时把 partial 文本暂存,与用户已经手敲的内容拼接显示,
   *  这样用户能看到"我已经识别到的实时文字" + 不影响他继续编辑前面的部分。 */
  const [dictationPartial, setDictationPartial] = useState('');
  /** 当前 turn 正在进行的 MCP tool 调用事件流 — call/result/error,渲染在思考过程里。
   *  每次新一轮 send() 会清空。 */
  const [toolEvents, setToolEvents] = useState<
    Array<{
      callId: string;
      stage: 'call' | 'result' | 'error';
      toolName: string;
      args?: unknown;
      result?: unknown;
      error?: string;
    }>
  >([]);
  /** 写操作确认请求 — 主进程调 mutating tool 前发来。点允许/拒绝后回 IPC。 */
  const [confirmRequest, setConfirmRequest] = useState<
    | { id: string; toolName: string; args: unknown }
    | null
  >(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const streamingTextRef = useRef('');
  const thinkingTextRef = useRef('');
  const streamFlushTimerRef = useRef<number | null>(null);
  const thinkingFlushTimerRef = useRef<number | null>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  /** 历史模式渐进渲染:只渲染最近 N 条消息 — 一条 markdown 复杂消息渲染挺慢
   *  (含 ReactMarkdown + KaTeX + Mermaid + SyntaxHighlighter),长会话进历史模式会卡。
   *  滚到顶部 50px 内自动 +20 条;切会话/切模式时重置 20。 */
  const HISTORY_PAGE = 20;
  const CODING_HISTORY_LIMIT = 80;
  const [historyDisplayCount, setHistoryDisplayCount] = useState(HISTORY_PAGE);
  /** 流式时思考过程区:每次新增内容自动滚到最底 */
  const thinkingBodyRef = useRef<HTMLDivElement>(null);
  const clearTextFlushTimers = () => {
    if (streamFlushTimerRef.current != null) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    if (thinkingFlushTimerRef.current != null) {
      window.clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }
  };
  const scheduleStreamingTextFlush = () => {
    if (streamFlushTimerRef.current != null) return;
    streamFlushTimerRef.current = window.setTimeout(() => {
      streamFlushTimerRef.current = null;
      setStreamingText(streamingTextRef.current);
    }, STREAM_STATE_FLUSH_MS);
  };
  const scheduleThinkingTextFlush = () => {
    if (thinkingFlushTimerRef.current != null) return;
    thinkingFlushTimerRef.current = window.setTimeout(() => {
      thinkingFlushTimerRef.current = null;
      setThinkingText(thinkingTextRef.current);
    }, STREAM_STATE_FLUSH_MS);
  };
  useEffect(() => {
    const el = thinkingBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thinkingText]);

  // 订阅 MCP 事件 — confirm-request(写操作前)+ tool-event(调用过程展示)
  useEffect(() => {
    const offConfirm = window.petAPI?.onMcpConfirmRequest?.((p) => {
      setConfirmRequest(p);
    });
    const offTool = window.petAPI?.onMcpToolEvent?.((p) => {
      setToolEvents((arr) => {
        // 同一 callId 已有 call → 合并 result/error
        const idx = arr.findIndex((e) => e.callId === p.callId);
        if (idx >= 0) {
          const next = arr.slice();
          next[idx] = { ...next[idx], ...p };
          return next;
        }
        return [...arr, p];
      });
    });
    return () => {
      offConfirm?.();
      offTool?.();
    };
  }, []);

  // ---- 初始化 / 角色切换:按当前角色 namespace 重新加载 sessions ----
  // characterName 变化时 → 切到那个角色之前的对话历史(每个角色独立一份)
  useEffect(() => {
    // 切角色时,先取消正在进行的流式请求,避免回包污染新角色
    cancelRef.current?.();
    cancelRef.current = null;
    setStreaming(false);
    clearTextFlushTimers();
    setStreamingText('');
    setThinkingText('');
    streamingTextRef.current = '';
    thinkingTextRef.current = '';
    setError(null);

    const { sessions: loaded, activeId: lastId } = loadSessions(characterName);
    if (loaded.length === 0) {
      const ns: Session = {
        id: genId(),
        title: '新对话',
        messages: [],
        createdAt: Date.now(),
      };
      setSessions([ns]);
      setActiveId(ns.id);
    } else {
      setSessions(loaded);
      setActiveId(lastId && loaded.some((s) => s.id === lastId) ? lastId : loaded[0].id);
    }
  }, [characterName]);

  // ---- 持久化:写到当前角色的 namespace key ----
  useEffect(() => {
    if (sessions.length > 0) saveSessions(characterName, sessions, activeId);
  }, [sessions, activeId, characterName]);

  // ---- 加载顶部显示名:优先用当前角色 active persona 的 displayName,
  //      没有则 fallback 到 character.name → skill name → '助手'。
  //      监听 petAI:configChanged 立即刷新(保存即生效)。 ----
  useEffect(() => {
    const refresh = async () => {
      const cfg = await window.petAPI?.getConfig?.();
      if (!cfg) return;
      // 1) 当前角色的 active persona
      if (characterName) {
        const slot = cfg.characterPersonas?.[characterName];
        if (slot && slot.personas.length > 0) {
          const cur = slot.personas.find((p) => p.id === slot.activeId) ?? slot.personas[0];
          if (cur.displayName) {
            setSkillName(cur.displayName);
            return;
          }
        }
        // 2) 默认 persona 的 displayName(代码内置)
        const def = DEFAULT_CHARACTER_PERSONAS[characterName];
        if (def?.displayName) {
          setSkillName(def.displayName);
          return;
        }
        // 3) 角色文件夹名兜底
        setSkillName(characterName);
        return;
      }
      // 4) 没角色时回到 skill 名
      const sk = cfg.skills?.find((s) => s.id === cfg.activeSkillId);
      setSkillName(sk?.name?.trim() || '助手');
    };
    refresh();
    const onChanged = () => refresh();
    window.addEventListener('petAI:configChanged', onChanged);
    return () => {
      window.removeEventListener('petAI:configChanged', onChanged);
    };
  }, [characterName]);

  // ---- 监听 persona 变化 → 自动给当前角色开新会话,
  //      避免历史里的旧自称/旧语气作为上下文影响 LLM,新人设无法生效 ----
  useEffect(() => {
    const onPersonaChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail as { characterName?: string };
      // 只对当前角色响应(改其他角色的 persona 不影响这里)
      if (detail?.characterName && detail.characterName !== characterName) return;
      newConversation();
    };
    window.addEventListener('petAI:personaChanged', onPersonaChanged as EventListener);
    return () =>
      window.removeEventListener('petAI:personaChanged', onPersonaChanged as EventListener);
  }, [characterName]);

  // ---- 监听 pet:state 反映到顶部状态条 ----
  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent).detail as { kind?: 'idle' | 'thinking' | 'talking' };
      setPetState(detail?.kind ?? 'idle');
    };
    window.addEventListener('pet:state', onState as EventListener);
    return () => window.removeEventListener('pet:state', onState as EventListener);
  }, []);

  // ---- 读 config.voiceWake.voiceInput 决定 🎤 按钮是否可见;
  //      顺便把 cfg.model 取出来给编码模式工具栏当模型标签用 ----
  useEffect(() => {
    const refresh = async () => {
      const cfg = await window.petAPI?.getConfig?.();
      setVoiceInputAvailable(!!cfg?.voiceWake?.voiceInput);
      // 模型名展示:截断超长的(有些 baseURL 拼出来的 model 字符串很长)
      const m = (cfg?.model ?? '').trim();
      setModelLabel(m ? (m.length > 32 ? m.slice(0, 30) + '…' : m) : '未配置模型');
      // 把所有 profile 的所有 modelPresets 拉出来 — 工具栏下拉一次性展示全部模型,
      // 选中后会同时切 profile + model(写顶层 cfg + active profile)
      const profiles = cfg?.providerProfiles ?? [];
      let groups: Array<{ profileId: string; profileName: string; models: string[] }>;
      if (profiles.length > 0) {
        groups = profiles
          .map((p) => ({
            profileId: p.id,
            profileName: p.name,
            // 兜底:active profile 的 model 不在 presets 时,把它加进去
            models:
              p.id === cfg?.activeProviderId && p.model && !p.modelPresets?.includes(p.model)
                ? [p.model, ...(p.modelPresets ?? [])]
                : p.modelPresets ?? [],
          }))
          .filter((g) => g.models.length > 0);
      } else {
        // 没 profile(老版本)— 退化成顶层 modelPresets
        const presets = cfg?.modelPresets ?? [];
        const opts = m && !presets.includes(m) ? [m, ...presets] : presets;
        groups = opts.length > 0 ? [{ profileId: '', profileName: '', models: opts }] : [];
      }
      setModelGroups(groups);
      const activeId = cfg?.activeProviderId ?? '';
      setActiveModelKey(m ? `${activeId}::${m}` : '');
    };
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener('petAI:configChanged', onChanged);
    return () => window.removeEventListener('petAI:configChanged', onChanged);
  }, []);

  // 关掉对话框 / 切换会话 / 切角色时,自动停止听写,避免后台还在持有 mic
  useEffect(() => {
    if (!visible) setDictating(false);
  }, [visible]);
  useEffect(() => {
    setDictating(false);
    setDictationPartial('');
  }, [characterName, activeId]);

  // ---- visible 切换时:重置 inline 尺寸 + 把 popup 默认放到模型(character-host)中央 ----
  useEffect(() => {
    if (!visible) {
      setPopupRect(null);
      if (popupRef.current) {
        popupRef.current.style.width = '';
        popupRef.current.style.height = '';
      }
      return;
    }
    // 清掉残留尺寸
    if (popupRef.current) {
      popupRef.current.style.width = '';
      popupRef.current.style.height = '';
    }
    // 延迟测量 — 等 chatOpen 触发的 character-host 重布局完成
    const timer = window.setTimeout(() => {
      const host = document.querySelector('.character-host') as HTMLElement | null;
      const popup = popupRef.current;
      if (!host || !popup) return;
      const hostRect = host.getBoundingClientRect();
      const popupW = popup.offsetWidth || 324;
      const popupH = popup.offsetHeight || 200;
      // 横向:character-host 中心 - popup 半宽(模型在哪边 popup 就在哪边)
      let left = hostRect.left + hostRect.width / 2 - popupW / 2;
      // 纵向:腰线 anchorY - popup 半高;无 anchorY 时取 host 中心
      const centerY = anchorY != null ? anchorY : hostRect.top + hostRect.height / 2;
      let top = centerY - popupH / 2;
      // clamp 到 viewport 内
      left = Math.max(8, Math.min(window.innerWidth - popupW - 8, left));
      top = Math.max(8, Math.min(window.innerHeight - popupH - 8, top));
      setPopupRect({ left, top });
    }, 80);
    return () => window.clearTimeout(timer);
    // 仅 visible 变化触发,anchorY 不进 deps(避免 anchorY 变把用户拖动后的位置刷回)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ---- 切角色卸载时取消正在进行的请求 ----
  useEffect(() => {
    return () => {
      cancelRef.current?.();
      clearTextFlushTimers();
    };
  }, []);

  // 注:popup max-width/max-height 由 popupStyle 内联根据 popup 当前 left/top 计算,
  // 浏览器原生限制 resize:both 不会越过 viewport,无需 ResizeObserver(避免反馈循环闪烁)

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const history = active?.messages ?? [];

  // 自动滚到底
  useEffect(() => {
    const el = linesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [history, streamingText, thinkingText, error]);

  // 切到 history 模式 / 切会话 → 重置渲染窗口为 N(只显示最近 N 条,避免一次渲染整段历史卡顿)
  useEffect(() => {
    if (mode === 'history') {
      setHistoryDisplayCount(HISTORY_PAGE);
    }
  }, [mode, activeId]);

  // 历史模式滚到顶 50px 内 → 自动加载更早一页(类似聊天软件向上滚加载历史)
  useEffect(() => {
    if (mode !== 'history') return;
    const el = linesRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 50 && history.length > historyDisplayCount) {
        // 记录当前 scrollHeight,加载后保持视觉位置(否则用户视觉位置会跳)
        const prevH = el.scrollHeight;
        setHistoryDisplayCount((c) => Math.min(c + HISTORY_PAGE, history.length));
        // 等下一帧 DOM 更新后调 scroll
        requestAnimationFrame(() => {
          if (linesRef.current) {
            const dh = linesRef.current.scrollHeight - prevH;
            linesRef.current.scrollTop = dh + el.scrollTop;
          }
        });
      }
    };
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [mode, history.length, historyDisplayCount]);

  const updateActiveSession = (patch: (s: Session) => Session) => {
    setSessions((arr) => arr.map((s) => (s.id === activeId ? patch(s) : s)));
  };

  const newConversation = () => {
    cancelRef.current?.();
    cancelRef.current = null;
    setStreaming(false);
    clearTextFlushTimers();
    setStreamingText('');
    setThinkingText('');
    streamingTextRef.current = '';
    thinkingTextRef.current = '';
    setError(null);
    const ns: Session = { id: genId(), title: '新对话', messages: [], createdAt: Date.now() };
    setSessions((arr) => [ns, ...arr]);
    setActiveId(ns.id);
  };

  const switchSession = (id: string) => {
    if (id === activeId) {
      return;
    }
    cancelRef.current?.();
    cancelRef.current = null;
    setStreaming(false);
    clearTextFlushTimers();
    setStreamingText('');
    setThinkingText('');
    streamingTextRef.current = '';
    thinkingTextRef.current = '';
    setError(null);
    setActiveId(id);
  };

  /** 重命名会话 — 编辑 sessions 数组中匹配 id 的 title 字段。空白回退到原值。 */
  const renameSession = (id: string, nextTitle: string) => {
    const t = nextTitle.trim();
    if (!t) return;
    setSessions((arr) => arr.map((s) => (s.id === id ? { ...s, title: t } : s)));
  };

  /** 编码模式工具栏切换模型 — 同时切 profile + model:
   *   - 把 active profile 改成 targetProfileId
   *   - 把 cfg 顶层(baseURL/apiKey/model/modelPresets,ai-client 读这一份)同步成 target profile 的内容
   *   - 把 target profile 自身的 model 字段也改成新选的 model
   *  广播 petAI:configChanged 让其他监听者(ai-client / chat-bubble 顶部状态条)立刻看到新值。 */
  const changeModel = async (key: string) => {
    const sep = key.indexOf('::');
    if (sep < 0) return;
    const targetProfileId = key.slice(0, sep);
    const targetModel = key.slice(sep + 2);
    if (!targetModel) return;
    const cfg = await window.petAPI?.getConfig?.();
    if (!cfg) return;
    const profiles = cfg.providerProfiles ?? [];
    // 找到目标 profile;把它 + 顶层都同步到新 model
    const target = profiles.find((p) => p.id === targetProfileId);
    if (target) {
      const updatedProfiles = profiles.map((p) =>
        p.id === targetProfileId ? { ...p, model: targetModel } : p,
      );
      await window.petAPI?.setConfig?.({
        ...cfg,
        baseURL: target.baseURL,
        apiKey: target.apiKey,
        model: targetModel,
        modelPresets: target.modelPresets ?? [],
        providerProfiles: updatedProfiles,
        activeProviderId: targetProfileId,
      });
    } else {
      // 没 profile 的退化场景,只改 model
      await window.petAPI?.setConfig?.({ ...cfg, model: targetModel });
    }
    window.dispatchEvent(new CustomEvent('petAI:configChanged'));
  };

  /** 编辑某条 user 消息:把内容回填到输入框,删除该条及后面所有消息(让用户重发)。
   *  index 是 active.messages 的下标。 */
  const editUserMessage = (index: number) => {
    if (!active) return;
    const msg = active.messages[index];
    if (!msg || msg.role !== 'user') return;
    setInput(contentToString(msg.content));
    setSessions((arr) =>
      arr.map((s) => (s.id === active.id ? { ...s, messages: s.messages.slice(0, index) } : s)),
    );
  };

  /** 删除整个会话。 */
  const deleteSession = (id: string) => {
    setSessions((arr) => {
      const next = arr.filter((s) => s.id !== id);
      if (next.length === 0) {
        const ns: Session = { id: genId(), title: '新对话', messages: [], createdAt: Date.now() };
        setActiveId(ns.id);
        return [ns];
      }
      if (id === activeId) setActiveId(next[0].id);
      return next;
    });
  };

  /** 从 config 取当前角色的 active persona;config 没存或字段为空就 fallback 到内置/通用 persona。
   *  注意:即使 config 里存有 slot,如果 personality 是空字符串(早期版本物化的"骨架"persona),
   *  也视为没有真实人设并回退到默认值,避免 LLM 拿到空 system prompt 自由发挥乱起名。 */
  const resolveActivePersona = async (
    name: string | null | undefined,
  ): Promise<CharacterPersona | null> => {
    if (!name) return null;
    try {
      const cfg = await window.petAPI?.getConfig?.();
      const slot = cfg?.characterPersonas?.[name];
      if (slot && slot.personas.length > 0) {
        const cur =
          slot.personas.find((p) => p.id === slot.activeId) ?? slot.personas[0];
        const hasContent = (cur.personality ?? '').trim().length > 0;
        if (hasContent) {
          return {
            displayName: cur.displayName,
            personality: cur.personality,
            speakingStyle: cur.speakingStyle,
          };
        }
        // 内容是空骨架 → 不再返回 null。未配置角色也要注入最小身份锁,
        // 避免全局 Skill/systemPrompt 的旧名字污染当前模型。
        const def = resolveDefaultCharacterPersona(name);
        return {
          displayName: cur.displayName?.trim() || def.displayName,
          personality: def.personality,
          speakingStyle: def.speakingStyle,
        };
      }
    } catch {
      // 读 config 失败 → 走默认
    }
    return resolveDefaultCharacterPersona(name);
  };

  // ===== 图片附件 =====
  /** 单图大小上限(8MB)。OpenAI 多模态接口实际限制因厂商不同 4-20MB 不等,8MB 是稳妥值。 */
  const MAX_IMG_BYTES = 8 * 1024 * 1024;
  const MAX_ATTACHMENTS = 4;
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** dataURL 长度估算字节(base64 ~ 1.33x 原文件) */
  const dataUrlBytes = (url: string): number => {
    const m = url.match(/^data:[^;]+;base64,(.*)$/);
    if (!m) return url.length;
    return Math.floor(m[1].length * 0.75);
  };

  const addAttachment = (url: string) => {
    if (dataUrlBytes(url) > MAX_IMG_BYTES) {
      setError('图片超过 8MB,请压缩后再上传');
      return;
    }
    setAttachments((arr) => {
      if (arr.length >= MAX_ATTACHMENTS) {
        setError(`最多只能附 ${MAX_ATTACHMENTS} 张图`);
        return arr;
      }
      return [...arr, url];
    });
  };

  const takeScreenshot = async () => {
    if (attachments.length >= MAX_ATTACHMENTS) {
      setError(`最多只能附 ${MAX_ATTACHMENTS} 张图`);
      return;
    }
    setError(null);
    const url = await window.petAPI?.captureScreen?.();
    if (!url) {
      setError('截图失败,请稍后再试');
      return;
    }
    addAttachment(url);
  };

  const onPickImages = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许下次选同一文件
    setError(null);
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_IMG_BYTES) {
        setError(`"${f.name}" 超过 8MB,已跳过`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === 'string' ? reader.result : '';
        if (url) addAttachment(url);
      };
      reader.readAsDataURL(f);
    }
  };

  // ===== 文件附件 =====
  /** 解析后文本上限(50KB) — 防上下文炸。超限走 truncateText 头尾截 + 中间省略。 */
  const MAX_FILE_TEXT_BYTES = 50 * 1024;
  const MAX_FILES = 4;
  const fileDocInputRef = useRef<HTMLInputElement>(null);
  /** 编码模式 + 按钮专用 — 单个 picker 同时接 图片 + 文档/代码,根据 MIME 分流 */
  const fileAnyInputRef = useRef<HTMLInputElement>(null);

  const truncateText = (s: string): string => {
    if (s.length <= MAX_FILE_TEXT_BYTES) return s;
    const half = Math.floor((MAX_FILE_TEXT_BYTES - 30) / 2);
    return s.slice(0, half) + `\n\n[…省略 ${s.length - 2 * half} 字节…]\n\n` + s.slice(-half);
  };
  const formatFileSize = (n: number): string => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  };

  /** 把 File 读成 ArrayBuffer */
  const readAsArrayBuffer = (f: File): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(f);
    });
  const readAsText = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
      r.onerror = () => reject(r.error);
      r.readAsText(f);
    });

  /** 按扩展名 / mime 把单个文件解析成纯文本。失败抛错。 */
  const parseFileToText = async (f: File): Promise<string> => {
    const name = f.name.toLowerCase();
    // 1. PDF — 走主进程
    if (name.endsWith('.pdf') || f.type === 'application/pdf') {
      const buf = await readAsArrayBuffer(f);
      const text = await window.petAPI?.parsePdf?.(buf);
      if (!text) throw new Error('PDF 解析失败(可能是扫描件 / 加密)');
      return text;
    }
    // 2. Word .docx — 渲染端 mammoth
    if (name.endsWith('.docx')) {
      const buf = await readAsArrayBuffer(f);
      const mammoth = await import('mammoth');
      const r = await mammoth.extractRawText({ arrayBuffer: buf });
      return r.value || '';
    }
    if (name.endsWith('.doc')) {
      throw new Error('不支持 .doc(老格式),请另存为 .docx 后重试');
    }
    // 3. Excel .xlsx / .xlsm — SheetJS,逐 sheet 转 csv 拼接
    if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || name.endsWith('.csv')) {
      const buf = await readAsArrayBuffer(f);
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buf, { type: 'array' });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        if (csv.trim()) parts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
      }
      return parts.join('\n\n');
    }
    if (name.endsWith('.xls')) {
      throw new Error('不支持 .xls(老 Excel 格式),请另存为 .xlsx 后重试');
    }
    // 4. 其它当作纯文本读 — md / txt / json / csv / log / yaml / xml / html / sql /
    //    各种代码扩展(.py/.js/.ts/.go/.rs/...)。靠 FileReader 自己识别编码,UTF-8 兜底。
    const text = await readAsText(f);
    if (!text) throw new Error('无法读出文本(可能是二进制文件)');
    return text;
  };

  /** 编码模式 + 按钮统一入口:同时支持图片 / 文档 / 代码文件,
   *  按 MIME / 后缀分流到 onPickImages(图片走附件预览)/ onPickFiles(其它走解析文本)。 */
  const onPickAny = (e: ChangeEvent<HTMLInputElement>) => {
    const all = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (all.length === 0) return;
    const imgs = all.filter((f) => f.type.startsWith('image/'));
    const docs = all.filter((f) => !f.type.startsWith('image/'));
    const makeFakeEvent = (fs: File[]): ChangeEvent<HTMLInputElement> => {
      const dt = new DataTransfer();
      fs.forEach((f) => dt.items.add(f));
      // 只用到 target.files / target.value 这两个字段,其余字段忽略
      return { target: { files: dt.files, value: '' } } as unknown as ChangeEvent<HTMLInputElement>;
    };
    if (imgs.length > 0) onPickImages(makeFakeEvent(imgs));
    if (docs.length > 0) void onPickFiles(makeFakeEvent(docs));
  };

  const onPickFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    setError(null);
    for (const f of files) {
      if (fileAttachments.length >= MAX_FILES) {
        setError(`最多只能附 ${MAX_FILES} 个文件`);
        break;
      }
      try {
        const raw = await parseFileToText(f);
        const text = truncateText(raw);
        setFileAttachments((arr) => [
          ...arr,
          { name: f.name, sizeBytes: f.size, text },
        ]);
      } catch (err) {
        setError(`"${f.name}":${(err as Error).message}`);
      }
    }
  };

  /** 用户文本里出现"看屏幕"类请求时,自动截一张屏一起发,免去用户手点 📷。
   *  关键词保守:必须有"动词+名词"组合或固定短语,避免随便提到"屏幕"就触发。 */
  const SCREEN_REQUEST_RE =
    /(?:看(?:看|一下)?|瞧|瞅|帮我看|分析|描述).{0,4}(?:屏幕|画面|窗口|界面)|当前(?:屏幕|画面|界面|窗口)|我(?:的)?屏幕(?:上|里)|屏幕上(?:是什么|有什么|显示|写)|截图(?:给|帮)?我看/i;

  /** 用户句首附近显式表示"开启新话题"时,本轮发给 LLM 的 messages 截断历史,
   *  只发本条 user message。sessions 里仍保留完整历史(便于用户翻看)。
   *  只看前 30 个字符,避免长句中段提到"新问题"误触发。 */
  const RESET_CONTEXT_RE =
    /(?:新(?:的)?(?:问题|话题)|换(?:个|一个)(?:话题|问题)|重新(?:开始|问|聊)|忘(?:记|了|掉)(?:前面|之前)|忽略(?:前面|之前)|开个新)/i;

  /** 用户问的是"鼠标位置 / 我指的"这类需要 cursor 坐标的场景 — 走 set-of-mark:
   *  截图后在 cursor 位置画红圈+十字,识图模型直接看红圈处描述。比让 AI 解析坐标准。 */
  const CURSOR_REQUEST_RE =
    /(?:鼠标|光标|cursor)(?:.{0,6}(?:在哪|哪里|位置|是什么|什么|指(?:着|的|向)|这|那))|(?:我|帮我).{0,2}(?:指(?:的|着|向)|点(?:着|的)|悬停)(?:.{0,4}(?:位置|地方|是什么|什么|哪|这|那))?/i;

  /** 在截图上用 Canvas 画红圈+十字标注鼠标位置,返回新 dataURL。
   *  cursor 坐标是 DIP,需要按"图片实际像素 / 屏幕 DIP"缩放对齐。 */
  const drawCursorMark = async (
    dataURL: string,
    cx: number,
    cy: number,
    sw: number,
    sh: number,
  ): Promise<string> => {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image load failed'));
      im.src = dataURL;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataURL;
    ctx.drawImage(img, 0, 0);
    const sx = img.naturalWidth / sw;
    const sy = img.naturalHeight / sh;
    const x = cx * sx;
    const y = cy * sy;
    const r = Math.max(22, img.naturalWidth * 0.012);
    // 外白圈 — 在任何颜色背景下都醒目
    ctx.lineWidth = Math.max(3, r * 0.16);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(x, y, r * 1.18, 0, Math.PI * 2);
    ctx.stroke();
    // 内红圈
    ctx.lineWidth = Math.max(4, r * 0.2);
    ctx.strokeStyle = 'rgba(255,40,40,0.95)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    // 十字延伸 — 让模型注意"中心点"
    ctx.lineWidth = Math.max(3, r * 0.14);
    ctx.beginPath();
    ctx.moveTo(x - r * 1.7, y);
    ctx.lineTo(x - r * 0.45, y);
    ctx.moveTo(x + r * 0.45, y);
    ctx.lineTo(x + r * 1.7, y);
    ctx.moveTo(x, y - r * 1.7);
    ctx.lineTo(x, y - r * 0.45);
    ctx.moveTo(x, y + r * 0.45);
    ctx.lineTo(x, y + r * 1.7);
    ctx.stroke();
    return canvas.toDataURL('image/png');
  };

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    const hasFiles = fileAttachments.length > 0;
    // 至少要有一个(文字 / 图 / 文件)
    if ((!text && attachments.length === 0 && !hasFiles) || streaming || !active) return;
    setInput('');
    setDictationPartial('');
    setDictating(false); // 发送时停止听写,避免持续录音
    setError(null);
    setToolEvents([]); // 新一轮清空上一轮的工具调用痕迹
    // 编码模式是消息流(ChatGPT 风格),不切换模式;普通模式才切到回答卡
    if (!codingMode) setMode('qa-answer');
    // 立刻把 streaming 相关 state 置为"思考态" — 否则 qa-answer 卡在 await 截屏的
    // 几百毫秒里 streaming=false,会回退到渲染 lastAssistant(上一轮的回答),用户
    // 视觉上能看到上轮答案闪一下再被新一轮覆盖。提前重置后 UI 立刻显示「思考中…」占位。
    setStreaming(true);
    clearTextFlushTimers();
    setStreamingText('');
    setThinkingText('');
    streamingTextRef.current = '';
    thinkingTextRef.current = '';
    dispatchPetState('thinking');

    // 关键词命中 + 用户没主动附图 → 自动截一张屏。+100~200ms 延迟,用户基本无感
    // cursor 类问题(我鼠标在哪 / 我指的是什么)优先走 set-of-mark:截图后在鼠标位置画红圈
    let autoScreenshot: string | null = null;
    let autoScreenshotIsCursor = false;
    if (text && attachments.length === 0) {
      const wantCursor = CURSOR_REQUEST_RE.test(text);
      const wantScreen = !wantCursor && SCREEN_REQUEST_RE.test(text);
      try {
        if (wantCursor && window.petAPI?.captureScreenWithCursor) {
          const r = await window.petAPI.captureScreenWithCursor();
          if (r && r.dataURL) {
            if (r.cursor.onPrimary) {
              // cursor 在主屏 → 画标注
              autoScreenshot = await drawCursorMark(
                r.dataURL,
                r.cursor.x,
                r.cursor.y,
                r.screenSize.width,
                r.screenSize.height,
              );
              autoScreenshotIsCursor = true;
            } else {
              // cursor 在副屏 → 退回普通截图,不能伪标
              autoScreenshot = r.dataURL;
            }
          }
        } else if (wantScreen) {
          autoScreenshot = (await window.petAPI?.captureScreen?.()) ?? null;
        }
      } catch {
        // 失败不阻塞,继续按纯文本发
        autoScreenshot = null;
      }
    }
    // 当前轮所有图(用户主动附 + 自动截屏),临时变量,不进 state
    const allImages = autoScreenshot ? [...attachments, autoScreenshot] : attachments;
    const hasImages = allImages.length > 0;

    // 把所有文件附件拼进文本块。AI 看到的格式:
    //   [文件 report.pdf · 12.3KB]
    //   <解析正文>
    const fileBlocks = fileAttachments
      .map(
        (a) =>
          `\n\n[文件 ${a.name} · ${formatFileSize(a.sizeBytes)}]\n${a.text}`,
      )
      .join('');
    // cursor 类截图加一段系统说明,告诉模型"红圈是用户鼠标位置,请重点看那里"
    const cursorHint = autoScreenshotIsCursor
      ? '\n\n[系统说明:截图上用红色圆圈+十字标注的位置就是用户当前鼠标光标所在处,请重点观察该区域并基于那里的内容回答用户的问题]'
      : '';
    const fullText = text + fileBlocks + cursorHint;

    // 真正发给 LLM 的 user content:有图 → array(text + image_url 多份);否则纯文本
    let liveContent: string | AIContentPart[];
    if (hasImages) {
      const parts: AIContentPart[] = [];
      if (fullText) parts.push({ type: 'text', text: fullText });
      for (const url of allImages) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
      liveContent = parts;
    } else {
      liveContent = fullText;
    }
    // sessions 里只存文本占位(不存大 dataURL / 不存大文件正文,localStorage 撑不住)
    const persistedParts: string[] = [];
    if (text) persistedParts.push(text);
    if (hasFiles) {
      persistedParts.push(
        fileAttachments
          .map((a) => `[文件 ${a.name} · ${formatFileSize(a.sizeBytes)}]`)
          .join(' '),
      );
    }
    if (hasImages) {
      persistedParts.push(
        allImages
          .map((_, i) => {
            if (autoScreenshot && i === allImages.length - 1) {
              return autoScreenshotIsCursor ? '[屏幕截图·标注鼠标位置]' : '[屏幕截图]';
            }
            return `[图 ${i + 1}]`;
          })
          .join(' '),
      );
    }
    const persistedContent = persistedParts.join(' ');

    setAttachments([]); // 立刻清两个队列,避免下一条误带
    setFileAttachments([]);

    const userMsg: AIMessage = { role: 'user', content: liveContent };
    const userMsgPersisted: AIMessage = { role: 'user', content: persistedContent };
    // 显式"新话题"信号:把当前 history.length 作为新的 contextStartIdx 持久化到 session。
    // 之后(包括后续轮)发给 LLM 的 messages = messages.slice(contextStartIdx),自然"翻篇"。
    // sessions 的 messages 永远是完整记录,用户翻历史看得到全部。
    const isFreshTurn = !!text && RESET_CONTEXT_RE.test(text.slice(0, 30));
    const prevStartIdx = active?.contextStartIdx ?? 0;
    const newStartIdx = isFreshTurn ? history.length : prevStartIdx;
    const llmHistory = history.slice(newStartIdx);
    const newMessages = [...llmHistory, userMsg];
    // 持久化版本:把 image_url(可能 MB 级 dataURL)替换成 [图 N] 占位,
    // 否则 localStorage 一两条就爆。后续轮次发给 LLM 时该条 user 不再带图,模型看到占位。
    const persistedHistory = [...history, userMsgPersisted];
    updateActiveSession((s) => ({
      ...s,
      messages: persistedHistory,
      contextStartIdx: newStartIdx,
      title: s.messages.length === 0 ? makeTitle(text || '[图片]') : s.title,
    }));

    // streaming 相关状态已在 send() 入口提前重置 — 见上方"立刻把 streaming 相关 state 置为思考态"

    const sentSessionId = activeId; // 锁定:即使用户切了会话,本次结果仍写回原会话

    // 发给 AI 的 messages 不要带 thinking 字段(避免污染 user-content)
    const cleanMessages: AIMessage[] = newMessages.map(({ role, content }) => ({ role, content }));
    // 按角色注入 persona system 消息(放在最前)。优先用 config 里编辑的 persona,
    // 没配则 fallback 到内置/通用 persona。后端 ai-client 还会再叠加全局
    // skill systemPrompt + memory;两者并存,角色 persona 优先级高(放后面)。
    const persona = await resolveActivePersona(characterName);
    const personaPrompt = buildCharacterSystemPrompt(persona);
    const messagesWithPersona = personaPrompt
      ? [{ role: 'system' as const, content: personaPrompt }, ...cleanMessages]
      : cleanMessages;

    cancelRef.current = window.petAPI.sendChat(
      messagesWithPersona,
      (delta, kind) => {
        if (kind === 'thinking') {
          thinkingTextRef.current += delta;
          scheduleThinkingTextFlush();
        } else {
          // 第一段答案到达 → 切换到说话动作
          if (streamingTextRef.current.length === 0) dispatchPetState('talking');
          streamingTextRef.current += delta;
          scheduleStreamingTextFlush();
        }
      },
      () => {
        clearTextFlushTimers();
        const finalAnswerRaw = streamingTextRef.current;
        const finalThinking = thinkingTextRef.current;
        streamingTextRef.current = '';
        thinkingTextRef.current = '';
        // 状态:回到 idle;并基于回复内容触发情感
        dispatchPetState('idle');
        const emo = detectEmotion(finalAnswerRaw);
        if (emo) dispatchPetEmotion(emo);
        // 写入 session / 显示前剥掉 [emotion: xxx] 标签 — 用户看不到这条标记
        const finalAnswer = stripEmotionTag(finalAnswerRaw);
        if (finalAnswer.length > 0) {
          // 写回到 sentSessionId 那条会话(可能已不是当前 active)
          setSessions((arr) =>
            arr.map((s) =>
              s.id === sentSessionId
                ? {
                    ...s,
                    messages: [
                      ...s.messages,
                      {
                        role: 'assistant',
                        content: finalAnswer,
                        ...(finalThinking ? { thinking: finalThinking } : {}),
                      },
                    ],
                  }
                : s,
            ),
          );
        }
        setStreaming(false);
        setStreamingText('');
        setThinkingText('');
        cancelRef.current = null;
      },
      (msg) => {
        setError(msg);
        dispatchPetState('idle');
        setStreaming(false);
        clearTextFlushTimers();
        setStreamingText('');
        setThinkingText('');
        streamingTextRef.current = '';
        thinkingTextRef.current = '';
        cancelRef.current = null;
      },
    );
  };

  // 剪贴板建议气泡点"总结/打开看看" → 触发 'pet:open-chat-with' { prompt }
  // 第一次打开对话框时 active(session)还没初始化,直接 send 会因 !active 被忽略,
  // 所以把 prompt 暂存到 pendingAutoSend,下一个 effect 等 active+非 streaming 就绪才发。
  const [pendingAutoSend, setPendingAutoSend] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { prompt?: string };
      const prompt = detail?.prompt;
      if (!prompt) return;
      setPendingAutoSend(prompt);
    };
    window.addEventListener('pet:open-chat-with', onOpen);
    return () => window.removeEventListener('pet:open-chat-with', onOpen);
  }, []);
  /** active / streaming 准备好后,把 pending 的 prompt 发出去 */
  useEffect(() => {
    if (!pendingAutoSend) return;
    if (!active || streaming) return;
    const p = pendingAutoSend;
    setPendingAutoSend(null);
    void send(p);
  }, [pendingAutoSend, active, streaming]);

  // ---- 语音听写:enabled 时 useVoiceDictation 起 mic + recognizer
  // partial 实时填到 input,vosk 检测到一段语音结束(final)→ 自动 send
  // 用 hook 内部 ref 包裹 callback,callback 闭包始终拿到最新 send / state ----
  useVoiceDictation({
    enabled: dictating,
    onPartial: (text) => setDictationPartial(text),
    onFinal: (text) => {
      setDictationPartial('');
      void send(text);
    },
    onError: (msg) => {
      setError(msg);
      setDictating(false);
    },
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };


  if (!visible) return null;

  /** 继续对话:回到输入框,准备下一问 */
  const continueChat = () => {
    setInput('');
    setError(null);
    setMode('qa-input');
  };
  /** 结束对话:关闭浮窗(session 已自动保存) */
  const endChat = () => {
    setError(null);
    onClose();
  };

  // 找当前 session 最近一条 assistant(qa-answer 流结束后用它显示)
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');

  // popup 定位 / 尺寸:
  //   - 用户拖过(popupRect 有值)→ 用 rect 坐标,无论模式 — 让用户能把 popup 拖离默认位置
  //   - 编码模式(没拖过)→ inline style 留空,CSS .qa-popup--coding 钉底部居中
  //   - 普通模式(没拖过)→ 锁腰线 anchorY,top:50% fallback
  // maxWidth/maxHeight 跟着 popup 当前 left/top 算 — 浏览器原生限制 resize 不超 viewport
  const popupStyle: React.CSSProperties = popupRect
    ? {
        left: popupRect.left,
        top: popupRect.top,
        bottom: 'auto',
        // 编码模式 CSS 默认有 translateX(-50%) 让其居中;一旦用户拖过,
        // inline 必须覆盖掉,否则 popup 会偏离 mouse 位置 50% 宽度
        transform: 'none',
        maxWidth: `calc(100vw - ${Math.max(0, popupRect.left)}px - 8px)`,
        maxHeight: `calc(100vh - ${Math.max(0, popupRect.top)}px - 8px)`,
      }
    : codingMode
    ? {}
    : {
        top: anchorY != null ? anchorY : '50%',
        bottom: 'auto',
        transform: 'translateY(-50%)',
      };

  // popup 自由拖动:在 popup 空白处(不是按钮/输入框/details/文字内容)按下后跟随鼠标。
  // ⚠ 文字内容区(回答 / 思考 / 代码块)必须排除,否则用户想选中复制时 popup 会跟着移。
  const onPopupMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (
      target.closest(
        'textarea, input, button, summary, a, ' +
          '.dialog-thinking-fold, .qa-answer-body, .md-body, ' +
          '.dialog-line, .dialog-thinking-body, .codeblock, code, pre',
      )
    )
      return;
    // 进一步保险:如果浏览器认为当前正在选文字(已经有 selection range),也不要开始拖
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    const el = popupRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 检测鼠标是否在右下角 resize 角标区(20x20),让浏览器原生 resize 接管
    const RESIZE_HOT = 20;
    const inResizeCorner =
      e.clientX >= rect.right - RESIZE_HOT &&
      e.clientX <= rect.right &&
      e.clientY >= rect.bottom - RESIZE_HOT &&
      e.clientY <= rect.bottom;
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    if (inResizeCorner) return;
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    // 拖动期间不通过 setState 改位置(那样会触发整段 markdown / 代码高亮重渲染,严重卡顿)。
    // 改为 rAF 节流 + 直接改 DOM 的 transform,松手时再 setPopupRect 一次性持久化。
    setPopupRect({ left: startLeft, top: startTop });
    let pendingDx = 0;
    let pendingDy = 0;
    let curLeft = startLeft;
    let curTop = startTop;
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      const EDGE_GAP = 8;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const maxL = Math.max(EDGE_GAP, window.innerWidth - w - EDGE_GAP);
      const maxT = Math.max(EDGE_GAP, window.innerHeight - h - EDGE_GAP);
      curLeft = Math.max(EDGE_GAP, Math.min(maxL, startLeft + pendingDx));
      curTop = Math.max(EDGE_GAP, Math.min(maxT, startTop + pendingDy));
      // 直接改 DOM,不走 React。popupStyle 里 left/top 已经是 startLeft/startTop,
      // 我们叠加 translate 表示偏移;松手时把 translate 清掉、setPopupRect 写最终值。
      el.style.left = curLeft + 'px';
      el.style.top = curTop + 'px';
    };
    const onMove = (ev: MouseEvent) => {
      pendingDx = ev.clientX - startMouseX;
      pendingDy = ev.clientY - startMouseY;
      if (rafId == null) rafId = requestAnimationFrame(flush);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        flush();
      }
      // 同步最终位置到 React state(下次渲染从 popupStyle 拿)
      setPopupRect({ left: curLeft, top: curTop });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ===== history 大窗 — 复用 qa-popup 外壳:同样的拖动 / resize 行为 =====
  if (mode === 'history') {
    return (
      <div
        ref={popupRef}
        className="qa-popup qa-popup--history"
        style={popupStyle}
        onMouseDown={onPopupMouseDown}
      >
        <div className="qa-header">
          <button
            className="dialog-icon-btn"
            onClick={() => setMode('qa-input')}
            title="返回对话"
          >
            ←
          </button>
          <span className="qa-skill-name">历史会话</span>
          <button className="dialog-icon-btn" onClick={newConversation} title="新对话">
            +
          </button>
          <button className="dialog-close-btn" onClick={onClose} title="关闭" aria-label="关闭">
            ✕
          </button>
        </div>

        {/* 会话列表 */}
        <div className="dialog-history">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={'dialog-history-item' + (s.id === activeId ? ' active' : '')}
            >
              <button className="dialog-history-pick" onClick={() => switchSession(s.id)}>
                {s.title}
              </button>
              {sessions.length > 1 && (
                <button
                  className="dialog-history-del"
                  onClick={() => deleteSession(s.id)}
                  title="删除"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>

        {/* 当前 session 的完整历史(只读) */}
        <div className="dialog-lines" ref={linesRef}>
          {error && <div className="dialog-line err">{error}</div>}
          {history.length === 0 && (
            <div className="dialog-line empty-hint">这个会话还没有对话</div>
          )}
          {/* 历史模式分页:只渲染最后 N 条;顶部如还有更早,显示"加载更多"提示。
              用 originalIdx(history 中真实下标)作 key,避免 slice 后 i=0 错位 */}
          {history.length > historyDisplayCount && (
            <div
              className="dialog-line empty-hint"
              style={{ cursor: 'pointer' }}
              onClick={() =>
                setHistoryDisplayCount((c) => Math.min(c + HISTORY_PAGE, history.length))
              }
            >
              ↑ 还有 {history.length - historyDisplayCount} 条更早消息(点击或上滑加载)
            </div>
          )}
          {history.slice(-historyDisplayCount).map((m, sliceI) => {
            const originalIdx = history.length - historyDisplayCount + sliceI;
            const i = Math.max(originalIdx, 0);
            return (
            <div key={i} className={'dialog-line ' + m.role}>
              {m.role === 'assistant' && m.thinking && (
                <details className="dialog-thinking-fold">
                  <summary>💭 思考过程</summary>
                  <div className="dialog-thinking-body">{m.thinking}</div>
                </details>
              )}
              {m.role === 'assistant' ? (
                <div className="md-body">
                  <MarkdownRenderer>
                    {sanitizeMarkdown(contentToString(m.content))}
                  </MarkdownRenderer>
                </div>
              ) : (
                contentToString(m.content)
              )}
            </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ===== qa-input / qa-answer 浮窗(锁腰线) =====
  // 顶部 title:始终显示当前角色名(displayName),不再追加"思考中/说话中"
  const headerTitle: string = skillName;
  const headerBusy = petState === 'thinking' || petState === 'talking';

  // ===== 编码模式:ChatGPT 风格消息流 =====
  // 跟普通气泡完全不同的 layout:顶部 (历史 / 标题 / 新建 / 关闭),中间消息流,底部输入框 + 工具栏。
  // 历史会话用顶部右下拉菜单,可重命名 / 删除;user 消息悬停显示「编辑」按钮,点了回填 input 并截断后续。
  const codingHistoryStart = Math.max(0, history.length - CODING_HISTORY_LIMIT);
  const codingVisibleHistory = history.slice(codingHistoryStart);
  if (codingMode) {
    return (
      <div
        ref={popupRef}
        className="qa-popup qa-popup--coding"
        style={popupStyle}
        onMouseDown={onPopupMouseDown}
      >
        <div className="qa-header">
          <button
            type="button"
            className="dialog-icon-btn"
            onClick={() => setShowHistoryMenu((v) => !v)}
            title="历史会话"
          >
            ≡
          </button>
          <span className="qa-skill-name">{headerTitle}</span>
          <button
            type="button"
            className="dialog-icon-btn"
            onClick={() => {
              newConversation();
              setShowHistoryMenu(false);
            }}
            title="新对话"
          >
            +
          </button>
          <button
            type="button"
            className="dialog-close-btn"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* 历史菜单浮层 — 锚在右上,点会话切换 / 编辑标题 / 删除 */}
        {showHistoryMenu && (
          <div
            className="qa-history-menu"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="qa-history-menu-title">历史会话 ({sessions.length})</div>
            {sessions.map((s) => {
              const isEditing = renamingSession?.id === s.id;
              const isActive = s.id === activeId;
              return (
                <div
                  key={s.id}
                  className={'qa-history-menu-item' + (isActive ? ' active' : '')}
                >
                  {isEditing ? (
                    <input
                      className="qa-history-menu-rename"
                      autoFocus
                      value={renamingSession!.title}
                      onChange={(e) =>
                        setRenamingSession({ id: s.id, title: e.target.value })
                      }
                      onBlur={() => {
                        renameSession(s.id, renamingSession!.title);
                        setRenamingSession(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          renameSession(s.id, renamingSession!.title);
                          setRenamingSession(null);
                        } else if (e.key === 'Escape') {
                          setRenamingSession(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="qa-history-menu-pick"
                      onClick={() => {
                        switchSession(s.id);
                        setShowHistoryMenu(false);
                      }}
                      title={s.title}
                    >
                      {s.title || '(未命名)'}
                    </button>
                  )}
                  {!isEditing && (
                    <button
                      type="button"
                      className="qa-history-menu-icon"
                      title="重命名"
                      onClick={() => setRenamingSession({ id: s.id, title: s.title })}
                    >
                      ✎
                    </button>
                  )}
                  {!isEditing && sessions.length > 1 && (
                    <button
                      type="button"
                      className="qa-history-menu-icon qa-history-menu-icon--del"
                      title="删除"
                      onClick={() => deleteSession(s.id)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 消息流 — 历史 + 当前 streaming */}
        <div className="qa-coding-stream" ref={linesRef}>
          {error && <div className="dialog-line err">{error}</div>}
          {history.length === 0 && !streaming && (
            <div className="qa-coding-empty">还没开始对话,试着说点什么吧</div>
          )}
          {history.length > CODING_HISTORY_LIMIT && (
            <div className="dialog-line empty-hint">
              已省略更早的 {history.length - CODING_HISTORY_LIMIT} 条消息
            </div>
          )}
          {codingVisibleHistory.map((m, visibleI) => {
            const i = codingHistoryStart + visibleI;
            if (m.role === 'user') {
              return (
                <div key={i} className="qa-coding-msg qa-coding-msg--user">
                  <div className="qa-coding-msg-body">{contentToString(m.content)}</div>
                  <button
                    type="button"
                    className="qa-coding-msg-edit"
                    title="编辑这条消息并重发(后面的回复会重新生成)"
                    onClick={() => editUserMessage(i)}
                  >
                    ✎
                  </button>
                </div>
              );
            }
            if (m.role === 'assistant') {
              return (
                <div key={i} className="qa-coding-msg qa-coding-msg--assistant">
                  {m.thinking && (
                    <details className="dialog-thinking-fold">
                      <summary>💭 思考过程</summary>
                      <div className="dialog-thinking-body">{m.thinking}</div>
                    </details>
                  )}
                  <div className="md-body">
                    <MarkdownRenderer>
                      {sanitizeMarkdown(contentToString(m.content))}
                    </MarkdownRenderer>
                  </div>
                </div>
              );
            }
            return null; // system / tool 等不在流里显示
          })}
          {streaming && (
            <div className="qa-coding-msg qa-coding-msg--assistant qa-coding-msg--streaming">
              {thinkingText && (
                <details className="dialog-thinking-fold" open>
                  <summary>💭 思考中…</summary>
                  <div className="dialog-thinking-body">{thinkingText}</div>
                </details>
              )}
              <div className="md-body">
                {streamingText ? (
                  <MarkdownRenderer>{sanitizeMarkdown(streamingText)}</MarkdownRenderer>
                ) : (
                  <span className="qa-coding-thinking-dots">思考中…</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 输入区 + 工具栏 */}
        <div className="qa-input-area">
          {(attachments.length > 0 || fileAttachments.length > 0) && (
            <div className="qa-attachments">
              {attachments.map((url, i) => (
                <div key={'img-' + i} className="qa-attach-thumb">
                  <img src={url} alt={`附件 ${i + 1}`} />
                  <button
                    type="button"
                    className="qa-attach-remove"
                    onClick={() =>
                      setAttachments((arr) => arr.filter((_, idx) => idx !== i))
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              {fileAttachments.map((a, i) => (
                <div
                  key={'file-' + i}
                  className="qa-attach-file"
                  title={`${a.name}(${formatFileSize(a.sizeBytes)},约 ${a.text.length} 字符)`}
                >
                  <span className="qa-attach-file-icon">📄</span>
                  <span className="qa-attach-file-name">{a.name}</span>
                  <span className="qa-attach-file-size">{formatFileSize(a.sizeBytes)}</span>
                  <button
                    type="button"
                    className="qa-attach-file-remove"
                    onClick={() =>
                      setFileAttachments((arr) => arr.filter((_, idx) => idx !== i))
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="qa-textarea"
            rows={3}
            autoFocus
            value={dictating && dictationPartial ? input + dictationPartial : input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              dictating
                ? '正在听… 说完一段话会自动发送(可再次点击 🎤 取消)'
                : '说点什么吧 (Shift+Enter 回车 Enter 发送)'
            }
            readOnly={dictating}
          />
          <div className="qa-tool-row qa-tool-row--coding">
            <div className="qa-tool-left">
              <button
                type="button"
                className="qa-coding-btn"
                onClick={() => fileAnyInputRef.current?.click()}
                disabled={fileAttachments.length >= MAX_FILES && attachments.length >= 4}
                title="添加文件 — 图片 / PDF / Word / Excel / PPT / Markdown / 代码(Python、Java、JS、Go…)"
                aria-label="添加文件"
              >
                +
              </button>
              <button
                type="button"
                className="qa-coding-btn"
                onClick={() => fileDocInputRef.current?.click()}
                disabled={fileAttachments.length >= MAX_FILES}
                title="插入代码/文件"
                aria-label="插入代码或文件"
              >
                {'<>'}
              </button>
              <select
                className="qa-coding-model"
                value={activeModelKey}
                onChange={(e) => void changeModel(e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                disabled={modelGroups.length === 0}
                title={`切换模型(列出所有 provider 的所有模型)\n当前: ${modelLabel}`}
              >
                {modelGroups.length === 0 && <option value="">未配置模型</option>}
                {modelGroups.map((g) =>
                  // 多 profile 时按 profile 分组;只有 1 个 profile / 没 profile 时不套 optgroup
                  g.profileName && modelGroups.length > 1 ? (
                    <optgroup key={g.profileId} label={g.profileName}>
                      {g.models.map((m) => (
                        <option key={`${g.profileId}::${m}`} value={`${g.profileId}::${m}`}>
                          {m}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    g.models.map((m) => (
                      <option key={`${g.profileId}::${m}`} value={`${g.profileId}::${m}`}>
                        {m}
                      </option>
                    ))
                  ),
                )}
              </select>
            </div>
            <div className="qa-tool-right">
              <button
                type="button"
                className="qa-coding-btn"
                onClick={newConversation}
                title="新一轮(等同 + 按钮,清空上下文)"
                aria-label="新一轮"
              >
                ↻
              </button>
              {voiceInputAvailable && (
                <button
                  type="button"
                  className={
                    'qa-coding-btn qa-coding-btn--icon' +
                    (dictating ? ' qa-coding-btn--active' : '')
                  }
                  onClick={() => setDictating((v) => !v)}
                  title={dictating ? '关闭语音输入' : '语音输入'}
                  aria-label={dictating ? '关闭语音输入' : '开启语音输入'}
                >
                  <ToolIcon name="mic" size={15} />
                </button>
              )}
              <button
                type="button"
                className="qa-coding-send"
                onClick={() => void send()}
                disabled={
                  streaming ||
                  (!input.trim() && attachments.length === 0 && fileAttachments.length === 0)
                }
                title="发送(Enter)"
                aria-label="发送"
              >
                ↑
              </button>
            </div>
          </div>
        </div>

        {/* 隐藏 file inputs(给 + / <> 按钮用)*/}
        <input
          ref={fileAnyInputRef}
          type="file"
          accept="image/*,.pdf,.docx,.xlsx,.xlsm,.csv,.md,.markdown,.txt,.json,.log,.yaml,.yml,.xml,.html,.htm,.sql,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.cpp,.c,.h,.hpp,.cs,.kt,.swift,.rb,.php,.sh,.bat,.ini,.toml,.conf,.ppt,.pptx"
          multiple
          style={{ display: 'none' }}
          onChange={onPickAny}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={onPickImages}
        />
        <input
          ref={fileDocInputRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.xlsm,.csv,.md,.markdown,.txt,.json,.log,.yaml,.yml,.xml,.html,.htm,.sql,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.cpp,.c,.h,.hpp,.cs,.kt,.swift,.rb,.php,.sh,.bat,.ini,.toml,.conf"
          multiple
          style={{ display: 'none' }}
          onChange={onPickFiles}
        />
      </div>
    );
  }

  return (
    <div
      ref={popupRef}
      className={'qa-popup' + (codingMode ? ' qa-popup--coding' : '')}
      style={popupStyle}
      onMouseDown={onPopupMouseDown}
    >
      {/* 顶部条:始终显示角色名;busy(thinking/talking)时隐藏左右按钮,
          只留居中名字作为信息提示 + 拖动把手 */}
      <div className={'qa-header' + (headerBusy ? ' qa-header--busy' : '')}>
        {!headerBusy && !codingMode && (
          <button
            className="dialog-icon-btn"
            onClick={() => setMode('history')}
            title="历史会话"
          >
            ≡
          </button>
        )}
        <span className="qa-skill-name">{headerTitle}</span>
        {!headerBusy && (
          <button className="dialog-close-btn" onClick={onClose} title="关闭" aria-label="关闭">
            ✕
          </button>
        )}
      </div>

      {error && <div className="dialog-line err">{error}</div>}

      {mode === 'qa-input' ? (
        // ============ 输入模式 — 干净的输入框 ============
        <div className="qa-input-area">
          {/* 附件预览区 — 图片缩略图 + 文件 chip 共用一个 .qa-attachments flex 容器 */}
          {(attachments.length > 0 || fileAttachments.length > 0) && (
            <div className="qa-attachments">
              {attachments.map((url, i) => (
                <div key={'img-' + i} className="qa-attach-thumb">
                  <img src={url} alt={`附件 ${i + 1}`} />
                  <button
                    type="button"
                    className="qa-attach-remove"
                    onClick={() =>
                      setAttachments((arr) => arr.filter((_, idx) => idx !== i))
                    }
                    title="移除"
                    aria-label="移除"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {fileAttachments.map((a, i) => (
                <div key={'file-' + i} className="qa-attach-file" title={`${a.name}(${formatFileSize(a.sizeBytes)},约 ${a.text.length} 字符)`}>
                  <span className="qa-attach-file-icon">📄</span>
                  <span className="qa-attach-file-name">{a.name}</span>
                  <span className="qa-attach-file-size">{formatFileSize(a.sizeBytes)}</span>
                  <button
                    type="button"
                    className="qa-attach-file-remove"
                    onClick={() =>
                      setFileAttachments((arr) => arr.filter((_, idx) => idx !== i))
                    }
                    title="移除"
                    aria-label="移除"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="qa-textarea"
            rows={3}
            autoFocus
            value={dictating && dictationPartial ? input + dictationPartial : input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              dictating
                ? '正在听… 说完一段话会自动发送(可再次点击 🎤 取消)'
                : '说点什么吧 (Shift+Enter 回车 Enter 发送)'
            }
            readOnly={dictating}
          />
          {codingMode ? (
            // ===== 编码模式工具栏(模仿 Windsurf):
            // 左侧 + / <> / 模型名(展示用);右侧 刷新 / 麦克风 / 圆形发送按钮 =====
            <div className="qa-tool-row qa-tool-row--coding">
              <div className="qa-tool-left">
                <button
                  type="button"
                  className="qa-coding-btn"
                  onClick={() => fileAnyInputRef.current?.click()}
                  disabled={fileAttachments.length >= MAX_FILES && attachments.length >= 4}
                  title="添加文件 — 图片 / PDF / Word / Excel / PPT / Markdown / 代码(Python、Java、JS、Go…)"
                  aria-label="添加文件"
                >
                  +
                </button>
                <button
                  type="button"
                  className="qa-coding-btn"
                  onClick={() => fileDocInputRef.current?.click()}
                  disabled={fileAttachments.length >= MAX_FILES}
                  title="插入代码/文件"
                  aria-label="插入代码或文件"
                >
                  {'<>'}
                </button>
                <span
                  className="qa-coding-model"
                  title={`当前模型: ${modelLabel}\n(可在设置面板里改)`}
                >
                  {modelLabel}
                </span>
              </div>
              <div className="qa-tool-right">
                <button
                  type="button"
                  className="qa-coding-btn"
                  onClick={newConversation}
                  title="新一轮(等同 + 按钮,清空上下文)"
                  aria-label="新一轮"
                >
                  ↻
                </button>
                {voiceInputAvailable && (
                  <button
                    type="button"
                    className={'qa-coding-btn qa-coding-btn--icon' + (dictating ? ' qa-coding-btn--active' : '')}
                    onClick={() => setDictating((v) => !v)}
                    title={dictating ? '关闭语音输入' : '语音输入(说完静默自动发送)'}
                    aria-label={dictating ? '关闭语音输入' : '开启语音输入'}
                  >
                    <ToolIcon name="mic" size={15} />
                  </button>
                )}
                <button
                  type="button"
                  className="qa-coding-send"
                  onClick={() => void send()}
                  disabled={
                    streaming ||
                    (!input.trim() && attachments.length === 0 && fileAttachments.length === 0)
                  }
                  title="发送(Enter)"
                  aria-label="发送"
                >
                  ↑
                </button>
              </div>
              {/* 隐藏 file inputs:
                  - fileAnyInputRef:「+」按钮,接图片 + 文档/代码 等所有支持类型,内部按 MIME 分流
                  - fileInputRef:仅图片(保留给可能扩展,目前编码模式没单独入口)
                  - fileDocInputRef:仅文档/代码(由「<>」触发) */}
              <input
                ref={fileAnyInputRef}
                type="file"
                accept="image/*,.pdf,.docx,.xlsx,.xlsm,.csv,.md,.markdown,.txt,.json,.log,.yaml,.yml,.xml,.html,.htm,.sql,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.cpp,.c,.h,.hpp,.cs,.kt,.swift,.rb,.php,.sh,.bat,.ini,.toml,.conf,.ppt,.pptx"
                multiple
                style={{ display: 'none' }}
                onChange={onPickAny}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={onPickImages}
              />
              <input
                ref={fileDocInputRef}
                type="file"
                accept=".pdf,.docx,.xlsx,.xlsm,.csv,.md,.markdown,.txt,.json,.log,.yaml,.yml,.xml,.html,.htm,.sql,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.cpp,.c,.h,.hpp,.cs,.kt,.swift,.rb,.php,.sh,.bat,.ini,.toml,.conf"
                multiple
                style={{ display: 'none' }}
                onChange={onPickFiles}
              />
            </div>
          ) : (
          <>
          <div className="qa-tool-row">
            {voiceInputAvailable && (
              <button
                type="button"
                className={'qa-tool-btn qa-mic-btn' + (dictating ? ' qa-mic-btn--active' : '')}
                onClick={() => setDictating((v) => !v)}
                title={dictating ? '关闭语音输入' : '语音输入(说完静默自动发送)'}
                aria-label={dictating ? '关闭语音输入' : '开启语音输入'}
              >
                <ToolIcon name="mic" />
              </button>
            )}
            <button
              type="button"
              className="qa-tool-btn"
              onClick={takeScreenshot}
              disabled={attachments.length >= 4}
              title="全屏截图(自动隐藏桌宠后截屏)"
              aria-label="全屏截图"
            >
              <ToolIcon name="camera" />
            </button>
            <button
              type="button"
              className="qa-tool-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= 4}
              title="上传图片(单图 ≤ 8MB,最多 4 张)"
              aria-label="上传图片"
            >
              <ToolIcon name="image" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={onPickImages}
            />
            <button
              type="button"
              className="qa-tool-btn"
              onClick={() => fileDocInputRef.current?.click()}
              disabled={fileAttachments.length >= MAX_FILES}
              title={`上传文件(PDF / Word(.docx)/ Excel(.xlsx)/ md / txt / 代码,最多 ${MAX_FILES} 个)`}
              aria-label="上传文件"
            >
              <ToolIcon name="paperclip" />
            </button>
            <input
              ref={fileDocInputRef}
              type="file"
              accept=".pdf,.docx,.xlsx,.xlsm,.csv,.md,.markdown,.txt,.json,.log,.yaml,.yml,.xml,.html,.htm,.sql,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.cpp,.c,.h,.hpp,.cs,.kt,.swift,.rb,.php,.sh,.bat,.ini,.toml,.conf"
              multiple
              style={{ display: 'none' }}
              onChange={onPickFiles}
            />
          </div>
          </>
          )}
        </div>
      ) : (
        // ============ 回答模式 — 只显示 AI 回答 ============
        <div className="qa-answer-area">
          {/* 思考过程(优先 streaming;否则上次保存的) */}
          {(streaming
            ? thinkingText
            : lastAssistant?.thinking) && (
            // streaming 时默认展开方便实时看;一旦回答结束(streaming=false)用 key 重挂
            // 强制 details 关闭,不依赖浏览器对 prop 变化的响应
            <details
              key={streaming ? 'thinking-streaming' : 'thinking-done'}
              className="dialog-thinking-fold"
              open={streaming}
            >
              <summary>💭 思考过程</summary>
              <div className="dialog-thinking-body" ref={thinkingBodyRef}>
                {streaming ? thinkingText : lastAssistant?.thinking}
              </div>
            </details>
          )}

          {/* 工具调用卡片 — 默认折叠,不刷屏。streaming/已完成都是默认关。
              用 key 强制重挂确保 streaming → done 切换时折叠状态不被浏览器记住 */}
          {toolEvents.length > 0 && (
            <details
              key={streaming ? 'tool-streaming' : 'tool-done'}
              className="dialog-thinking-fold"
            >
              <summary>🔧 工具调用 ({toolEvents.length})</summary>
              <div className="dialog-thinking-body">
                {toolEvents.map((ev) => (
                  <div key={ev.callId} style={{ marginBottom: 6, fontSize: 12 }}>
                    <div>
                      <b>{ev.stage === 'call' ? '▶' : ev.stage === 'result' ? '✓' : '✗'}</b>{' '}
                      <code>{ev.toolName}</code>
                    </div>
                    {ev.args !== undefined && (
                      <div style={{ opacity: 0.7, marginLeft: 12 }}>
                        args: {safeStringify(ev.args, 200)}
                      </div>
                    )}
                    {ev.stage === 'result' && (
                      <div style={{ opacity: 0.8, marginLeft: 12, whiteSpace: 'pre-wrap' }}>
                        {safeStringify(ev.result, 500)}
                      </div>
                    )}
                    {ev.stage === 'error' && (
                      <div style={{ color: '#e88', marginLeft: 12 }}>{ev.error}</div>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* 回答内容(markdown) */}
          <div className="md-body qa-answer-body">
            {streaming ? (
              <>
                <MarkdownRenderer>
                  {sanitizeMarkdown(stripEmotionTag(streamingText)) || '思考中…'}
                </MarkdownRenderer>
                <span className="caret">▍</span>
              </>
            ) : lastAssistant ? (
              <MarkdownRenderer>
                {sanitizeMarkdown(contentToString(lastAssistant.content))}
              </MarkdownRenderer>
            ) : (
              <span className="empty-hint">(无回答)</span>
            )}
          </div>
        </div>
      )}

      {/* 动作按钮 — 始终在 popup 底部固定,不随内容滚动 */}
      {mode === 'qa-answer' && (
        <div className="qa-actions">
          {streaming ? (
            <button
              className="qa-btn"
              onClick={() => {
                cancelRef.current?.();
                cancelRef.current = null;
                setStreaming(false);
                clearTextFlushTimers();
                setStreamingText('');
                setThinkingText('');
                streamingTextRef.current = '';
                thinkingTextRef.current = '';
                dispatchPetState('idle');
              }}
            >
              取消
            </button>
          ) : (
            <>
              <button className="qa-btn qa-btn-primary" onClick={continueChat}>
                继续对话
              </button>
              <button className="qa-btn" onClick={endChat}>
                结束对话
              </button>
            </>
          )}
        </div>
      )}

      {/* 写操作确认模态 — 通过 Portal 挂到 body,配合 passthrough-suppress 穿透窗口。
       *  点"允许"回 true,"拒绝"回 false,可勾选"本会话总是允许"。 */}
      {confirmRequest &&
        createPortal(
          <ConfirmToolModal
            request={confirmRequest}
            onRespond={async (approve, alwaysAllow) => {
              await window.petAPI?.mcpRespondConfirm?.(
                confirmRequest.id,
                approve,
                alwaysAllow,
                confirmRequest.toolName,
              );
              setConfirmRequest(null);
            }}
          />,
          document.body,
        )}
    </div>
  );
}

/** 工具中文友好名 + 用户视角描述。前缀 server id 之后的 raw name 是稳定的,
 *  这里只对最常出现的几类做好看的转译,其它直接展示原名。 */
const TOOL_LABELS: Record<string, { title: string; verb: string }> = {
  // app 内置
  open_url: { title: '打开网页', verb: '在浏览器打开' },
  web_search: { title: '搜索网页', verb: '搜索' },
  open_path: { title: '打开本地文件 / 程序', verb: '打开' },
  open_app: { title: '启动应用程序', verb: '启动' },
  set_clipboard: { title: '写入剪贴板', verb: '复制到剪贴板' },
  notify: { title: '弹系统通知', verb: '发送通知' },
  // filesystem
  write_file: { title: '写入文件', verb: '写入' },
  edit_file: { title: '编辑文件', verb: '编辑' },
  create_directory: { title: '新建文件夹', verb: '新建' },
  move_file: { title: '移动 / 重命名', verb: '移动' },
  delete_file: { title: '删除文件', verb: '删除' },
};
/** 把单个 arg 值渲染成漂亮的 ReactNode(URL 渲染成链接,长字符串截断,等)。 */
function renderArgValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <em style={{ opacity: 0.6 }}>(空)</em>;
  if (typeof v === 'boolean' || typeof v === 'number') return <code>{String(v)}</code>;
  if (typeof v === 'string') {
    if (/^https?:\/\//.test(v)) {
      return (
        <a
          href={v}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#7eb6ff', wordBreak: 'break-all' }}
        >
          {v}
        </a>
      );
    }
    if (v.length > 240) {
      return (
        <span style={{ wordBreak: 'break-all' }}>
          {v.slice(0, 240)}
          <span style={{ opacity: 0.5 }}>… (省略 {v.length - 240} 字)</span>
        </span>
      );
    }
    return <span style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{v}</span>;
  }
  // 其它类型 fallback 成 JSON
  return (
    <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{safeStringify(v, 240)}</code>
  );
}

/** 写操作确认弹窗 — 用户视角的简洁展示 + "本会话总是允许"勾选。 */
function ConfirmToolModal({
  request,
  onRespond,
}: {
  request: { id: string; toolName: string; args: unknown };
  onRespond: (approve: boolean, alwaysAllow: boolean) => void | Promise<void>;
}): JSX.Element {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('pet:passthrough-suppress', { detail: { suppress: true } }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent('pet:passthrough-suppress', { detail: { suppress: false } }),
      );
    };
  }, []);
  // 去 server 前缀
  const rawName = request.toolName.includes('__')
    ? request.toolName.split('__').slice(1).join('__')
    : request.toolName;
  const label = TOOL_LABELS[rawName];
  // 把 args 转成 [key, value] 数组渲染。非 object 时退化为单条
  const argEntries: Array<[string, unknown]> =
    request.args && typeof request.args === 'object' && !Array.isArray(request.args)
      ? Object.entries(request.args as Record<string, unknown>)
      : [['args', request.args]];
  return (
    <div className="qa-lightbox" role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'rgba(30, 30, 34, 0.96)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 12,
          padding: 20,
          maxWidth: 560,
          width: '86vw',
          color: '#fff',
          boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
          🔒 AI 想要执行操作
        </div>
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 14 }}>
          {label ? (
            <>
              <b>{label.title}</b>{' '}
              <span style={{ opacity: 0.6, fontSize: 11 }}>({rawName})</span>
            </>
          ) : (
            <code>{rawName}</code>
          )}
        </div>

        <div
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: 12,
            fontSize: 13,
            maxHeight: 280,
            overflow: 'auto',
          }}
        >
          {argEntries.length === 0 && (
            <div style={{ opacity: 0.6 }}>(无参数)</div>
          )}
          {argEntries.map(([k, v]) => (
            <div key={k} style={{ marginBottom: 8 }}>
              <div style={{ opacity: 0.7, fontSize: 11, marginBottom: 2 }}>{k}</div>
              <div>{renderArgValue(v)}</div>
            </div>
          ))}
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 14,
            fontSize: 12,
            opacity: 0.85,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(e) => setAlwaysAllow(e.target.checked)}
          />
          本次会话总是允许 <code style={{ fontSize: 11 }}>{rawName}</code>
          (重启应用后失效)
        </label>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="qa-btn" onClick={() => void onRespond(false, false)}>
            拒绝
          </button>
          <button
            className="qa-btn qa-btn-primary"
            onClick={() => void onRespond(true, alwaysAllow)}
          >
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
