import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as PIXI from 'pixi.js';
import type { Live2DCharacter, Live2DExpressionRef } from '../../shared/character';
import {
  pickExpressionFor,
  pickMotionFor,
  type Emotion,
} from '../../shared/emotion-map';
import { useProactiveGreetings } from './use-proactive-greetings';
import { toPetUrl } from './pet-url';
import { LIVE2D_TARGET_FPS, loadLive2D, fitAndCenterModel } from './live2d-adapter';
import { Cubism4ExpressionManager } from 'pixi-live2d-display-lipsyncpatch/cubism4';
import type { Live2DModel } from 'pixi-live2d-display-lipsyncpatch/cubism4';

interface Props {
  character: Live2DCharacter;
  /** 资源根 */
  roots: { live2d: string; sprite: string };
  onLoaded?: () => void;
  onError?: (err: Error) => void;
  onContextMenu?: (e: { clientX: number; clientY: number }) => void;
  /** 外部获取主动通知 scale 变化,供菜单同步显示。 */
  onScaleChange?: (scale: number) => void;
  /** 报告当前模型在窗口里的"对话气泡锚点 Y"(腰线附近,CSS 像素) */
  onAnchorY?: (y: number) => void;
  /** 模型是否可见。隐藏时暂停 Pixi/Live2D ticker,避免 display:none 仍然烧 CPU。 */
  visible?: boolean;
}

export interface CharacterHostHandle {
  /** 提交 user scale —— 改窗口尺寸 + 持久化(用于按钮、松开 slider) */
  setUserScale: (s: number) => void;
  /** 预览 user scale —— 不改窗口,只改 PIXI model.scale,做拖动 slider 时的实时视觉反馈
   *  避免反复 setWindowSize 引起菜单 popup 跟着窗口飘移、闪烁 */
  previewUserScale: (s: number) => void;
  resetUserScale: () => void;
  getUserScale: () => number;
  /** 调试:列出当前模型所有 expression 名 */
  listExpressions: () => string[];
  /** 调试:列出当前模型所有 motion group 名 */
  listMotions: () => string[];
  /** 调试:直接播放某个 expression(name 或 index)— 返回库的解析结果 */
  playExpression: (name: string | number) => Promise<unknown>;
  /** 调试:直接播放某个 motion group(强制 priority=3 打断当前)— 返回库的解析结果 */
  playMotion: (group: string) => Promise<unknown>;
  /** 调试:复位 expression 到默认 */
  resetExpression: () => void;
}

/**
 * 只负责挂一个 PIXI Application 到 div,并把当前 Live2D 模型渲染上去。
 * 后续会扩成支持 PNG sprite 适配器、状态切换、表情/嘴型等。
 */
/** 用户额外缩放的 localStorage key 前缀 */
const SCALE_KEY_PREFIX = 'pet:scale:';

function loadUserScale(characterId: string): number {
  try {
    const v = localStorage.getItem(SCALE_KEY_PREFIX + characterId);
    if (!v) return 1;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? Math.max(0.3, Math.min(3, n)) : 1;
  } catch {
    return 1;
  }
}
function saveUserScale(characterId: string, scale: number): void {
  try {
    localStorage.setItem(SCALE_KEY_PREFIX + characterId, scale.toFixed(3));
  } catch {
    // ignore
  }
}

/** 模型在窗口内的位置(中心点 CSS 像素)。每个角色独立持久化。 */
const POS_KEY_PREFIX = 'pet:position:';
const MODEL_POS_SAFE_MARGIN = 100;

function clampModelPos(
  pos: { x: number; y: number },
  size: { w: number; h: number } = { w: MODEL_POS_SAFE_MARGIN * 2, h: MODEL_POS_SAFE_MARGIN * 2 },
): { x: number; y: number } {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const halfW = Math.max(1, size.w / 2);
  const halfH = Math.max(1, size.h / 2);
  const marginX = Math.min(MODEL_POS_SAFE_MARGIN, halfW, Math.max(0, w / 2));
  const marginY = Math.min(MODEL_POS_SAFE_MARGIN, halfH, Math.max(0, h / 2));
  const minX = marginX;
  const minY = marginY;
  const maxX = Math.max(minX, w - marginX);
  const maxY = Math.max(minY, h - marginY);
  return {
    x: Math.max(minX, Math.min(maxX, pos.x)),
    y: Math.max(minY, Math.min(maxY, pos.y)),
  };
}

function loadModelPos(characterId: string, size?: { w: number; h: number }): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY_PREFIX + characterId);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (
      typeof obj?.x === 'number' &&
      Number.isFinite(obj.x) &&
      typeof obj?.y === 'number' &&
      Number.isFinite(obj.y)
    ) {
      return clampModelPos(obj, size);
    }
    return null;
  } catch {
    return null;
  }
}
function saveModelPos(characterId: string, pos: { x: number; y: number }): void {
  try {
    localStorage.setItem(POS_KEY_PREFIX + characterId, JSON.stringify(pos));
  } catch {
    // ignore
  }
}

type RuntimeExpressionDefinition = {
  Name?: string;
  name?: string;
  File?: string;
  file?: string;
};
type Cubism4ExpressionManagerSettings = ConstructorParameters<typeof Cubism4ExpressionManager>[0];

function runtimeExpressionName(def: RuntimeExpressionDefinition): string {
  const name = def.Name ?? def.name;
  return typeof name === 'string' ? name : '';
}

function normalizeDiscoveredExpression(
  item: Live2DExpressionRef | string | null | undefined,
): { Name: string; File: string } | null {
  if (typeof item === 'string') {
    const name = item.trim();
    return name ? { Name: name, File: `${name}.exp3.json` } : null;
  }
  const name = typeof item?.name === 'string' ? item.name.trim() : '';
  const file = typeof item?.file === 'string' ? item.file.replace(/\\/g, '/') : '';
  if (!name || !file) return null;
  return { Name: name, File: file };
}

function patchDiscoveredExpressions(model: Live2DModel, character: Live2DCharacter): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = model;
  const settings = m.internalModel?.settings as
    | { expressions?: RuntimeExpressionDefinition[] }
    | undefined;
  if (!settings) return 0;

  if (!Array.isArray(settings.expressions)) settings.expressions = [];
  const expressions = settings.expressions;
  const existing = new Set(expressions.map(runtimeExpressionName).filter(Boolean));
  const additions: Array<{ Name: string; File: string }> = [];

  for (const item of character.discoveredExpressions ?? []) {
    const def = normalizeDiscoveredExpression(item);
    if (!def || existing.has(def.Name)) continue;
    existing.add(def.Name);
    additions.push(def);
  }

  if (additions.length === 0) return 0;
  expressions.push(...additions);

  const motionManager = m.internalModel?.motionManager;
  let expressionManager = motionManager?.expressionManager;
  if (!expressionManager && motionManager) {
    try {
      expressionManager = new Cubism4ExpressionManager(settings as Cubism4ExpressionManagerSettings);
      motionManager.expressionManager = expressionManager;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[CharacterHost] create expression manager failed:', err);
    }
  }
  if (expressionManager) {
    expressionManager.definitions = expressions;
  }
  return additions.length;
}

const CURSOR_FOCUS_GAIN = 1.45;
const CURSOR_FOCUS_RANGE_X = 0.32;
const CURSOR_FOCUS_RANGE_Y = 0.34;
const CURSOR_FOCUS_MIN_RANGE = 80;
const CURSOR_FOCUS_BOUNDS_TTL_MS = 500;
const HIT_TEST_INTERVAL_MS = 50;
const PIXI_MAX_RESOLUTION = 2;
const LIVE2D_IDLE_FPS = 24;
const LIVE2D_ACTIVE_HOLD_MS = 2500;

type FocusBoundsSnapshot = {
  at: number;
  containerW: number;
  containerH: number;
  centerX: number;
  centerY: number;
  rangeX: number;
  rangeY: number;
};
const focusBoundsCache = new WeakMap<Live2DModel, FocusBoundsSnapshot>();

function getPixiResolution(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.min(PIXI_MAX_RESOLUTION, dpr));
}

function clampUnit(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function isValidRect(r: PIXI.Rectangle): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > 1 &&
    r.height > 1
  );
}

function destroyLive2DModel(model: unknown, app: PIXI.Application | null): void {
  if (!model) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = model;
  try {
    app?.stage.removeChild(m);
  } catch {
    // ignore
  }
  try {
    // pixi-live2d-display 会复用/缓存 texture。强行销毁 texture/baseTexture
    // 容易让后续模型只剩黑色剪影,所以这里只卸显示对象层。
    m.destroy?.({ children: true });
  } catch {
    // ignore
  }
}

function applyCursorFocus(
  model: Live2DModel,
  container: HTMLDivElement,
  windowX: number,
  windowY: number,
): void {
  const rect = container.getBoundingClientRect();
  const localX = windowX - rect.left;
  const localY = windowY - rect.top;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = model;
  const focusController = m.internalModel?.focusController;
  if (!focusController || typeof focusController.focus !== 'function') {
    m.focus?.(localX, localY);
    return;
  }

  const containerW = container.clientWidth;
  const containerH = container.clientHeight;
  let centerX = containerW / 2;
  let centerY = containerH / 2;
  let rangeX = Math.max(CURSOR_FOCUS_MIN_RANGE, containerW * CURSOR_FOCUS_RANGE_X);
  let rangeY = Math.max(CURSOR_FOCUS_MIN_RANGE, containerH * CURSOR_FOCUS_RANGE_Y);

  const now = performance.now();
  const cached = focusBoundsCache.get(model);
  if (
    cached &&
    now - cached.at < CURSOR_FOCUS_BOUNDS_TTL_MS &&
    cached.containerW === containerW &&
    cached.containerH === containerH
  ) {
    centerX = cached.centerX;
    centerY = cached.centerY;
    rangeX = cached.rangeX;
    rangeY = cached.rangeY;
  } else {
    try {
      const bounds = m.getBounds() as PIXI.Rectangle;
      if (isValidRect(bounds)) {
        centerX = bounds.x + bounds.width / 2;
        centerY = bounds.y + bounds.height / 2;
        rangeX = Math.max(CURSOR_FOCUS_MIN_RANGE, bounds.width * CURSOR_FOCUS_RANGE_X);
        rangeY = Math.max(CURSOR_FOCUS_MIN_RANGE, bounds.height * CURSOR_FOCUS_RANGE_Y);
      }
    } catch {
      // Use container fallback above.
    }
    focusBoundsCache.set(model, {
      at: now,
      containerW,
      containerH,
      centerX,
      centerY,
      rangeX,
      rangeY,
    });
  }

  const targetX = clampUnit(((localX - centerX) / rangeX) * CURSOR_FOCUS_GAIN);
  const targetY = clampUnit(((centerY - localY) / rangeY) * CURSOR_FOCUS_GAIN);
  focusController.focus(targetX, targetY);
}

export const CharacterHost = forwardRef<CharacterHostHandle, Props>(function CharacterHost(
  {
    character,
    roots,
    onLoaded,
    onError,
    onContextMenu,
    onScaleChange,
    onAnchorY,
    visible = true,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const modelRef = useRef<Live2DModel | null>(null);
  const visibleRef = useRef<boolean>(visible);
  visibleRef.current = visible;
  const userScaleRef = useRef<number>(1);
  /** 拖动 size slider 时的 setWindowSize debounce timer — 静止后才真正改窗口尺寸 */
  const resizeDebounceRef = useRef<number | null>(null);
  /** 当前鼠标是否处于模型 bounds 内,用于切换鼠标穿透 */
  const insideModelRef = useRef<boolean>(false);
  /** 全屏 modal(如 lightbox)打开时置 true:强制取消鼠标穿透,
   *  让用户能点到 modal 上的关闭按钮 / 遮罩。由 'pet:passthrough-suppress' 事件驱动。 */
  const forcePassthroughOffRef = useRef<boolean>(false);
  /** 设置:锁定模型位置(true 时拖拽不真正移动窗口)。由 Effect 同步 config 维护 */
  const lockPositionRef = useRef<boolean>(false);
  /** 触发提示气泡(在 Effect 1 内赋值);duration 默认 800ms,可传更长 */
  const showHintRef = useRef<((s: string, duration?: number) => void) | null>(null);
  /** 上一次点击触发的 motion 组 / expression 索引,避免连续相同 */
  const lastMotionRef = useRef<string | null>(null);
  const lastExpressionIdxRef = useRef<number>(-1);
  /** expression 自动复位定时器(防造型类表情把隐藏图层留在画面) */
  const expResetTimerRef = useRef<number | null>(null);
  /** focus(视线跟随)冻结到的时间戳。motion 播放期间冻结,避免 focus 每帧覆盖
   *  ParamAngleX/Y/Z,导致点头/摇头之类的头部 motion 被冲掉看不见。 */
  const focusFrozenUntilRef = useRef<number>(0);
  /** 把回调封进 ref,避免父级每次 re-render 重建函数引发 effect 重跑、PIXI 重建 */
  const ctxRef = useRef(onContextMenu);
  const scaleCbRef = useRef(onScaleChange);
  const loadedCbRef = useRef(onLoaded);
  const errorCbRef = useRef(onError);
  const anchorCbRef = useRef(onAnchorY);
  ctxRef.current = onContextMenu;
  scaleCbRef.current = onScaleChange;
  loadedCbRef.current = onLoaded;
  errorCbRef.current = onError;
  anchorCbRef.current = onAnchorY;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedName, setLoadedName] = useState<string | null>(null);
  const [scaleHint, setScaleHint] = useState<string | null>(null);
  /** character-host div 的 inline 尺寸(模型区)。基础 400×600,跟随 user scale 等比放大。
   *  由 setUserScale / resetUserScale / 角色加载时根据 loadUserScale 设置。
   *  ResizeObserver 监听这个尺寸变化触发 PIXI fit。 */
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 400, h: 600 });
  const containerSizeRef = useRef<{ w: number; h: number }>(containerSize);
  containerSizeRef.current = containerSize;
  /** 模型容器在窗口内的中心点位置(CSS 像素)。null 表示首次未加载,先用窗口中央。
   *  拖动时通过 setModelPos 实时更新;切角色 / mount 时从 localStorage 加载。 */
  const [modelPos, setModelPos] = useState<{ x: number; y: number } | null>(null);
  /** 闭包里要读最新位置(mousemove handler),用 ref 镜像 state */
  const modelPosRef = useRef<{ x: number; y: number } | null>(null);
  modelPosRef.current = modelPos;
  /** flushDrag 在 effect 1(只挂载一次)闭包里要写 localStorage,需要最新角色 id */
  const characterIdRef = useRef<string>(character.id);
  characterIdRef.current = character.id;

  // ---- Effect 1:PIXI Application 全生命周期只创建一次,在 div 卸载时销毁 ----
  // 避免角色切换时 app.destroy() 带走 GPU texture cache,导致后续渲染黑屏。
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const app = new PIXI.Application({
      width: container.clientWidth,
      height: container.clientHeight,
      backgroundAlpha: 0, // 透明背景,与 Electron 透明窗合作
      antialias: false,
      resolution: getPixiResolution(),
      autoDensity: true,
    });
    app.ticker.maxFPS = LIVE2D_TARGET_FPS;
    PIXI.Ticker.shared.maxFPS = LIVE2D_TARGET_FPS;
    if (!visibleRef.current) app.stop();
    appRef.current = app;

    // 拖动状态:ResizeObserver / ticker idle check / mouse handlers 都要读。
    let dragging = false;
    let live2dFps = LIVE2D_TARGET_FPS;
    let live2dActiveUntil = performance.now() + LIVE2D_ACTIVE_HOLD_MS;
    let live2dIdleTimer: number | null = null;
    const setLive2DFps = (fps: number) => {
      if (live2dFps === fps) return;
      live2dFps = fps;
      app.ticker.maxFPS = fps;
      PIXI.Ticker.shared.maxFPS = fps;
    };
    const scheduleLive2DIdleCheck = () => {
      if (live2dIdleTimer != null) return;
      const delay = Math.max(200, live2dActiveUntil - performance.now());
      live2dIdleTimer = window.setTimeout(() => {
        live2dIdleTimer = null;
        if (!visibleRef.current) return;
        if (dragging || forcePassthroughOffRef.current) {
          live2dActiveUntil = performance.now() + LIVE2D_ACTIVE_HOLD_MS;
          scheduleLive2DIdleCheck();
          return;
        }
        if (performance.now() < live2dActiveUntil) {
          scheduleLive2DIdleCheck();
          return;
        }
        setLive2DFps(LIVE2D_IDLE_FPS);
      }, delay);
    };
    const markLive2DActive = () => {
      live2dActiveUntil = performance.now() + LIVE2D_ACTIVE_HOLD_MS;
      setLive2DFps(LIVE2D_TARGET_FPS);
      scheduleLive2DIdleCheck();
    };
    markLive2DActive();

    const canvas = app.view as HTMLCanvasElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);

    /** 算"对话气泡锚点 Y" = 模型 bounds 上半 60% 处(大约腰线 / 胸口偏下),CSS 像素 */
    const reportAnchor = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = modelRef.current;
      if (!m || !appRef.current) return;
      const bs = m.getBounds() as PIXI.Rectangle;
      if (!isFinite(bs.height) || bs.height <= 0) return;
      const y = Math.round(bs.y + bs.height * 0.6);
      anchorCbRef.current?.(y);
      // 同时报告给主进程,做窗口下方 clamp(腰线不沉到屏底以下)
      window.petAPI?.setAnchorY?.(y);
    };

    // 记录最近一次 resize 的 size,只有真的变了才触发 fit;且拖动期间不触发 fit
    let lastW = container.clientWidth;
    let lastH = container.clientHeight;
    const ro = new ResizeObserver(() => {
      if (!appRef.current) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      // 5px 死区:吸收 Windows transparent 窗 setPosition 后的 ±2px 漂移噪声;
      // 同时拖动期间一律不重排
      if (dragging) return;
      if (Math.abs(w - lastW) < 5 && Math.abs(h - lastH) < 5) return;
      lastW = w;
      lastH = h;
      appRef.current.renderer.resize(w, h);
      // user scale 通过窗口尺寸反映,这里 fit 用 1 让模型总是填满 0.9 * 窗口
      if (modelRef.current) {
        fitAndCenterModel(appRef.current, modelRef.current, 1);
        reportAnchor();
      }
    });
    ro.observe(container);

    // 缩放提示气泡(由菜单滑块驱动 / 对话状态切换)
    let hintTimer: number | null = null;
    showHintRef.current = (s: string, duration: number = 800) => {
      setScaleHint(s);
      if (hintTimer) window.clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => setScaleHint(null), duration);
    };

    // 右键 -> 弹出菜单
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      ctxRef.current?.({ clientX: e.clientX, clientY: e.clientY });
    };

    // 左键拖拽:rAF 节流积累 dx/dy,每帧只发一次 IPC,消除闪烁
    // dragging 已在前面声明
    let lastX = 0;
    let lastY = 0;
    let pendingDx = 0;
    let pendingDy = 0;
    let rafId: number | null = null;
    const flushDrag = () => {
      rafId = null;
      if (pendingDx === 0 && pendingDy === 0) return;
      const dx = pendingDx;
      const dy = pendingDy;
      pendingDx = 0;
      pendingDy = 0;
      // 设置里启用了"锁定位置" → 丢弃位移,但 click 检测仍然正常工作
      if (lockPositionRef.current) return;
      // 改为在窗口内移动模型容器(modelPos),不动 BrowserWindow。
      // 这样窗口可以全屏覆盖工作区,模型放左下角时对话框还能拖到右上角。
      // clamp 到工作区:不让模型中心点跑到窗口外面(留出安全边)。
      const cur = modelPosRef.current;
      if (!cur) return;
      const next = clampModelPos({ x: cur.x + dx, y: cur.y + dy }, containerSizeRef.current);
      modelPosRef.current = next;
      setModelPos(next);
      // 持久化到当前 active 角色(用 ref 取最新 id,避免闭包陈旧)
      saveModelPos(characterIdRef.current, next);
    };
    // 点击 vs 拖动:mousedown 起记录起点 + 时间;mouseup 时如未移动 → 视为点击触发交互
    let downStartX = 0;
    let downStartY = 0;
    let downStartTime = 0;
    let hasMoved = false;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      markLive2DActive();
      dragging = true;
      lastX = e.screenX;
      lastY = e.screenY;
      downStartX = e.screenX;
      downStartY = e.screenY;
      downStartTime = performance.now();
      hasMoved = false;
    };
    // 像素级 alpha hit-test:决定鼠标是否穿透下层窗口
    // - 鼠标在菜单/UI 上 → 强制不穿透
    // - 鼠标在模型不透明像素上 → 不穿透(可点击)
    // - 其它(透明区) → 穿透
    let hitRaf: number | null = null;
    let hitTimer: number | null = null;
    let lastHitTestAt = 0;
    let pendingHitX = 0;
    let pendingHitY = 0;
    const hitPixel = new Uint8Array(4);
    const runHitTest = () => {
      hitRaf = null;
      lastHitTestAt = performance.now();
      if (dragging || !appRef.current) return;
      const cx = pendingHitX;
      const cy = pendingHitY;

      const elAt = document.elementFromPoint(cx, cy);
      const overUi =
        !!elAt &&
        elAt.closest(
          '.pet-menu, .pet-menu-panel, .scan-error, .scan-hint, .vosk-toast, .dialog-frame, .qa-popup, .debug-trigger, .debug-panel, .clipboard-suggest',
        ) !== null;

      let onPixel = false;
      if (!overUi) {
        // PIXI 7 的 renderer.gl 是 WebGL2/1 context;readPixels 拿 1 像素 alpha
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gl = (appRef.current.renderer as any).gl as WebGL2RenderingContext | undefined;
        // canvas 不一定从 (0,0) 开始(对话框打开时占左半 / 翻边占右半),
        // 必须把 client 坐标转成 canvas 内坐标,否则 readPixels 越界 → 误判为透明 → 鼠标穿透
        const rect = canvas.getBoundingClientRect();
        const localX = cx - rect.left;
        const localY = cy - rect.top;
        if (
          gl &&
          localX >= 0 &&
          localX < rect.width &&
          localY >= 0 &&
          localY < rect.height
        ) {
          const dpr = appRef.current.renderer.resolution || 1;
          const stageH = appRef.current.screen.height;
          const px = Math.round(localX * dpr);
          const py = Math.round((stageH - localY) * dpr); // WebGL Y 反向
          try {
            gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, hitPixel);
            onPixel = hitPixel[3] > 16;
          } catch {
            onPixel = false;
          }
        }
      }

      // forcePassthroughOff = lightbox / 全屏 modal 打开期间,强制不穿透,
      // 否则模型外区域 hit-test 会判定 inside=false → 开启穿透 → 用户点 × 关不掉。
      const inside = forcePassthroughOffRef.current || overUi || onPixel;
      if (inside !== insideModelRef.current) {
        insideModelRef.current = inside;
        window.petAPI?.setIgnoreMouseEvents(!inside, true);
      }
    };
    const scheduleHitTest = () => {
      if (hitRaf != null || hitTimer != null) return;
      const delay = HIT_TEST_INTERVAL_MS - (performance.now() - lastHitTestAt);
      if (delay <= 0) {
        hitRaf = requestAnimationFrame(runHitTest);
        return;
      }
      hitTimer = window.setTimeout(() => {
        hitTimer = null;
        if (hitRaf == null) hitRaf = requestAnimationFrame(runHitTest);
      }, delay);
    };

    const onMove = (e: MouseEvent) => {
      // 视线跟随用全屏鼠标位置驱动(主进程推),这里不再调 model.focus
      // 不在拖动时,做像素 hit-test 决定穿透状态(rAF 节流)
      if (!dragging) {
        pendingHitX = e.clientX;
        pendingHitY = e.clientY;
        scheduleHitTest();
        markLive2DActive();
        return;
      }
      markLive2DActive();
      pendingDx += e.screenX - lastX;
      pendingDy += e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      // 偏移超过 4px 视为真在拖动
      if (
        !hasMoved &&
        (Math.abs(e.screenX - downStartX) > 4 || Math.abs(e.screenY - downStartY) > 4)
      ) {
        hasMoved = true;
      }
      if (rafId == null) rafId = requestAnimationFrame(flushDrag);
    };
    const onUp = (e: MouseEvent) => {
      const wasDragging = dragging;
      dragging = false;
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        flushDrag();
      }
      // 短按 + 没拖 → 触发模型点击交互
      const dt = performance.now() - downStartTime;
      if (wasDragging && !hasMoved && dt < 350) {
        triggerTap(e.clientX, e.clientY);
      }
    };

    /**
     * 模型点击交互:
     *   - 头部命中 → 顺序切换下一个 expression(可循环遍历模型所有表情)
     *   - 身体 / 其它 → 播一个 motion(避免与上次相同)
     * 没配 motion/expression 的模型不做反馈。
     *
     * 头/身体判定:
     *   1. hitArea 名含 head/face/头/脸 → 头
     *   2. 没 hit area 时用 Y 坐标兜底:点在 canvas 上 40% → 头
     */
    const triggerTap = (x: number, y: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = modelRef.current;
      if (!m) return;
      markLive2DActive();

      const settings = m.internalModel?.settings;
      const motionGroups: string[] = settings?.motions ? Object.keys(settings.motions) : [];
      const expressions: RuntimeExpressionDefinition[] = settings?.expressions ?? [];

      // ---- 头/身体判定 ----
      let hitHead = false;
      try {
        if (typeof m.hitTest === 'function') {
          const r = m.hitTest(x, y);
          if (Array.isArray(r) && r.length > 0) {
            hitHead = (r as string[]).some((n) => /head|頭|face|脸|首/i.test(n));
          } else {
            // hitTest 返回空(模型没配 HitAreas)→ 用 Y 比例兜底
            // 阈值 0.5 = 画面上半算头部,下半算身体;之前 0.4 对瘦高模型(MIKU)太严格
            const canvas = appRef.current?.view as HTMLCanvasElement | undefined;
            if (canvas) {
              const rect = canvas.getBoundingClientRect();
              const ratio = (y - rect.top) / rect.height;
              hitHead = ratio < 0.5;
            }
          }
        }
      } catch {
        // ignore
      }

      if (hitHead) {
        // 头 → 顺序切下一个 expression
        if (expressions.length === 0) return;
        try {
          const next = (lastExpressionIdxRef.current + 1) % expressions.length;
          lastExpressionIdxRef.current = next;
          const name = runtimeExpressionName(expressions[next] ?? {}) || next;
          // 同样:先卸旧表情再设新的,避免叠加图层
          try {
            m.internalModel?.motionManager?.expressionManager?.resetExpression?.();
          } catch {
            // ignore
          }
          m.expression?.(name);
          // 不再显示 toast hint(用户要求只“思考中”才显示)

          // 6 秒后复位,避免造型类表情把隐藏图层留在画面
          if (expResetTimerRef.current != null) {
            window.clearTimeout(expResetTimerRef.current);
          }
          expResetTimerRef.current = window.setTimeout(() => {
            expResetTimerRef.current = null;
            try {
              m.internalModel?.motionManager?.expressionManager?.resetExpression?.();
            } catch {
              // ignore
            }
          }, 6000);
        } catch {
          // ignore
        }
      } else {
        // 身体 → 随机一个 motion(避免连播相同)
        if (motionGroups.length === 0) return;
        let candidates = motionGroups.filter((g) => g !== lastMotionRef.current);
        if (candidates.length === 0) candidates = motionGroups;
        const group = candidates[Math.floor(Math.random() * candidates.length)];
        try {
          // 估算 motion 时长冻结 focus,避免头部 motion 被视线跟随覆盖
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const motions = m?.internalModel?.motionManager?.motionGroups?.[group] as any[];
          const dur =
            motions?.[0]?._motionData?.duration ??
            motions?.[0]?.getDuration?.() ??
            settings?.motions?.[group]?.[0]?.Duration;
          const durationMs = typeof dur === 'number' && dur > 0 ? dur * 1000 : 2500;
          focusFrozenUntilRef.current = Date.now() + durationMs + 200;

          m.motion?.(group, undefined, 3);
          lastMotionRef.current = group;
          // 不再显示 toast hint(用户要求只“思考中”才显示)
        } catch {
          // ignore
        }
      }
    };
    // 拖动 / 右键的来源:canvas + dialog-frame 的非交互区域
    // (text/input/button/历史项等交互元素不要触发)
    const isInteractive = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el || !el.closest) return false;
      return !!el.closest(
        'textarea, input, button, select, summary, .dialog-history, .pet-menu',
      );
    };
    const onWinDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (isInteractive(e.target)) return;
      // 拖动只在 dialog 顶部条响应(history 大窗 .dialog-top + qa 浮窗 .qa-header)
      const el = e.target as HTMLElement | null;
      if (el && el.closest && el.closest('.dialog-top, .qa-header')) {
        onDown(e);
      }
    };
    const onWinCtx = (e: MouseEvent) => {
      if (isInteractive(e.target)) return;
      const el = e.target as HTMLElement | null;
      if (el && el.closest && el.closest('.dialog-frame, .qa-popup')) {
        e.preventDefault();
        ctxRef.current?.({ clientX: e.clientX, clientY: e.clientY });
      }
    };
    canvas.addEventListener('contextmenu', onCtx);
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousedown', onWinDown);
    window.addEventListener('contextmenu', onWinCtx);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    // 全屏鼠标订阅:让模型视线在窗外也能跟随
    const offCursor = window.petAPI?.onCursorScreen?.((cx, cy) => {
      if (!visibleRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = modelRef.current;
      if (!m || typeof m.focus !== 'function') return;
      // motion 播放期间冻结 focus,避免覆盖头部角度
      if (Date.now() < focusFrozenUntilRef.current) return;
      markLive2DActive();
      applyCursorFocus(m, container, cx, cy);
    });

    // ====== 对话联动:全局事件 → 触发模型 motion / expression ======
    // ChatBubble dispatch:
    //   pet:state   { kind: 'thinking' | 'talking' | 'idle' }
    //   pet:emotion { emotion: 'happy' | 'sad' | 'angry' | 'surprised' }
    const findMotionGroup = (keys: string[]): string | null => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = modelRef.current;
      const groups: string[] = m?.internalModel?.settings?.motions
        ? Object.keys(m.internalModel.settings.motions)
        : [];
      if (groups.length === 0) return null;
      for (const k of keys) {
        const g = groups.find((g) => g.toLowerCase().includes(k.toLowerCase()));
        if (g) return g;
      }
      // fallback:模型只有 1-2 个 motion 组时,任何状态都播第一个,至少有动作反馈
      if (groups.length <= 2) return groups[0];
      return null;
    };
    /** 列出当前模型所有 expression name */
    const listExpressionNames = (): string[] => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = modelRef.current;
      const exps: RuntimeExpressionDefinition[] =
        m?.internalModel?.settings?.expressions ?? [];
      return exps.map(runtimeExpressionName).filter(Boolean);
    };
    /** 列出当前模型所有 motion group name */
    const listMotionGroups = (): string[] => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = modelRef.current;
      return m?.internalModel?.settings?.motions
        ? Object.keys(m.internalModel.settings.motions)
        : [];
    };
    const onPetState = (e: Event) => {
      const detail = (e as CustomEvent).detail as { kind?: 'thinking' | 'talking' | 'idle' };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = modelRef.current;
      if (!m || !detail) return;
      markLive2DActive();
      try {
        let g: string | null = null;
        if (detail.kind === 'thinking') {
          g = findMotionGroup(['think', 'wait', 'idle', '思', '考']);
          showHintRef.current?.('💭 思考中…', 60000); // 持续显示直到下次状态切换
        } else if (detail.kind === 'talking') {
          g = findMotionGroup(['talk', 'speak', 'say', '说', '话']);
          // talking 阶段(AI 正在流式回答)也保持 hint 可见 —— 否则会出现:
          // chat-bubble 仍在流式输出,但模型头顶 hint 闪一下就消失,用户感觉不到状态。
          // 用 60s 长 timeout 兜底,正常会被下一次 state 切换提前清掉。
          showHintRef.current?.('💬 回答中…', 60000);
        } else {
          // idle:立刻清掉提示
          showHintRef.current?.('', 0);
        }
        // priority=3 (FORCE) 强制打断当前 motion 重新开始
        if (g) m.motion?.(g, undefined, 3);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[pet:state] play motion failed:', err);
      }
    };
    // emotion → expression / motion 映射通过 shared/emotion-map.ts 按角色名查表;
    // 没显式映射的模型 fallback 到关键词匹配。每个角色可在 emotion-map.ts 自定义。
    const EMOJI: Record<Emotion, string> = {
      happy: '😊',
      sad: '😢',
      angry: '😠',
      surprised: '😲',
    };
    const onPetEmotion = (e: Event) => {
      const detail = (e as CustomEvent).detail as { emotion?: Emotion };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = modelRef.current;
      if (!m || !detail?.emotion) return;
      markLive2DActive();
      const emo = detail.emotion;
      try {
        // emotion 触发不显示 toast hint
        const exp = pickExpressionFor(character.name, emo, listExpressionNames());
        const mot = pickMotionFor(character.name, emo, listMotionGroups());
        // eslint-disable-next-line no-console
        console.log('[pet:emotion]', character.name, emo, '→ exp:', exp, 'motion:', mot);
        if (exp != null) {
          // 切新表情前先复位旧表情 — Live2D 表情是叠加式,旧表情设过但新表情没设的
          // 参数(如"感叹号图层""嘴张大")会被保留,看起来像旧表情没卸
          try {
            m.internalModel?.motionManager?.expressionManager?.resetExpression?.();
          } catch {
            // ignore
          }
          m.expression?.(exp);
          // 6 秒后复位,避免表情卡住
          if (expResetTimerRef.current != null) {
            window.clearTimeout(expResetTimerRef.current);
          }
          expResetTimerRef.current = window.setTimeout(() => {
            expResetTimerRef.current = null;
            try {
              m.internalModel?.motionManager?.expressionManager?.resetExpression?.();
            } catch {
              // ignore
            }
          }, 6000);
        }
        if (mot != null) {
          // motion 同步触发(focus 已被 playMotion 路径处理;这里用 priority=3 直接打断)
          m.motion?.(mot, undefined, 3);
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener('pet:state', onPetState as EventListener);
    window.addEventListener('pet:emotion', onPetEmotion as EventListener);

    // 监听 lightbox 等 modal 的"取消穿透"信号 — 它们打开时整窗都不能穿透,
    // 否则鼠标会穿到桌面、模态框上的按钮点不到。
    const onPassthroughSuppress = (e: Event) => {
      const detail = (e as CustomEvent).detail as { suppress?: boolean } | undefined;
      const next = !!detail?.suppress;
      forcePassthroughOffRef.current = next;
      if (next) {
        // 立即关掉穿透,不等下一次 mousemove
        insideModelRef.current = true;
        window.petAPI?.setIgnoreMouseEvents(false, false);
      }
      // 解除时不主动开穿透 — 下一次 mousemove 的 hit-test 会自然恢复正确状态
    };
    window.addEventListener('pet:passthrough-suppress', onPassthroughSuppress as EventListener);

    // Ctrl+Shift+P:全局切换鼠标穿透(给 DevTools 检查元素用)
    const onToggleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        const next = !forcePassthroughOffRef.current;
        forcePassthroughOffRef.current = next;
        if (next) {
          insideModelRef.current = true;
          window.petAPI?.setIgnoreMouseEvents(false, false);
          console.log('[pet] passthrough disabled — DevTools 检查元素 OK');
        } else {
          console.log('[pet] passthrough re-enabled');
        }
      }
    };
    window.addEventListener('keydown', onToggleKey);

    // 启动:默认不穿透。鼠标移动后由像素 alpha hit-test 动态切换
    window.petAPI?.setIgnoreMouseEvents(false, false);
    insideModelRef.current = true;

    return () => {
      ro.disconnect();
      canvas.removeEventListener('contextmenu', onCtx);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousedown', onWinDown);
      window.removeEventListener('contextmenu', onWinCtx);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('pet:state', onPetState as EventListener);
      window.removeEventListener('pet:emotion', onPetEmotion as EventListener);
      window.removeEventListener('pet:passthrough-suppress', onPassthroughSuppress as EventListener);
      window.removeEventListener('keydown', onToggleKey);
      if (rafId != null) cancelAnimationFrame(rafId);
      if (hitRaf != null) cancelAnimationFrame(hitRaf);
      if (hitTimer != null) window.clearTimeout(hitTimer);
      if (live2dIdleTimer != null) window.clearTimeout(live2dIdleTimer);
      if (hintTimer) window.clearTimeout(hintTimer);
      offCursor?.();
      // 卸载时一定关掉穿透,避免遗留状态影响其它窗口
      window.petAPI?.setIgnoreMouseEvents(false, false);
      if (expResetTimerRef.current != null) {
        window.clearTimeout(expResetTimerRef.current);
        expResetTimerRef.current = null;
      }
      destroyLive2DModel(modelRef.current, app);
      modelRef.current = null;
      app.destroy(true, { children: true });
      appRef.current = null;
    };
    // 仅 character.id;onContextMenu / onScaleChange 通过 ref 读取避免 effect 重跑
  }, [character.id]);

  useEffect(() => {
    const app = appRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model: any = modelRef.current;
    if (visible) {
      if (model) model.autoUpdate = true;
      app?.start();
      app?.render();
    } else {
      if (model) model.autoUpdate = false;
      app?.stop();
    }
  }, [visible]);

  // 向父组件暴露命令式 API:后续菜单滑块调整大小会调这里
  useImperativeHandle(
    ref,
    () => ({
      setUserScale: (s: number) => {
        if (!appRef.current || !modelRef.current) return;
        // 提交版:真正改窗口尺寸 + 持久化。仅基本上下限保护(0.3 ~ 3)。
        const clamped = Math.max(0.3, Math.min(3, s));
        userScaleRef.current = clamped;
        showHintRef.current?.(`${Math.round(clamped * 100)}%`);
        scaleCbRef.current?.(clamped);
        // 改容器尺寸(inline width/height)→ ResizeObserver 自动触发 fitAndCenterModel(scale=1)
        // 把 model.scale 重置为容器比例,所以预览阶段对 model.scale 的临时改动会被覆盖,符合预期
        setContainerSize({ w: 400 * clamped, h: 600 * clamped });
        saveUserScale(character.id, clamped);
      },
      previewUserScale: (s: number) => {
        // 预览版:不动窗口、不持久化,只直接改 PIXI 内 model.scale 让用户立刻看到大小变化。
        // 用于 slider 拖动期间;松开后由 setUserScale 真正提交并重新 fit。
        if (!appRef.current || !modelRef.current) return;
        const clamped = Math.max(0.3, Math.min(3, s));
        // 关键:窗口尺寸还是旧的(没 commit 之前),如果 model.scale 直接放大到 > 1
        // 模型会超出 stage 被画布裁切。所以预览时把 model.scale 限制在 ≤ 1,
        // 放大方向只看百分比,不真显示放大效果;缩小方向所见即所得。
        const visualScale = Math.min(1, clamped);
        const prev = (userScaleRef.current || 1);
        const visualPrev = Math.min(1, prev);
        const ratio = visualScale / visualPrev;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m: any = modelRef.current;
        if (ratio !== 1) {
          m.scale.x *= ratio;
          m.scale.y *= ratio;
        }
        userScaleRef.current = clamped;
        showHintRef.current?.(`${Math.round(clamped * 100)}%`);
        scaleCbRef.current?.(clamped);
      },
      resetUserScale: () => {
        if (!appRef.current || !modelRef.current) return;
        userScaleRef.current = 1;
        setContainerSize({ w: 400, h: 600 });
        saveUserScale(character.id, 1);
        showHintRef.current?.('100%');
        scaleCbRef.current?.(1);
      },
      getUserScale: () => userScaleRef.current,
      listExpressions: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m: any = modelRef.current;
        const exps: RuntimeExpressionDefinition[] =
          m?.internalModel?.settings?.expressions ?? [];
        return exps.map((e, i) => runtimeExpressionName(e) || `#${i}`);
      },
      listMotions: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m: any = modelRef.current;
        return m?.internalModel?.settings?.motions
          ? Object.keys(m.internalModel.settings.motions)
          : [];
      },
      playExpression: async (name: string | number) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m: any = modelRef.current;
        if (!m) return { ok: false, reason: 'no model' };
        // eslint-disable-next-line no-console
        console.log('[debug] playExpression →', name);
        try {
          const r = await m.expression?.(name);
          // eslint-disable-next-line no-console
          console.log('[debug] expression resolved =', r);
          return { ok: r !== false, value: r };
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[debug] expression rejected:', err);
          return { ok: false, error: String(err) };
        }
      },
      playMotion: async (group: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m: any = modelRef.current;
        if (!m) return { ok: false, reason: 'no model' };
        // eslint-disable-next-line no-console
        console.log('[debug] playMotion →', group);
        // 估算 motion 时长,冻结 focus 到结束 + 200ms 缓冲。
        // motion3.json Meta.Duration 在 motionManager.definitions[group][0]
        let durationMs = 2500;
        try {
          const defs = m?.internalModel?.motionManager?.definitions?.[group];
          // 已加载的 motion 实例上有 _duration / duration 字段;
          // 未加载时只有 settings 数据,fallback 估算
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const motions = m?.internalModel?.motionManager?.motionGroups?.[group] as any[];
          const dur =
            motions?.[0]?._motionData?.duration ??
            motions?.[0]?.getDuration?.() ??
            defs?.[0]?.Duration;
          if (typeof dur === 'number' && dur > 0) durationMs = dur * 1000;
        } catch {
          // ignore
        }
        focusFrozenUntilRef.current = Date.now() + durationMs + 200;
        try {
          const r = await m.motion?.(group, undefined, 3);
          // eslint-disable-next-line no-console
          console.log('[debug] motion resolved =', r, 'freeze focus for', durationMs, 'ms');
          return { ok: r !== false, value: r };
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[debug] motion rejected:', err);
          focusFrozenUntilRef.current = 0; // 失败立刻解冻
          return { ok: false, error: String(err) };
        }
      },
      resetExpression: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m: any = modelRef.current;
        try {
          m?.internalModel?.motionManager?.expressionManager?.resetExpression?.();
        } catch {
          // ignore
        }
      },
    }),
    [character.id],
  );

  // ---- Effect 2:角色变化时,在现有 app 上 swap model ----
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const app = appRef.current;
      if (!app) return;

      // 卸载上个 model
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prev: any = modelRef.current;
      if (prev) {
        if (expResetTimerRef.current != null) {
          window.clearTimeout(expResetTimerRef.current);
          expResetTimerRef.current = null;
        }
        destroyLive2DModel(prev, app);
        modelRef.current = null;
      }
      setLoadedName(null);
      setLoadError(null);

      try {
        userScaleRef.current = loadUserScale(character.id);
        scaleCbRef.current?.(userScaleRef.current);
        // 加载该角色记忆的位置;没有就放屏幕中央偏右下(经典桌宠位置)
        const scaledSize = { w: 400 * userScaleRef.current, h: 600 * userScaleRef.current };
        const savedPos = loadModelPos(character.id, scaledSize);
        const initialPos = savedPos ?? {
          x: Math.floor(window.innerWidth * 0.7),
          y: Math.floor(window.innerHeight * 0.65),
        };
        modelPosRef.current = initialPos;
        setModelPos(initialPos);

        const url = toPetUrl(character.modelPath, 'live2d', roots.live2d);
        // eslint-disable-next-line no-console
        console.log('[CharacterHost] loading live2d', url);
        const loaded = await loadLive2D(url, app.ticker);
        if (cancelled || !appRef.current) {
          destroyLive2DModel(loaded, null);
          return;
        }
        const patchedExpressionCount = patchDiscoveredExpressions(loaded, character);
        if (patchedExpressionCount > 0) {
          // eslint-disable-next-line no-console
          console.log('[CharacterHost] patched discovered expressions:', patchedExpressionCount);
        }
        modelRef.current = loaded;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        appRef.current.stage.addChild(loaded as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (loaded as any).autoUpdate = visibleRef.current;
        if (visibleRef.current) appRef.current.start();
        else appRef.current.stop();

        // ===== MIKU 专属:motion 播完自动复位 motion + expression =====
        // MIKU 的 motion3.json 普遍 Loop=true 且 FadeOutTime=0,且 expression 设了之后会
        // 一直叠加在脸上。给这个模型挂 patch:每次 lm.motion(group) 启动后,根据 motion
        // duration 设个一次性 timeout,到期主动 stopAllMotions + resetExpression,
        // 让模型回到自然站姿。
        // 用 modelPath 判定(包含 "MIKU" 文件夹路径,大小写不敏感)
        const isMiku =
          character.name?.toLowerCase() === 'miku' ||
          character.modelPath?.toLowerCase().includes('/miku/') ||
          character.modelPath?.toLowerCase().includes('\\miku\\');
        if (isMiku) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lm: any = loaded as any;
          if (typeof lm.motion === 'function' && !lm.__mikuAutoReset) {
            const origMotion = lm.motion.bind(lm);
            let autoResetTimer: number | null = null;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            lm.motion = async (...args: any[]) => {
              const r = await origMotion(...args);
              try {
                const group = args[0] as string | undefined;
                const mm = lm.internalModel?.motionManager;
                // 估算 motion 时长 — 优先取实例 _motionData.duration,fallback Definition,再 fallback 2.5s
                let durationMs = 2500;
                const list = mm?.motionGroups?.[group ?? ''] ?? mm?._motionGroups?.[group ?? ''];
                const inst = Array.isArray(list) ? list[0] : null;
                const defs = mm?.definitions?.[group ?? ''];
                const dur =
                  inst?._motionData?.duration ??
                  inst?.getDuration?.() ??
                  defs?.[0]?.Duration;
                if (typeof dur === 'number' && dur > 0) durationMs = dur * 1000;
                if (autoResetTimer != null) window.clearTimeout(autoResetTimer);
                autoResetTimer = window.setTimeout(() => {
                  autoResetTimer = null;
                  // eslint-disable-next-line no-console
                  console.log('[miku-auto-reset] firing for group:', group);
                  // 1) 停掉所有 motion(使其参数停止驱动)
                  try {
                    if (typeof mm?.stopAllMotions === 'function') mm.stopAllMotions();
                    else mm?.queueManager?.stopAllMotions?.();
                  } catch {
                    // ignore
                  }
                  // 2) 卸表情 — 多种 SDK 写法都尝试一遍
                  try {
                    const em = mm?.expressionManager;
                    em?.resetExpression?.();
                    // pixi-live2d-display 暴露的另一个入口
                    if (typeof lm.expression === 'function') {
                      try {
                        lm.expression(null);
                      } catch {
                        // 部分版本不接受 null,忽略
                      }
                    }
                  } catch {
                    // ignore
                  }
                }, durationMs + 300);
              } catch {
                // ignore
              }
              return r;
            };
            lm.__mikuAutoReset = true;
            // eslint-disable-next-line no-console
            console.log('[miku-auto-reset] patch installed');
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyModel = loaded as any;
        // 角色加载完后,以该角色记忆的 user scale 调整容器尺寸(inline width/height);
        // ResizeObserver 会触发 fit
        setContainerSize(scaledSize);
        const hasRenderableBounds = (): boolean => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m: any = modelRef.current;
            if (!m) return false;
            const bs = m.getBounds() as PIXI.Rectangle;
            return (
              Number.isFinite(bs.x) &&
              Number.isFinite(bs.y) &&
              Number.isFinite(bs.width) &&
              Number.isFinite(bs.height) &&
              bs.width > 1 &&
              bs.height > 1
            );
          } catch {
            return false;
          }
        };
        const tryFitU = (): boolean => {
          if (cancelled || !appRef.current || !modelRef.current) return false;
          if (!hasRenderableBounds()) return false;
          fitAndCenterModel(appRef.current, modelRef.current, 1);
          // fit 后报告锚点(腰线 Y)给父组件,聊天气泡用它定位
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const m: any = modelRef.current;
          const bs = m.getBounds() as PIXI.Rectangle;
          if (isFinite(bs.height) && bs.height > 0) {
            const y = Math.round(bs.y + bs.height * 0.6);
            anchorCbRef.current?.(y);
            window.petAPI?.setAnchorY?.(y);
          }
          return true;
        };
        anyModel.once?.('load', tryFitU);
        let tries = 0;
        const retry = () => {
          if (cancelled) return;
          const fitted = tryFitU();
          if (++tries < 60 && !fitted) {
            requestAnimationFrame(retry);
          }
        };
        requestAnimationFrame(retry);

        setLoadedName(character.name);
        loadedCbRef.current?.();
      } catch (e) {
        if (cancelled) return;
        const msg = (e as Error).message ?? String(e);
        // eslint-disable-next-line no-console
        console.error('[CharacterHost] load failed', e);
        setLoadError(msg);
        errorCbRef.current?.(e as Error);
      }
    })();

    return () => {
      cancelled = true;
    };
    // 只在角色 id / 模型路径 / 资源根真正变化时重新加载,
    // 否则父级每次 re-render 传新的 character 对象引用都会触发 model 重载,
    // 导致用户操作(如调整大小、菜单切换)时模型反复 destroy/load → 画面闪烁。
  }, [character.id, character.modelPath, roots.live2d]);

  // 避免 "未使用 loadedName" 警告:仅用于加载状态判断
  void loadedName;

  // ---- Effect 3:桌宠主动行为(时段问候 + 整点报时 + 节假日 + 记忆提醒 + 无操作搭话)
  // 实现拆到 use-proactive-greetings.ts。这里只负责把 character 信息和 hint 显示函数传进去。
  useProactiveGreetings({
    characterId: character.id,
    characterName: character.name,
    showHint: (msg, duration) => showHintRef.current?.(msg, duration),
  });

  // ---- Effect 4:同步 config.lockPosition → lockPositionRef
  // mount 时读一次,之后监听 'petAI:configChanged' 事件(SettingsPanel 改动时 dispatch)实时更新。
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      window.petAPI?.getConfig?.().then((cfg) => {
        if (cancelled) return;
        lockPositionRef.current = !!cfg?.lockPosition;
      });
    };
    sync();
    const onCfgChanged = () => sync();
    window.addEventListener('petAI:configChanged', onCfgChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('petAI:configChanged', onCfgChanged);
    };
  }, []);

  return (
    <div
      className="character-host"
      ref={containerRef}
      style={{
        width: containerSize.w,
        height: containerSize.h,
        // modelPos 是中心点;用 left/top 加 transform: translate(-50%, -50%) 居中。
        // 没初始化前用窗口中央(防一帧空白闪烁)。
        left: modelPos ? modelPos.x : '50%',
        top: modelPos ? modelPos.y : '50%',
        transform: 'translate(-50%, -50%)',
      }}
    >
      {loadError && (
        <div className="overlay err">
          <b>加载失败</b>
          <pre>{loadError}</pre>
        </div>
      )}
      {!loadError && !loadedName && <div className="overlay hint">加载中…</div>}
      {scaleHint && <div className="overlay scale">{scaleHint}</div>}
    </div>
  );
});
