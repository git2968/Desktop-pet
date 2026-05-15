import type { HatchPetBehaviorConfig } from './character';

export const HATCH_PET_ROWS = {
  idle: 0,
  runningRight: 1,
  runningLeft: 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
} as const;

/**
 * Codex hatch-pet atlas 的全局默认行为。
 * 新增模型只需要提供 pet.json + spritesheet.webp;需要特殊动作时再在 pet.json.behavior 里覆盖。
 */
export const DEFAULT_HATCH_PET_BEHAVIOR: HatchPetBehaviorConfig = {
  idleRows: [HATCH_PET_ROWS.idle],
  walkRightRow: HATCH_PET_ROWS.runningRight,
  walkLeftRow: HATCH_PET_ROWS.runningLeft,
  thinkingRow: HATCH_PET_ROWS.running,
  talkingRow: HATCH_PET_ROWS.review,
  draggingRow: HATCH_PET_ROWS.jumping,
  emotionRows: {
    happy: HATCH_PET_ROWS.waving,
    sad: HATCH_PET_ROWS.failed,
    angry: HATCH_PET_ROWS.failed,
    surprised: HATCH_PET_ROWS.waving,
  },
  aliases: {
    idle: HATCH_PET_ROWS.idle,
    rest: HATCH_PET_ROWS.idle,
    'running-right': HATCH_PET_ROWS.runningRight,
    'running-r': HATCH_PET_ROWS.runningRight,
    walkRight: HATCH_PET_ROWS.runningRight,
    walk: [HATCH_PET_ROWS.runningRight, HATCH_PET_ROWS.runningLeft],
    'running-left': HATCH_PET_ROWS.runningLeft,
    'running-l': HATCH_PET_ROWS.runningLeft,
    walkLeft: HATCH_PET_ROWS.runningLeft,
    waving: HATCH_PET_ROWS.waving,
    wave: HATCH_PET_ROWS.waving,
    jumping: HATCH_PET_ROWS.jumping,
    jump: HATCH_PET_ROWS.jumping,
    dragged: HATCH_PET_ROWS.jumping,
    dragging: HATCH_PET_ROWS.jumping,
    happy: [HATCH_PET_ROWS.waving, HATCH_PET_ROWS.jumping],
    failed: HATCH_PET_ROWS.failed,
    fail: HATCH_PET_ROWS.failed,
    sad: HATCH_PET_ROWS.failed,
    angry: HATCH_PET_ROWS.failed,
    waiting: HATCH_PET_ROWS.waiting,
    wait: HATCH_PET_ROWS.waiting,
    bored: HATCH_PET_ROWS.waiting,
    yawn: HATCH_PET_ROWS.waiting,
    yawning: HATCH_PET_ROWS.waiting,
    running: HATCH_PET_ROWS.running,
    working: HATCH_PET_ROWS.running,
    thinking: HATCH_PET_ROWS.running,
    game: HATCH_PET_ROWS.running,
    gaming: HATCH_PET_ROWS.running,
    review: HATCH_PET_ROWS.review,
    talking: HATCH_PET_ROWS.review,
    snack: HATCH_PET_ROWS.review,
    eating: HATCH_PET_ROWS.review,
    '待机': HATCH_PET_ROWS.idle,
    '走路': [HATCH_PET_ROWS.runningRight, HATCH_PET_ROWS.runningLeft],
    '向右走': HATCH_PET_ROWS.runningRight,
    '向左走': HATCH_PET_ROWS.runningLeft,
    '挥手': HATCH_PET_ROWS.waving,
    '开心': [HATCH_PET_ROWS.waving, HATCH_PET_ROWS.jumping],
    '跳跃': HATCH_PET_ROWS.jumping,
    '抓起来': HATCH_PET_ROWS.jumping,
    '伤心': HATCH_PET_ROWS.failed,
    '生气': HATCH_PET_ROWS.failed,
    '失败': HATCH_PET_ROWS.failed,
    '无聊': HATCH_PET_ROWS.waiting,
    '等待': HATCH_PET_ROWS.waiting,
    '打哈欠': HATCH_PET_ROWS.waiting,
    '思考': HATCH_PET_ROWS.running,
    '工作中': HATCH_PET_ROWS.running,
    '打游戏': HATCH_PET_ROWS.running,
    '回答': HATCH_PET_ROWS.review,
    '复盘': HATCH_PET_ROWS.review,
    '吃零食': HATCH_PET_ROWS.review,
  },
  fps: 8,
  walkSpeed: 24,
  walkMs: [2000, 5000],
  restMs: [8000, 20000],
};

export function mergeHatchPetBehaviorConfig(
  override?: HatchPetBehaviorConfig,
): HatchPetBehaviorConfig {
  return {
    ...DEFAULT_HATCH_PET_BEHAVIOR,
    ...override,
    idleRows: override?.idleRows
      ? [...override.idleRows]
      : [...(DEFAULT_HATCH_PET_BEHAVIOR.idleRows ?? [HATCH_PET_ROWS.idle])],
    emotionRows: {
      ...(DEFAULT_HATCH_PET_BEHAVIOR.emotionRows ?? {}),
      ...(override?.emotionRows ?? {}),
    },
    aliases: {
      ...(DEFAULT_HATCH_PET_BEHAVIOR.aliases ?? {}),
      ...(override?.aliases ?? {}),
    },
    walkMs: override?.walkMs
      ? [...override.walkMs]
      : ([...(DEFAULT_HATCH_PET_BEHAVIOR.walkMs ?? [2000, 5000])] as [number, number]),
    restMs: override?.restMs
      ? [...override.restMs]
      : ([...(DEFAULT_HATCH_PET_BEHAVIOR.restMs ?? [8000, 20000])] as [number, number]),
  };
}
