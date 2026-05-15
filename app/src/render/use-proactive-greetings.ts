import { useEffect, useRef } from 'react';
import {
  type CharacterPersona,
  buildCharacterSystemPrompt,
  resolveDefaultCharacterPersona,
} from '../../shared/emotion-map';

/**
 * 桌宠主动行为系统:
 *   1. 时段问候(早/午/晚/睡前/凌晨等)
 *   2. 整点报时(白天 8-21 点)
 *   3. 节假日贺词(公历表;农历节日预留 TODO)
 *   4. 记忆提醒(从用户填的 memory 里挖关键词)
 *   5. 长时间无操作主动搭话(鼠标/键盘 30 分钟未动)
 *
 * 所有触发都走当前角色 active persona,通过 sendChat 让 AI 即兴生成符合人设的一句话,
 * 显示在桌宠头顶气泡(showHint)。失败时各自有 fallback 文案。
 *
 * 去重策略:
 *   - 时段/整点/节日/记忆 — localStorage key 含日期,每天每事件最多 1 次
 *   - 无操作 — 用 ref 节流,触发后必须重新有"活动"才会再次触发
 */

interface Args {
  characterId: string;
  characterName: string;
  /** 在桌宠头顶气泡显示一段文字,duration 毫秒后自动消失。 */
  showHint: (msg: string, duration: number) => void;
}

type Slot = {
  key: string;
  label: string;
  match: (h: number) => boolean;
  fallback: string[];
  duration: number;
};

const SLOTS: Slot[] = [
  {
    key: 'morning',
    label: '早上(5-11 点,刚起床)',
    match: (h) => h >= 5 && h < 11,
    fallback: ['🌅 早上好~', '☀️ 早安,新的一天开始啦'],
    duration: 6000,
  },
  {
    key: 'noon',
    label: '中午(11-14 点,午饭时间)',
    match: (h) => h >= 11 && h < 14,
    fallback: ['🍱 中午好~记得吃饭', '🥢 该吃午饭啦'],
    duration: 6000,
  },
  {
    key: 'afternoon',
    label: '下午(14-18 点,工作/学习时间)',
    match: (h) => h >= 14 && h < 18,
    fallback: ['☕ 下午好~', '🍵 喝杯茶歇会儿吧'],
    duration: 6000,
  },
  {
    key: 'evening',
    label: '晚上(18-22 点,晚饭后放松)',
    match: (h) => h >= 18 && h < 22,
    fallback: ['🌆 晚上好~', '🌙 放松一下吧'],
    duration: 6000,
  },
  {
    key: 'bedtime',
    label: '睡前(22-24 点,该准备睡觉)',
    match: (h) => h >= 22 && h < 24,
    fallback: ['🌙 该休息啦,准备睡觉吧', '😴 不要熬夜哦'],
    duration: 7000,
  },
  {
    key: 'late_night',
    label: '凌晨深夜(0-5 点,熬夜中)',
    match: (h) => h >= 0 && h < 5,
    fallback: ['💤 这么晚还不睡?', '🌃 真的该睡了!'],
    duration: 7000,
  },
];

/** 公历节日表(月-日 → 名称)。农历节日(春节/端午/中秋)目前未支持,
 *  如需添加可手动 build 一张当年日期表(每年不同)写在这里。 */
const HOLIDAYS: Record<string, string> = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '06-01': '儿童节',
  '08-15': '七夕(若农历当年此日)/普通日',
  '09-10': '教师节',
  '10-01': '国庆节',
  '11-11': '光棍节',
  '12-24': '平安夜',
  '12-25': '圣诞节',
  '12-31': '跨年夜',
  // TODO: 农历春节/端午/中秋等需要每年手动加(或引 lunar 库自动算)
};

/** 整点报时:此区间内的整点会报。范围外(凌晨 / 深夜)静音。 */
const HOURLY_RANGE: { start: number; end: number } = { start: 8, end: 22 };

/** 长时间无操作阈值(毫秒)。用户 30 分钟没动就主动搭话。 */
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/* ===================== 工具函数 ===================== */

const dateKey = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

const mdKey = (d = new Date()): string =>
  `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const lsHas = (key: string): boolean => {
  try {
    return localStorage.getItem(key) != null;
  } catch {
    return false;
  }
};

const lsSet = (key: string): void => {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // ignore
  }
};

/** 解析当前角色的 active persona(参考 chat-bubble.tsx 同名实现) */
async function resolvePersona(name: string): Promise<CharacterPersona | null> {
  if (!name) return null;
  try {
    const cfg = await window.petAPI?.getConfig?.();
    const slot = cfg?.characterPersonas?.[name];
    if (slot && slot.personas.length > 0) {
      const cur =
        slot.personas.find((p) => p.id === slot.activeId) ?? slot.personas[0];
      if ((cur.personality ?? '').trim().length > 0) {
        return {
          displayName: cur.displayName,
          personality: cur.personality,
          speakingStyle: cur.speakingStyle,
        };
      }
      const def = resolveDefaultCharacterPersona(name);
      return {
        displayName: cur.displayName?.trim() || def.displayName,
        personality: def.personality,
        speakingStyle: def.speakingStyle,
      };
    }
  } catch {
    // ignore
  }
  return resolveDefaultCharacterPersona(name);
}

/** 根据应用名 / 窗口标题粗略推断用户在干什么 — 给 AI 拼互动 prompt 用。
 *  返回 null 表示推断不出来,AI 自己看应用名编。 */
function inferActivity(app: string, title: string): string | null {
  const a = (app || '').toLowerCase();
  const t = (title || '').toLowerCase();
  if (/(code|cursor|windsurf|devenv|idea|pycharm|webstorm|goland|rider|sublime|atom|vim|emacs)/.test(a)) {
    return '在写代码 / 编程';
  }
  if (/(msedge|chrome|firefox|opera|brave|safari)/.test(a)) {
    if (/youtube|bilibili|哔哩|netflix|iqiyi|youku/.test(t)) return '在看视频';
    if (/github|gitlab|stackoverflow|stack overflow|mdn/.test(t)) return '在浏览开发资源';
    if (/twitter|x\.com|微博|reddit|知乎/.test(t)) return '在刷社交媒体';
    if (/google|baidu|bing|搜索/.test(t)) return '在搜索资料';
    return '在浏览网页';
  }
  if (/(wechat|qq|tim|feishu|dingtalk|telegram|discord|slack)/.test(a)) {
    return '在聊天 / 社交';
  }
  if (/(spotify|qqmusic|cloudmusic|netease|music)/.test(a)) {
    return '在听音乐';
  }
  if (/(notion|obsidian|onenote|typora|word|winword)/.test(a)) {
    return '在写文档 / 笔记';
  }
  if (/(excel|powerpnt|wpsoffice)/.test(a)) {
    return '在处理表格 / 文档';
  }
  if (/(photoshop|illustrator|figma|sketch|illustrator)/.test(a)) {
    return '在做设计 / 绘图';
  }
  if (/(powershell|cmd|windowsterminal|wt|terminal|bash|iterm)/.test(a)) {
    return '在敲命令 / 终端';
  }
  if (/(steam|game|league|dota|valorant|wow)/.test(a)) {
    return '在玩游戏';
  }
  if (/(explorer)/.test(a)) {
    return '在翻文件夹';
  }
  return null;
}

/** 调 AI 一次性获取一句话,用于桌宠主动行为。失败/空返回 → null。 */
function askAIOnce(opts: {
  systemPrompt: string;
  userPrompt: string;
  /** 限制最大字符数,超过截断 */
  maxChars?: number;
  signal: { disposed: boolean };
}): Promise<string | null> {
  const { systemPrompt, userPrompt, maxChars = 60, signal } = opts;
  if (!window.petAPI?.sendChat) return Promise.resolve(null);
  return new Promise((resolve) => {
    let acc = '';
    try {
      window.petAPI.sendChat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        (delta, kind) => {
          if (kind === 'answer') acc += delta;
        },
        () => {
          if (signal.disposed) return resolve(null);
          const cleaned = acc
            .replace(/\[emotion:\s*\w+\s*\]/gi, '')
            .replace(/^\s+|\s+$/g, '')
            .slice(0, maxChars);
          resolve(cleaned.length > 0 ? cleaned : null);
        },
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/* ===================== Hook ===================== */

export function useProactiveGreetings(args: Args): void {
  const { characterId, characterName, showHint } = args;

  // 用 ref 锁住 showHint,避免父组件每次 re-render 传入新箭头函数
  // 导致下面的 useEffect 反复 cleanup/setup,定时器和事件监听器一直处于刚装就拆的状态。
  const showHintRef = useRef(showHint);
  useEffect(() => {
    showHintRef.current = showHint;
  });

  useEffect(() => {
    const signal = { disposed: false };
    /** 始终读最新的 showHint(避免闭包陷阱) */
    const emit = (msg: string, duration: number) => showHintRef.current(msg, duration);

    /** 调 AI 拿一句话并显示;失败用 fallback */
    const speak = async (
      userPrompt: string,
      fallback: string[],
      duration: number,
    ): Promise<void> => {
      if (signal.disposed) return;
      const persona = await resolvePersona(characterName);
      const sys = buildCharacterSystemPrompt(persona);
      let line: string | null = null;
      if (sys) {
        line = await askAIOnce({
          systemPrompt: sys,
          userPrompt,
          signal,
        });
      }
      if (signal.disposed) return;
      if (!line) line = fallback[Math.floor(Math.random() * fallback.length)];
      emit(line, duration);
    };

    let proactiveEnabled = false;
    const refreshProactiveEnabled = async () => {
      try {
        const cfg = await window.petAPI?.getConfig?.();
        proactiveEnabled = !!cfg?.proactive?.enabled;
      } catch {
        proactiveEnabled = false;
      }
    };
    const shouldRunProactive = () => proactiveEnabled && !signal.disposed;
    void refreshProactiveEnabled();
    const onProactiveCfgChanged = () => void refreshProactiveEnabled();
    window.addEventListener('petAI:configChanged', onProactiveCfgChanged);

    /** 1. 时段问候 */
    const tryGreet = async () => {
      if (!shouldRunProactive()) return;
      const slot = SLOTS.find((s) => s.match(new Date().getHours()));
      if (!slot) return;
      const k = `pet:greeting:${dateKey()}:${slot.key}`;
      if (lsHas(k)) return;
      lsSet(k);
      await speak(
        `请给主人一句此时此刻的问候/提醒(当前是「${slot.label}」)。` +
          '严格遵守你的人设口吻、自称、口头禅。' +
          '只输出一句话,不超过 30 字,可以加 1~2 个 emoji。' +
          '不要寒暄,不要解释,不要 markdown,不要加 [emotion] 标签。',
        slot.fallback,
        slot.duration,
      );
    };

    /** 2. 整点报时 */
    const tryHourly = async () => {
      if (!shouldRunProactive()) return;
      const now = new Date();
      const h = now.getHours();
      const m = now.getMinutes();
      // 进入新整点的前 1 分钟内才触发(避免 1 分钟轮询里同一小时多次触发)
      if (m >= 1) return;
      if (h < HOURLY_RANGE.start || h >= HOURLY_RANGE.end) return;
      const k = `pet:hourly:${dateKey()}:${h}`;
      if (lsHas(k)) return;
      lsSet(k);
      await speak(
        `现在是 ${h}:00 整。请用一句话报时,提醒主人这个时间点(可以加情境,如午饭/下午茶/下班等)。` +
          '严格用人设口吻。最多 25 字,不要 markdown,不要 [emotion] 标签。',
        [`🕒 ${h} 点啦~`, `⏰ 现在 ${h} 点`],
        4500,
      );
    };

    /** 3. 节假日提醒 — 当天启动一次 */
    const tryHoliday = async () => {
      if (!shouldRunProactive()) return;
      const today = mdKey();
      const name = HOLIDAYS[today];
      if (!name) return;
      const k = `pet:holiday:${dateKey()}`;
      if (lsHas(k)) return;
      lsSet(k);
      await speak(
        `今天是「${name}」。请用人设口吻给主人发一句节日祝福或调侃,最多 30 字,可以加 1 个 emoji。` +
          '不要解释这个节日,不要寒暄"你好",不要 markdown,不要 [emotion] 标签。',
        [`🎉 今天是${name}哦~`],
        7000,
      );
    };

    /** 4. 记忆提醒 — 从 config.memory 里挖"提醒/生日/纪念日"等内容 */
    const tryMemoryReminder = async () => {
      if (!shouldRunProactive()) return;
      const k = `pet:memory-remind:${dateKey()}`;
      if (lsHas(k)) return;
      let memory = '';
      try {
        const cfg = await window.petAPI?.getConfig?.();
        memory = (cfg?.memory ?? '').trim();
      } catch {
        // ignore
      }
      if (!memory) return; // 没记忆 → 跳过
      lsSet(k);
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
      const userPrompt =
        `这是主人写给你的备忘录:\n${memory}\n\n` +
        `今天是 ${dateStr}。如果备忘录里有今天相关的事项(如生日、纪念日、待办、提醒)` +
        '或主人提到希望你提醒的内容,请用人设口吻提醒一句;' +
        '如果备忘录里没有今天相关的事项,请只输出"PASS"(纯字符串,无任何额外内容)。' +
        '正常输出时:最多 40 字,可加 1 个 emoji,不要 markdown,不要 [emotion] 标签。';
      const persona = await resolvePersona(characterName);
      const sys = buildCharacterSystemPrompt(persona);
      if (!sys) return;
      const line = await askAIOnce({
        systemPrompt: sys,
        userPrompt,
        maxChars: 80,
        signal,
      });
      if (signal.disposed) return;
      if (!line || line.toUpperCase().includes('PASS')) return;
      emit(line, 8000);
    };

    /** 5. 无操作主动搭话 */
    let lastActivityAt = Date.now();
    let idleFiredAt = 0;
    const onActivity = () => {
      lastActivityAt = Date.now();
    };
    window.addEventListener('mousemove', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity, { passive: true });
    window.addEventListener('mousedown', onActivity, { passive: true });
    window.addEventListener('wheel', onActivity, { passive: true });

    const tryIdle = async () => {
      if (!shouldRunProactive()) return;
      const now = Date.now();
      // 已过空闲阈值 + 距离上次触发至少又 30 分钟,且窗口不可见时不打扰
      if (document.hidden) return;
      if (now - lastActivityAt < IDLE_THRESHOLD_MS) return;
      if (idleFiredAt > 0 && now - idleFiredAt < IDLE_THRESHOLD_MS) return;
      // 必须先有过新的活动再触发(避免一直无操作时反复打扰)
      if (idleFiredAt > lastActivityAt) return;
      idleFiredAt = now;
      const minutes = Math.floor((now - lastActivityAt) / 60_000);
      await speak(
        `主人已经 ${minutes} 分钟没动了,你担心又有点无聊。` +
          '请用人设口吻关心或调侃一句,看看主人在不在/累不累。' +
          '最多 30 字,可加 1 个 emoji,不要 markdown,不要 [emotion] 标签。',
        ['😶 主人?在吗?', '🥺 主人都不理人家了…', '✨ 主人累了就歇歇吧~'],
        6000,
      );
    };

    /** 1 分钟轮询调度 */
    const tick = () => {
      void tryGreet();
      void tryHourly();
      void tryHoliday();
      void tryIdle();
    };
    // 启动延后 1.5s,避开模型加载瞬间
    const startTimer = window.setTimeout(() => {
      void tryGreet();
      void tryHoliday();
      void tryMemoryReminder();
    }, 1500);
    const tickTimer = window.setInterval(tick, 60_000);

    /** 6. 切换角色后主动打招呼 — App.tsx 切了 active 角色后 dispatch。
     *  受 config.proactive.enabled && interactOnSwitch 控制 */
    const onCharacterSwitched = async () => {
      const cfg = await window.petAPI?.getConfig?.();
      const pro = cfg?.proactive;
      if (!pro?.enabled || !pro.interactOnSwitch) return;
      void speak(
        '主人刚刚把你切换到当前界面(模型刚加载完)。' +
          '请用人设口吻简短打个招呼,体现你"刚被召唤出来"的感觉。' +
          '最多 25 字,可加 1 个 emoji,不要 markdown,不要 [emotion] 标签。',
        ['主人,我来啦~', '诶嘿,换我登场!', '哼,又叫人家出来啦?'],
        5000,
      );
    };
    const onCharacterSwitchedListener = () => void onCharacterSwitched();
    window.addEventListener('pet:character-switched', onCharacterSwitchedListener);

    /** 8. 前台应用变化主动搭话 — 主进程 ProactiveAware 推 'pet:proactive-app-event'。
     *  主进程已检查 enabled / awareApps / awareLongStay,这里只补 model-hidden 判断,
     *  并根据 autoReadScreen / autoReadBrowser 给 AI 加"主动调工具拿 context"的提示。 */
    const offAppEvent = window.petAPI?.onProactiveAppEvent?.(async (p) => {
      // eslint-disable-next-line no-console
      console.log('[proactive] received app-event', p);
      if (document.hidden) {
        // eslint-disable-next-line no-console
        console.log('[proactive] skipped: document.hidden');
        return;
      }
      const root = document.querySelector('.app-root');
      if (root?.classList.contains('app--model-hidden')) {
        // eslint-disable-next-line no-console
        console.log('[proactive] skipped: model-hidden');
        return;
      }

      // 拉最新 proactive 配置(用户可能刚改完开关)
      const cfg = await window.petAPI?.getConfig?.();
      const pro = cfg?.proactive;
      if (!pro?.enabled) return;

      const friendly = p.friendly;
      const reason = p.reason;
      const activity = inferActivity(p.app, p.title);
      const isBrowser = /(msedge|chrome|firefox|opera|brave|safari)/.test(p.app.toLowerCase());

      // 根据开关构造工具使用提示。AI 看到提示会自己决定是否调工具(streamChat 带着 tools)
      const toolHints: string[] = [];
      if (pro.autoReadScreen) {
        toolHints.push(
          '允许你调 app__read_screen_elements 看一眼当前屏幕(只看一次,看完直接给搭话,不要再调其它工具)',
        );
      }
      if (pro.autoReadBrowser && isBrowser) {
        toolHints.push(
          '允许你调浏览器 MCP 工具(browsermcp__* / chrome_mcp__* / mcp_chrome__*)读当前标签页内容,再用 1 句话搭话',
        );
      }
      const toolHintText = toolHints.length > 0 ? `\n[可选工具:${toolHints.join(';')}]` : '';

      const userPrompt =
        reason === 'switch'
          ? `主人刚切换到了「${friendly}」(标题:${p.title || '(无标题)'})。${activity ? '推断:' + activity + '。' : ''}${toolHintText}\n` +
            '请用人设口吻给主人发一句轻松的搭话,可以是关心 / 调侃 / 鼓励等。' +
            '最多 30 字,可加 1 个 emoji,不要 markdown,不要 [emotion] 标签,不要泄露窗口标题里的具体内容(隐私)。'
          : `主人在「${friendly}」里专注了好一会儿了(标题:${p.title || '(无标题)'})。${activity ? '推断:' + activity + '。' : ''}${toolHintText}\n` +
            '请用人设口吻关心一下,提醒休息或鼓励都行。' +
            '最多 30 字,可加 1 个 emoji,不要 markdown,不要 [emotion] 标签。';
      const fallback =
        reason === 'switch'
          ? [`咦?切到${friendly}啦~`, `${friendly},嗯哼?`]
          : [`${friendly} 待这么久,歇会吧~`, `主人好专注哦~`];
      void speak(userPrompt, fallback, 6000);
    });

    return () => {
      signal.disposed = true;
      window.clearTimeout(startTimer);
      window.clearInterval(tickTimer);
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('mousedown', onActivity);
      window.removeEventListener('wheel', onActivity);
      window.removeEventListener('petAI:configChanged', onProactiveCfgChanged);
      window.removeEventListener('pet:character-switched', onCharacterSwitchedListener);
      offAppEvent?.();
    };
  }, [characterId, characterName]);
}
