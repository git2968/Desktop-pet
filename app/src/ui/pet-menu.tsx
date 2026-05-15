import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  loadVoskModel,
  invalidateVoskModel,
  releaseVoskModel,
  getVoskState,
  type VoskState,
} from '../render/vosk-shared';
import type { Live2DCharacter, HatchPetCharacter } from '../../shared/character';

/** 角色菜单 / 设置 / Persona 编辑 共用的 character 类型。
 *  Live2D 与 Hatch-Pet 都参与角色切换 + AI persona 配置;sprite 还没启用故不并入。 */
type MenuCharacter = Live2DCharacter | HatchPetCharacter;
import type {
  CharacterPersonaEntry,
  CharacterPersonaSlot,
  DownloadedSkillMeta,
  GeneralAssistConfig,
  McpServerSpec,
  ProviderProfile,
  RuntimeCacheUsage,
  VisionAssistConfig,
} from '../../electron/preload';
import { PROVIDER_TEMPLATES } from '../../shared/provider-templates';
import { useDraggablePanel } from '../render/use-draggable-panel';
import {
  DEFAULT_CHARACTER_PERSONAS,
  type CharacterPersona,
} from '../../shared/emotion-map';
import { MCP_PRESETS } from '../../shared/mcp-presets';

interface Props {
  /** 菜单是否展开 */
  open: boolean;
  /** 关闭菜单(点击外部 / Esc) */
  onClose: () => void;
  /** 当前角色清单(Live2D + Hatch-Pet) */
  characters: MenuCharacter[];
  activeId: string | undefined;
  /** 当前激活角色的 name(用于 AI 设置里编辑 per-character persona) */
  activeCharacterName?: string | null;
  onPick: (id: string) => void;
  /** 当前用户缩放(1=原始 fit) */
  scale: number;
  /** 提交版:用于按钮 / 松开 slider — 改窗口尺寸并持久化 */
  onScale: (s: number) => void;
  /** 预览版:slider 拖动期间高频调用 — 只改 PIXI 内 model.scale,不动窗口 */
  onPreviewScale: (s: number) => void;
  onResetScale: () => void;
  /** 对话面板是否可见 */
  chatOpen: boolean;
  /** 切换对话面板可见性 */
  onToggleChat: () => void;
}

type Panel = 'root' | 'characters' | 'size' | 'ai' | 'settings';

function characterCategory(c: MenuCharacter): string {
  const direct = c.category?.trim();
  if (direct) return direct;

  // 兼容正在运行的旧主进程:它返回的 Character 还没有 category 字段时,
  // 从绝对路径里的 app/live2d/<分类>/... 或 resources/live2d/<分类>/... 推断。
  // hatch-pet 角色没有 modelPath,直接用 root。
  const modelPath = 'modelPath' in c ? c.modelPath : '';
  const sourcePath = (modelPath || c.root || '').replace(/\\/g, '/');
  const segs = sourcePath.split('/').filter(Boolean);
  const idx = segs.map((s) => s.toLowerCase()).lastIndexOf('live2d');
  if (idx >= 0 && segs[idx + 1]) return decodeURIComponent(segs[idx + 1]);
  return '未分类';
}

function groupedCharacters(characters: MenuCharacter[]): Array<{
  category: string;
  items: MenuCharacter[];
}> {
  const map = new Map<string, MenuCharacter[]>();
  for (const c of characters) {
    const category = characterCategory(c);
    const arr = map.get(category) ?? [];
    arr.push(c);
    map.set(category, arr);
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
}

function defaultOpenCharacterGroups(groups: Array<{ category: string }>): Set<string> {
  const categories = groups.map((g) => g.category);
  if (categories.includes('通用')) return new Set(['通用']);
  return categories[0] ? new Set([categories[0]]) : new Set();
}

function CollapsibleCharacterGroups({
  groups,
  isActive,
  labelFor,
  onPick,
  className = '',
}: {
  groups: Array<{ category: string; items: MenuCharacter[] }>;
  isActive: (character: MenuCharacter) => boolean;
  labelFor: (character: MenuCharacter) => string;
  onPick: (character: MenuCharacter) => void;
  className?: string;
}): JSX.Element {
  const [openGroups, setOpenGroups] = useState<Set<string>>(() =>
    defaultOpenCharacterGroups(groups),
  );

  useEffect(() => {
    setOpenGroups((prev) => {
      const known = new Set(groups.map((g) => g.category));
      const next = new Set<string>();
      let changed = false;
      for (const category of prev) {
        if (known.has(category)) next.add(category);
        else changed = true;
      }
      if (next.size === 0) {
        for (const category of defaultOpenCharacterGroups(groups)) next.add(category);
        changed = next.size !== prev.size;
      }
      return changed ? next : prev;
    });
  }, [groups]);

  const toggleGroup = (category: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  return (
    <div className={'char-list' + (className ? ` ${className}` : '')}>
      {groups.map((group) => {
        const expanded = openGroups.has(group.category);
        return (
          <div
            className={'char-group' + (expanded ? '' : ' collapsed')}
            key={group.category}
          >
            <button
              type="button"
              className="char-group-title"
              onClick={() => toggleGroup(group.category)}
              aria-expanded={expanded}
            >
              <span className="char-group-title-main">
                <span className={'char-group-chevron' + (expanded ? ' open' : '')}>›</span>
                <span>{group.category}</span>
              </span>
              <span className="char-group-count">{group.items.length}</span>
            </button>
            {expanded && (
              <div className="char-group-items">
                {group.items.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={'char-item' + (isActive(c) ? ' active' : '')}
                    onClick={() => onPick(c)}
                  >
                    {labelFor(c)}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 卡通风格的弹出菜单。从模型右侧滑出,垂直排列圆形按钮。
 * 点击「切换角色」展开横向头像条;点击「调整大小」展开滑块。
 */
export function PetMenu({
  open,
  onClose,
  characters,
  activeId,
  activeCharacterName,
  onPick,
  scale,
  onScale,
  onPreviewScale,
  onResetScale,
  chatOpen,
  onToggleChat,
}: Props) {
  const [panel, setPanel] = useState<Panel>('root');
  const [side, setSide] = useState<'left' | 'right'>('right');
  const rootRef = useRef<HTMLDivElement>(null);

  // 托盘菜单点"设置"时,App 转 dispatch 'pet:open-settings';这里监听后直接跳 settings 面板
  useEffect(() => {
    const onOpenSettings = () => setPanel('settings');
    window.addEventListener('pet:open-settings', onOpenSettings);
    return () => window.removeEventListener('pet:open-settings', onOpenSettings);
  }, []);

  // 每次打开重置到根面板,并按窗口在屏幕中的位置决定菜单弹出方向
  useEffect(() => {
    if (!open) return;
    setPanel('root');
    // 窗口中心在屏幕右半边 → 菜单从模型左侧弹出;否则右侧
    const winCenterX = window.screenX + window.outerWidth / 2;
    const screenHalf = window.screen.availWidth / 2;
    setSide(winCenterX > screenHalf ? 'left' : 'right');
  }, [open]);

  // 点击菜单外 / Esc 关闭。注意:子面板(characters/size/ai/settings)用 createPortal
  // 挂到 document.body,DOM 上不再是 .pet-menu 的后代,所以 rootRef.contains 判不到。
  // 用 data-pet-menu-panel 属性识别这些 portal 出去的 panel,把它们也算"菜单内部"。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (rootRef.current && rootRef.current.contains(target)) return;
      if (target.closest('[data-pet-menu-panel]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 用 mousedown 而非 click,避免与右键打开形成竞态
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={'pet-menu pet-menu--' + side}
      ref={rootRef}
      onContextMenu={(e) => e.preventDefault()}
    >
      {panel === 'root' && (
        <div className="pet-menu-buttons">
          <MenuBtn
            label="切换"
            icon={<MenuIcon name="swap" />}
            color="#ffd166"
            onClick={() => setPanel('characters')}
          />
          <MenuBtn label="大小" icon={<MenuIcon name="ruler" />} color="#9bd5ff" onClick={() => setPanel('size')} />
          <MenuBtn label="AI" icon={<MenuIcon name="bot" />} color="#c5e1a5" onClick={() => setPanel('ai')} />
          <MenuBtn
            label={chatOpen ? '隐藏' : '对话'}
            icon={<MenuIcon name="chat" />}
            color="#f4cb84"
            onClick={() => {
              onToggleChat();
              onClose();
            }}
          />
          <MenuBtn
            label="设置"
            icon={<MenuIcon name="gear" />}
            color="#d0d3db"
            onClick={() => setPanel('settings')}
          />
          <MenuBtn
            label="隐藏"
            icon={<MenuIcon name="moon" />}
            color="#b6c4d6"
            onClick={() => {
              void window.petAPI?.windowHide?.();
              onClose();
            }}
          />
          <MenuBtn
            label="退出"
            icon={<MenuIcon name="close" />}
            color="#ff8c8c"
            onClick={() => {
              // 完全退出应用(走主进程 app.quit:停 MCP / 写 config / 销毁托盘)
              void window.petAPI?.appQuit?.();
            }}
          />
        </div>
      )}

      {panel === 'characters' && (
        <DraggableCharacterPanel
          characters={characters}
          activeId={activeId}
          onPick={onPick}
          onClose={onClose}
          onBack={() => setPanel('root')}
        />
      )}

      {panel === 'ai' && (
        <AiSettingsPanel
          onBack={() => setPanel('root')}
          characterName={activeCharacterName ?? null}
          allCharacters={characters}
        />
      )}

      {panel === 'settings' && (
        <SettingsPanel onBack={() => setPanel('root')} allCharacters={characters} />
      )}

      {panel === 'size' && (
        <DraggableSizePanel
          onBack={() => setPanel('root')}
          scale={scale}
          onScale={onScale}
          onPreviewScale={onPreviewScale}
          onResetScale={onResetScale}
        />
      )}
    </div>
  );
}

/** 「选择角色」面板 — 单独抽出来好用 hook(hook 必须在组件顶层调,不能放在父组件的条件分支里) */
function DraggableCharacterPanel({
  characters,
  activeId,
  onPick,
  onClose,
  onBack,
}: {
  characters: MenuCharacter[];
  activeId: string | undefined;
  onPick: (id: string) => void;
  onClose: () => void;
  onBack: () => void;
}): JSX.Element {
  const { panelRef, panelStyle, titleProps } = useDraggablePanel();
  const groups = groupedCharacters(characters);
  // panel 通过 portal 挂到 body,脱离父级 .pet-menu 的 transform 影响,fixed 才相对 viewport。
  // data-pet-menu-panel 属性给 PetMenu 的"点击外部关闭"逻辑识别 — portal 后 panel DOM 不在
  // .pet-menu 内,但仍属于菜单的逻辑子,不应当成 outside。
  return createPortal(
    <div className="pet-menu-panel" data-pet-menu-panel="true" ref={panelRef} style={panelStyle}>
      <div className="pet-menu-title" {...titleProps}>
        <button className="back-btn" onClick={onBack}>
          ←
        </button>
        <span>选择角色</span>
      </div>
      <CollapsibleCharacterGroups
        groups={groups}
        isActive={(c) => c.id === activeId}
        labelFor={(c) => c.name}
        onPick={(c) => {
          onPick(c.id);
          onClose();
        }}
      />
    </div>,
    document.body,
  );
}

/** 「调整大小」面板 — 同上,单独组件好用 hook */
function DraggableSizePanel({
  onBack,
  scale,
  onScale,
  onPreviewScale,
  onResetScale,
}: {
  onBack: () => void;
  scale: number;
  onScale: (s: number) => void;
  onPreviewScale: (s: number) => void;
  onResetScale: () => void;
}): JSX.Element {
  const { panelRef, panelStyle, titleProps } = useDraggablePanel();
  return createPortal(
    <div
      className="pet-menu-panel pet-menu-panel--compact"
      data-pet-menu-panel="true"
      ref={panelRef}
      style={panelStyle}
    >
      <div className="pet-menu-title" {...titleProps}>
        <button className="back-btn" onClick={onBack}>
          ←
        </button>
        <span>调整大小</span>
      </div>
      <SizeSlider
        scale={scale}
        onScale={onScale}
        onPreviewScale={onPreviewScale}
        onResetScale={onResetScale}
      />
    </div>,
    document.body,
  );
}

interface SkillData {
  id: string;
  name: string;
  systemPrompt: string;
}

/** ===== 长期记忆设置区 =====
 *  让用户直接查看 / 添加 / 编辑 / 删除自己的长期记忆。记忆来源:
 *   - AI 通过 `app__remember` 工具自动写入
 *   - 这里用户手动添加(偏好 / 关键事实)
 *  记忆每次 streamChat 注入 system prompt,所有模型 / 会话都能"记得"。
 *  存储位置 userData/memory.json,与 cfg 解耦,单独走 ipcMain 'memory:*' 通道。 */
type MemoryItem = { id: string; content: string; createdAt: number };
function MemorySection(): JSX.Element {
  const [list, setList] = useState<MemoryItem[]>([]);
  const [filter, setFilter] = useState('');
  /** 编辑态:正在编辑的 id 与草稿;'new' 表示底部「新增」textarea 打开 */
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);

  const refresh = async () => {
    const r = (await window.petAPI?.memoryList?.()) ?? [];
    setList(r);
    setLoaded(true);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const beginEdit = (m: MemoryItem) => {
    setEditingId(m.id);
    setDraft(m.content);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft('');
  };
  const saveEdit = async () => {
    const t = draft.trim();
    if (!t || !editingId) return cancelEdit();
    if (editingId === 'new') {
      await window.petAPI?.memoryAdd?.(t);
    } else {
      await window.petAPI?.memoryUpdate?.(editingId, t);
    }
    cancelEdit();
    await refresh();
  };
  const remove = async (id: string) => {
    if (!confirm('删除这条记忆?AI 之后将不再记得这件事。')) return;
    await window.petAPI?.memoryRemove?.(id);
    await refresh();
  };
  const clearAll = async () => {
    if (list.length === 0) return;
    if (!confirm(`清空所有 ${list.length} 条记忆?此操作不可撤销。`)) return;
    await window.petAPI?.memoryClear?.();
    await refresh();
  };

  // 过滤(大小写不敏感子串)— 不影响排序;原数据已经是 createdAt 正序(老在前)
  const filtered = filter.trim()
    ? list.filter((m) => m.content.toLowerCase().includes(filter.trim().toLowerCase()))
    : list;

  const fmtDate = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  };

  return (
    <details className="memory-section memory-section--collapsible">
      <summary className="memory-section-summary">
        <span className="memory-section-title">长期记忆(Memories)</span>
        <span className="memory-section-count">{list.length}</span>
        <span className="memory-section-desc">
          跨模型 / 跨会话的事实(偏好、习惯、关键信息),每次对话注入 AI system prompt。
        </span>
      </summary>
      <div className="memory-toolbar">
        <input
          className="memory-search"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索记忆…"
        />
        <button
          type="button"
          className="mini-btn"
          onClick={() => {
            setEditingId('new');
            setDraft('');
          }}
          disabled={editingId === 'new'}
          title="新增一条记忆"
        >
          + 新增
        </button>
        <button
          type="button"
          className="mini-btn"
          onClick={() => void clearAll()}
          disabled={list.length === 0}
          title="清空所有记忆"
        >
          清空
        </button>
      </div>

      {/* 新增时顶部插入 textarea 编辑器 */}
      {editingId === 'new' && (
        <div className="memory-card memory-card--editing">
          <textarea
            className="memory-edit-area"
            rows={3}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="比如:用户偏好用中文回答 / 在 Windows 上使用 PowerShell / 喜欢简洁不啰嗦的解释"
          />
          <div className="memory-card-actions">
            <button className="mini-btn" onClick={cancelEdit}>取消</button>
            <button className="mini-btn primary" onClick={() => void saveEdit()} disabled={!draft.trim()}>
              保存
            </button>
          </div>
        </div>
      )}

      {loaded && filtered.length === 0 && editingId !== 'new' && (
        <div className="memory-empty">
          {list.length === 0
            ? '还没有任何记忆。点 + 新增,或让 AI 在对话里调用「记住」工具自动写入。'
            : '没有匹配的记忆。'}
        </div>
      )}

      {filtered.map((m) => {
        const isEditing = editingId === m.id;
        return (
          <div
            key={m.id}
            className={'memory-card' + (isEditing ? ' memory-card--editing' : '')}
          >
            {isEditing ? (
              <>
                <textarea
                  className="memory-edit-area"
                  rows={3}
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="memory-card-actions">
                  <span className="memory-date">添加于 {fmtDate(m.createdAt)}</span>
                  <button className="mini-btn" onClick={cancelEdit}>取消</button>
                  <button
                    className="mini-btn primary"
                    onClick={() => void saveEdit()}
                    disabled={!draft.trim() || draft.trim() === m.content}
                  >
                    保存
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="memory-content">{m.content}</div>
                <div className="memory-card-actions">
                  <span className="memory-date">{fmtDate(m.createdAt)}</span>
                  <button
                    className="mini-btn"
                    onClick={() => beginEdit(m)}
                    title="编辑此条记忆"
                  >
                    ✎ 编辑
                  </button>
                  <button
                    className="mini-btn memory-btn-danger"
                    onClick={() => void remove(m.id)}
                    title="删除此条记忆"
                  >
                    ✕ 删除
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </details>
  );
}

/** ===== Hatch-Pet 角色管理 =====
 *  列出 codex hatch-pet 生成的全部桌宠(builtin + user),允许:
 *    - 「+ 导入文件夹」选含 pet.json + spritesheet.webp 的目录,复制到 userData/hatch-pet
 *    - 删除 user 角色(builtin 不可删 — 跟程序一起打包)
 *  导入 / 删除后通知所有页面重新 scan 角色 → 角色菜单立刻刷新。 */
function HatchPetSection(): JSX.Element {
  const [pets, setPets] = useState<Array<{
    id: string;
    name: string;
    source: 'builtin' | 'user';
    description?: string;
  }>>([]);
  const [busy, setBusy] = useState<'idle' | 'importing' | 'removing'>('idle');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = async () => {
    const idx = await window.petAPI?.scanCharacters?.();
    if (!idx) return;
    setPets(
      idx.hatchPet.map((c) => ({
        id: c.id,
        name: c.name,
        source: c.source,
        description: c.description,
      })),
    );
  };
  useEffect(() => {
    void refresh();
  }, []);

  const onImport = async () => {
    setBusy('importing');
    setMsg(null);
    try {
      const r = await window.petAPI?.hatchPetImport?.();
      if (r === null || r === undefined) {
        // 用户取消,无消息
      } else if (r.ok) {
        setMsg({ kind: 'ok', text: `✓ 已导入「${r.added.name}」` });
        await refresh();
        // 通知 App 层 重新扫描 + 托盘菜单刷新
        window.dispatchEvent(new CustomEvent('pet:characters-changed'));
        await window.petAPI?.trayRefresh?.({ activeCharacterId: undefined });
      } else {
        setMsg({ kind: 'err', text: '导入失败:' + r.error });
      }
    } finally {
      setBusy('idle');
    }
  };

  const onRemove = async (id: string, name: string) => {
    if (!window.confirm(`确定删除角色「${name}」?该操作不可撤销。`)) return;
    setBusy('removing');
    setMsg(null);
    try {
      const r = await window.petAPI?.hatchPetRemove?.(id);
      if (r?.ok) {
        setMsg({ kind: 'ok', text: `✓ 已删除「${name}」` });
        await refresh();
        window.dispatchEvent(new CustomEvent('pet:characters-changed'));
        await window.petAPI?.trayRefresh?.({ activeCharacterId: undefined });
      } else {
        setMsg({ kind: 'err', text: '删除失败:' + (r?.error ?? '未知错误') });
      }
    } finally {
      setBusy('idle');
    }
  };

  const userCount = pets.filter((p) => p.source === 'user').length;
  const builtinCount = pets.filter((p) => p.source === 'builtin').length;

  return (
    <details className="settings-section" style={{ marginTop: 12 }}>
      <summary className="settings-section-title">
        Hatch-Pet 角色 · 内置 {builtinCount} · 已导入 {userCount}
      </summary>
      <div className="settings-row-desc" style={{ marginBottom: 8, opacity: 0.7 }}>
        Codex 的 <code>hatch-pet</code> skill 生成的桌宠(8×9 atlas)。导入文件夹后会复制到
        本地用户目录,可在角色菜单里立即切换。所有 hatch-pet 角色共用同一套情绪 → 动作映射,
        不需要在 emotion-map 里单独配置。
      </div>

      <div className="hatch-pet-toolbar">
        <button
          className="ai-skill-add-btn"
          disabled={busy !== 'idle'}
          onClick={onImport}
          title="选含 pet.json + spritesheet.webp 的文件夹"
        >
          {busy === 'importing' ? '导入中…' : '+ 导入文件夹'}
        </button>
      </div>

      {msg && (
        <div
          style={{
            fontSize: 12,
            padding: '4px 8px',
            borderRadius: 4,
            marginBottom: 8,
            background: msg.kind === 'ok' ? 'rgba(40,160,80,0.15)' : 'rgba(201,60,32,0.15)',
            color: msg.kind === 'ok' ? '#1f7a3e' : '#c93c20',
          }}
        >
          {msg.text}
        </div>
      )}

      {pets.length === 0 ? (
        <div className="ai-empty-hint">还没有任何 Hatch-Pet 角色。点击「+ 导入文件夹」加一个。</div>
      ) : (
        <div className="hatch-pet-grid">
          {pets.map((p) => (
            <div key={p.id} className="hatch-pet-card">
              <div className="hatch-pet-card-main">
                <div className="hatch-pet-card-head">
                  <span className="hatch-pet-card-name" title={p.name}>
                    {p.name}
                  </span>
                  <span className={'hatch-pet-badge hatch-pet-badge--' + p.source}>
                    {p.source === 'builtin' ? '内置' : '已导入'}
                  </span>
                </div>
                {p.description && (
                  <div className="hatch-pet-card-desc" title={p.description}>
                    {p.description}
                  </div>
                )}
              </div>
              {p.source === 'user' && (
                <button
                  className="ai-skill-del-btn"
                  disabled={busy !== 'idle'}
                  onClick={() => onRemove(p.id, p.name)}
                  title="删除该用户导入的角色(不可撤销)"
                >
                  删除
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

/** Agent Skills 设置区(在线 GitHub 源 + 本地 SKILL.md 上传)— 自管 cfg 读写,
 *  改动立刻 persist + dispatch 'petAI:configChanged',被 AIPanel 和 SettingsPanel 复用。
 *  ⚠ 两边都引这个组件后,AIPanel 的 save 不要再写 agentSkills 字段(由本组件直接负责)。 */
function AgentSkillsSection(): JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [sources, setSources] = useState<
    { id: string; repo: string; branch: string; enabled: boolean }[]
  >([]);
  const [localSkills, setLocalSkills] = useState<
    { id: string; sourceId: string; rawId: string; name: string }[]
  >([]);
  const [downloadedSkills, setDownloadedSkills] = useState<DownloadedSkillMeta[]>([]);
  const [localDisabled, setLocalDisabled] = useState<Set<string>>(new Set());
  /** 内置 skill — 元数据从主进程 catalog 来,启用状态按 builtinEnabled 白名单。
   *  白名单模型:默认全关,用户勾选后 rawId 进来才生效。 */
  const [builtin, setBuiltin] = useState<
    { rawId: string; name: string; description: string }[]
  >([]);
  const [builtinEnabled, setBuiltinEnabled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const refreshLocal = async () => {
    const list = (await window.petAPI?.skillsListLocal?.()) ?? [];
    setLocalSkills(list);
  };
  const refreshDownloaded = async () => {
    const list = (await window.petAPI?.skillsListDownloaded?.()) ?? [];
    setDownloadedSkills(list);
  };

  useEffect(() => {
    // 把 cfg.agentSkills 映射到本地 state。单独抽出,方便外部 petAI:configChanged 时重新调。
    const syncFromCfg = async () => {
      const cfg = await window.petAPI?.getConfig?.();
      const as = cfg?.agentSkills;
      setEnabled(as?.enabled !== false);
      setSources(
        Array.isArray(as?.sources) && as!.sources.length > 0
          ? as!.sources.map((s) => ({ ...s, branch: s.branch || 'main' }))
          : [
              { id: 'addyosmani', repo: 'addyosmani/agent-skills', branch: 'main', enabled: true },
              { id: 'qiushi', repo: 'HughYau/qiushi-skill', branch: 'main', enabled: true },
            ],
      );
      setLocalDisabled(new Set(as?.localDisabled ?? []));
      setBuiltinEnabled(new Set(as?.builtinEnabled ?? []));
    };
    void (async () => {
      await syncFromCfg();
      // 拉内置 skill catalog(含名字 + 描述,固定列表,不走网络)— 只首次拉一次
      const b = (await window.petAPI?.skillsListBuiltin?.()) ?? [];
      setBuiltin(b.map(({ rawId, name, description }) => ({ rawId, name, description })));
      await refreshLocal();
      await refreshDownloaded();
    })();
    // 监听外部对 cfg 的改动(比如「编码模式」一键启用编程 skill),立即同步勾选状态。
    // 本组件自己 persist 也会派发此事件,二次 syncFromCfg 读到相同值不会有实际 UI 跳动。
    const onCfg = () => {
      void syncFromCfg();
      void refreshDownloaded();
    };
    const onSkills = () => {
      void refreshLocal();
      void refreshDownloaded();
    };
    window.addEventListener('petAI:configChanged', onCfg);
    window.addEventListener('petAI:skillsChanged', onSkills);
    return () => {
      window.removeEventListener('petAI:configChanged', onCfg);
      window.removeEventListener('petAI:skillsChanged', onSkills);
    };
  }, []);

  /** 改动后立即写回 config,只 patch agentSkills 字段(其它字段不动) */
  const persist = async (
    patch: Partial<{
      enabled: boolean;
      sources: typeof sources;
      localDisabled: Set<string>;
      builtinEnabled: Set<string>;
    }>,
  ) => {
    const cfg = await window.petAPI?.getConfig?.();
    if (!cfg) return;
    const merged = {
      enabled: patch.enabled ?? enabled,
      sources: patch.sources ?? sources,
      localDisabled: Array.from(patch.localDisabled ?? localDisabled),
      builtinEnabled: Array.from(patch.builtinEnabled ?? builtinEnabled),
    };
    await window.petAPI?.setConfig?.({ ...cfg, agentSkills: merged });
    window.dispatchEvent(new CustomEvent('petAI:configChanged'));
  };

  const toggleEnabled = (v: boolean) => {
    setEnabled(v);
    void persist({ enabled: v });
  };
  const toggleSource = (i: number, on: boolean) => {
    const next = [...sources];
    next[i] = { ...next[i], enabled: on };
    setSources(next);
    void persist({ sources: next });
  };
  const toggleLocal = (rawId: string, on: boolean) => {
    const next = new Set(localDisabled);
    if (on) next.delete(rawId);
    else next.add(rawId);
    setLocalDisabled(next);
    void persist({ localDisabled: next });
  };
  /** 内置 skill — 白名单模型:on=加入 set,off=移除 set(跟 localDisabled 黑名单相反) */
  const toggleBuiltin = (rawId: string, on: boolean) => {
    const next = new Set(builtinEnabled);
    if (on) next.add(rawId);
    else next.delete(rawId);
    setBuiltinEnabled(next);
    void persist({ builtinEnabled: next });
  };

  return (
    <div className="ai-section ai-skills-card">
      <div className="ai-skills-head">
        <label className="ai-skills-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
          <span className="ai-skills-toggle-track">
            <span className="ai-skills-toggle-thumb" />
          </span>
        </label>
        <div className="ai-skills-head-text">
          <div className="ai-skills-head-title">Agent Skills</div>
          <div className="ai-skills-head-sub">
            AI 在相关问题里自动查阅已启用的 SKILL.md
          </div>
        </div>
      </div>

      <details className="ai-skills-group ai-skills-collapsible" data-disabled={!enabled || undefined} open>
        <summary className="ai-skills-group-title">
          <span>在线源</span>
          <span className="ai-skills-group-count">{sources.filter((s) => s.enabled).length} / {sources.length}</span>
        </summary>
        {sources.map((src, i) => (
          <div key={src.id} className="ai-skill-card">
            <label className="ai-skill-card-check">
              <input
                type="checkbox"
                checked={src.enabled}
                disabled={!enabled}
                onChange={(e) => toggleSource(i, e.target.checked)}
              />
            </label>
            <div className="ai-skill-card-main">
              <div className="ai-skill-card-name">{src.id}</div>
              <a
                className="ai-skill-card-repo"
                href={`https://github.com/${src.repo}`}
                target="_blank"
                rel="noreferrer"
                title="在浏览器中打开"
              >
                {src.repo} ↗
              </a>
            </div>
          </div>
        ))}
      </details>

      <details className="ai-skills-group ai-skills-collapsible" data-disabled={!enabled || undefined} open>
        <summary className="ai-skills-group-title">
          <span>已下载在线 skill</span>
          <span className="ai-skills-group-count">{downloadedSkills.length}</span>
        </summary>
        {downloadedSkills.length === 0 ? (
          <div className="ai-skills-empty">
            AI 还没有读取过在线 skill。之后它在对话里 query_skill 下载后,这里会自动出现。
          </div>
        ) : (
          downloadedSkills.map((s) => {
            const sourceEnabled = sources.find((src) => src.id === s.sourceId)?.enabled !== false;
            return (
              <div key={s.id} className="ai-skill-card">
                <div className="ai-skill-card-icon">↓</div>
                <div className="ai-skill-card-main">
                  <div className="ai-skill-card-name">{s.name}</div>
                  <div className="ai-skill-card-repo">
                    id: {s.id} · {sourceEnabled ? '在线源已启用' : '在线源已关闭'}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </details>

      <details className="ai-skills-group ai-skills-collapsible" data-disabled={!enabled || undefined}>
        <summary className="ai-skills-group-title">
          <span>内置 skill</span>
          <span className="ai-skills-group-count">{builtinEnabled.size} / {builtin.length}</span>
        </summary>
        {builtin.map((b) => {
          const checked = builtinEnabled.has(b.rawId);
          return (
            <div key={b.rawId} className="ai-skill-card">
              <label className="ai-skill-card-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!enabled}
                  onChange={(e) => toggleBuiltin(b.rawId, e.target.checked)}
                />
              </label>
              <div className="ai-skill-card-icon">⭐</div>
              <div className="ai-skill-card-main">
                <div className="ai-skill-card-name">{b.name}</div>
                <div className="ai-skill-card-repo">{b.description}</div>
              </div>
            </div>
          );
        })}
      </details>

      <details className="ai-skills-group ai-skills-collapsible" data-disabled={!enabled || undefined} open>
        <summary className="ai-skills-group-title">
          <span>本地 SKILL.md</span>
          <span className="ai-skills-group-count">{localSkills.length - localDisabled.size} / {localSkills.length}</span>
          <button
            type="button"
            className="ai-skills-upload-btn"
            disabled={busy || !enabled}
            onClick={async (e) => {
              // summary 内的 button 默认会触发 details toggle,这里阻止
              e.preventDefault();
              e.stopPropagation();
              setBusy(true);
              try {
                const r = await window.petAPI?.skillsPickAndUploadLocal?.();
                if (r) await refreshLocal();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '上传中…' : '+ 上传 .md'}
          </button>
        </summary>
        {localSkills.length === 0 ? (
          <div className="ai-skills-empty">
            还没上传过本地 skill。点上方按钮选个 .md 文件,AI 在相关问题时会读取它。
          </div>
        ) : (
          localSkills.map((s) => {
            const checked = !localDisabled.has(s.rawId);
            return (
              <div key={s.id} className="ai-skill-card">
                <label className="ai-skill-card-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!enabled}
                    onChange={(e) => toggleLocal(s.rawId, e.target.checked)}
                  />
                </label>
                <div className="ai-skill-card-icon">📄</div>
                <div className="ai-skill-card-main">
                  <div className="ai-skill-card-name">{s.name}</div>
                  <div className="ai-skill-card-repo">id: {s.id}</div>
                </div>
                <button
                  type="button"
                  className="ai-skill-del-btn"
                  title="删除"
                  onClick={async () => {
                    if (!window.confirm(`删除本地 skill "${s.name}"?`)) return;
                    await window.petAPI?.skillsRemoveLocal?.(s.rawId);
                    await refreshLocal();
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </details>
    </div>
  );
}

/** 设置面板的「模型辅助」区 — 唯一入口:视觉辅助(识图)+ 通用模型辅助(delegate_to_model)。
 *  包含 总开关 / 默认辅助 model / 全员兜底 / 「调用时不再提示」(仅模型辅助)。
 *  自管 cfg 读写,改动立刻 persist + dispatch 'petAI:configChanged'。 */
function AssistEnableSection(): JSX.Element {
  // visionAssist
  const [vision, setVision] = useState<VisionAssistConfig>({
    enabled: false,
    fallbackAcrossAll: false,
  });
  // generalAssist
  const [general, setGeneral] = useState<GeneralAssistConfig>({
    enabled: false,
    fallbackAcrossAll: false,
  });
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);

  useEffect(() => {
    const reload = () => {
      window.petAPI?.getConfig?.().then((cfg) => {
        setVision(cfg.visionAssist ?? { enabled: false, fallbackAcrossAll: false });
        setGeneral(cfg.generalAssist ?? { enabled: false, fallbackAcrossAll: false });
        setProfiles(cfg.providerProfiles ?? []);
      });
    };
    reload();
    window.addEventListener('petAI:configChanged', reload);
    return () => window.removeEventListener('petAI:configChanged', reload);
  }, []);

  const persistVision = (next: VisionAssistConfig) => {
    setVision(next);
    void window.petAPI?.setConfig?.({ visionAssist: next });
    window.dispatchEvent(new CustomEvent('petAI:configChanged'));
  };
  const persistGeneral = (next: GeneralAssistConfig) => {
    setGeneral(next);
    void window.petAPI?.setConfig?.({ generalAssist: next });
    window.dispatchEvent(new CustomEvent('petAI:configChanged'));
  };

  const visionProfile = profiles.find((p) => p.id === vision.assistantProfileId);
  const generalProfile = profiles.find((p) => p.id === general.assistantProfileId);

  return (
    <div className="settings-section">
      <div className="settings-section-title">模型辅助</div>
      <div className="settings-row-desc" style={{ marginBottom: 6, opacity: 0.7 }}>
        当主模型能力不足时,让其他模型帮忙。开启后可在下面选默认辅助 model。
      </div>

      {/* ===== 视觉辅助 ===== */}
      <label className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-name">启用视觉辅助</span>
          <span className="settings-row-desc">
            主模型不支持识图(如 DeepSeek-v4-pro)时,自动用辅助模型先描述图片,再让主模型基于描述回答。
          </span>
        </div>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={vision.enabled}
          onChange={(e) => persistVision({ ...vision, enabled: e.target.checked })}
        />
      </label>

      {vision.enabled && (
        <>
          <div className="settings-row" style={{ paddingLeft: 16 }}>
            <div className="settings-row-text">
              <span className="settings-row-name">默认识图模型</span>
              <span className="settings-row-desc">从已配置的供应商里选一个会识图的 model。</span>
            </div>
            <div style={{ display: 'flex', gap: 6, minWidth: 280 }}>
              <select
                value={vision.assistantProfileId ?? ''}
                onChange={(e) =>
                  persistVision({
                    ...vision,
                    assistantProfileId: e.target.value,
                    assistantModel: '',
                  })
                }
                style={{ flex: 1 }}
              >
                <option value="">— 选供应商 —</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                value={vision.assistantModel ?? ''}
                onChange={(e) =>
                  persistVision({ ...vision, assistantModel: e.target.value })
                }
                disabled={!visionProfile}
                style={{ flex: 1 }}
              >
                <option value="">— 选模型 —</option>
                {(visionProfile?.modelPresets ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="settings-row" style={{ paddingLeft: 16 }}>
            <div className="settings-row-text">
              <span className="settings-row-name">没配 / 也不识图时全员兜底</span>
              <span className="settings-row-desc">
                自动从所有供应商的预设里挑一个 vision 模型(关键词匹配 vl / vision / 4o / claude-3 / gemini 等)。
              </span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={vision.fallbackAcrossAll}
              onChange={(e) => persistVision({ ...vision, fallbackAcrossAll: e.target.checked })}
            />
          </label>
        </>
      )}

      {/* ===== 模型辅助(通用) ===== */}
      <label className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-name">启用模型辅助</span>
          <span className="settings-row-desc">
            AI 觉得自己干不动某项任务时,可主动调用其他 model 帮忙(代码极复杂 / 推理深度不足 等场景)。
          </span>
        </div>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={general.enabled}
          onChange={(e) => persistGeneral({ ...general, enabled: e.target.checked })}
        />
      </label>

      {general.enabled && (
        <>
          <div className="settings-row" style={{ paddingLeft: 16 }}>
            <div className="settings-row-text">
              <span className="settings-row-name">默认辅助模型</span>
              <span className="settings-row-desc">AI 没指定 target 时用这个 model 帮忙。</span>
            </div>
            <div style={{ display: 'flex', gap: 6, minWidth: 280 }}>
              <select
                value={general.assistantProfileId ?? ''}
                onChange={(e) =>
                  persistGeneral({
                    ...general,
                    assistantProfileId: e.target.value,
                    assistantModel: '',
                  })
                }
                style={{ flex: 1 }}
              >
                <option value="">— 选供应商 —</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                value={general.assistantModel ?? ''}
                onChange={(e) =>
                  persistGeneral({ ...general, assistantModel: e.target.value })
                }
                disabled={!generalProfile}
                style={{ flex: 1 }}
              >
                <option value="">— 选模型 —</option>
                {(generalProfile?.modelPresets ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="settings-row" style={{ paddingLeft: 16 }}>
            <div className="settings-row-text">
              <span className="settings-row-name">允许 AI 自由从所有模型里挑</span>
              <span className="settings-row-desc">
                默认辅助也不合适时,AI 可从所有供应商的预设里自己挑别的 model 委托。
              </span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={general.fallbackAcrossAll}
              onChange={(e) =>
                persistGeneral({ ...general, fallbackAcrossAll: e.target.checked })
              }
            />
          </label>
          <label className="settings-row" style={{ paddingLeft: 16 }}>
            <div className="settings-row-text">
              <span className="settings-row-name">调用时不再提示我</span>
              <span className="settings-row-desc">
                信任 AI 自动委托,关闭确认弹窗。⚠ 关闭后 AI 调任何辅助 model 都不会问你,
                小心 token 消耗。
              </span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={general.skipConfirm === true}
              onChange={(e) =>
                persistGeneral({ ...general, skipConfirm: e.target.checked })
              }
            />
          </label>
        </>
      )}
    </div>
  );
}

function makePersonaId(): string {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 把 DEFAULT_CHARACTER_PERSONAS 里的某条转成带 id 的 PersonaEntry */
function defaultPersonaEntry(
  characterName: string,
  base: CharacterPersona,
): CharacterPersonaEntry {
  return {
    id: makePersonaId(),
    name: base.displayName || characterName,
    displayName: base.displayName,
    personality: base.personality,
    speakingStyle: base.speakingStyle,
  };
}

function AiSettingsPanel({
  onBack,
  characterName,
  allCharacters,
}: {
  onBack: () => void;
  characterName: string | null;
  allCharacters: MenuCharacter[];
}) {
  // 拖拽 + resize:hook 必须在组件顶层调用
  const { panelRef: aiPanelRef, panelStyle: aiPanelStyle, titleProps: aiTitleProps } =
    useDraggablePanel();
  /** 当前正在编辑哪个模型的 persona;默认 = 当前激活角色,可在面板下拉里切到任何模型 */
  const [editingCharacter, setEditingCharacter] = useState<string | null>(characterName);
  // characterName 外部变化时(用户在外面切了角色)同步过来
  useEffect(() => {
    setEditingCharacter(characterName);
  }, [characterName]);
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [modelPresets, setModelPresets] = useState<string[]>([]);
  /** 多厂商配置:每个 profile = 一组 baseURL+apiKey+model+modelPresets。
   *  当前激活的 profile 字段会同步到上面的顶层 state(ai-client 仍读顶层)。 */
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfile[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string>('');
  /** inline 重命名 — 记录正在重命名的 profile id(空 = 没在改);改 draft 文本 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** "+ 添加"按钮是否展开了厂商选择菜单 */
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [skills, setSkills] = useState<SkillData[]>([
    { id: 'default', name: '默认', systemPrompt: '' },
  ]);
  const [activeSkillId, setActiveSkillId] = useState('default');
  const [memory, setMemory] = useState('');
  // Agent Skills 配置已由 <AgentSkillsSection /> 组件自管(读写 cfg.agentSkills 字段),
  // 不再在 AIPanel 里维护 state,save 时也不写 agentSkills。
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  /** 所有角色的 persona slot 映射 — 整体保存到 config.characterPersonas */
  const [personaSlots, setPersonaSlots] = useState<Record<string, CharacterPersonaSlot>>({});
  const characterGroups = groupedCharacters(allCharacters);

  useEffect(() => {
    window.petAPI?.getConfig?.().then((cfg) => {
      // 多厂商:加载 providerProfiles。若空,自动包一个"默认"profile 容纳顶层字段。
      let profiles = Array.isArray(cfg.providerProfiles) ? [...cfg.providerProfiles] : [];
      let active = cfg.activeProviderId ?? '';
      if (profiles.length === 0) {
        profiles = [
          {
            id: 'p_' + Math.random().toString(36).slice(2, 10),
            name: '默认',
            baseURL: cfg.baseURL ?? '',
            apiKey: cfg.apiKey ?? '',
            model: cfg.model ?? '',
            modelPresets: cfg.modelPresets ?? [],
          },
        ];
        active = profiles[0].id;
      } else if (!active || !profiles.some((p) => p.id === active)) {
        active = profiles[0].id;
      }
      const cur = profiles.find((p) => p.id === active)!;
      setProviderProfiles(profiles);
      setActiveProviderId(active);
      setBaseURL(cur.baseURL);
      setApiKey(cur.apiKey);
      setModel(cur.model);
      setModelPresets(cur.modelPresets ?? []);
      setMemory(cfg.memory ?? '');
      // agentSkills 由 <AgentSkillsSection /> 组件自己读写,这里不处理
      const sks = cfg.skills && cfg.skills.length > 0 ? cfg.skills : [
        { id: 'default', name: '默认', systemPrompt: '' },
      ];
      setSkills(sks);
      setActiveSkillId(
        cfg.activeSkillId && sks.some((s) => s.id === cfg.activeSkillId)
          ? cfg.activeSkillId
          : sks[0].id,
      );
      const slots = cfg.characterPersonas ?? {};
      // 自动迁移规则:
      //  1) personality 为空字符串(早期物化的"骨架"persona)→ 用最新 DEFAULT 填充
      //  2) 命中已知"过时默认值指纹"(personalityContains 列表中任一关键词)→ 用最新 DEFAULT 强制覆盖
      //     用于角色默认人设被改写时(如 ulvm2_0001:实验机 → 女仆),让用户无需手动重置
      const STALE_FINGERPRINTS: Record<string, string[]> = {
        ulvm2_0001: ['ULVM', '实验机', '虚拟生命体', '数据已归档', 'U-01'],
      };
      let migrated = false;
      const fixedSlots: Record<string, CharacterPersonaSlot> = {};
      for (const [name, slot] of Object.entries(slots)) {
        const seed = DEFAULT_CHARACTER_PERSONAS[name];
        if (!seed || !slot || slot.personas.length === 0) {
          fixedSlots[name] = slot;
          continue;
        }
        const stale = STALE_FINGERPRINTS[name] ?? [];
        let slotChanged = false;
        const personas = slot.personas.map((p) => {
          const empty = (p.personality ?? '').trim().length === 0;
          const isStale = stale.some((kw) => (p.personality ?? '').includes(kw));
          if (empty || isStale) {
            slotChanged = true;
            return {
              ...p,
              displayName: empty
                ? (p.displayName ?? '').trim() || seed.displayName
                : seed.displayName,
              personality: seed.personality,
              speakingStyle: seed.speakingStyle,
            };
          }
          return p;
        });
        if (slotChanged) {
          migrated = true;
          fixedSlots[name] = { ...slot, personas };
        } else {
          fixedSlots[name] = slot;
        }
      }
      setPersonaSlots(fixedSlots);
      // 记住"已保存的"基线,用于 save 时判断 persona 是否真的变了
      (window as unknown as { __lastSavedPersonas?: typeof fixedSlots }).__lastSavedPersonas =
        fixedSlots;
      // 有迁移就静默写回 config.json,后续启动直接读到正确数据
      if (migrated) {
        window.petAPI?.setConfig?.({
          ...cfg,
          characterPersonas: fixedSlots,
        });
      }
    });
  }, []);

  // skills 数据保留(向后兼容旧 config),但 UI 不再编辑;
  // ai-client 仍读 cfg 里 active skill 的 systemPrompt(默认空字符串无副作用)。

  // ====== Persona 编辑 — 仅当 editingCharacter 存在时启用 ======
  /** 取当前角色的 slot;没有则 lazy 用 DEFAULT 初始化(只在编辑时材料化,不覆盖未触碰的角色)。
   *  另:若已有 slot 但当前 active entry 的 personality 是空字符串(早期版本物化的"骨架"persona),
   *  则用最新 DEFAULT_CHARACTER_PERSONAS 的内容覆盖该 entry,避免面板里看到一片空白。*/
  const ensureSlot = (name: string): CharacterPersonaSlot => {
    const cur = personaSlots[name];
    const seed = DEFAULT_CHARACTER_PERSONAS[name];
    if (cur && cur.personas.length > 0) {
      // 检测空骨架并就地补齐(只补 personality 为空的那一项)
      if (!seed) return cur;
      let mutated = false;
      const fixed = cur.personas.map((p) => {
        if ((p.personality ?? '').trim().length === 0) {
          mutated = true;
          return {
            ...p,
            displayName: (p.displayName ?? '').trim() || seed.displayName,
            personality: seed.personality,
            speakingStyle: seed.speakingStyle,
          };
        }
        return p;
      });
      return mutated ? { ...cur, personas: fixed } : cur;
    }
    const entry = defaultPersonaEntry(
      name,
      seed ?? { displayName: name, personality: '', speakingStyle: '' },
    );
    return { personas: [entry], activeId: entry.id };
  };
  const slot = editingCharacter
    ? personaSlots[editingCharacter] ?? ensureSlot(editingCharacter)
    : null;
  const activePersona =
    slot && slot.personas.find((p) => p.id === slot.activeId)
      ? slot.personas.find((p) => p.id === slot.activeId)!
      : slot?.personas[0] ?? null;

  /** 更新正在编辑的角色 slot */
  const updateSlot = (next: CharacterPersonaSlot) => {
    if (!editingCharacter) return;
    setPersonaSlots((s) => ({ ...s, [editingCharacter]: next }));
  };
  const updateActivePersona = (patch: Partial<CharacterPersonaEntry>) => {
    if (!slot || !activePersona) return;
    updateSlot({
      ...slot,
      personas: slot.personas.map((p) => (p.id === activePersona.id ? { ...p, ...patch } : p)),
    });
  };
  const addPersona = () => {
    if (!editingCharacter || !slot) return;
    const np: CharacterPersonaEntry = {
      id: makePersonaId(),
      name: '新 Persona',
      displayName: editingCharacter,
      personality: '',
      speakingStyle: '',
    };
    updateSlot({ personas: [...slot.personas, np], activeId: np.id });
  };
  const deletePersona = () => {
    if (!slot || slot.personas.length <= 1 || !activePersona) return;
    const rest = slot.personas.filter((p) => p.id !== activePersona.id);
    updateSlot({ personas: rest, activeId: rest[0].id });
  };
  const resetToDefault = () => {
    if (!editingCharacter) return;
    const seed = DEFAULT_CHARACTER_PERSONAS[editingCharacter];
    if (!seed) return;
    const entry = defaultPersonaEntry(editingCharacter, seed);
    updateSlot({ personas: [entry], activeId: entry.id });
  };

  // ====== Model preset 增删 ======
  const addModelPreset = () => {
    const v = model.trim();
    if (!v || modelPresets.includes(v)) return;
    setModelPresets((arr) => [...arr, v]);
  };
  const removeModelPreset = () => {
    setModelPresets((arr) => arr.filter((m) => m !== model));
  };

  // ====== 多厂商 profile 操作 ======
  /** 在已有 profile 名集合中,生成一个不重名的候选名 */
  const uniqueProfileName = (base: string): string => {
    const existing = new Set(providerProfiles.map((p) => p.name));
    if (!existing.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const n = `${base} ${i}`;
      if (!existing.has(n)) return n;
    }
    return base + ' ' + Date.now().toString(36).slice(-4);
  };
  /** 切到另一个 profile:把当前字段写回原 profile,再加载新 profile 字段。 */
  const switchProvider = (id: string) => {
    if (id === activeProviderId || !id) return;
    setProviderProfiles((arr) => {
      const synced = arr.map((p) =>
        p.id === activeProviderId
          ? { ...p, baseURL, apiKey, model, modelPresets }
          : p,
      );
      const next = synced.find((x) => x.id === id);
      if (!next) return synced;
      setActiveProviderId(id);
      setBaseURL(next.baseURL);
      setApiKey(next.apiKey);
      setModel(next.model);
      setModelPresets(next.modelPresets ?? []);
      return synced;
    });
  };
  /** 新建 profile。可选 templateId:从模板预填 baseURL/model/modelPresets;否则建空白。
   *  apiKey 永远空,等用户填。新建后立刻切到它。 */
  const newProfile = (templateId?: string) => {
    const tpl = templateId ? PROVIDER_TEMPLATES.find((t) => t.id === templateId) : null;
    const fresh: ProviderProfile = {
      id: 'p_' + Math.random().toString(36).slice(2, 10),
      name: uniqueProfileName(tpl?.name ?? '新配置'),
      templateId: tpl?.id,
      baseURL: tpl?.baseURL ?? '',
      apiKey: '',
      model: tpl?.models[0] ?? '',
      modelPresets: tpl ? [...tpl.models] : [],
    };
    setProviderProfiles((arr) => {
      const synced = arr.map((p) =>
        p.id === activeProviderId
          ? { ...p, baseURL, apiKey, model, modelPresets }
          : p,
      );
      return [...synced, fresh];
    });
    setActiveProviderId(fresh.id);
    setBaseURL(fresh.baseURL);
    setApiKey('');
    setModel(fresh.model);
    setModelPresets(fresh.modelPresets ?? []);
  };
  /** 开始重命名某个 profile(任何 profile,不限 active) */
  const beginRename = (id: string) => {
    const cur = providerProfiles.find((p) => p.id === id);
    if (!cur) return;
    setRenameDraft(cur.name);
    setRenamingId(id);
  };
  /** 提交重命名:写入 renamingId 对应的 profile */
  const commitRename = () => {
    const id = renamingId;
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!id || !name) return;
    setProviderProfiles((arr) =>
      arr.map((p) => (p.id === id ? { ...p, name } : p)),
    );
  };
  const cancelRename = () => setRenamingId(null);
  /** 删除指定 profile(不一定是当前 active);删完所有时建一个空白"默认"。 */
  const deleteProfile = (id: string) => {
    setProviderProfiles((arr) => {
      const remaining = arr.filter((p) => p.id !== id);
      if (remaining.length === 0) {
        const fresh: ProviderProfile = {
          id: 'p_' + Math.random().toString(36).slice(2, 10),
          name: '默认',
          baseURL: '',
          apiKey: '',
          model: '',
          modelPresets: [],
        };
        setActiveProviderId(fresh.id);
        setBaseURL('');
        setApiKey('');
        setModel('');
        setModelPresets([]);
        return [fresh];
      }
      // 如果删的是 active,自动切到第一个剩余的
      if (id === activeProviderId) {
        const next = remaining[0];
        setActiveProviderId(next.id);
        setBaseURL(next.baseURL);
        setApiKey(next.apiKey);
        setModel(next.model);
        setModelPresets(next.modelPresets ?? []);
      }
      return remaining;
    });
  };

  const save = async () => {
    // 保存时若当前 model 还没在 presets 里 → 自动加入(常见场景:用户刚改了 model 直接保存)
    const presetsToSave = model.trim() && !modelPresets.includes(model.trim())
      ? [...modelPresets, model.trim()]
      : modelPresets;
    // 把当前正在编辑显示的 slot 物化进 personaSlots —
    // 即使用户没修改任何字段,只要打开过面板就把那份 ensureSlot 的内容(默认或之前编辑的)
    // 写回 config,避免 send 时 fallback 到内置默认导致编辑没生效。
    const personasToSave = { ...personaSlots };
    if (editingCharacter && slot && !personasToSave[editingCharacter]) {
      personasToSave[editingCharacter] = slot;
    }
    // 同步当前字段到 active profile
    const profilesToSave: ProviderProfile[] = providerProfiles.map((p) =>
      p.id === activeProviderId
        ? { ...p, baseURL, apiKey, model, modelPresets: presetsToSave }
        : p,
    );
    await window.petAPI?.setConfig?.({
      baseURL,
      apiKey,
      model,
      modelPresets: presetsToSave,
      skills,
      activeSkillId,
      memory,
      characterPersonas: personasToSave,
      providerProfiles: profilesToSave,
      activeProviderId: activeProviderId,
      // agentSkills 由 <AgentSkillsSection /> 自管,save 不写,避免覆盖
    });
    setProviderProfiles(profilesToSave);
    setPersonaSlots(personasToSave);
    setModelPresets(presetsToSave);
    setSavedHint('已保存');
    window.setTimeout(() => setSavedHint(null), 1500);
    // 通知应用其它部分(chat-bubble 顶部名字 / 角色 persona)立即刷新,
    // 不再依赖 2 秒轮询 → 保存即生效
    window.dispatchEvent(new CustomEvent('petAI:configChanged'));
    // 若 persona 实际变化 → 通知 chat-bubble 给当前角色开个新会话,
    // 否则历史里前面的"自称/语气"会被 LLM 当上下文延续,新人设无法生效。
    const prevSlot = (window as unknown as { __lastSavedPersonas?: typeof personasToSave })
      .__lastSavedPersonas?.[editingCharacter ?? ''];
    const curSlot = editingCharacter ? personasToSave[editingCharacter] : null;
    if (editingCharacter && JSON.stringify(prevSlot) !== JSON.stringify(curSlot)) {
      window.dispatchEvent(
        new CustomEvent('petAI:personaChanged', { detail: { characterName: editingCharacter } }),
      );
    }
    (window as unknown as { __lastSavedPersonas?: typeof personasToSave }).__lastSavedPersonas =
      personasToSave;
  };

  return createPortal(
    <div className="pet-menu-panel ai-panel" data-pet-menu-panel="true" ref={aiPanelRef} style={aiPanelStyle}>
      <div className="pet-menu-title" {...aiTitleProps}>
        <button className="back-btn" onClick={onBack}>
          ←
        </button>
        <span>AI 设置</span>
      </div>
      {/* 中间滚动区:面板高度受限时只滚这一段,顶部 title 和底部保存按钮固定 */}
      <div className="ai-panel-body">
      {/* ===== 供应商管理 — 卡片列表 + 模板快建 ===== */}
      <div className="ai-field">
        <span>供应商管理</span>
        {/* 卡片列表 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {providerProfiles.map((p) => {
            const isActive = p.id === activeProviderId;
            const isRenaming = renamingId === p.id;
            return (
              <div
                key={p.id}
                className={'provider-card' + (isActive ? ' active' : '')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  border: '1px solid ' + (isActive ? 'var(--accent, #4a9eff)' : 'rgba(127,127,127,0.2)'),
                  borderRadius: 6,
                  background: isActive ? 'rgba(74,158,255,0.08)' : 'transparent',
                  cursor: isActive ? 'default' : 'pointer',
                }}
                onClick={() => !isRenaming && switchProvider(p.id)}
              >
                {isRenaming ? (
                  <>
                    <input
                      type="text"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') cancelRename();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      style={{ flex: 1, minWidth: 80 }}
                      placeholder="配置名"
                    />
                    <button
                      className="mini-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        commitRename();
                      }}
                      title="确定"
                    >
                      ✓
                    </button>
                    <button
                      className="mini-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelRename();
                      }}
                      title="取消"
                    >
                      ✗
                    </button>
                  </>
                ) : (
                  <>
                    <span style={{ flex: 1, fontWeight: isActive ? 600 : 400 }}>{p.name}</span>
                    {isActive && (
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--accent, #4a9eff)',
                          padding: '2px 6px',
                          border: '1px solid currentColor',
                          borderRadius: 4,
                        }}
                      >
                        ✓ 使用中
                      </span>
                    )}
                    <button
                      className="mini-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        beginRename(p.id);
                      }}
                      title="重命名"
                    >
                      ✎
                    </button>
                    <button
                      className="mini-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteProfile(p.id);
                      }}
                      title="删除此配置"
                    >
                      🗑
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {/* + 添加 按钮 — 点开后展开厂商模板选择菜单;选中后新建 profile,菜单自动收起 */}
        <div style={{ marginTop: 6 }}>
          <button
            className="mini-btn"
            onClick={() => setAddMenuOpen((v) => !v)}
            style={{ whiteSpace: 'nowrap' }}
            title="添加一个新配置"
          >
            {addMenuOpen ? '× 取消' : '+ 添加'}
          </button>
          {addMenuOpen && (
            <div
              className="ai-skill-row"
              style={{
                flexWrap: 'wrap',
                gap: 4,
                marginTop: 6,
                padding: 8,
                border: '1px solid rgba(127,127,127,0.2)',
                borderRadius: 6,
                background: 'rgba(127,127,127,0.05)',
              }}
            >
              <div style={{ width: '100%', fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
                选择厂商预设,或点"自定义"自己填字段:
              </div>
              <button
                className="mini-btn"
                onClick={() => {
                  newProfile();
                  setAddMenuOpen(false);
                }}
                title="新建空白配置(自己手填)"
                style={{ fontSize: 11, whiteSpace: 'nowrap', padding: '2px 8px' }}
              >
                自定义
              </button>
              {PROVIDER_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  className="mini-btn"
                  onClick={() => {
                    newProfile(t.id);
                    setAddMenuOpen(false);
                  }}
                  title={
                    (t.note ?? '') +
                    (t.applyUrl ? `\n申请 key:${t.applyUrl}` : '') +
                    `\nbaseURL:${t.baseURL}`
                  }
                  style={{ fontSize: 11, whiteSpace: 'nowrap', padding: '2px 8px' }}
                >
                  {t.name}
                  {t.vision ? ' 👁' : ''}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* 申请 API key 链接 — 当前 active profile 若关联模板,显示提示 */}
        {(() => {
          const cur = providerProfiles.find((p) => p.id === activeProviderId);
          const tpl = cur?.templateId
            ? PROVIDER_TEMPLATES.find((t) => t.id === cur.templateId)
            : null;
          if (!tpl?.applyUrl) return null;
          return (
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
              {tpl.note && <span>{tpl.note} · </span>}
              <a
                href={tpl.applyUrl}
                onClick={(e) => {
                  e.preventDefault();
                  window.petAPI?.openExternal?.(tpl.applyUrl!);
                }}
                style={{ color: 'var(--accent)', cursor: 'pointer' }}
              >
                申请 API key →
              </a>
            </div>
          );
        })()}
      </div>

      <label className="ai-field">
        <span>baseURL</span>
        <input
          type="text"
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
          placeholder="https://api.openai.com/v1"
        />
      </label>
      <label className="ai-field">
        <span>API Key</span>
        <div className="ai-key-row">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
          />
          <button className="mini-btn" onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </label>
      <div className="ai-field">
        <span>模型</span>
        {modelPresets.length > 0 && (
          <div className="ai-skill-row" style={{ marginBottom: 4 }}>
            <select
              value={modelPresets.includes(model) ? model : ''}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">— 选预设 —</option>
              {modelPresets.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              className="mini-btn"
              onClick={removeModelPreset}
              disabled={!modelPresets.includes(model)}
              title="从预设中删除当前模型"
            >
              −
            </button>
          </div>
        )}
        <div className="ai-skill-row">
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini / deepseek-chat"
          />
          <button
            className="mini-btn"
            onClick={addModelPreset}
            disabled={!model.trim() || modelPresets.includes(model.trim())}
            title="把当前模型加进预设"
          >
            +
          </button>
        </div>
      </div>

      {/* ============ 角色 Persona — 每个模型独立配置 ============ */}
      <div className="ai-section-divider" />

      {/* 编辑哪个模型 — 默认是当前激活角色,可切到任意模型独立设置 */}
      <div className="ai-field">
        <span>角色 Persona</span>
        {allCharacters.length === 0 && (
          <div className="ai-empty-hint">扫描中…还没找到任何 Live2D 模型</div>
        )}
        {allCharacters.length > 0 && (
          <CollapsibleCharacterGroups
            groups={characterGroups}
            className="char-list--persona"
            isActive={(c) => c.name === editingCharacter}
            labelFor={(c) => `${c.name}${c.name === characterName ? ' (当前)' : ''}`}
            onPick={(c) => setEditingCharacter(c.name)}
          />
        )}
      </div>

      {editingCharacter && slot && activePersona && (
        <>
          <div className="ai-field">
            <span>Persona 列表(同一模型可多个,切换试不同性格)</span>
            <div className="ai-skill-row">
              <select
                value={activePersona.id}
                onChange={(e) => updateSlot({ ...slot, activeId: e.target.value })}
              >
                {slot.personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName || p.name}
                  </option>
                ))}
              </select>
              <button className="mini-btn" onClick={addPersona} title="新建 Persona">
                +
              </button>
              <button
                className="mini-btn"
                onClick={deletePersona}
                disabled={slot.personas.length <= 1}
                title="删除当前 Persona"
              >
                −
              </button>
              <button
                className="mini-btn"
                onClick={resetToDefault}
                disabled={!DEFAULT_CHARACTER_PERSONAS[editingCharacter]}
                title="用内置默认重置"
              >
                ↺
              </button>
            </div>
          </div>

          <label className="ai-field">
            <span>对话自称</span>
            <input
              type="text"
              value={activePersona.displayName}
              onChange={(e) =>
                updateActivePersona({
                  displayName: e.target.value,
                  // 同步到 name(列表显示用),保持单一字段直观
                  name: e.target.value || activePersona.name,
                })
              }
              placeholder="AI 自称的名字,也是对话框标题。比如 火火"
            />
          </label>

          <label className="ai-field">
            <span>性格设定</span>
            <textarea
              value={activePersona.personality}
              onChange={(e) => updateActivePersona({ personality: e.target.value })}
              placeholder="2~5 句口语化描述。例如:神秘小魔女,说话带点占卜隐喻,本质温柔。"
              rows={4}
            />
          </label>

          <label className="ai-field">
            <span>说话风格(可选)</span>
            <textarea
              value={activePersona.speakingStyle ?? ''}
              onChange={(e) => updateActivePersona({ speakingStyle: e.target.value })}
              placeholder="句末语气词、口头禅、自称等"
              rows={3}
            />
          </label>
        </>
      )}
      {/* 长期记忆:UI 已下架 — 后续改为自动写入 user 的 .desktopPet 配置文件,
          由 AI 在对话中自动学习累积。memory state 仍保留并随保存写回,避免覆盖旧数据。 */}
      {/* Agent Skills 已迁到「设置 → 编程技能」一处管理,这里不再重复显示,
          避免两处编辑混乱。 */}

      </div>
      {/* 固定底部:保存按钮永远可见,免得每次编辑完要滚到最底 */}
      <div className="ai-panel-footer">
        <button className="mini-btn primary" onClick={save}>
          保存
        </button>
        {savedHint && <span className="ai-saved">{savedHint}</span>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 调整大小滑块 — uncontrolled。React 不去 control input.value,
 * 让 DOM 自己跟手鼠标;否则 slider 控制窗口尺寸时,setWindowSize 引起的
 * React 重渲染会反向把 input.value 拉回旧位置,造成"直接跳最大/最小"的怪现象。
 *
 * 父组件 scale state 通过 props 传入用作初始值 + 重置时同步,期间 prop 改变
 * 只在跟当前 input.value 不一致时才回写一次(`+/-` 按钮 / 重置时)。
 */
function SizeSlider({
  scale,
  onScale,
  onPreviewScale,
  onResetScale,
}: {
  scale: number;
  onScale: (s: number) => void;
  onPreviewScale: (s: number) => void;
  onResetScale: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState(Math.round(scale * 100));
  const draggingRef = useRef(false);
  // prop 变化(+/- 按钮 / 重置)时,如果跟当前 DOM 显示不一致才覆盖;
  // 拖动期间不覆盖,避免被 prop 回写打断
  useEffect(() => {
    if (draggingRef.current) return;
    const want = Math.round(scale * 100);
    if (inputRef.current && parseInt(inputRef.current.value, 10) !== want) {
      inputRef.current.value = String(want);
      setPct(want);
    }
  }, [scale]);
  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    setPct(v);
    // 拖动期间走预览(不改窗口),菜单 popup 不会跟着飘
    onPreviewScale(v / 100);
  };
  const commit = () => {
    if (!inputRef.current) return;
    const v = parseInt(inputRef.current.value, 10);
    draggingRef.current = false;
    // 松手才真正改窗口尺寸 + 持久化
    onScale(v / 100);
  };
  return (
    <>
      <div className="size-row">
        <span className="size-val">{pct}%</span>
        <input
          ref={inputRef}
          type="range"
          min={30}
          max={300}
          step={1}
          defaultValue={pct}
          onPointerDown={() => {
            draggingRef.current = true;
          }}
          onChange={handleInput}
          onPointerUp={commit}
          onPointerCancel={commit}
          onKeyUp={commit}
        />
      </div>
      <div className="size-actions">
        <button
          className="mini-btn"
          onClick={() => onScale(Math.max(0.3, (pct - 10) / 100))}
        >
          −
        </button>
        <button className="mini-btn primary" onClick={onResetScale}>
          重置
        </button>
        <button
          className="mini-btn"
          onClick={() => onScale(Math.min(3, (pct + 10) / 100))}
        >
          +
        </button>
      </div>
    </>
  );
}

/**
 * 通用设置面板。第一项:锁定模型位置(防止误拖)。
 * 后续可在此扩展更多全局开关(如启用整点报时、禁用主动问候等),无需新增按钮。
 *
 * 数据流:
 *   - mount 时读 config 当前值
 *   - toggle 立即调 setConfig 写回
 *   - 写回后 dispatch 'petAI:configChanged',让 character-host 等监听者实时刷新
 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function RuntimeCacheSection(): JSX.Element {
  const [usage, setUsage] = useState<RuntimeCacheUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const refresh = async () => {
    const r = await window.petAPI?.getRuntimeCacheUsage?.();
    if (r) setUsage(r);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const clear = async () => {
    if (
      !window.confirm(
        '清理运行缓存会释放语音模型缓存 / Chromium 缓存。不会删除对话记录和模型位置。清理后重启桌宠效果最明显,确定继续?',
      )
    ) {
      return;
    }
    setBusy(true);
    setHint(null);
    try {
      releaseVoskModel();
      const next = await window.petAPI?.clearRuntimeCache?.();
      if (next) setUsage(next);
      setHint('已清理。若内存没有立刻下降,重启桌宠后会释放得更彻底。');
      window.setTimeout(() => setHint(null), 5000);
    } finally {
      setBusy(false);
    }
  };

  const topItems = (usage?.items ?? []).slice(0, 4);

  return (
    <div className="settings-section">
      <div className="settings-section-title">性能和缓存</div>
      <div className="voice-wake-card">
        <div className="settings-row-desc">
          运行缓存当前约 <b>{formatBytes(usage?.totalBytes ?? 0)}</b>。语音识别 / IndexedDB
          缓存过大时,这里可以手动释放。
        </div>
        {topItems.length > 0 && (
          <div className="settings-row-desc" style={{ display: 'grid', gap: 2 }}>
            {topItems.map((x) => (
              <span key={x.name}>
                {x.name}: {formatBytes(x.bytes)}
              </span>
            ))}
          </div>
        )}
        {hint && <div className="wake-status wake-status--ready">{hint}</div>}
        <div className="voice-wake-card-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="mini-btn" disabled={busy} onClick={() => void refresh()}>
            刷新
          </button>
          <button type="button" className="mini-btn primary" disabled={busy} onClick={() => void clear()}>
            {busy ? '清理中…' : '清理缓存'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* MCP server 预置模板从 shared/mcp-presets.ts 统一导入 — 这里曾有一份本地副本,
 * 容易与 shared 失同步(新增预设只在一边出现就不会显示在 UI 下拉里)。
 * 现在统一从 shared 导入,所有新增预设只需修改 shared/mcp-presets.ts 一处。 */

function SettingsPanel({
  onBack,
  allCharacters,
}: {
  onBack: () => void;
  allCharacters: MenuCharacter[];
}) {
  const { panelRef: setPanelRef, panelStyle: setPanelStyle, titleProps: setTitleProps } =
    useDraggablePanel();
  const [lockPosition, setLockPosition] = useState(false);
  const [defaultCharacterId, setDefaultCharacterId] = useState('');
  /** 编码(增强)模式 — 开启时:
   *   - 聊天框切 ChatGPT 消息流 + 底部居中;模型完整展示
   *   - 自动启用编程相关内置 skill(Code Review / Simplifier / Webapp Testing / MCP Builder 等)
   *   - 自动启用所有已安装 MCP 工具
   *   - 打开通用模型辅助(generalAssist)总开关,让 AI 卡住时可调别的模型救场 */
  const [codingMode, setCodingMode] = useState(false);
  // ----- 开机自启动 state -----
  // supported=false 表示 dev 模式或不支持的系统,UI 显示 disabled + 解释
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [autoLaunchSupported, setAutoLaunchSupported] = useState(false);
  // ----- 主动互动增强 state(全部默认 false,用户勾选才生效) -----
  const [proEnabled, setProEnabled] = useState(false);
  const [proInteractOnSwitch, setProInteractOnSwitch] = useState(true);
  const [proAwareApps, setProAwareApps] = useState(false);
  const [proAwareLongStay, setProAwareLongStay] = useState(false);
  const [proIdleStayMin, setProIdleStayMin] = useState(20);
  const [proAutoReadScreen, setProAutoReadScreen] = useState(false);
  const [proAutoReadBrowser, setProAutoReadBrowser] = useState(false);
  // ----- 对话框语音输入 state -----
  const [voiceInput, setVoiceInput] = useState(false);
  // ----- MCP state(AI 工具)-----
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerSpec[]>([]);
  const [mcpConfirmWrites, setMcpConfirmWrites] = useState(true);
  /** listTools 获取到的工具列表;折叠显示让用户知道 AI 能做什么 */
  const [mcpTools, setMcpTools] = useState<
    Array<{ name: string; rawName: string; serverId: string; description: string }>
  >([]);
  const [mcpRunning, setMcpRunning] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  /** 当前选中的 preset id(给"添加 server"下拉用) */
  const [mcpPresetId, setMcpPresetId] = useState<string>(MCP_PRESETS[0].id);
  /** 哪一条 server 当前展开(显示 args/env 编辑器);用 id 标识 */
  const [mcpExpandedId, setMcpExpandedId] = useState<string | null>(null);
  /** 一键安装实时日志(每个 preset 独立),null 表示未触发 / 已收起。 */
  const [installLog, setInstallLog] = useState<string[] | null>(null);
  const [installing, setInstalling] = useState(false);
  /** 安装完成后的引导提示(postSetupHint + url),null 表示无 */
  const [installResult, setInstallResult] = useState<{
    hint?: string;
    url?: string;
  } | null>(null);

  // 订阅一键安装日志
  useEffect(() => {
    const off = window.petAPI?.onMcpInstallLog?.((p) => {
      setInstallLog((arr) => [...(arr ?? []), p.line]);
    });
    return () => {
      off?.();
    };
  }, []);

  /** 触发一键安装 */
  const oneClickInstall = async () => {
    const preset = MCP_PRESETS.find((p) => p.id === mcpPresetId);
    if (!preset?.oneClickInstall) return;
    setInstalling(true);
    setInstallLog([]);
    setInstallResult(null);
    try {
      const r = await window.petAPI?.mcpOneClickInstall?.(preset.id);
      if (r) {
        // 重新拉服务器列表 + tools
        const cfg = await window.petAPI?.getConfig?.();
        if (cfg?.mcp?.servers) setMcpServers(cfg.mcp.servers);
        const tools = (await window.petAPI?.mcpListTools?.()) ?? [];
        setMcpTools(tools);
        setInstallResult({ hint: r.postSetupHint, url: r.postSetupUrl });
      }
    } catch (e) {
      setInstallLog((arr) => [...(arr ?? []), `✗ 安装失败:${String((e as Error).message)}`]);
    } finally {
      setInstalling(false);
    }
  };
  /** 是否给开发者显示 MCP 高级设置 — 普通用户应该让 AI 自动装/配,这块面板默认隐藏。
   *  开发者可在 DevTools 里 `localStorage.setItem('desktopPet:devMode','true')` 后刷新打开。 */
  const [showMcpAdvanced] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem('desktopPet:devMode') === 'true',
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.petAPI?.getConfig?.().then((cfg) => {
      if (cancelled) return;
      setLockPosition(!!cfg.lockPosition);
      setDefaultCharacterId(cfg.defaultCharacterId ?? '');
      setCodingMode(!!cfg.codingMode);
      // 异步拉自启动状态(主进程读 OS API,与 cfg 无关)
      void window.petAPI?.getAutoLaunch?.().then((r) => {
        if (cancelled) return;
        setAutoLaunch(r.enabled);
        setAutoLaunchSupported(r.supported);
      });
      // 主动互动配置
      const pro = cfg.proactive;
      setProEnabled(!!pro?.enabled);
      setProInteractOnSwitch(pro?.interactOnSwitch !== false);
      setProAwareApps(!!pro?.awareApps);
      setProAwareLongStay(!!pro?.awareLongStay);
      setProIdleStayMin(typeof pro?.idleStayMinutes === 'number' ? pro.idleStayMinutes : 20);
      setProAutoReadScreen(!!pro?.autoReadScreen);
      setProAutoReadBrowser(!!pro?.autoReadBrowser);
      const vw = cfg.voiceWake;
      setVoiceInput(!!vw?.voiceInput);
      // MCP 配置读入
      const mcp = cfg.mcp;
      setMcpEnabled(!!mcp?.enabled);
      setMcpServers(Array.isArray(mcp?.servers) ? mcp!.servers : []);
      setMcpConfirmWrites(mcp?.confirmWrites !== false);
      setLoaded(true);
      // 异步拉 tools 列表和运行状态
      void refreshMcp();
      if (vw?.enabled) {
        void window.petAPI?.setConfig?.({
          ...cfg,
          voiceWake: { ...vw, enabled: false, voiceInput: !!vw.voiceInput },
        });
        window.dispatchEvent(new CustomEvent('petAI:configChanged'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 监听外部对 cfg 的改动(编码模式一键启用会写 mcp.enabled / mcp.servers)
   *  → 把本面板的 MCP 相关 state 重新从 cfg 拉一遍,保证勾选状态立刻跟上。
   *  其它字段(voiceWake / proactive / lockPosition 等)基本只本组件自己改,不需要同步。 */
  useEffect(() => {
    const onCfg = async () => {
      const cfg = await window.petAPI?.getConfig?.();
      if (!cfg) return;
      setCodingMode(!!cfg.codingMode);
      setDefaultCharacterId(cfg.defaultCharacterId ?? '');
      const mcp = cfg.mcp;
      setMcpEnabled(!!mcp?.enabled);
      setMcpServers(Array.isArray(mcp?.servers) ? mcp!.servers : []);
      setMcpConfirmWrites(mcp?.confirmWrites !== false);
      void refreshMcp();
    };
    window.addEventListener('petAI:configChanged', onCfg);
    return () => window.removeEventListener('petAI:configChanged', onCfg);
  }, []);

  /** 写回 config 并广播,所有监听者实时刷新 */
  const persist = async (
    patch: Partial<{
      lockPosition: boolean;
      defaultCharacterId?: string;
      codingMode: boolean;
      voiceWake: { enabled?: boolean; voiceInput?: boolean };
    }>,
  ) => {
    const cfg = await window.petAPI?.getConfig?.();
    if (!cfg) return;
    await window.petAPI?.setConfig?.({ ...cfg, ...patch });
    window.dispatchEvent(new CustomEvent('petAI:configChanged'));
  };

  const updateLock = async (next: boolean) => {
    setLockPosition(next);
    await persist({ lockPosition: next });
  };
  const updateDefaultCharacter = async (next: string) => {
    setDefaultCharacterId(next);
    await persist({ defaultCharacterId: next || undefined });
  };
  /** 编码模式自动启用的「编程相关」内置 skill rawId 白名单 —
   *  覆盖 superpowers / planning / code-review / code-simplifier / webapp-testing /
   *  ralph-loop / mcp-builder。其它(UI/UX、PPTX、Skill Creator)非必需,留给用户手选。 */
  const CODING_BUILTIN_SKILLS = [
    'superpowers',
    'planning-with-files',
    'code-review',
    'code-simplifier',
    'webapp-testing',
    'ralph-loop',
    'mcp-builder',
  ];

  /** 一键启用编码模式所需配套 — 编程 builtin skills + 全部 MCP servers + 总开关。
   *  不回滚:用户关闭编码模式后这些保持不变,避免覆盖用户后续手动调过的值。 */
  const applyCodingModePreset = async () => {
    const cfg = await window.petAPI?.getConfig?.();
    if (!cfg) return;
    // 1) Agent Skills:总开关打开 + 把编程白名单合并进 builtinEnabled(并集,不动用户其他选择)
    const enabledSet = new Set(cfg.agentSkills?.builtinEnabled ?? []);
    CODING_BUILTIN_SKILLS.forEach((id) => enabledSet.add(id));
    const nextAgentSkills = {
      enabled: true,
      sources: cfg.agentSkills?.sources ?? [],
      localDisabled: cfg.agentSkills?.localDisabled ?? [],
      builtinEnabled: Array.from(enabledSet),
    };
    // 2) MCP:总开关 + 所有已安装 server 全部 enabled(编程要工具能跑就行,粗一点没关系)
    const nextMcp = cfg.mcp
      ? {
          ...cfg.mcp,
          enabled: true,
          servers: (cfg.mcp.servers ?? []).map((s) => ({ ...s, enabled: true })),
        }
      : cfg.mcp;
    // 3) 模型协同(generalAssist):打开总开关,让 AI 干不动时能调 delegate_to_model 找别的模型救场。
    //    具体辅助 model 等用户在 AI 设置里选 — 这里只开总开关,不强行指派 profile。
    const nextGeneralAssist = cfg.generalAssist
      ? { ...cfg.generalAssist, enabled: true }
      : cfg.generalAssist;
    await window.petAPI?.setConfig?.({
      ...cfg,
      agentSkills: nextAgentSkills,
      mcp: nextMcp,
      generalAssist: nextGeneralAssist,
    });
    window.dispatchEvent(new CustomEvent('petAI:configChanged'));
  };

  const updateCodingMode = async (next: boolean) => {
    setCodingMode(next);
    await persist({ codingMode: next });
    if (next) {
      // 一键应用编码预设(编程 skill + MCP 全开)。关闭模式不回滚,留给用户。
      await applyCodingModePreset();
    }
  };
  /** 切换开机自启动 — 写 OS 注册表(Windows)或 Login Items(macOS),不写 cfg */
  const updateAutoLaunch = async (next: boolean) => {
    setAutoLaunch(next); // 乐观更新,失败时主进程返回真实状态修正
    const r = await window.petAPI?.setAutoLaunch?.(next);
    if (r) setAutoLaunch(r.enabled);
  };

  /** 主动互动配置 — 持久化到 cfg.proactive。任何字段变了写整段(主进程拿到自动 refresh 后台轮询) */
  const persistProactive = async (
    patch: Partial<{
      enabled: boolean;
      interactOnSwitch: boolean;
      awareApps: boolean;
      awareLongStay: boolean;
      idleStayMinutes: number;
      autoReadScreen: boolean;
      autoReadBrowser: boolean;
    }>,
  ) => {
    const next = {
      enabled: patch.enabled ?? proEnabled,
      interactOnSwitch: patch.interactOnSwitch ?? proInteractOnSwitch,
      awareApps: patch.awareApps ?? proAwareApps,
      awareLongStay: patch.awareLongStay ?? proAwareLongStay,
      idleStayMinutes: patch.idleStayMinutes ?? proIdleStayMin,
      autoReadScreen: patch.autoReadScreen ?? proAutoReadScreen,
      autoReadBrowser: patch.autoReadBrowser ?? proAutoReadBrowser,
    };
    const cfg = await window.petAPI?.getConfig?.();
    if (!cfg) return;
    await window.petAPI?.setConfig?.({ ...cfg, proactive: next });
    window.dispatchEvent(new CustomEvent('petAI:configChanged'));
  };

  const updateVoiceInput = async (next: boolean) => {
    setVoiceInput(next);
    const cfg = await window.petAPI?.getConfig?.();
    if (!cfg) return;
    await window.petAPI?.setConfig?.({
      ...cfg,
      voiceWake: { ...(cfg.voiceWake ?? {}), enabled: false, voiceInput: next },
    });
    window.dispatchEvent(new CustomEvent('petAI:configChanged'));
  };

  // ----- MCP 操作 -----
  /** 从主进程拉一次状态 + tools 列表(setConfig 后 server 重启有延迟) */
  const refreshMcp = async (): Promise<void> => {
    try {
      const status = await window.petAPI?.mcpGetStatus?.();
      setMcpRunning(!!status?.running);
      const tools = (await window.petAPI?.mcpListTools?.()) ?? [];
      setMcpTools(
        tools.map((t) => ({
          name: t.name,
          rawName: t.rawName,
          serverId: t.serverId,
          description: t.description,
        })),
      );
    } catch {
      // ignore
    }
  };
  /** 写回 mcp 配置 — 主进程会自动 applyConfig 重启 servers。 */
  const persistMcp = async (
    patch: Partial<{ enabled: boolean; servers: McpServerSpec[]; confirmWrites: boolean }>,
  ) => {
    setMcpBusy(true);
    const cfg = await window.petAPI?.getConfig?.();
    if (!cfg) {
      setMcpBusy(false);
      return;
    }
    const merged = {
      enabled: patch.enabled ?? mcpEnabled,
      servers: patch.servers ?? mcpServers,
      confirmWrites: patch.confirmWrites ?? mcpConfirmWrites,
    };
    await window.petAPI?.setConfig?.({ ...cfg, mcp: merged });
    window.dispatchEvent(new CustomEvent('petAI:configChanged'));
    // server 异步启动,给它点时间再 refresh
    setTimeout(() => {
      void refreshMcp().finally(() => setMcpBusy(false));
    }, 800);
  };
  const updateMcpEnabled = async (next: boolean) => {
    setMcpEnabled(next);
    await persistMcp({ enabled: next });
  };
  const updateMcpConfirmWrites = async (next: boolean) => {
    setMcpConfirmWrites(next);
    await persistMcp({ confirmWrites: next });
  };
  /** 生成一个唯一 id(基于 preset id + 后缀) */
  const genServerId = (base: string): string => {
    const used = new Set(mcpServers.map((s) => s.id));
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base}${i}`)) i++;
    return `${base}${i}`;
  };
  /** 基于选中的 preset 添加一条 server */
  const addServerFromPreset = async () => {
    const preset = MCP_PRESETS.find((p) => p.id === mcpPresetId);
    if (!preset) return;
    const id = genServerId(preset.id);
    const spec: McpServerSpec = { id, enabled: true, ...preset.template };
    const next = [...mcpServers, spec];
    setMcpServers(next);
    setMcpExpandedId(id);
    await persistMcp({ servers: next });
  };
  /** 删除一条 server */
  const removeServer = async (id: string) => {
    const next = mcpServers.filter((s) => s.id !== id);
    setMcpServers(next);
    if (mcpExpandedId === id) setMcpExpandedId(null);
    await persistMcp({ servers: next });
  };
  /** 修改某条 server(整体替换),会立即 persist */
  const updateServer = async (id: string, patch: Partial<McpServerSpec>) => {
    const next = mcpServers.map((s) => (s.id === id ? { ...s, ...patch } : s));
    setMcpServers(next);
    await persistMcp({ servers: next });
  };
  /** 简化版"修改设置":根据 server 的 command + args + env 推断它属于哪种类型,
   *  返回一个用户视角的"可改字段"描述 — 用人话不暴露 args/env 这种技术细节。
   *  - 'fs'         → 目录白名单(args 全是目录)
   *  - 'env-token'  → 单个 API key 类 env(GitHub / Brave 等),显示 password 输入
   *  - 'arg-path'   → args 里有一个 <…路径> 占位符或单一路径(SQLite / Git 等)
   *  - 'arg-url'    → args 里有连接 URL(Postgres)
   *  - 'no-config'  → 无可改字段(Memory / Puppeteer / Fetch / Time / SequentialThinking)
   *  - 'custom'     → 不属于以上,普通区不展开,提示去高级编辑 */
  type FriendlyKind =
    | { kind: 'fs' }
    | { kind: 'env-token'; envKey: string; label: string; help?: string }
    | { kind: 'arg-path'; argIndex: number; label: string; pickFile?: boolean; pickDir?: boolean }
    | { kind: 'arg-url'; argIndex: number; label: string; placeholder?: string }
    | { kind: 'no-config'; reason: string }
    | { kind: 'custom' };
  const detectServerKind = (s: McpServerSpec): FriendlyKind => {
    if (s.command === 'bundled-fs') return { kind: 'fs' };
    const argStr = s.args.join(' ');
    // GitHub
    if (s.env && 'GITHUB_PERSONAL_ACCESS_TOKEN' in s.env) {
      return {
        kind: 'env-token',
        envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub Personal Access Token',
        help: '在 github.com/settings/tokens 申请。需要 repo / read:user 等权限。',
      };
    }
    if (s.env && 'BRAVE_API_KEY' in s.env) {
      return {
        kind: 'env-token',
        envKey: 'BRAVE_API_KEY',
        label: 'Brave Search API Key',
        help: '在 brave.com/search/api 申请,有免费额度。',
      };
    }
    // Git: uvx mcp-server-git --repository <path>
    const repoIdx = s.args.indexOf('--repository');
    if (repoIdx >= 0 && repoIdx + 1 < s.args.length) {
      return { kind: 'arg-path', argIndex: repoIdx + 1, label: 'Git 仓库目录', pickDir: true };
    }
    // SQLite: --db-path <file>
    const dbIdx = s.args.indexOf('--db-path');
    if (dbIdx >= 0 && dbIdx + 1 < s.args.length) {
      return { kind: 'arg-path', argIndex: dbIdx + 1, label: 'SQLite 数据库文件', pickFile: true };
    }
    // Chrome DevTools: --browserUrl http://...
    const burlIdx = s.args.indexOf('--browserUrl');
    if (burlIdx >= 0 && burlIdx + 1 < s.args.length) {
      return {
        kind: 'arg-url',
        argIndex: burlIdx + 1,
        label: 'Chrome 调试端口 URL',
        placeholder: 'http://localhost:9222',
      };
    }
    // Postgres: 最后一个 arg 像 postgresql://
    const lastArg = s.args[s.args.length - 1];
    if (typeof lastArg === 'string' && /^postgres(?:ql)?:\/\//.test(lastArg)) {
      return {
        kind: 'arg-url',
        argIndex: s.args.length - 1,
        label: 'Postgres 连接 URL',
        placeholder: 'postgresql://user:pwd@host:5432/db',
      };
    }
    // Chrome MCP:command='node',args[0] 是 stdio.js 绝对路径(以 .js 结尾)
    if (s.command === 'node' && s.args.length === 1 && /\.js$/i.test(s.args[0])) {
      return {
        kind: 'arg-path',
        argIndex: 0,
        label: 'Chrome MCP stdio 入口文件',
        pickFile: true,
      };
    }
    // 已知"无需配置"列表 — 这些 server 加进来即可用,没有可改字段
    const noConfigPackages = [
      '@modelcontextprotocol/server-puppeteer',
      '@modelcontextprotocol/server-memory',
      '@modelcontextprotocol/server-sequential-thinking',
      '@browsermcp/mcp@latest',
      'mcp-server-fetch',
      'mcp-server-time',
    ];
    if (noConfigPackages.some((p) => argStr.includes(p))) {
      return { kind: 'no-config', reason: '此工具开箱即用,没有可改的设置。' };
    }
    return { kind: 'custom' };
  };
  /** 改 args 里某个下标的值(用于 arg-path / arg-url) */
  const updateServerArgAt = async (id: string, idx: number, value: string) => {
    const cur = mcpServers.find((s) => s.id === id);
    if (!cur) return;
    const next = [...cur.args];
    next[idx] = value;
    await updateServer(id, { args: next });
  };
  /** 弹原生选文件框(单选)。filters 可指定扩展名过滤(如 [{name:'.db', extensions:['db']}]) */
  const pickOneFile = async (
    filters?: Array<{ name: string; extensions: string[] }>,
    title?: string,
  ): Promise<string | null> => {
    return (await window.petAPI?.mcpPickFile?.({ filters, title })) ?? null;
  };
  /** filesystem(bundled-fs)专用:用原生选目录框追加目录到 args */
  const addFsRootTo = async (id: string) => {
    const picked = (await window.petAPI?.mcpPickDirectory?.()) ?? [];
    if (picked.length === 0) return;
    const cur = mcpServers.find((s) => s.id === id);
    if (!cur) return;
    const merged = Array.from(new Set([...cur.args, ...picked]));
    await updateServer(id, { args: merged });
  };
  const restartMcp = async () => {
    setMcpBusy(true);
    try {
      await window.petAPI?.mcpRestart?.();
      await refreshMcp();
    } finally {
      setMcpBusy(false);
    }
  };
  return createPortal(
    <div className="pet-menu-panel" data-pet-menu-panel="true" ref={setPanelRef} style={setPanelStyle}>
      <div className="pet-menu-title" {...setTitleProps}>
        <button className="back-btn" onClick={onBack}>
          ←
        </button>
        <span>设置</span>
      </div>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-name">锁定模型位置</span>
            <span className="settings-row-desc">
              开启后拖动桌宠不会移动窗口,避免不小心碰到把它划走。
            </span>
          </div>
          <input
            type="checkbox"
            className="settings-toggle"
            checked={lockPosition}
            disabled={!loaded}
            onChange={(e) => updateLock(e.target.checked)}
          />
        </label>

        <label className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-name">默认打开模型</span>
            <span className="settings-row-desc">
              不指定时启动自动打开第一个 Hatch-Pet;如果没有 Hatch-Pet,再回退到 Live2D。
            </span>
          </div>
          <select
            value={defaultCharacterId}
            disabled={!loaded}
            onChange={(e) => updateDefaultCharacter(e.target.value)}
          >
            <option value="">自动:第一个 Hatch-Pet</option>
            {groupedCharacters(allCharacters).map((group) => (
              <optgroup key={group.category} label={group.category}>
                {group.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-name">编码(增强)模式</span>
            <span className="settings-row-desc">
              开启后:对话框变 ChatGPT 风格消息流(底部居中、可 resize、支持编辑历史消息),
              并自动启用编程相关内置 skill + 所有 MCP 工具 + 模型协同辅助(让 AI 卡住时可让别的模型救场)。
              关闭只还原对话框样式,skill/MCP 的启用状态保持不变(避免覆盖你后续手动调过的)。
            </span>
          </div>
          <input
            type="checkbox"
            className="settings-toggle"
            checked={codingMode}
            disabled={!loaded}
            onChange={(e) => void updateCodingMode(e.target.checked)}
          />
        </label>

        <label className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-name">开机自动启动</span>
            <span className="settings-row-desc">
              {autoLaunchSupported
                ? '开启后,Windows 登录时会自动启动桌宠,常驻陪伴你。'
                : '当前是开发模式 / 不支持的系统,只在打包发布版本里可用。'}
            </span>
          </div>
          <input
            type="checkbox"
            className="settings-toggle"
            checked={autoLaunch}
            disabled={!autoLaunchSupported}
            onChange={(e) => void updateAutoLaunch(e.target.checked)}
          />
        </label>

        {/* ===== 模型辅助(2 个总开关,详细配置在 AI 设置面板) ===== */}
        <AssistEnableSection />

        <RuntimeCacheSection />

        {/* ===== 主动互动增强 ===== */}
        <div className="settings-section">
          <div className="settings-section-title">主动互动(可选)</div>
          <div className="settings-row-desc" style={{ marginBottom: 6, opacity: 0.7 }}>
            让桌宠"活起来":切换角色时打招呼、感知你切到什么应用主动搭话等。
            所有触发都只在桌宠可见时进行,隐藏到托盘后停止。
          </div>

          <label className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-name">启用主动互动</span>
              <span className="settings-row-desc">总开关。关闭后下面的子选项全部失效。</span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={proEnabled}
              onChange={(e) => {
                setProEnabled(e.target.checked);
                void persistProactive({ enabled: e.target.checked });
              }}
            />
          </label>

          <label className="settings-row" style={{ opacity: proEnabled ? 1 : 0.45 }}>
            <div className="settings-row-text">
              <span className="settings-row-name">切换角色时打招呼</span>
              <span className="settings-row-desc">从托盘 / 菜单切到新角色后,新角色会主动说一句话打招呼。</span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={proInteractOnSwitch}
              disabled={!proEnabled}
              onChange={(e) => {
                setProInteractOnSwitch(e.target.checked);
                void persistProactive({ interactOnSwitch: e.target.checked });
              }}
            />
          </label>

          <label className="settings-row" style={{ opacity: proEnabled ? 1 : 0.45 }}>
            <div className="settings-row-text">
              <span className="settings-row-name">感知前台应用切换</span>
              <span className="settings-row-desc">
                你切到不同应用(VS Code / 浏览器 / 微信 等)时,角色会用人设口吻搭话一句。
                每应用 5 分钟冷却,不会刷屏。
              </span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={proAwareApps}
              disabled={!proEnabled}
              onChange={(e) => {
                setProAwareApps(e.target.checked);
                void persistProactive({ awareApps: e.target.checked });
              }}
            />
          </label>

          <label className="settings-row" style={{ opacity: proEnabled ? 1 : 0.45 }}>
            <div className="settings-row-text">
              <span className="settings-row-name">长时间专注关心一下</span>
              <span className="settings-row-desc">
                同一应用停留超过下面分钟数,角色会关心一句(每个应用每次会话只触发一次)。
              </span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={proAwareLongStay}
              disabled={!proEnabled}
              onChange={(e) => {
                setProAwareLongStay(e.target.checked);
                void persistProactive({ awareLongStay: e.target.checked });
              }}
            />
          </label>

          {proAwareLongStay && proEnabled && (
            <div className="settings-row">
              <div className="settings-row-text">
                <span className="settings-row-name">触发分钟数</span>
                <span className="settings-row-desc">至少 5 分钟。常用 15~30。</span>
              </div>
              <input
                type="number"
                className="settings-num-input"
                min={5}
                max={120}
                step={5}
                value={proIdleStayMin}
                onChange={(e) => {
                  const v = Math.max(5, Math.min(120, Number(e.target.value) || 20));
                  setProIdleStayMin(v);
                  void persistProactive({ idleStayMinutes: v });
                }}
              />
            </div>
          )}

          <label className="settings-row" style={{ opacity: proEnabled && proAwareApps ? 1 : 0.45 }}>
            <div className="settings-row-text">
              <span className="settings-row-name">自动读屏给 AI 当 context(隐私)</span>
              <span className="settings-row-desc">
                ⚠ 切应用时自动调读屏工具,把当前窗口的元素喂给 AI,让搭话更贴合你在做什么。
                介意隐私可保持关闭。
              </span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={proAutoReadScreen}
              disabled={!proEnabled || !proAwareApps}
              onChange={(e) => {
                setProAutoReadScreen(e.target.checked);
                void persistProactive({ autoReadScreen: e.target.checked });
              }}
            />
          </label>

          <label className="settings-row" style={{ opacity: proEnabled && proAwareApps ? 1 : 0.45 }}>
            <div className="settings-row-text">
              <span className="settings-row-name">切到浏览器时自动读页面</span>
              <span className="settings-row-desc">
                配合 BrowserMCP / Chrome MCP 工具(需要先在「我的工具」里装好),
                切到 Chrome / Edge 时让 AI 读当前标签页内容再搭话。
              </span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={proAutoReadBrowser}
              disabled={!proEnabled || !proAwareApps}
              onChange={(e) => {
                setProAutoReadBrowser(e.target.checked);
                void persistProactive({ autoReadBrowser: e.target.checked });
              }}
            />
          </label>
        </div>

        {/* ===== 对话框语音输入 ===== */}
        <div className="settings-section">
          <div className="settings-section-title">语音输入</div>
          <VoskModelSection />
          <label className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-name">对话框语音输入</span>
              <span className="settings-row-desc">
                开启后,对话框输入区出现 🎤 按钮,点击即可语音转文字。说完一段话(静默)自动发送给 AI。
                语音识别只在点击麦克风时启动。
              </span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={voiceInput}
              disabled={!loaded}
              onChange={(e) => updateVoiceInput(e.target.checked)}
            />
          </label>

          {/* ===== 长期记忆 — 让用户直接管理 AI 的"长期记忆"。
                可折叠的 details,标题 / 描述 / 记忆数都在组件内部的 summary 里渲染。 ===== */}
          <MemorySection />

          {/* ===== Hatch-Pet 角色管理 —— 列出 codex 生成的桌宠 + 导入文件夹。
                builtin 来自 app/hatch-pet 或 resourcesPath/hatch-pet,user 在 userData 可删。 ===== */}
          <HatchPetSection />

          {/* ===== Agent Skills(在线 SKILL 仓库 + 本地 .md 上传)
                对所有用户可见,与 AI 设置面板共享同一份组件 ===== */}
          <div className="settings-section-title">Agent Skills</div>
          <div className="settings-row-desc" style={{ marginBottom: 6, opacity: 0.7 }}>
            AI 在相关问题里会自动查阅这里启用的 SKILL.md 作为参考。
          </div>
          <AgentSkillsSection />

          {/* ===== AI 能力扩展(对所有用户可见)— 只列出有"一键安装"的 preset。
                让普通用户能直接装上推荐的能力(如 Chrome MCP),不接触 args/env 等技术细节。
                高级配置(自定义 args/env、添加任意 server)还是藏在 devMode 里。 ===== */}
          {(() => {
            const installable = MCP_PRESETS.filter((p) => p.oneClickInstall);
            if (installable.length === 0) return null;
            return (
              <>
                <div className="settings-section-title">AI 能力扩展(可选)</div>
                <div className="settings-row-desc" style={{ marginBottom: 8, opacity: 0.7 }}>
                  桌宠默认已具备读屏、读剪贴板、HTTP 抓取、文件读写等基础能力。
                  下面这些是**可选增强**,点「一键安装」即可,不用懂命令行。
                </div>
                {installable.map((p) => {
                  // 是否已经装过(以 preset.id 前缀判断)
                  const alreadyHave = mcpServers.some((s) => s.id.startsWith(p.id));
                  return (
                    <div key={p.id} className="voice-wake-card" style={{ marginBottom: 8 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{p.label}</div>
                      <div className="settings-row-desc" style={{ marginBottom: 6 }}>
                        {p.description}
                      </div>
                      <div className="voice-wake-card-row" style={{ gap: 8 }}>
                        <button
                          className="mini-btn"
                          onClick={() => {
                            setMcpPresetId(p.id);
                            void oneClickInstall();
                          }}
                          disabled={installing || alreadyHave}
                          title={alreadyHave ? '已经装过' : '桌宠自动跑 npm install -g 并探测路径'}
                        >
                          {alreadyHave
                            ? '✓ 已安装'
                            : installing && mcpPresetId === p.id
                              ? '安装中…'
                              : '⚡ 一键安装'}
                        </button>
                      </div>
                      {/* 当前正在装的那条 preset 显示日志 + 完成提示 */}
                      {mcpPresetId === p.id && installLog && (
                        <div
                          style={{
                            marginTop: 8,
                            maxHeight: 180,
                            overflow: 'auto',
                            background: '#1f2230',
                            color: '#dde3ee',
                            fontFamily: 'monospace',
                            fontSize: 11,
                            padding: 8,
                            borderRadius: 6,
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {installLog.length === 0 ? '准备中…' : installLog.join('\n')}
                        </div>
                      )}
                      {mcpPresetId === p.id && installResult && (
                        <div
                          style={{
                            marginTop: 8,
                            padding: 10,
                            background: 'rgba(40, 180, 100, 0.08)',
                            border: '1px solid rgba(40, 180, 100, 0.4)',
                            borderRadius: 6,
                            whiteSpace: 'pre-wrap',
                            fontSize: 12,
                          }}
                        >
                          {installResult.hint}
                          {installResult.url && (
                            <div style={{ marginTop: 6 }}>
                              <button
                                className="mini-btn"
                                onClick={() => {
                                  void window.petAPI?.openExternal?.(installResult.url ?? '');
                                }}
                              >
                                打开下载页
                              </button>
                              <button
                                className="mini-btn"
                                style={{ marginLeft: 6 }}
                                onClick={() => setInstallResult(null)}
                              >
                                知道了
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            );
          })()}

          {/* ===== 我的工具(对所有人可见)— 列出已安装 server,用人话提供「修改设置」。
                只有 custom / 复杂的才提示去高级编辑。 ===== */}
          {mcpServers.length > 0 && (
            <details className="mcp-tools-collapsible" open>
              <summary className="settings-section-title mcp-tools-summary">
                <span>我的工具</span>
                <span className="ai-skills-group-count">
                  {mcpServers.filter((s) => s.enabled).length} / {mcpServers.length}
                </span>
              </summary>
              <div className="settings-row-desc" style={{ marginBottom: 8, opacity: 0.7 }}>
                这里是已经安装的工具。可以禁用、删除、或改它们各自的关键设置(如目录、Token、文件路径)。
              </div>
              {/* 工具卡片双列 grid — 压缩竖向空间。展开「修改设置」时该卡片 span 满宽。 */}
              <div className="mcp-tools-grid">
              {mcpServers.map((s) => {
                const friendly = detectServerKind(s);
                const expanded = mcpExpandedId === s.id;
                return (
                  <div
                    key={s.id}
                    className="voice-wake-card mcp-tool-card"
                    data-expanded={expanded || undefined}
                    style={{ marginBottom: 0 }}
                  >
                    <div className="voice-wake-card-row" style={{ alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={mcpBusy}
                        onChange={(e) => void updateServer(s.id, { enabled: e.target.checked })}
                        title={s.enabled ? '已启用,点击停用' : '已停用,点击启用'}
                      />
                      <strong style={{ flex: 1, fontSize: 13 }}>{s.name}</strong>
                      {friendly.kind !== 'custom' && (
                        <button
                          className="mini-btn"
                          onClick={() => setMcpExpandedId(expanded ? null : s.id)}
                          disabled={friendly.kind === 'no-config'}
                          title={
                            friendly.kind === 'no-config' ? friendly.reason : '修改这个工具的设置'
                          }
                        >
                          {expanded ? '收起' : '修改设置'}
                        </button>
                      )}
                      <button
                        className="mini-btn"
                        onClick={() => {
                          if (confirm(`确定要删除工具「${s.name}」吗?(只是从列表移除,不卸载已下载的包)`)) {
                            void removeServer(s.id);
                          }
                        }}
                        disabled={mcpBusy}
                      >
                        删除
                      </button>
                    </div>

                    {/* no-config:即便点不开也显示一行说明 */}
                    {friendly.kind === 'no-config' && (
                      <div className="settings-row-desc" style={{ marginTop: 4, opacity: 0.7, fontSize: 11 }}>
                        ℹ {friendly.reason}
                      </div>
                    )}
                    {/* custom:不属于已知类型,提示去高级 */}
                    {friendly.kind === 'custom' && (
                      <div className="settings-row-desc" style={{ marginTop: 4, opacity: 0.7, fontSize: 11 }}>
                        ⚙ 这是自定义工具,改设置请打开下方「开发者高级」区域。
                      </div>
                    )}

                    {/* 友好编辑面板 */}
                    {expanded && friendly.kind === 'fs' && (
                      <div style={{ marginTop: 10, fontSize: 12 }}>
                        <div style={{ marginBottom: 6 }}>
                          允许 AI 访问的目录(每行一个,只列出的目录里它能读写)
                        </div>
                        {s.args.length === 0 && (
                          <div className="settings-row-desc" style={{ opacity: 0.7, marginBottom: 6 }}>
                            (还没添加,AI 没法读写任何目录)
                          </div>
                        )}
                        {s.args.map((dir, i) => (
                          <div
                            key={i}
                            className="voice-wake-card-row"
                            style={{ gap: 6, marginBottom: 4, alignItems: 'center' }}
                          >
                            <code
                              style={{
                                flex: 1,
                                fontSize: 11,
                                padding: '2px 6px',
                                background: 'rgba(0,0,0,0.05)',
                                borderRadius: 4,
                                wordBreak: 'break-all',
                              }}
                            >
                              {dir}
                            </code>
                            <button
                              className="mini-btn"
                              onClick={() =>
                                void updateServer(s.id, {
                                  args: s.args.filter((_, j) => j !== i),
                                })
                              }
                              disabled={mcpBusy}
                              title="移除此目录"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <button
                          className="mini-btn"
                          onClick={() => void addFsRootTo(s.id)}
                          disabled={mcpBusy}
                          style={{ marginTop: 4 }}
                        >
                          + 添加目录
                        </button>
                      </div>
                    )}

                    {expanded && friendly.kind === 'env-token' && (
                      <div style={{ marginTop: 10, fontSize: 12 }}>
                        <label style={{ display: 'block', marginBottom: 4 }}>
                          {friendly.label}
                        </label>
                        <input
                          type="password"
                          value={s.env?.[friendly.envKey] ?? ''}
                          onChange={(e) => {
                            const env = { ...(s.env ?? {}), [friendly.envKey]: e.target.value };
                            void updateServer(s.id, { env });
                          }}
                          style={{ width: '100%', fontFamily: 'monospace' }}
                          placeholder={`粘贴你的 ${friendly.label}`}
                        />
                        {friendly.help && (
                          <div className="settings-row-desc" style={{ opacity: 0.7, marginTop: 4 }}>
                            💡 {friendly.help}
                          </div>
                        )}
                      </div>
                    )}

                    {expanded && friendly.kind === 'arg-path' && (
                      <div style={{ marginTop: 10, fontSize: 12 }}>
                        <label style={{ display: 'block', marginBottom: 4 }}>
                          {friendly.label}
                        </label>
                        <div className="voice-wake-card-row" style={{ gap: 6 }}>
                          <input
                            type="text"
                            value={s.args[friendly.argIndex] ?? ''}
                            onChange={(e) =>
                              void updateServerArgAt(s.id, friendly.argIndex, e.target.value)
                            }
                            style={{ flex: 1, fontFamily: 'monospace' }}
                            placeholder="(路径)"
                          />
                          <button
                            className="mini-btn"
                            onClick={async () => {
                              if (friendly.pickDir) {
                                const picked = (await window.petAPI?.mcpPickDirectory?.()) ?? [];
                                if (picked[0]) {
                                  void updateServerArgAt(s.id, friendly.argIndex, picked[0]);
                                }
                              } else {
                                const picked = await pickOneFile(undefined, `选择${friendly.label}`);
                                if (picked) {
                                  void updateServerArgAt(s.id, friendly.argIndex, picked);
                                }
                              }
                            }}
                            disabled={mcpBusy}
                          >
                            {friendly.pickDir ? '选目录…' : '选文件…'}
                          </button>
                        </div>
                      </div>
                    )}

                    {expanded && friendly.kind === 'arg-url' && (
                      <div style={{ marginTop: 10, fontSize: 12 }}>
                        <label style={{ display: 'block', marginBottom: 4 }}>
                          {friendly.label}
                        </label>
                        <input
                          type="text"
                          value={s.args[friendly.argIndex] ?? ''}
                          onChange={(e) =>
                            void updateServerArgAt(s.id, friendly.argIndex, e.target.value)
                          }
                          style={{ width: '100%', fontFamily: 'monospace' }}
                          placeholder={friendly.placeholder}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              </div>
            </details>
          )}

          {/* ===== AI 工具(MCP)— 高级设置,默认隐藏。
                普通用户:让 AI 在对话里自己 list_available_mcp_servers / install_mcp_server 即可。
                开发者:在 DevTools Console 跑 localStorage.setItem('desktopPet:devMode','true') 后刷新可见。 ===== */}
          {showMcpAdvanced && (<>
          <div className="settings-section-title">AI 工具(MCP)</div>
          <label className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-name">启用 AI 工具</span>
              <span className="settings-row-desc">
                开启后 AI 可以通过 MCP 协议调用工具(读写文件等)。需要模型支持 function/tool calling。
                {mcpEnabled && (
                  <>
                    {' · '}
                    <span style={{ color: mcpRunning ? '#7fd67f' : '#e88' }}>
                      {mcpRunning ? '● 运行中' : '○ 未连接(检查目录白名单)'}
                    </span>
                  </>
                )}
              </span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={mcpEnabled}
              disabled={!loaded || mcpBusy}
              onChange={(e) => updateMcpEnabled(e.target.checked)}
            />
          </label>

          {mcpEnabled && (
            <>
              <label className="settings-row">
                <div className="settings-row-text">
                  <span className="settings-row-name">写操作需二次确认</span>
                  <span className="settings-row-desc">
                    AI 调用 write_file / edit_file / create_directory / move_file 等写操作前弹框确认,强烈建议开启。
                  </span>
                </div>
                <input
                  type="checkbox"
                  className="settings-toggle"
                  checked={mcpConfirmWrites}
                  disabled={!loaded || mcpBusy}
                  onChange={(e) => updateMcpConfirmWrites(e.target.checked)}
                />
              </label>

              <div className="settings-section-subtitle">MCP Servers</div>
              <div className="settings-row-desc" style={{ marginBottom: 6 }}>
                每条 server 是一个独立子进程,提供一组 tool。点条目可展开编辑 command/args/env。
                内置工具(打开 URL / 应用 / 搜索 / 剪贴板 / 通知)无需配置,自动可用。
              </div>

              {mcpServers.length === 0 && (
                <div className="settings-row-desc" style={{ opacity: 0.7 }}>
                  (尚未添加 server。下方"添加 Server"选预置或自定义)
                </div>
              )}
              {mcpServers.map((s) => {
                const expanded = mcpExpandedId === s.id;
                return (
                  <div key={s.id} className="voice-wake-card" style={{ padding: 10 }}>
                    <div
                      className="voice-wake-card-row"
                      style={{ alignItems: 'center', gap: 8 }}
                    >
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={mcpBusy}
                        onChange={(e) =>
                          void updateServer(s.id, { enabled: e.target.checked })
                        }
                        title="启用 / 停用"
                      />
                      <strong style={{ flex: 1, fontSize: 13 }}>
                        {s.name}{' '}
                        <span style={{ opacity: 0.6, fontWeight: 'normal', fontSize: 11 }}>
                          [{s.id}]
                        </span>
                      </strong>
                      <button
                        className="mini-btn"
                        onClick={() => setMcpExpandedId(expanded ? null : s.id)}
                      >
                        {expanded ? '收起' : '编辑'}
                      </button>
                      <button
                        className="mini-btn"
                        onClick={() => void removeServer(s.id)}
                        disabled={mcpBusy}
                      >
                        删除
                      </button>
                    </div>

                    {expanded && (
                      <div style={{ marginTop: 10, fontSize: 12 }}>
                        <label style={{ display: 'block', marginBottom: 4, opacity: 0.8 }}>
                          名称
                        </label>
                        <input
                          type="text"
                          value={s.name}
                          onChange={(e) => void updateServer(s.id, { name: e.target.value })}
                          style={{ width: '100%', marginBottom: 8 }}
                        />

                        <label style={{ display: 'block', marginBottom: 4, opacity: 0.8 }}>
                          command
                          {s.command === 'bundled-fs' && (
                            <span style={{ marginLeft: 6, opacity: 0.6 }}>
                              (内置 filesystem,无需修改)
                            </span>
                          )}
                        </label>
                        <input
                          type="text"
                          value={s.command}
                          onChange={(e) => void updateServer(s.id, { command: e.target.value })}
                          style={{ width: '100%', marginBottom: 8, fontFamily: 'monospace' }}
                          placeholder="npx / uvx / node / 绝对路径"
                        />

                        <label style={{ display: 'block', marginBottom: 4, opacity: 0.8 }}>
                          args(每行一个)
                          {s.command === 'bundled-fs' && (
                            <button
                              className="mini-btn"
                              style={{ marginLeft: 8 }}
                              onClick={() => void addFsRootTo(s.id)}
                              disabled={mcpBusy}
                            >
                              + 选目录
                            </button>
                          )}
                        </label>
                        <textarea
                          rows={Math.max(3, s.args.length + 1)}
                          value={s.args.join('\n')}
                          onChange={(e) =>
                            void updateServer(s.id, {
                              args: e.target.value.split('\n').filter((x) => x.length > 0),
                            })
                          }
                          style={{
                            width: '100%',
                            fontFamily: 'monospace',
                            marginBottom: 8,
                          }}
                        />

                        <label style={{ display: 'block', marginBottom: 4, opacity: 0.8 }}>
                          env(每行 KEY=VALUE)
                        </label>
                        <textarea
                          rows={3}
                          value={Object.entries(s.env ?? {})
                            .map(([k, v]) => `${k}=${v}`)
                            .join('\n')}
                          onChange={(e) => {
                            const env: Record<string, string> = {};
                            for (const line of e.target.value.split('\n')) {
                              const m = line.match(/^([^=]+)=(.*)$/);
                              if (m) env[m[1].trim()] = m[2];
                            }
                            void updateServer(s.id, { env });
                          }}
                          style={{
                            width: '100%',
                            fontFamily: 'monospace',
                          }}
                          placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx"
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="voice-wake-card" style={{ marginTop: 8 }}>
                <div className="settings-row-desc" style={{ marginBottom: 6 }}>
                  添加 Server
                </div>
                <select
                  value={mcpPresetId}
                  onChange={(e) => setMcpPresetId(e.target.value)}
                  className="voice-wake-select"
                  style={{ width: '100%', marginBottom: 6 }}
                >
                  {MCP_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {(() => {
                  const cur = MCP_PRESETS.find((p) => p.id === mcpPresetId);
                  return cur?.hint ? (
                    <div className="settings-row-desc" style={{ opacity: 0.7, marginBottom: 6 }}>
                      {cur.hint}
                    </div>
                  ) : null;
                })()}
                <div className="voice-wake-card-row" style={{ gap: 8 }}>
                  <button
                    className="mini-btn"
                    onClick={() => void addServerFromPreset()}
                    disabled={mcpBusy || installing}
                  >
                    + 添加
                  </button>
                  {(() => {
                    const cur = MCP_PRESETS.find((p) => p.id === mcpPresetId);
                    if (!cur?.oneClickInstall) return null;
                    return (
                      <button
                        className="mini-btn"
                        onClick={() => void oneClickInstall()}
                        disabled={installing || mcpBusy}
                        title="桌宠自动跑 npm install -g 并探测路径"
                      >
                        {installing ? '安装中…' : '⚡ 一键安装'}
                      </button>
                    );
                  })()}
                  <button
                    className="mini-btn"
                    onClick={() => void restartMcp()}
                    disabled={mcpBusy || installing}
                  >
                    {mcpBusy ? '…' : '重新连接全部'}
                  </button>
                </div>
                {/* 安装日志区 — 流式显示 npm install 输出 */}
                {installLog && (
                  <div
                    className="voice-wake-card"
                    style={{
                      marginTop: 8,
                      maxHeight: 200,
                      overflow: 'auto',
                      background: '#1f2230',
                      color: '#dde3ee',
                      fontFamily: 'monospace',
                      fontSize: 11,
                      padding: 8,
                      borderRadius: 6,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {installLog.length === 0 ? '准备中…' : installLog.join('\n')}
                  </div>
                )}
                {/* 安装完成的引导 */}
                {installResult && (
                  <div
                    className="settings-row-desc"
                    style={{
                      marginTop: 8,
                      padding: 10,
                      background: 'rgba(40, 180, 100, 0.08)',
                      border: '1px solid rgba(40, 180, 100, 0.4)',
                      borderRadius: 6,
                      whiteSpace: 'pre-wrap',
                      fontSize: 12,
                    }}
                  >
                    {installResult.hint}
                    {installResult.url && (
                      <div style={{ marginTop: 6 }}>
                        <button
                          className="mini-btn"
                          onClick={() => {
                            void window.petAPI?.openExternal?.(installResult.url ?? '');
                          }}
                        >
                          打开:{installResult.url}
                        </button>
                        <button
                          className="mini-btn"
                          style={{ marginLeft: 6 }}
                          onClick={() => setInstallResult(null)}
                        >
                          知道了
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {mcpTools.length > 0 && (
                <>
                  <div className="settings-section-subtitle">
                    AI 当前可用工具 ({mcpTools.length})
                  </div>
                  <div className="voice-wake-card" style={{ maxHeight: 280, overflow: 'auto' }}>
                    {(() => {
                      // 按 serverId 分组
                      const groups = new Map<
                        string,
                        Array<{ name: string; rawName: string; description: string }>
                      >();
                      for (const t of mcpTools) {
                        const arr = groups.get(t.serverId) ?? [];
                        arr.push({ name: t.name, rawName: t.rawName, description: t.description });
                        groups.set(t.serverId, arr);
                      }
                      return Array.from(groups.entries()).map(([sid, arr]) => (
                        <div key={sid} style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>
                            <b>
                              [{sid}]
                              {sid === 'app' && ' 内置'}
                            </b>{' '}
                            ({arr.length})
                          </div>
                          {arr.map((t) => (
                            <div
                              key={t.name}
                              style={{ marginBottom: 4, fontSize: 12, paddingLeft: 8 }}
                            >
                              <code>{t.rawName}</code>
                              <div style={{ opacity: 0.7, marginTop: 1 }}>{t.description}</div>
                            </div>
                          ))}
                        </div>
                      ));
                    })()}
                  </div>
                </>
              )}
            </>
          )}
          </>)}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 设置面板「语音输入」区里的子组件:语音识别模型展示。
 *  当前**只支持内置 small 中文模型**(打包随发布版),不再开放自定义模型上传 —
 *  原因:vosk-browser@0.0.8 的 WASM 不支持 RNNLM rescoring,而所有官方完整版中文模型
 *  (如 vosk-model-cn-0.22)都带 RNNLM,加载时会 abort。强行让用户上传只会浪费 1GB+ 流量
 *  和磁盘,体验更差。如未来 vosk-browser 升级支持 RNNLM,可再恢复上传。
 *  保留「移除」按钮 — 老版本已上传过大模型的用户可以从这里清理。 */
function VoskModelSection(): JSX.Element {
  const [info, setInfo] = useState<
    { hasCustom: false } | { hasCustom: true; fileName: string; sizeBytes: number }
  >({ hasCustom: false });
  const [busy, setBusy] = useState<'idle' | 'removing'>('idle');
  /** vosk 加载状态 — 来自 vosk-shared 的全局广播,即使本面板关闭重开也能恢复实时态 */
  const [voskState, setVoskState] = useState<VoskState>(() => getVoskState());
  /** ready 提示是否要展示 — 第一次切到 'ready' 时打开,4s 后自动隐藏 */
  const [showReady, setShowReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const r = await window.petAPI?.voskGetCustomModelInfo?.();
    if (r) setInfo(r);
  };
  useEffect(() => {
    void refresh();
    // 设置变化(其他面板改了 cfg)— 同步刷新本组件
    const onCfg = () => void refresh();
    window.addEventListener('petAI:configChanged', onCfg);
    // 全局 vosk 加载状态变化 — 让本面板的 spinner / 就绪条与全局保持一致
    const onVosk = (e: Event) => {
      const s = (e as CustomEvent).detail as VoskState;
      setVoskState(s);
      if (s.kind === 'ready') {
        setShowReady(true);
        window.setTimeout(() => setShowReady(false), 4000);
      } else if (s.kind === 'loading' || s.kind === 'idle') {
        setShowReady(false);
      }
      if (s.kind === 'error') setError(s.message);
      else if (s.kind === 'ready' || s.kind === 'loading') setError(null);
    };
    window.addEventListener('pet:vosk-state', onVosk as EventListener);
    return () => {
      window.removeEventListener('petAI:configChanged', onCfg);
      window.removeEventListener('pet:vosk-state', onVosk as EventListener);
    };
  }, []);

  const formatSize = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  /** 触发 vosk 模型加载 — 失效缓存后启动 loadVoskModel(在后台跑)。
   *  这里不 await:让用户可以随时关闭设置面板,加载继续在 vosk-shared 里跑,
   *  完成时通过 'pet:vosk-state' 通知所有监听者(本面板若仍打开 + 全局 VoskToast)。 */
  const triggerLoad = () => {
    setError(null);
    invalidateVoskModel();
    void loadVoskModel().catch(() => {
      /* 错误已经通过全局 state 广播,onVosk 会写到 setError,这里 swallow */
    });
  };

  const onRemove = async () => {
    if (!window.confirm('确定移除自定义模型?将回到内置 small 中文模型。')) return;
    setBusy('removing');
    setError(null);
    try {
      // 先把卡死的 modelPromise 失效掉(loading 中 WASM 可能挂住 promise 永不 resolve),
      // 否则即使删了文件,UI 仍显示 loading,而且 fallback 加载内置 small 也不会触发。
      invalidateVoskModel();
      await window.petAPI?.voskRemoveCustomModel?.();
      setInfo({ hasCustom: false });
      window.dispatchEvent(new CustomEvent('petAI:configChanged'));
      triggerLoad();
    } finally {
      setBusy('idle');
    }
  };

  return (
    <div className="vosk-model-card">
      <div className="vosk-model-head">
        <span className="vosk-model-title">语音识别模型</span>
        <span className={'vosk-model-badge' + (info.hasCustom ? ' vosk-model-badge--custom' : '')}>
          {info.hasCustom ? '自定义' : '内置 small'}
        </span>
      </div>
      <div className="vosk-model-detail">
        {info.hasCustom ? (
          <>
            <div className="vosk-model-filename" title={info.fileName}>
              {info.fileName}
            </div>
            <div className="vosk-model-meta">{formatSize(info.sizeBytes)}</div>
            <div className="vosk-model-meta" style={{ color: '#c93c20', marginTop: 4 }}>
              ⚠ 当前版本已禁用自定义模型 — 完整版 vosk 中文模型大都带 RNNLM 组件,
              vosk-browser 不支持,会卡死或 abort。建议点「移除」回到内置 small。
            </div>
          </>
        ) : (
          <div className="vosk-model-meta">
            使用内置 small 中文模型(约 50 MB,离线快速识别,精度一般)。
            <br />
            <span style={{ opacity: 0.65 }}>
              已禁用自定义模型上传 — vosk-browser 的 WASM 不支持完整版模型里的 RNNLM 组件,
              强行加载会 abort,因此暂不开放上传。
            </span>
          </div>
        )}
      </div>
      {error && <div className="vosk-model-error">{error}</div>}
      {/* 状态条 — 加载中显示 spinner;就绪 4s 内显示绿色对勾;
          loading 状态来自全局 VoskState,即使关闭面板再打开也能恢复显示 */}
      {voskState.kind === 'loading' && (
        <div className="vosk-model-status vosk-model-status--loading">
          <span className="vosk-model-spinner" aria-hidden="true" />
          模型加载中…(大模型可能需要 10–60 秒,可以关闭设置,加载好后桌宠会通知你)
        </div>
      )}
      {showReady && voskState.kind === 'ready' && (
        <div className="vosk-model-status vosk-model-status--ready">
          ✓ 模型已就绪,可以使用语音输入了
        </div>
      )}
      <div className="vosk-model-actions">
        <button
          type="button"
          className="ai-skills-upload-btn vosk-model-test-btn"
          disabled={busy !== 'idle' || voskState.kind === 'loading'}
          onClick={triggerLoad}
          title="立即加载模型并验证可用 — 不点也行,首次点击语音输入时会自动加载"
        >
          {voskState.kind === 'loading' ? '加载中…' : '测试加载'}
        </button>
        {info.hasCustom && (
          <button
            type="button"
            className="ai-skill-del-btn"
            disabled={busy !== 'idle'}
            onClick={onRemove}
            title="移除自定义模型,回到内置 small(加载中也可点,等同于中断 + 回退)"
          >
            {busy === 'removing' ? '移除中…' : '移除自定义模型'}
          </button>
        )}
      </div>
    </div>
  );
}

function MenuBtn({
  label,
  icon,
  color,
  onClick,
}: {
  label: string;
  /** 极简线条 SVG 或任意 ReactNode;旧的 emoji string 也兼容(直接渲染) */
  icon: React.ReactNode;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      className="menu-btn"
      style={{ ['--accent' as string]: color }}
      onClick={onClick}
      title={label}
    >
      <span className="emoji">{icon}</span>
      <span className="label">{label}</span>
    </button>
  );
}

/** 极简线条图标 — 主菜单按钮专用,描边 currentColor,大小靠 .menu-btn .emoji 容器约束。
 *  与 chat-bubble 的 ToolIcon 一致风格,但每个图标单独定义,viewBox 统一 24×24。 */
function MenuIcon({ name }: { name: 'swap' | 'ruler' | 'bot' | 'chat' | 'gear' | 'moon' | 'close' }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    style: { display: 'block' as const },
  };
  switch (name) {
    case 'swap':
      // 上下箭头交换 — 暗示"切换"
      return (
        <svg {...common}>
          <path d="M7 4v14" />
          <path d="M4 7l3-3 3 3" />
          <path d="M17 20V6" />
          <path d="M14 17l3 3 3-3" />
        </svg>
      );
    case 'ruler':
      // 直尺,带刻度
      return (
        <svg {...common}>
          <path d="M3 16l13-13 5 5L8 21l-5-5z" />
          <path d="M7 12l2 2" />
          <path d="M10 9l2 2" />
          <path d="M13 6l2 2" />
        </svg>
      );
    case 'bot':
      // 圆角矩形头 + 两眼 + 天线
      return (
        <svg {...common}>
          <rect x="4" y="7" width="16" height="13" rx="3" />
          <circle cx="9" cy="13" r="1.2" />
          <circle cx="15" cy="13" r="1.2" />
          <path d="M12 7V3" />
          <circle cx="12" cy="2.5" r="0.8" />
        </svg>
      );
    case 'chat':
      // 圆角对话气泡 + 尾巴
      return (
        <svg {...common}>
          <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
        </svg>
      );
    case 'gear':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case 'moon':
      return (
        <svg {...common}>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      );
    case 'close':
      return (
        <svg {...common}>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      );
  }
}
