/**
 * 可拖拽 + 可缩放的面板 hook。
 *
 * 用法:
 *   const { panelRef, panelStyle, titleProps } = useDraggablePanel();
 *   return createPortal(
 *     <div ref={panelRef} style={panelStyle}>
 *       <div {...titleProps}>Title</div>
 *       ...
 *     </div>,
 *     document.body,
 *   );
 *
 * 设计要点:
 * 1. 面板默认 CSS 定位(如 absolute 挂在菜单内)—— 初次 layout 后我们读 rect,
 *    转为 `position: fixed` + 显式 left/top/width/height,从父容器的 transform
 *    中脱离出来(配合 `createPortal(..., document.body)` 使用最稳)。
 * 2. 把 width/height 存到 state,防止一次 React rerender 就让 inline style 丢失
 *    用户手动 resize 出来的尺寸(浏览器 resize:both 会往 DOM inline style 写,
 *    React 再渲染会覆盖它 —— 所以用 ResizeObserver 把 DOM 尺寸回读到 state)。
 * 3. 拖动结束前一直覆写 maxWidth/maxHeight 为 'none',避免 CSS 原先的
 *    `max-width: 80vw` 把用户新位置/新尺寸截断导致"跳"。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, MouseEvent as ReactMouseEvent, RefObject } from 'react';

export interface UseDraggablePanelResult {
  panelRef: RefObject<HTMLDivElement>;
  panelStyle: CSSProperties;
  titleProps: Pick<HTMLAttributes<HTMLDivElement>, 'onMouseDown' | 'style'>;
}

export function useDraggablePanel(): UseDraggablePanelResult {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // 第一次 layout:把 CSS 初始布局下的 rect 锁成 fixed 坐标
  useLayoutEffect(() => {
    if (!panelRef.current || pos) return;
    const r = panelRef.current.getBoundingClientRect();
    setPos({ left: r.left, top: r.top });
    setSize({ w: r.width, h: r.height });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 用户拖 resizer 改变大小时,DOM 尺寸变了但 state 没变 —— 下次 rerender 会被
  // state 里的旧 width/height 覆盖回去。用 ResizeObserver 把 DOM 真实尺寸同步到
  // state,避免"一点击就弹回初始大小"的闪烁。
  useLayoutEffect(() => {
    if (!panelRef.current) return;
    const el = panelRef.current;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((prev) => {
        if (prev && Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5) {
          return prev;
        }
        return { w: r.width, h: r.height };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // 只响应左键,且当前 pos 已确定
      if (e.button !== 0) return;
      if (!panelRef.current) return;
      e.preventDefault();

      // 以 DOM 真实 rect 为起点,避免 state 落后造成跳动
      const r = panelRef.current.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startL = r.left;
      const startT = r.top;
      const w = r.width;
      const h = r.height;

      const onMove = (ev: MouseEvent) => {
        const nx = startL + (ev.clientX - startX);
        const ny = startT + (ev.clientY - startY);
        // 边界:让面板至少留一角在屏内
        const maxL = window.innerWidth - 40;
        const maxT = window.innerHeight - 40;
        const minL = 40 - w;
        const minT = 0;
        setPos({
          left: Math.min(Math.max(minL, nx), maxL),
          top: Math.min(Math.max(minT, ny), maxT),
        });
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [],
  );

  const panelStyle: CSSProperties =
    pos && size
      ? {
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          width: size.w,
          height: size.h,
          maxWidth: 'none',
          maxHeight: 'none',
        }
      : {};

  const titleProps = {
    onMouseDown,
    style: { cursor: 'move' as const },
  };

  return { panelRef, panelStyle, titleProps };
}
