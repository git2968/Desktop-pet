import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import type {
  CharacterIndex,
  HatchPetBehaviorConfig,
  HatchPetCharacter,
  Live2DCharacter,
  SpriteCharacter,
  SpriteLoopRule,
  SpriteState,
  SpriteStateOrComposite,
} from '../shared/character.js';
import { mergeHatchPetBehaviorConfig } from '../shared/hatch-pet-behavior.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 解析资产根路径:
 *  - 开发态:  app/live2d  (Live2D 模型);sprite 已废弃,保留字段兼容。
 *  - 生产态:  process.resourcesPath/live2d  (打包时由 extraResources 写入)
 *
 * 后续支持「用户导入模型」时,会再合并 app.getPath('userData')/live2d 作为可写目录。
 */
export function resolveAssetRoots(): {
  live2d: string;
  sprite: string;
  /** Hatch-Pet 内置根:dev=app/hatch-pet,prod=resourcesPath/hatch-pet。只读,extraResources 打包。 */
  hatchPet: string;
  /** Hatch-Pet 用户根:userData/hatch-pet。可写,设置面板「导入」会把新角色落到这里。 */
  hatchPetUser: string;
  voskBuiltin: string;
} {
  // 用户根总在 userData/hatch-pet,dev/prod 共享 — 用户在 dev 态导入的角色,
  // 切到打包版仍能用(只要打包版连着同一个 userData)。
  const userHatchPet = path.join(app.getPath('userData'), 'hatch-pet');

  const isDev = !!process.env.VITE_DEV_SERVER_URL;
  if (isDev) {
    // dist-electron/main.js 位于 app/dist-electron 下;app 根 = ..
    const appRoot = path.resolve(__dirname, '..');
    return {
      live2d: path.join(appRoot, 'live2d'),
      sprite: path.join(appRoot, 'live2d'), // 占位,sprite 未启用
      // hatch-pet 内置根:子目录 = 一只桌宠(含 pet.json + spritesheet.webp)。
      // 用户手动从外部 `自制/` 复制进来,扫描器读到就自动出现在角色菜单。
      hatchPet: path.join(appRoot, 'hatch-pet'),
      hatchPetUser: userHatchPet,
      voskBuiltin: path.join(appRoot, 'VOSK'), // 内置 vosk 小模型目录(zip 放这里)
    };
  }
  return {
    live2d: path.join(process.resourcesPath, 'live2d'),
    sprite: path.join(process.resourcesPath, 'live2d'),
    hatchPet: path.join(process.resourcesPath, 'hatch-pet'),
    hatchPetUser: userHatchPet,
    voskBuiltin: path.join(process.resourcesPath, 'VOSK'),
  };
}

// ------------------------- Live2D -------------------------

/**
 * 忽略名单(按 baseName 或上层文件夹名匹配)。
 * 这些模型设计上不完整(如「黑灰日常」是裸服装,无头部图层),不进入角色清单。
 */
const LIVE2D_IGNORE_NAMES = new Set<string>(['黑灰日常', 'K571']);

export async function scanLive2D(root: string, errors: string[]): Promise<Live2DCharacter[]> {
  const out: Live2DCharacter[] = [];
  if (!(await exists(root))) {
    errors.push(`live2D 根目录不存在:${root}`);
    return out;
  }

  await walk(root, async (file) => {
    if (!file.endsWith('.model3.json')) return;
    try {
      const text = await fs.readFile(file, 'utf-8');
      const json = JSON.parse(text) as Live2DModel3JSON;
      const ref = json.FileReferences ?? {};
      const expressionRefs = (ref.Expressions ?? [])
        .map((e) => ({
          name: e.Name?.trim() ?? '',
          file: (e.File ?? '').replace(/\\/g, '/'),
        }))
        .filter((e) => e.name);
      const expressions = expressionRefs.map((e) => e.name);
      const motionsObj = ref.Motions ?? {};
      const motions = Object.entries(motionsObj).map(([group, list]) => ({
        group,
        count: Array.isArray(list) ? list.length : 0,
      }));
      const hitAreas = (json.HitAreas ?? [])
        .filter((h): h is { Name: string; Id: string } => !!h.Name && !!h.Id)
        .map((h) => ({ name: h.Name, id: h.Id }));

      const baseName = path.basename(file, '.model3.json');
      const folderName = path.basename(path.dirname(file));
      const modelDir = path.dirname(file);
      const relModelDir = path.relative(root, modelDir);
      const category = relModelDir.split(path.sep).filter(Boolean)[0] || '未分类';

      // 检查忽略名单(baseName / folderName / 上上层文件夹任一匹配即跳过)
      const grandFolder = path.basename(path.dirname(path.dirname(file)));
      if (
        LIVE2D_IGNORE_NAMES.has(baseName) ||
        LIVE2D_IGNORE_NAMES.has(folderName) ||
        LIVE2D_IGNORE_NAMES.has(grandFolder)
      ) {
        return;
      }

      // 兜底:有些模型 model3.json 不引用同目录里实际存在的 *.exp3.json / *.motion3.json,
      // 这里递归扫一下补全显示数据。
      const siblingFiles = await listFilesRecursive(modelDir);
      const siblingExp = siblingFiles
        .filter((p) => p.toLowerCase().endsWith('.exp3.json'))
        .map((p) => ({
          name: path.basename(p).replace(/\.exp3\.json$/i, ''),
          file: path.relative(modelDir, p).replace(/\\/g, '/'),
        }))
        .filter((e) => e.name && e.file);
      const siblingMotions = groupMotionFiles(
        siblingFiles.filter((p) => p.endsWith('.motion3.json')),
      );

      const finalExpressions = Array.from(new Set([...expressions, ...siblingExp.map((e) => e.name)]));
      const finalMotions = mergeMotionGroups(motions, siblingMotions);

      out.push({
        id: makeId(file, root),
        name: baseName || folderName,
        category,
        type: 'live2d',
        root: modelDir,
        modelPath: file,
        expressions: finalExpressions,
        motions: finalMotions,
        declaredExpressions: expressions,
        discoveredExpressions: siblingExp,
        declaredMotions: motions,
        discoveredMotions: siblingMotions,
        hitAreas,
      });
    } catch (e) {
      errors.push(`解析 model3.json 失败:${file} - ${(e as Error).message}`);
    }
  });

  // 同名(罕见)按 root 排重
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}

interface Live2DModel3JSON {
  Version?: number;
  FileReferences?: {
    Moc?: string;
    Textures?: string[];
    Physics?: string;
    Pose?: string;
    Expressions?: { Name?: string; File?: string }[];
    Motions?: Record<string, unknown[]>;
  };
  HitAreas?: { Name?: string; Id?: string }[];
}

function groupMotionFiles(files: string[]): { group: string; count: number }[] {
  const map = new Map<string, number>();
  for (const file of files) {
    const name = path.basename(file);
    const group = path.basename(name, '.json').replace(/\.motion3$/, '');
    map.set(group, (map.get(group) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => a.group.localeCompare(b.group, 'zh'));
}

function mergeMotionGroups(
  declared: { group: string; count: number }[],
  discovered: { group: string; count: number }[],
): { group: string; count: number }[] {
  const map = new Map<string, number>();
  for (const m of declared) map.set(m.group, m.count);
  for (const m of discovered) {
    map.set(m.group, Math.max(map.get(m.group) ?? 0, m.count));
  }
  return Array.from(map.entries())
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => a.group.localeCompare(b.group, 'zh'));
}

// ------------------------- PNG / Sprite -------------------------

/**
 * 启发式解析 .txt 文件名,返回循环规则。无法识别返回 null 让上层兜底。
 *
 * 已知样例(均为 0 字节文件,关键信息在文件名):
 *   说话重复1-5.txt              → simple 1..5
 *   持续开心重复23.txt           → simple 2..3 (两位粘连数字)
 *   持续生气重复23.txt           → simple 2..3
 *   行走是4-9然后重复.txt        → enter-then-loop, enterEnd=3, loop 4..9
 *   思考是4-9然后重复.txt        → enter-then-loop, enterEnd=3, loop 4..9
 */
export function parseLoopFilename(name: string): SpriteLoopRule | null {
  const stem = name.replace(/\.txt$/i, '');

  // 1. 「...是N-M然后重复」/「...是N到M然后重复」  最高优先级
  const enterLoop = /是\s*(\d+)\s*[-－~~到]\s*(\d+)\s*然后/.exec(stem);
  if (enterLoop) {
    const a = parseInt(enterLoop[1], 10);
    const b = parseInt(enterLoop[2], 10);
    if (a > 0 && b >= a) {
      return { kind: 'enter-then-loop', enterEnd: a - 1, loopStart: a, loopEnd: b };
    }
  }

  // 2. 「重复N-M」 / 「重复N~M」  (含全角破折号)
  const range = /重复\s*(\d+)\s*[-－~~]\s*(\d+)/.exec(stem);
  if (range) {
    const a = parseInt(range[1], 10);
    const b = parseInt(range[2], 10);
    if (a > 0 && b >= a) return { kind: 'simple', loopStart: a, loopEnd: b };
  }

  // 3. 「持续...重复NN」(两位粘连数字,如 "23"=2-3)
  const concat = /重复\s*(\d)(\d)\s*$/.exec(stem);
  if (concat) {
    return { kind: 'simple', loopStart: parseInt(concat[1], 10), loopEnd: parseInt(concat[2], 10) };
  }

  // 4. 「重复N」 单帧
  const single = /重复\s*(\d+)\s*$/.exec(stem);
  if (single) {
    return { kind: 'hold', frame: parseInt(single[1], 10) };
  }

  return null;
}

function parseFrameIndex(filename: string): number {
  const stem = path.basename(filename, path.extname(filename));
  const m = /^(\d+)/.exec(stem);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

async function readSpriteState(
  dir: string,
  stateName: string,
  errors: string[],
): Promise<SpriteState | null> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    errors.push(`读取目录失败:${dir} - ${(e as Error).message}`);
    return null;
  }

  const pngs = entries
    .filter((e) => e.isFile() && /\.png$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => parseFrameIndex(a) - parseFrameIndex(b));
  if (pngs.length === 0) return null;

  const txt = entries.find((e) => e.isFile() && /\.txt$/i.test(e.name));
  let rule: SpriteLoopRule;
  let ruleSource: string;
  if (txt) {
    const parsed = parseLoopFilename(txt.name);
    if (parsed) {
      rule = parsed;
      ruleSource = txt.name;
    } else {
      // .txt 存在但无法解析,fallback 到全循环并记一笔
      errors.push(`无法解析循环规则:${dir}\\${txt.name},兜底 1..${pngs.length}`);
      rule = { kind: 'simple', loopStart: 1, loopEnd: pngs.length };
      ruleSource = `${txt.name} (未识别)`;
    }
  } else {
    // 无 .txt:多帧 → 全循环;单帧 → hold
    rule =
      pngs.length === 1
        ? { kind: 'hold', frame: 1 }
        : { kind: 'simple', loopStart: 1, loopEnd: pngs.length };
    ruleSource = '(无 txt,默认全循环)';
  }

  return {
    name: stateName,
    frames: pngs.map((p) => path.join(dir, p)),
    loopRule: rule,
    ruleSource,
  };
}

export async function scanSprite(root: string, errors: string[]): Promise<SpriteCharacter[]> {
  if (!(await exists(root))) {
    errors.push(`桌宠 根目录不存在:${root}`);
    return [];
  }

  const stateEntries = (await fs.readdir(root, { withFileTypes: true })).filter((e) =>
    e.isDirectory(),
  );

  const states: Record<string, SpriteStateOrComposite> = {};
  for (const e of stateEntries) {
    const stateRoot = path.join(root, e.name);

    // 先尝试当作直接帧目录
    const direct = await readSpriteState(stateRoot, e.name, errors);
    if (direct) {
      states[e.name] = direct;
      continue;
    }

    // 否则看是否含子目录(如 走路/右转身、走路/左转身)
    const subEntries = (await fs.readdir(stateRoot, { withFileTypes: true })).filter((s) =>
      s.isDirectory(),
    );
    const substates: Record<string, SpriteState> = {};
    for (const s of subEntries) {
      const sub = await readSpriteState(path.join(stateRoot, s.name), s.name, errors);
      if (sub) substates[s.name] = sub;
    }
    if (Object.keys(substates).length > 0) {
      states[e.name] = { substates };
    }
    // 否则就是空目录(人物形象/吃零食/...),静默跳过
  }

  if (Object.keys(states).length === 0) return [];

  return [
    {
      id: 'sprite-default',
      name: '桌宠原画',
      type: 'sprite',
      root,
      states,
    },
  ];
}

// ------------------------- Hatch-Pet (Codex) -------------------------

/**
 * Hatch-Pet 扫描器:每个子目录里有 `pet.json` + `spritesheet.webp` 即识别为一只桌宠。
 * pet.json 形如:`{ id, displayName, description, spritesheetPath }`。
 *
 *  - id 跟着文件夹名走,避免不同 hatch-pet 包用同一 id 冲突;若 pet.json 里有 id
 *    且和文件夹名不同,优先用文件夹名(因为 codexpets.org/install 也强调 id ≡ 文件夹名)。
 *  - 文件夹不存在 / 没 pet.json / 没 spritesheet 都安静跳过(只在 errors 里提一笔)。
 *  - source 区分 builtin vs user;前缀加进 id 防止两根目录名撞车。
 */
export async function scanHatchPet(
  root: string,
  source: 'builtin' | 'user',
  errors: string[],
): Promise<HatchPetCharacter[]> {
  if (!(await exists(root))) {
    // 资源根缺失不算错 — 用户可能根本没装 hatch-pet 角色,或者还没导入过。
    return [];
  }
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    errors.push(`hatch-pet 读取失败:${root} (${(e as Error).message})`);
    return [];
  }

  const idPrefix = source === 'builtin' ? 'hatch-b-' : 'hatch-u-';
  const out: HatchPetCharacter[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, 'pet.json');
    if (!(await exists(manifestPath))) continue;

    let manifest: {
      id?: string;
      displayName?: string;
      description?: string;
      spritesheetPath?: string;
      behavior?: HatchPetBehaviorConfig;
    };
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(raw);
    } catch (e) {
      errors.push(`hatch-pet pet.json 解析失败:${manifestPath} (${(e as Error).message})`);
      continue;
    }

    const sheet = manifest.spritesheetPath
      ? path.resolve(dir, manifest.spritesheetPath)
      : path.join(dir, 'spritesheet.webp');
    if (!(await exists(sheet))) {
      errors.push(`hatch-pet 缺 spritesheet:${sheet}`);
      continue;
    }

    out.push({
      id: `${idPrefix}${entry.name}`,
      name: manifest.displayName?.trim() || entry.name,
      category: 'Hatch Pet',
      type: 'hatch-pet',
      source,
      root: dir,
      manifestPath,
      spritesheetPath: sheet,
      description: manifest.description,
      behavior: mergeHatchPetBehaviorConfig(manifest.behavior),
      expressions: [],
      motions: [],
      hitAreas: [],
    });
  }

  // 按显示名排序,菜单稳定
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

// ------------------------- 入口 -------------------------

export async function scanAll(): Promise<CharacterIndex> {
  const errors: string[] = [];
  const roots = resolveAssetRoots();
  // sprite 自制模型暂时不上线;Hatch-Pet 扫两个根:builtin + user
  const [live2d, hatchPetBuiltin, hatchPetUser] = await Promise.all([
    scanLive2D(roots.live2d, errors),
    scanHatchPet(roots.hatchPet, 'builtin', errors),
    scanHatchPet(roots.hatchPetUser, 'user', errors),
  ]);
  // user 角色在前(用户最近导入的更可能想用),builtin 在后
  const hatchPet = [...hatchPetUser, ...hatchPetBuiltin];
  const sprite: SpriteCharacter[] = [];
  return {
    live2d,
    sprite,
    hatchPet,
    scannedAt: Date.now(),
    errors,
    roots,
  };
}

// ------------------------- utils -------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, async (file) => {
    out.push(file);
  });
  return out;
}

async function walk(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      await walk(p, visit);
    } else if (e.isFile()) {
      await visit(p);
    }
  }
}

function makeId(absPath: string, root: string): string {
  const rel = path.relative(root, absPath);
  return rel.replace(/\\/g, '/').replace(/\.model3\.json$/i, '');
}
