import { useCallback, useEffect, useRef, useState } from 'react';
import type { CharacterIndex, Live2DCharacter, HatchPetCharacter } from '../shared/character';
import { CharacterHost, type CharacterHostHandle } from './render/character-host';
import { HatchPetHost } from './render/hatch-pet-host';
import { PetMenu } from './ui/pet-menu';
import { ChatBubble } from './ui/chat-bubble';
import { ClipboardSuggestionLayer } from './ui/clipboard-suggestion';
import type { VoskState } from './render/vosk-shared';

/** 当前外层支持的角色类型(sprite 还没启用)。 */
type ActiveCharacter = Live2DCharacter | HatchPetCharacter;

function pickStartupCharacterId(
  idx: CharacterIndex,
  preferredId?: string | null,
): string | null {
  const all = [...idx.live2d, ...idx.hatchPet];
  if (preferredId && all.some((c) => c.id === preferredId)) return preferredId;
  return idx.hatchPet[0]?.id ?? idx.live2d[0]?.id ?? null;
}

/**
 * 主应用:
 * - 全窗 PIXI 透明画布渲染当前 Live2D 角色
 * - 右键画布弹出卡通菜单:切换角色 / 调整大小
 */
export default function App() {
  const [index, setIndex] = useState<CharacterIndex | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scale, setScale] = useState(1);
  /** 模型腰线 Y(CSS 像素),用于定位聊天气泡 */
  const [anchorY, setAnchorY] = useState<number | null>(null);
  /** 对话面板是否可见(默认收起,由菜单 💬 按钮打开) */
  const [chatOpen, setChatOpen] = useState(false);
  /** 「只打开对话」模式 — 隐藏模型 canvas,只留聊天气泡。
   *  从托盘"只打开对话"进入,关闭聊天 / 切换角色 / 选"显示桌宠"会复位。 */
  const [modelHidden, setModelHidden] = useState(false);
  /** 「编码(增强)模式」— 改变聊天气泡为底部居中紧凑条,
   *  让模型完整露出。从设置面板开关,实时同步。 */
  const [codingMode, setCodingMode] = useState(false);
  const hostRef = useRef<CharacterHostHandle>(null);

  useEffect(() => {
    const offConfig = window.petAPI?.onAppConfigChanged?.((payload) => {
      window.dispatchEvent(new CustomEvent('petAI:configChanged', { detail: payload }));
    });
    const offSkills = window.petAPI?.onAppSkillsChanged?.((payload) => {
      window.dispatchEvent(new CustomEvent('petAI:skillsChanged', { detail: payload }));
    });
    return () => {
      offConfig?.();
      offSkills?.();
    };
  }, []);

  // 监听 cfg.codingMode — 初次 + 设置变更后都同步
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      window.petAPI?.getConfig?.().then((cfg) => {
        if (cancelled) return;
        setCodingMode(!!cfg.codingMode);
      });
    };
    refresh();
    const onCfg = () => refresh();
    window.addEventListener('petAI:configChanged', onCfg);
    return () => {
      cancelled = true;
      window.removeEventListener('petAI:configChanged', onCfg);
    };
  }, []);

  useEffect(() => {
    if (!window.petAPI) {
      setScanError('preload 未加载');
      return;
    }
    const doScan = (initial: boolean) => {
      window.petAPI
        ?.scanCharacters()
        .then(async (idx) => {
          setIndex(idx);
          if (initial) {
            // 默认 active:用户设置优先;否则优先第一只 hatch-pet,没有再回退 Live2D。
            const cfg = await window.petAPI?.getConfig?.();
            const first = pickStartupCharacterId(idx, cfg?.defaultCharacterId);
            if (first) setActiveId(first);
          }
        })
        .catch((e) => setScanError(String(e)));
    };
    doScan(true);
    // hatch-pet 导入 / 删除后会派发该事件,我们重新扫一次刷新菜单
    const onCharsChanged = () => doScan(false);
    window.addEventListener('pet:characters-changed', onCharsChanged);
    return () => window.removeEventListener('pet:characters-changed', onCharsChanged);
  }, []);

  // 合并 Live2D + Hatch-Pet 作为可选角色列表;sprite 仍未启用所以不并入
  const characters: ActiveCharacter[] = [
    ...(index?.live2d ?? []),
    ...(index?.hatchPet ?? []),
  ];
  const active = characters.find((c) => c.id === activeId) ?? characters[0];

  const handleContextMenu = useCallback(() => {
    setMenuOpen(true);
  }, []);

  // 默认禁掉整窗右键菜单(包括非 canvas 区,例如错误 overlay)
  useEffect(() => {
    const onCtx = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('contextmenu', onCtx);
    return () => window.removeEventListener('contextmenu', onCtx);
  }, []);

  // 剪贴板建议点"总结/打开"时,自动打开对话气泡 — chat-bubble 自己会接收 prompt 并发送
  useEffect(() => {
    const onOpen = () => setChatOpen(true);
    window.addEventListener('pet:open-chat-with', onOpen);
    return () => window.removeEventListener('pet:open-chat-with', onOpen);
  }, []);

  // ===== 托盘菜单事件订阅 =====
  // 切角色 / 打开对话 / 打开设置 都从托盘的右键菜单触发
  useEffect(() => {
    const off1 = window.petAPI?.onTraySwitchCharacter?.((id) => {
      setActiveId(id);
      // 切角色就显示模型(否则切了看不见,体验奇怪)
      setModelHidden(false);
    });
    const off2 = window.petAPI?.onTrayOpenChat?.(() => {
      // 「打开对话和模型」:模型 + 聊天都要可见
      setModelHidden(false);
      setChatOpen(true);
    });
    const off2b = window.petAPI?.onTrayOpenChatOnly?.(() => {
      // 「只打开对话」:只弹聊天气泡,模型隐藏
      setModelHidden(true);
      setChatOpen(true);
    });
    const off3 = window.petAPI?.onTrayOpenSettings?.(() => {
      // 设置面板需要看到模型(用户可能要调大小、切角色等)
      setModelHidden(false);
      // 先打开菜单 → 等下一个 tick PetMenu listener 已挂载 → 派发事件让它跳到 settings 面板
      setMenuOpen(true);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('pet:open-settings'));
      }, 60);
    });
    return () => {
      off1?.();
      off2?.();
      off2b?.();
      off3?.();
    };
  }, []);

  // 角色切换时,通知主进程刷新托盘菜单的 ● 标记
  useEffect(() => {
    if (activeId) void window.petAPI?.trayRefresh?.({ activeCharacterId: activeId });
  }, [activeId]);

  // 角色切换后(非首次加载)派发事件 → use-proactive-greetings 监听后让 AI 主动打招呼。
  // 用 ref 跳过首次 mount,避免应用启动就触发(那不是用户主动切的)。
  const firstActiveSetRef = useRef(true);
  useEffect(() => {
    if (firstActiveSetRef.current) {
      firstActiveSetRef.current = false;
      return;
    }
    if (!activeId) return;
    // 给新角色 host mount + use-proactive-greetings 注册 listener 一点时间
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('pet:character-switched'));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [activeId]);

  return (
    <div
      className={
        'app-root' +
        (chatOpen ? '' : ' app--no-chat') +
        (modelHidden ? ' app--model-hidden' : '') +
        (codingMode ? ' app--coding' : '')
      }
    >
      {active && index && active.type === 'live2d' && (
        <CharacterHost
          ref={hostRef}
          key={active.id}
          character={active}
          roots={index.roots}
          onError={(e) => setScanError(String(e))}
          onContextMenu={handleContextMenu}
          onScaleChange={setScale}
          onAnchorY={setAnchorY}
          visible={!modelHidden}
        />
      )}
      {active && index && active.type === 'hatch-pet' && (
        <HatchPetHost
          ref={hostRef}
          key={active.id}
          character={active}
          roots={index.roots}
          onError={(e) => setScanError(String(e))}
          onContextMenu={handleContextMenu}
          onScaleChange={setScale}
          onAnchorY={setAnchorY}
          visible={!modelHidden}
        />
      )}

      {/* 扫描错误 / 加载提示:轻量浮层,后期可移到菜单内 */}
      {scanError && <div className="scan-error">{scanError}</div>}
      {!index && !scanError && <div className="scan-hint">扫描资源中…</div>}

      <ChatBubble
        visible={chatOpen}
        onClose={() => setChatOpen(false)}
        anchorY={anchorY}
        characterName={active?.name ?? null}
        codingMode={codingMode}
      />

      <PetMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        characters={characters}
        activeId={active?.id}
        activeCharacterName={active?.name ?? null}
        onPick={(id) => setActiveId(id)}
        scale={scale}
        onScale={(s) => hostRef.current?.setUserScale(s)}
        onPreviewScale={(s) => hostRef.current?.previewUserScale(s)}
        onResetScale={() => hostRef.current?.resetUserScale()}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((v) => !v)}
      />

      {/* 剪贴板建议气泡 — 全局监听,不依赖 chatOpen。
          位置贴模型腰线(anchorY),跟"思考中"气泡同区域,显眼又自然。
          点"总结/打开看看"会 dispatch 'pet:open-chat-with',这里同时打开对话气泡 */}
      <ClipboardSuggestionLayer anchorY={anchorY} />

      {/* 全局 vosk 模型加载状态浮层 — 任何地方触发的加载(启动预热 / 设置面板手动)
          完成后都会通过 'pet:vosk-state' 通知到这里,关闭设置面板也能收到 */}
      <VoskToast />
    </div>
  );
}

/** Vosk 模型加载完成 / 失败时的全局通知浮层 — 桌宠可见时短暂显示。
 *  Loading 时不显示(loading 进度由设置面板内部呈现);ready/error 才弹通知。
 *  与 .scan-hint 同位(底部左侧),叠在桌面上不抢视线。 */
function VoskToast(): JSX.Element | null {
  const [msg, setMsg] = useState<{ kind: 'ready' | 'error'; text: string } | null>(null);
  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent).detail as VoskState | undefined;
      if (!detail) return;
      if (detail.kind === 'ready') {
        setMsg({ kind: 'ready', text: '✓ 语音识别模型已就绪' });
        // 4 秒后自动收起
        window.setTimeout(() => {
          setMsg((cur) => (cur && cur.kind === 'ready' ? null : cur));
        }, 4000);
      } else if (detail.kind === 'error') {
        setMsg({ kind: 'error', text: '语音模型加载失败:' + detail.message });
        // error 让用户多看一会再消失(8 秒)
        window.setTimeout(() => {
          setMsg((cur) => (cur && cur.kind === 'error' ? null : cur));
        }, 8000);
      } else if (detail.kind === 'idle') {
        setMsg(null);
      }
    };
    window.addEventListener('pet:vosk-state', onState as EventListener);
    return () => window.removeEventListener('pet:vosk-state', onState as EventListener);
  }, []);
  if (!msg) return null;
  return (
    <div className={'vosk-toast vosk-toast--' + msg.kind} onClick={() => setMsg(null)}>
      {msg.text}
    </div>
  );
}
