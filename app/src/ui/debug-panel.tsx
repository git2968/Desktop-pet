import { useMemo, useState, type RefObject } from 'react';
import type { Live2DCharacter, Live2DExpressionRef } from '../../shared/character';
import {
  CHARACTER_EMOTION_MAP,
  EMOTION_KEYS_FALLBACK,
  type Emotion,
} from '../../shared/emotion-map';
import type { CharacterHostHandle } from '../render/character-host';

interface Props {
  hostRef: RefObject<CharacterHostHandle | null>;
  characters: Live2DCharacter[];
  activeId: string | undefined;
  onPick: (id: string) => void;
  onClose: () => void;
}

const EMOTIONS: Array<{ key: Emotion; label: string }> = [
  { key: 'happy', label: '开心' },
  { key: 'sad', label: '难过' },
  { key: 'angry', label: '生气' },
  { key: 'surprised', label: '惊讶' },
];

function declaredExpressions(c: Live2DCharacter): string[] {
  return c.declaredExpressions ?? c.expressions ?? [];
}

function expressionRefName(item: Live2DExpressionRef | string): string {
  return typeof item === 'string' ? item : item.name;
}

function discoveredExpressionRefs(c: Live2DCharacter): Array<Live2DExpressionRef | string> {
  return c.discoveredExpressions ?? c.expressions ?? [];
}

function discoveredExpressions(c: Live2DCharacter): string[] {
  return discoveredExpressionRefs(c).map(expressionRefName).filter(Boolean);
}

function allExpressions(c: Live2DCharacter): string[] {
  return c.expressions ?? Array.from(new Set([...declaredExpressions(c), ...discoveredExpressions(c)]));
}

function declaredMotions(c: Live2DCharacter): { group: string; count: number }[] {
  return c.declaredMotions ?? c.motions ?? [];
}

function discoveredMotions(c: Live2DCharacter): { group: string; count: number }[] {
  return c.discoveredMotions ?? c.motions ?? [];
}

function asList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function missingNames(found: string[], declared: string[]): string[] {
  const declaredSet = new Set(declared);
  return found.filter((name) => !declaredSet.has(name));
}

function findFallbackExpression(emotion: Emotion, availableExpressions: string[]): string | null {
  const keys = EMOTION_KEYS_FALLBACK[emotion];
  for (const key of keys) {
    const needle = key.toLowerCase();
    const hit = availableExpressions.find((name) => {
      const n = name.toLowerCase();
      return key.length <= 2 ? n === needle : n.includes(needle);
    });
    if (hit) return hit;
  }
  return null;
}

function describeEmotion(character: Live2DCharacter, emotion: Emotion): string {
  const mapping = CHARACTER_EMOTION_MAP[character.name]?.[emotion];
  const exps = allExpressions(character);
  const motions = (character.motions ?? declaredMotions(character)).map((m) => m.group);
  const explicitExps = asList(mapping?.expression);
  const explicitMotions = asList(mapping?.motion);

  let exp = '表情:-';
  if (explicitExps.length > 0) {
    const valid = explicitExps.filter((name) => exps.includes(name));
    exp = valid.length > 0
      ? `表情:${valid.join('/')}`
      : `表情未命中:${explicitExps.join('/')}`;
  } else {
    const fallback = findFallbackExpression(emotion, exps);
    if (fallback) exp = `表情:${fallback}(fallback)`;
  }

  let motion = '动作:-';
  if (explicitMotions.length > 0) {
    const valid = explicitMotions.filter((name) => motions.includes(name));
    motion = valid.length > 0
      ? `动作:${valid.join('/')}`
      : `动作未命中:${explicitMotions.join('/')}`;
  }

  return `${exp}；${motion}`;
}

type ChipItem = string | { label: string; value: string; title?: string };

function chipValue(item: ChipItem): string {
  return typeof item === 'string' ? item : item.value;
}

function chipLabel(item: ChipItem): string {
  return typeof item === 'string' ? item : item.label;
}

function chipTitle(item: ChipItem): string {
  return typeof item === 'string' ? item : (item.title ?? item.value);
}

function ChipList({
  items,
  empty,
  onClick,
}: {
  items: ChipItem[];
  empty: string;
  onClick?: (item: string) => void;
}): JSX.Element {
  if (items.length === 0) return <span className="debug-empty">{empty}</span>;
  return (
    <div className="debug-chip-row">
      {items.map((item) => {
        const value = chipValue(item);
        const label = chipLabel(item);
        const title = chipTitle(item);
        return onClick ? (
          <button
            key={`${value}:${label}`}
            type="button"
            className="debug-chip debug-chip--button"
            title={title}
            onClick={() => onClick(value)}
          >
            {label}
          </button>
        ) : (
          <span key={`${value}:${label}`} className="debug-chip" title={title}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

export function DebugPanel({ hostRef, characters, activeId, onPick, onClose }: Props) {
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<string>('');
  const active = characters.find((c) => c.id === activeId) ?? characters[0];
  const runtimeExpressions = hostRef.current?.listExpressions() ?? [];
  const runtimeMotions = hostRef.current?.listMotions() ?? [];
  const grouped = useMemo(() => {
    const map = new Map<string, Live2DCharacter[]>();
    for (const c of characters) {
      const list = map.get(c.category) ?? [];
      list.push(c);
      map.set(c.category, list);
    }
    return Array.from(map.entries())
      .map(([category, items]) => ({
        category,
        items: items.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh')),
      }))
      .sort((a, b) => {
        if (a.category === '通用') return -1;
        if (b.category === '通用') return 1;
        return a.category.localeCompare(b.category, 'zh');
      });
  }, [characters]);

  void tick;

  const refresh = () => setTick((v) => v + 1);

  const tryExp = async (name: string) => {
    setStatus(`表情: ${name} ...`);
    const r = await hostRef.current?.playExpression(name);
    setStatus(`表情 ${name} -> ${JSON.stringify(r)}`);
  };
  const tryMotion = async (group: string) => {
    setStatus(`动作: ${group} ...`);
    const r = await hostRef.current?.playMotion(group);
    setStatus(`动作 ${group} -> ${JSON.stringify(r)}`);
  };

  return (
    <div className="debug-panel">
      <div className="debug-header">
        <strong>调试 · 表情 / 动作</strong>
        <button className="debug-refresh" onClick={refresh} title="刷新列表">
          ↻
        </button>
        <button className="debug-close" onClick={onClose} title="关闭">
          ×
        </button>
      </div>

      {status && <div className="debug-status">{status}</div>}

      <div className="debug-section">
        <div className="debug-section-title">
          当前模型: {active ? `${active.name} / ${active.category}` : '(无)'}
        </div>
        <div className="debug-subtitle">运行时表情({runtimeExpressions.length})</div>
        <ChipList items={runtimeExpressions} empty="当前模型没有可触发表情" onClick={tryExp} />
        <button
          className="debug-btn debug-btn-reset"
          onClick={() => hostRef.current?.resetExpression()}
        >
          复位表情
        </button>
        <div className="debug-subtitle">运行时动作({runtimeMotions.length})</div>
        <ChipList items={runtimeMotions} empty="当前模型没有可触发动作" onClick={tryMotion} />
      </div>

      <div className="debug-section">
        <div className="debug-section-title">所有模型({characters.length})</div>
        <div className="debug-model-list">
          {grouped.map((group) => (
            <div className="debug-model-category" key={group.category}>
              <div className="debug-model-category-title">{group.category}</div>
              {group.items.map((character) => {
                const modelExps = declaredExpressions(character);
                const fileExps = discoveredExpressions(character);
                const modelMotions = declaredMotions(character);
                const fileMotions = discoveredMotions(character);
                const missingExp = missingNames(fileExps, modelExps);
                const missingMotion = missingNames(
                  fileMotions.map((m) => m.group),
                  modelMotions.map((m) => m.group),
                );
                const isActive = character.id === activeId;
                return (
                  <div
                    className={'debug-model-card' + (isActive ? ' active' : '')}
                    key={character.id}
                  >
                    <div className="debug-model-head">
                      <div className="debug-model-title">{character.name}</div>
                      <button
                        className="mini-btn"
                        onClick={() => onPick(character.id)}
                        disabled={isActive}
                      >
                        {isActive ? '当前' : '切换'}
                      </button>
                    </div>
                    <div className="debug-model-meta">
                      model3 表情 {modelExps.length} / 文件表情 {fileExps.length} · model3 动作{' '}
                      {modelMotions.length} / 文件动作 {fileMotions.length}
                    </div>
                    <div className="debug-subtitle">model3 表情</div>
                    <ChipList items={modelExps} empty="未声明" onClick={isActive ? tryExp : undefined} />
                    <div className="debug-subtitle">文件表情(.exp3.json)</div>
                    <ChipList items={fileExps} empty="未发现" onClick={isActive ? tryExp : undefined} />
                    <div className="debug-subtitle">model3 动作</div>
                    <ChipList
                      items={modelMotions.map((m) => ({
                        label: `${m.group}(${m.count})`,
                        value: m.group,
                      }))}
                      empty="未声明"
                      onClick={isActive ? tryMotion : undefined}
                    />
                    <div className="debug-subtitle">文件动作(.motion3.json)</div>
                    <ChipList
                      items={fileMotions.map((m) => ({
                        label: `${m.group}(${m.count})`,
                        value: m.group,
                      }))}
                      empty="未发现"
                      onClick={isActive ? tryMotion : undefined}
                    />
                    {(missingExp.length > 0 || missingMotion.length > 0) && (
                      <div className="debug-warning">
                        {missingExp.length > 0 && <>未写入 model3 的表情: {missingExp.join(', ')}</>}
                        {missingExp.length > 0 && missingMotion.length > 0 && <br />}
                        {missingMotion.length > 0 && <>未写入 model3 的动作: {missingMotion.join(', ')}</>}
                      </div>
                    )}
                    <div className="debug-subtitle">AI 情绪标签映射</div>
                    <div className="debug-emotion-list">
                      {EMOTIONS.map((emotion) => (
                        <div className="debug-emotion-row" key={emotion.key}>
                          <span>[emotion: {emotion.key}] {emotion.label}</span>
                          <span>{describeEmotion(character, emotion.key)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="debug-model-meta">
                      HitAreas:{' '}
                      {character.hitAreas.length > 0
                        ? character.hitAreas.map((h) => `${h.name}:${h.id}`).join(', ')
                        : '无,点击位置按上半头部/下半身体兜底'}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
