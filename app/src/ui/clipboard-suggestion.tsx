/**
 * 剪贴板建议气泡 — 用户复制 ≥ 200 字 / URL 时,在桌宠胸前弹一个轻量提示:
 *   "要我总结/打开吗?"
 *
 * 位置:跟"思考中"对话气泡同一区域(模型腰线 anchorY 处,水平贴着 character-host
 * 的中心),用户视线已经聚焦在这里,提示更显眼。anchorY 不可用时回退到屏幕顶部 24px。
 *
 * 行为:
 *  - 3 秒后自动消失
 *  - 鼠标进入暂停消失,离开重新计时
 *  - 点"忽略"立刻消失;点"总结"/"打开"把对应 prompt 投到对话气泡
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Suggestion {
  text: string;
  isUrl: boolean;
  len: number;
}

const AUTO_DISMISS_MS = 3500;

interface Props {
  /** 模型腰线 Y(CSS 像素)— 与 chat-bubble 共用同一个值 */
  anchorY: number | null;
}

export function ClipboardSuggestionLayer({ anchorY }: Props): JSX.Element | null {
  const [cur, setCur] = useState<Suggestion | null>(null);
  /** 启动倒计时 ref;mouseenter 暂停时清掉,mouseleave 再起 */
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const off = window.petAPI?.onClipboardSuggest?.((p) => {
      // 后到的覆盖先到的
      setCur(p);
    });
    return () => {
      off?.();
    };
  }, []);

  // 起 / 重置倒计时
  useEffect(() => {
    if (!cur) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCur(null);
      timerRef.current = null;
    }, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [cur]);

  // 不强制关穿透 — character-host 的 hit-test 已经把 .clipboard-suggest 加进白名单,
  // 鼠标移到气泡上时自然关穿透(可点击),移开时恢复穿透(其它应用照常用)。

  if (!cur) return null;

  // 锚点对齐:气泡贴在角色胸口下方,用 PIXI stage 坐标(anchorY)+ character-host
  // 容器在 viewport 的 top 转成 fixed 定位的 viewport y。
  // 不用 useMemo —— 每次渲染算很便宜,且避免 hooks 在 early return 之后调用。
  const positionStyle: React.CSSProperties = (() => {
    if (anchorY == null) {
      return { top: 24, left: '50%', transform: 'translateX(-50%)' };
    }
    const host = document.querySelector('.character-host') as HTMLElement | null;
    if (host) {
      const r = host.getBoundingClientRect();
      // anchorY 是 PIXI stage 内 y(相对 character-host 左上,大约腰线/胸口偏下),
      // 加 r.top 转成 viewport y,再上移让气泡显示在角色头顶上方。
      // 横向往右挪 100px 避开角色身体,让气泡看起来像贴在角色"侧面"举牌。
      const cx = r.left + r.width / 2 + 100;
      return {
        top: r.top + anchorY - 300,
        left: cx,
        transform: 'translate(-50%, -50%)',
      };
    }
    return { top: 24, left: '50%', transform: 'translateX(-50%)' };
  })();

  const dismiss = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setCur(null);
  };

  /** 把建议提示投到对话气泡 — 触发自定义事件,chat-bubble 监听到会自动打开 + 填入 prompt + 发送 */
  const fire = (prompt: string) => {
    window.dispatchEvent(
      new CustomEvent('pet:open-chat-with', { detail: { prompt } }),
    );
    dismiss();
  };

  const preview =
    cur.text.length > 60 ? cur.text.slice(0, 60).replace(/\s+/g, ' ') + '…' : cur.text;

  return createPortal(
    <div
      className={'clipboard-suggest' + (anchorY != null ? ' clipboard-suggest--anchored' : '')}
      style={positionStyle}
      onMouseEnter={() => {
        if (timerRef.current) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      }}
      onMouseLeave={() => {
        // 重新起倒计时
        if (!cur) return;
        timerRef.current = window.setTimeout(() => setCur(null), AUTO_DISMISS_MS);
      }}
    >
      <div className="clipboard-suggest-text">
        <span className="clipboard-suggest-icon">{cur.isUrl ? '🔗' : '📋'}</span>
        <span className="clipboard-suggest-preview" title={cur.text}>
          {preview}
        </span>
      </div>
      <div className="clipboard-suggest-actions">
        {cur.isUrl ? (
          <button
            className="clipboard-suggest-btn"
            onClick={() => fire(`帮我看看这个网页的内容并总结:${cur.text}`)}
          >
            打开看看
          </button>
        ) : (
          <button
            className="clipboard-suggest-btn"
            onClick={() => fire(`帮我总结一下下面这段文本:\n\n${cur.text}`)}
          >
            总结
          </button>
        )}
        <button className="clipboard-suggest-btn ghost" onClick={dismiss}>
          ✕
        </button>
      </div>
    </div>,
    document.body,
  );
}
