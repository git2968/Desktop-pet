import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { HatchPetBehaviorConfig, HatchPetCharacter } from '../../shared/character';
import {
  DEFAULT_HATCH_PET_BEHAVIOR,
  HATCH_PET_ROWS,
  mergeHatchPetBehaviorConfig,
} from '../../shared/hatch-pet-behavior';
import type { CharacterHostHandle } from './character-host';
import type { Emotion } from '../../shared/emotion-map';

/**
 * Hatch-Pet 渲染器 —— OpenAI Codex 的 hatch-pet skill 桌宠包格式。
 *
 * 资源契约(详见 https://codexpets.org/install):
 *   - 1 张 spritesheet.webp,1536×1872,8 列 × 9 行 = 72 帧,单帧 192×208,未填格透明。
 *   - 9 行固定语义:
 *       0 idle / 1 running-right / 2 running-left / 3 waving / 4 jumping
 *       5 failed / 6 waiting / 7 running / 8 review
 *
 * 对接到本项目 pet 状态:
 *   - `pet:state` (thinking / talking / idle) → 切到 waiting / review / idle 行
 *   - `pet:emotion` (happy / sad / surprised…) → 短暂播放 jumping / failed / waving 行,
 *     播完回到当前长期态(thinking 期间不打断 hint)
 *
 * 渲染策略:用 Canvas 2D drawImage + 透明帧检测推断每行实际帧数,然后 8fps 循环。
 * 组件 API(props/handle)向 CharacterHost 看齐,App.tsx 切换两种角色不用改外层。
 */

const FRAME_W = 192;
const FRAME_H = 208;
const COLS = 8;
const ROWS = 9;
const FPS = DEFAULT_HATCH_PET_BEHAVIOR.fps ?? 8;

/** 行号 → 语义,目前我们只主动切 idle / waiting / review;其余在 emotion 触发或 idle 兜底。 */
const ROW_IDLE = HATCH_PET_ROWS.idle;
const ROW_RUNNING_RIGHT = HATCH_PET_ROWS.runningRight;
const ROW_RUNNING_LEFT = HATCH_PET_ROWS.runningLeft;
const ROW_JUMPING = HATCH_PET_ROWS.jumping;
const ROW_RUNNING = HATCH_PET_ROWS.running;
const ROW_REVIEW = HATCH_PET_ROWS.review;
const DEFAULT_WALK_SPEED = DEFAULT_HATCH_PET_BEHAVIOR.walkSpeed ?? 24;
const DEFAULT_WALK_MS: [number, number] = DEFAULT_HATCH_PET_BEHAVIOR.walkMs ?? [2000, 5000];
const DEFAULT_REST_MS: [number, number] = DEFAULT_HATCH_PET_BEHAVIOR.restMs ?? [8000, 20000];
const DRAG_START_PX = 4;
const LONG_PRESS_MS = 320;

interface Props {
  character: HatchPetCharacter;
  /** 资源根 — 由主进程扫描后下发,渲染端用 character.source 选 builtin / user */
  roots: { live2d: string; sprite: string; hatchPet: string; hatchPetUser: string };
  onLoaded?: () => void;
  onError?: (err: Error) => void;
  onContextMenu?: (e: { clientX: number; clientY: number }) => void;
  onScaleChange?: (scale: number) => void;
  onAnchorY?: (y: number) => void;
  visible?: boolean;
}

const SCALE_KEY_PREFIX = 'pet:scale:';
const POS_KEY_PREFIX = 'pet:position:';
const MODEL_POS_SAFE_MARGIN = 100;

function loadUserScale(id: string): number {
  try {
    const v = localStorage.getItem(SCALE_KEY_PREFIX + id);
    if (!v) return 1;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? Math.max(0.3, Math.min(3, n)) : 1;
  } catch {
    return 1;
  }
}
function saveUserScale(id: string, s: number): void {
  try {
    localStorage.setItem(SCALE_KEY_PREFIX + id, s.toFixed(3));
  } catch {
    /* ignore */
  }
}

/** 模型在窗口内的中心点位置(CSS 像素)。每个角色独立持久化,跟 character-host 共享 key 前缀。 */
function scaledFrameSize(scale: number): { w: number; h: number } {
  return { w: FRAME_W * scale, h: FRAME_H * scale };
}

function clampModelPos(
  pos: { x: number; y: number },
  size: { w: number; h: number } = { w: MODEL_POS_SAFE_MARGIN * 2, h: MODEL_POS_SAFE_MARGIN * 2 },
): { x: number; y: number } {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const halfW = Math.max(1, size.w / 2);
  const halfH = Math.max(1, size.h / 2);
  const mx = Math.min(MODEL_POS_SAFE_MARGIN, halfW, Math.max(0, w / 2));
  const my = Math.min(MODEL_POS_SAFE_MARGIN, halfH, Math.max(0, h / 2));
  return {
    x: Math.max(mx, Math.min(Math.max(mx, w - mx), pos.x)),
    y: Math.max(my, Math.min(Math.max(my, h - my), pos.y)),
  };
}
function loadModelPos(id: string, scale: number): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY_PREFIX + id);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (
      typeof obj?.x === 'number' &&
      Number.isFinite(obj.x) &&
      typeof obj?.y === 'number' &&
      Number.isFinite(obj.y)
    ) {
      return clampModelPos(obj, scaledFrameSize(scale));
    }
    return null;
  } catch {
    return null;
  }
}
function saveModelPos(id: string, pos: { x: number; y: number }): void {
  try {
    localStorage.setItem(POS_KEY_PREFIX + id, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

function clampAtlasRow(row: unknown, fallback: number): number {
  const n = typeof row === 'number' ? row : Number(row);
  if (!Number.isInteger(n) || n < 0 || n >= ROWS) return fallback;
  return n;
}

function clampPositiveNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampMsRange(range: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(range) || range.length < 2) return fallback;
  const a = clampPositiveNumber(range[0], fallback[0], 300, 60000);
  const b = clampPositiveNumber(range[1], fallback[1], 300, 60000);
  return a <= b ? [a, b] : [b, a];
}

function pickIdleRow(config: HatchPetBehaviorConfig | undefined): number {
  const rows = (config?.idleRows ?? [])
    .map((row) => clampAtlasRow(row, -1))
    .filter((row) => row >= 0);
  if (rows.length === 0) return ROW_IDLE;
  return rows[Math.floor(Math.random() * rows.length)] ?? ROW_IDLE;
}

function emotionRow(config: HatchPetBehaviorConfig | undefined, emotion: Emotion): number {
  const fallback = DEFAULT_HATCH_PET_BEHAVIOR.emotionRows?.[emotion] ?? ROW_IDLE;
  return clampAtlasRow(config?.emotionRows?.[emotion], fallback);
}

function normalizeAliasRows(value: unknown, fallback: number): number[] {
  const values = Array.isArray(value) ? value : [value];
  const rows = values
    .map((row) => clampAtlasRow(row, -1))
    .filter((row) => row >= 0);
  return rows.length > 0 ? rows : [fallback];
}

function pickMotionRow(rows: number[] | undefined): number | null {
  if (!rows || rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)] ?? null;
}

function buildMotionAliasMap(config: HatchPetBehaviorConfig | undefined): Record<string, number[]> {
  const raw = {
    ...(DEFAULT_HATCH_PET_BEHAVIOR.aliases ?? {}),
    ...(config?.aliases ?? {}),
  };
  const map: Record<string, number[]> = {};
  for (const [name, row] of Object.entries(raw)) {
    const key = name.trim();
    if (!key) continue;
    map[key] = normalizeAliasRows(row, map[key]?.[0] ?? ROW_IDLE);
  }
  return map;
}

function shouldClearGuidePixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 8) return true;
  const saturated = Math.max(r, g, b) - Math.min(r, g, b) > 70;
  if (!saturated) return false;
  return (
    (r < 95 && g > 110 && b > 110) ||
    (g < 95 && r > 120 && b > 110) ||
    (r < 95 && g < 110 && b > 120) ||
    (r < 95 && g > 120 && b < 110)
  );
}

function drawPetFrame(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  col: number,
  row: number,
): void {
  ctx.clearRect(0, 0, FRAME_W, FRAME_H);
  ctx.drawImage(
    img,
    col * FRAME_W,
    row * FRAME_H,
    FRAME_W,
    FRAME_H,
    0,
    0,
    FRAME_W,
    FRAME_H,
  );

  try {
    const imageData = ctx.getImageData(0, 0, FRAME_W, FRAME_H);
    const { data } = imageData;
    let changed = false;
    for (let i = 0; i < data.length; i += 4) {
      if (shouldClearGuidePixel(data[i], data[i + 1], data[i + 2], data[i + 3])) {
        data[i + 3] = 0;
        changed = true;
      }
    }
    if (changed) ctx.putImageData(imageData, 0, 0);
  } catch {
    // If the canvas ever becomes unreadable, keep drawing the original frame.
  }
}

/** 把 spritesheetPath 绝对路径换成 pet:// URL,让 protocol handler 走文件系统。
 *  根据 character.source 选 host:builtin → pet://hatch-pet/,user → pet://hatch-pet-user/。 */
function toPetUrl(
  absSheet: string,
  source: 'builtin' | 'user',
  builtinRoot: string,
  userRoot: string,
): string {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const root = norm(source === 'builtin' ? builtinRoot : userRoot).replace(/\/+$/, '');
  const abs = norm(absSheet);
  let rel = abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs;
  // 编码每段路径,保留斜杠
  rel = rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const host = source === 'builtin' ? 'hatch-pet' : 'hatch-pet-user';
  return `pet://${host}/${rel}`;
}

/** 给一张 sprite sheet 算出每行实际有效帧数(从右往左找第一个非全透明列)。
 *  hatch-pet 未填格是透明 RGBA(0,0,0,0),用一个 offscreen canvas 取像素判定。 */
function computeRowFrameCounts(img: HTMLImageElement): number[] {
  const off = document.createElement('canvas');
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  if (!ctx) return new Array<number>(ROWS).fill(COLS);
  ctx.drawImage(img, 0, 0);
  const counts: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    let lastNonEmpty = -1;
    for (let c = 0; c < COLS; c++) {
      // 取该单元格中心 8x8 区域采样,任一 alpha>0 即非空
      const x = c * FRAME_W + FRAME_W / 2 - 4;
      const y = r * FRAME_H + FRAME_H / 2 - 4;
      try {
        const data = ctx.getImageData(x, y, 8, 8).data;
        let any = false;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 0) {
            any = true;
            break;
          }
        }
        if (any) lastNonEmpty = c;
      } catch {
        // tainted canvas (CORS) 时退回保守值
        lastNonEmpty = COLS - 1;
      }
    }
    counts.push(lastNonEmpty + 1 || 1); // 至少 1 帧避免除 0
  }
  return counts;
}

export const HatchPetHost = forwardRef<CharacterHostHandle, Props>(function HatchPetHost(
  { character, roots, onLoaded, onError, onContextMenu, onScaleChange, onAnchorY, visible = true },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rowCountsRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef(0);
  const frameIndexRef = useRef(0);
  const lastDrawKeyRef = useRef('');
  const visibleRef = useRef(visible);
  const behaviorConfigRef = useRef<HatchPetBehaviorConfig>(
    mergeHatchPetBehaviorConfig(character.behavior),
  );
  const draggingRef = useRef(false);
  const dragMovingRef = useRef(false);
  const holdJumpRef = useRef(false);
  const dragDirRef = useRef<1 | -1>(1);

  // ---- 行为状态机 ----
  // 系统态(由外部 pet:state 注入):idle 时跑桌宠行为(walk/rest);
  //   thinking/talking 期间冻结位置 + 用 row 6 / 8(站定播 waiting/review 动画)。
  type SystemState = 'idle' | 'thinking' | 'talking';
  type Behavior = 'walk' | 'rest';
  const systemRef = useRef<SystemState>('idle');
  const behaviorRef = useRef<Behavior>('walk');
  const dirRef = useRef<1 | -1>(1); // 1=右,-1=左
  const restRowRef = useRef<number>(ROW_IDLE);
  // 下一次 walk↔rest 切换时间戳(performance.now ms)
  const behaviorUntilRef = useRef<number>(0);
  // emotion 临时打断 row(jumping/failed/waving),结束后回到行为/系统态
  const emotionRowRef = useRef<number | null>(null);
  const emotionUntilRef = useRef(0);

  const [scale, setScale] = useState<number>(() => loadUserScale(character.id));
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 位置完全用 ref + 直接 DOM 写,不进 React state(避免每帧 re-render)。
  // 初始位置:loadModelPos 优先,没存过就放窗口中心偏下。
  const posRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  if (posRef.current.x === 0 && posRef.current.y === 0) {
    posRef.current = loadModelPos(character.id, scale) ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 + 50,
    };
  }

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    behaviorConfigRef.current = mergeHatchPetBehaviorConfig(character.behavior);
  }, [character.behavior]);

  // 角色切换时:读新角色的持久化位置 + 同步 DOM
  useEffect(() => {
    posRef.current = loadModelPos(character.id, scale) ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 + 50,
    };
    const el = containerRef.current;
    if (el) {
      el.style.left = `${posRef.current.x}px`;
      el.style.top = `${posRef.current.y}px`;
    }
  }, [character.id]);

  // ---- 拖窗 + 像素穿透 hit-test ----
  // hatch-pet 不挂在 character-host 那套 PIXI 上,需要自己实现:
  //  - 全局 mousemove → 用 canvas 2D ctx.getImageData 取目标像素 alpha,>16 判定 onPixel
  //  - 在模型不透明像素上 / 在 UI 上 → 不穿透;否则穿透
  //  - 容器 mousedown → 拖窗:累加 dx/dy,rAF flush 改 posRef + 持久化
  // 卸载时关穿透,避免遗留状态影响别的角色。
  const characterIdRef = useRef(character.id);
  useEffect(() => {
    characterIdRef.current = character.id;
  }, [character.id]);

  /** 直接把 posRef 同步到容器 DOM(left/top),避免 React re-render */
  const applyPosToDom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.style.left = `${posRef.current.x}px`;
    el.style.top = `${posRef.current.y}px`;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const hitCtx = canvas.getContext('2d', { willReadFrequently: true });
    if (!hitCtx) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pendingDx = 0;
    let pendingDy = 0;
    let rafId: number | null = null;
    let hasMoved = false;
    let downStartX = 0;
    let downStartY = 0;
    let longPressTimer: number | null = null;
    const insideRef = { current: true };

    const clearLongPressTimer = () => {
      if (longPressTimer == null) return;
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    };

    const resetDragGesture = () => {
      draggingRef.current = false;
      dragMovingRef.current = false;
      holdJumpRef.current = false;
      clearLongPressTimer();
    };

    const flushDrag = () => {
      rafId = null;
      if (pendingDx === 0 && pendingDy === 0) return;
      const dx = pendingDx;
      const dy = pendingDy;
      pendingDx = 0;
      pendingDy = 0;
      const cur = posRef.current;
      posRef.current = clampModelPos({ x: cur.x + dx, y: cur.y + dy }, scaledFrameSize(scale));
      applyPosToDom();
      saveModelPos(characterIdRef.current, posRef.current);
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      draggingRef.current = true;
      dragMovingRef.current = false;
      holdJumpRef.current = false;
      lastX = e.screenX;
      lastY = e.screenY;
      downStartX = e.screenX;
      downStartY = e.screenY;
      hasMoved = false;
      clearLongPressTimer();
      longPressTimer = window.setTimeout(() => {
        if (!dragging || hasMoved) return;
        holdJumpRef.current = true;
        frameIndexRef.current = 0;
      }, LONG_PRESS_MS);
    };

    // 全局 mousemove:拖动期间累加位移;非拖动期间做 hit-test
    let hitRaf: number | null = null;
    let pendingHitX = 0;
    let pendingHitY = 0;
    const runHitTest = () => {
      hitRaf = null;
      if (dragging) return;
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
        const rect = canvas.getBoundingClientRect();
        const localX = cx - rect.left;
        const localY = cy - rect.top;
        if (localX >= 0 && localX < rect.width && localY >= 0 && localY < rect.height) {
          // 容器是缩放后的尺寸,canvas backing 是 FRAME_W×FRAME_H;按比例换算
          const px = Math.floor((localX / rect.width) * canvas.width);
          const py = Math.floor((localY / rect.height) * canvas.height);
          try {
            const data = hitCtx.getImageData(px, py, 1, 1).data;
            onPixel = data[3] > 16;
          } catch {
            onPixel = false;
          }
        }
      }

      const inside = overUi || onPixel;
      if (inside !== insideRef.current) {
        insideRef.current = inside;
        window.petAPI?.setIgnoreMouseEvents(!inside, true);
      }
    };

    const onMove = (e: MouseEvent) => {
      if (!dragging) {
        pendingHitX = e.clientX;
        pendingHitY = e.clientY;
        if (hitRaf == null) hitRaf = requestAnimationFrame(runHitTest);
        return;
      }
      const totalDx = e.screenX - downStartX;
      const totalDy = e.screenY - downStartY;
      if (!hasMoved && Math.hypot(totalDx, totalDy) >= DRAG_START_PX) {
        hasMoved = true;
        dragMovingRef.current = true;
        holdJumpRef.current = false;
        clearLongPressTimer();
        frameIndexRef.current = 0;
      }
      if (!hasMoved) return;

      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      if (dx > 0) dragDirRef.current = 1;
      else if (dx < 0) dragDirRef.current = -1;
      dirRef.current = dragDirRef.current;
      pendingDx += dx;
      pendingDy += dy;
      lastX = e.screenX;
      lastY = e.screenY;
      if (rafId == null) rafId = requestAnimationFrame(flushDrag);
    };
    const onUp = () => {
      dragging = false;
      resetDragGesture();
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        flushDrag();
      }
    };

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    // 启动:默认不穿透。下一次 mousemove 会按 hit-test 调整。
    window.petAPI?.setIgnoreMouseEvents(false, false);

    return () => {
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (rafId != null) cancelAnimationFrame(rafId);
      if (hitRaf != null) cancelAnimationFrame(hitRaf);
      resetDragGesture();
      // 卸载时一定关穿透,避免影响其它角色
      window.petAPI?.setIgnoreMouseEvents(false, false);
    };
  }, [loaded, scale]); // 等 spritesheet 加载完才有像素可读

  // 加载 spritesheet — character 切换 / 路径变更时重新加载
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    const url = toPetUrl(
      character.spritesheetPath,
      character.source,
      roots.hatchPet,
      roots.hatchPetUser,
    );
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      rowCountsRef.current = computeRowFrameCounts(img);
      lastDrawKeyRef.current = '';
      setLoaded(true);
      onLoaded?.();
    };
    img.onerror = () => {
      if (cancelled) return;
      const msg = `加载 hatch-pet spritesheet 失败:${url}`;
      setError(msg);
      onError?.(new Error(msg));
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [
    character.id,
    character.spritesheetPath,
    character.source,
    roots.hatchPet,
    roots.hatchPetUser,
    onLoaded,
    onError,
  ]);

  // 监听 pet:state / pet:emotion — 写 systemRef + 临时 emotion row
  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { kind?: 'idle' | 'thinking' | 'talking' }
        | undefined;
      if (!detail) return;
      systemRef.current = detail.kind ?? 'idle';
      // 切系统态时让 frame 从 0 重播(否则会从 walk row 的中间帧接到 waiting)
      frameIndexRef.current = 0;
    };
    const onEmotion = (e: Event) => {
      const detail = (e as CustomEvent).detail as { emotion?: Emotion } | undefined;
      const emo = detail?.emotion;
      if (!emo) return;
      // hatch-pet 角色优先读 pet.json behavior.emotionRows,没有配置才走默认 atlas 语义。
      emotionRowRef.current = emotionRow(behaviorConfigRef.current, emo);
      emotionUntilRef.current = performance.now() + 1500;
      frameIndexRef.current = 0;
    };
    window.addEventListener('pet:state', onState as EventListener);
    window.addEventListener('pet:emotion', onEmotion as EventListener);
    return () => {
      window.removeEventListener('pet:state', onState as EventListener);
      window.removeEventListener('pet:emotion', onEmotion as EventListener);
    };
  }, []);

  // 渲染循环 + 行为状态机
  // 设计:
  //   层级优先(高 → 低): emotion 临时(1.5s) > system(thinking/talking) > behavior(walk/rest)
  //   走路速度 24 px/s,撞屏幕边距 80px 翻方向。
  //   每 5~10s 在 walk ↔ rest 之间随机切换;rest 期间停在原地播 idle 行 1.5~3s。
  //   切到 walk 时随机选个方向(50/50),让桌宠不会一直一个方向。
  useEffect(() => {
    if (!loaded) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const EDGE_MARGIN = 80;
    const randInRange = (a: number, b: number) => a + Math.random() * (b - a);
    const planNextBehavior = (now: number) => {
      const config = behaviorConfigRef.current;
      if (behaviorRef.current === 'walk') {
        const [a, b] = clampMsRange(config?.walkMs, DEFAULT_WALK_MS);
        behaviorUntilRef.current = now + randInRange(a, b);
      } else {
        restRowRef.current = pickIdleRow(config);
        const [a, b] = clampMsRange(config?.restMs, DEFAULT_REST_MS);
        behaviorUntilRef.current = now + randInRange(a, b);
      }
    };
    // 常态保持 idle。只有外部 motion / 情绪 / 鼠标交互才切到其它行。
    behaviorRef.current = 'rest';
    restRowRef.current = ROW_IDLE;
    dirRef.current = Math.random() < 0.5 ? -1 : 1;
    dragDirRef.current = dirRef.current;
    behaviorUntilRef.current = Number.POSITIVE_INFINITY;

    let lastTickTime = performance.now();
    const tick = (now: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (!visibleRef.current) {
        lastTickTime = now;
        return;
      }
      const dt = Math.min(100, now - lastTickTime); // 最大 100ms 防止 tab 切回时大跳
      lastTickTime = now;
      const config = behaviorConfigRef.current;

      // emotion 临时到期 → 清掉
      if (emotionRowRef.current != null && now >= emotionUntilRef.current) {
        emotionRowRef.current = null;
        frameIndexRef.current = 0;
      }

      // 行为切换计时(只在系统态 idle 时推进)
      if (systemRef.current === 'idle' && now >= behaviorUntilRef.current) {
        behaviorRef.current = behaviorRef.current === 'walk' ? 'rest' : 'walk';
        if (behaviorRef.current === 'walk') {
          // 切走时随机重选方向
          dirRef.current = Math.random() < 0.5 ? -1 : 1;
        }
        frameIndexRef.current = 0;
        planNextBehavior(now);
      }

      // 决定当前应该播哪一行
      let row: number;
      if (draggingRef.current && dragMovingRef.current) {
        row =
          dragDirRef.current === 1
            ? clampAtlasRow(config?.walkRightRow, ROW_RUNNING_RIGHT)
            : clampAtlasRow(config?.walkLeftRow, ROW_RUNNING_LEFT);
      } else if (draggingRef.current && holdJumpRef.current) {
        row = clampAtlasRow(config?.draggingRow, ROW_JUMPING);
      } else if (emotionRowRef.current != null) {
        row = emotionRowRef.current;
      } else if (systemRef.current === 'thinking') {
        row = clampAtlasRow(config?.thinkingRow, ROW_RUNNING);
      } else if (systemRef.current === 'talking') {
        row = clampAtlasRow(config?.talkingRow, ROW_REVIEW);
      } else if (behaviorRef.current === 'walk') {
        row =
          dirRef.current === 1
            ? clampAtlasRow(config?.walkRightRow, ROW_RUNNING_RIGHT)
            : clampAtlasRow(config?.walkLeftRow, ROW_RUNNING_LEFT);
      } else {
        row = restRowRef.current;
      }

      // 移动位置(只在系统态 idle + behavior=walk + emotion 不在打断时)
      if (
        systemRef.current === 'idle' &&
        behaviorRef.current === 'walk' &&
        emotionRowRef.current == null &&
        !draggingRef.current
      ) {
        const walkSpeed = clampPositiveNumber(
          config?.walkSpeed,
          DEFAULT_WALK_SPEED,
          0,
          240,
        );
        const dx = (dirRef.current * walkSpeed * dt) / 1000;
        const cur = posRef.current;
        let nx = cur.x + dx;
        // 容器中心点 ± 模型半宽 是模型可视边界;这里简化用 EDGE_MARGIN 做缓冲
        if (nx < EDGE_MARGIN) {
          nx = EDGE_MARGIN;
          dirRef.current = 1;
        } else if (nx > window.innerWidth - EDGE_MARGIN) {
          nx = window.innerWidth - EDGE_MARGIN;
          dirRef.current = -1;
        }
        if (nx !== cur.x) {
          posRef.current = { x: nx, y: cur.y };
          applyPosToDom();
        }
      }

      // frame 切换
      const elapsed = now - lastFrameTimeRef.current;
      const fps = Math.round(clampPositiveNumber(config?.fps, FPS, 1, 24));
      const frameDuration = 1000 / fps;
      if (elapsed >= frameDuration) {
        lastFrameTimeRef.current = now;
        const cols = rowCountsRef.current[row] ?? COLS;
        frameIndexRef.current = (frameIndexRef.current + 1) % cols;
      }

      // draw
      const img = imgRef.current;
      if (!img) return;
      const cols = rowCountsRef.current[row] ?? COLS;
      const col = frameIndexRef.current % cols;
      frameIndexRef.current = col;
      const drawKey = `${row}:${col}`;
      if (drawKey !== lastDrawKeyRef.current) {
        lastDrawKeyRef.current = drawKey;
        drawPetFrame(ctx, img, col, row);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [loaded]);

  // 上报 anchorY(腰线 ≈ canvas 顶 + 高度的 60% 处)— 给 chat-bubble 用
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const report = () => {
      const rect = el.getBoundingClientRect();
      onAnchorY?.(rect.top + rect.height * 0.6);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [onAnchorY, scale]);

  useEffect(() => {
    onScaleChange?.(scale);
  }, [scale, onScaleChange]);

  // CharacterHostHandle 兼容实现 — hatch-pet 没有 expression / motion 概念,
  // playExpression / playMotion 给 noop,debug-panel 不会崩。
  useImperativeHandle(
    ref,
    () => ({
      setUserScale: (s: number) => {
        const clamped = Math.max(0.3, Math.min(3, s));
        setScale(clamped);
        saveUserScale(character.id, clamped);
      },
      previewUserScale: (s: number) => {
        const clamped = Math.max(0.3, Math.min(3, s));
        setScale(clamped);
      },
      resetUserScale: () => {
        setScale(1);
        saveUserScale(character.id, 1);
      },
      getUserScale: () => scale,
      listExpressions: () => [],
      listMotions: () => Object.keys(buildMotionAliasMap(behaviorConfigRef.current)),
      playExpression: async () => null,
      playMotion: async (group: string) => {
        // 调试/AI 指令:用动作名字直接切 row,2s 后自动回到当前行为态。
        const map = buildMotionAliasMap(behaviorConfigRef.current);
        const row = pickMotionRow(map[group]);
        if (row != null) {
          emotionRowRef.current = clampAtlasRow(row, ROW_IDLE);
          emotionUntilRef.current = performance.now() + 2000;
          frameIndexRef.current = 0;
        }
        return null;
      },
      resetExpression: () => undefined,
    }),
    [character.id, scale],
  );

  const styleW = Math.round(FRAME_W * scale);
  const styleH = Math.round(FRAME_H * scale);

  return (
    <div
      ref={containerRef}
      className="character-host hatch-pet-host"
      style={{
        // 容器中心点跟随 posRef:left/top 由 rAF 循环 / 拖窗 / 角色切换 直接改 DOM,
        // 不进 React state 避免每帧 re-render。这里只设置初始值。
        position: 'absolute',
        left: posRef.current.x,
        top: posRef.current.y,
        transform: 'translate(-50%, -50%)',
        width: styleW,
        height: styleH,
        display: visible ? undefined : 'none',
        cursor: 'grab',
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.({ clientX: e.clientX, clientY: e.clientY });
      }}
    >
      <canvas
        ref={canvasRef}
        width={FRAME_W}
        height={FRAME_H}
        style={{
          width: styleW,
          height: styleH,
          imageRendering: 'pixelated', // hatch-pet 是像素风,放大用最近邻
        }}
      />
      {error && <div className="overlay err">{error}</div>}
      {!loaded && !error && <div className="overlay hint">加载中…</div>}
    </div>
  );
});

// 故意不用 React.memo:character 切换时 props.character 变,我们已经在 useEffect 里
// 按 character.id / character.spritesheetPath 重新加载,父级 key={active.id} 也会
// 触发 remount,语义清晰不容易出错。
