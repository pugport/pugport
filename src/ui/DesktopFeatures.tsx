import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useMenuKeys } from './use-menu-keys';
import { shownTitle, translateInterfaceText } from './i18n';
import { CornerDownLeft, Search } from 'lucide-react';
import type { Conversation, Settings, Workflow } from '../shared/types';

/* Desktop-app conveniences modelled on the Codex and Claude apps: a right-click menu, a command palette,
   unread markers, finish notifications and keyboard shortcuts. */

export type MenuItem =
  | {
      label: ReactNode;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: (event?: ReactMouseEvent<HTMLButtonElement>) => void;
    }
  | 'separator';

/** A right-click menu at the pointer; Esc, a click elsewhere or scrolling closes it. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useMenuKeys(true, ref, onClose);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    });
  }, [x, y, items.length]);
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof MouseEvent && ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="context-menu" role="menu" style={position} onClick={(event) => event.stopPropagation()}>
      {items.map((item, index) =>
        item === 'separator' ? (
          <hr key={index} />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={item.danger ? 'danger' : ''}
            disabled={item.disabled}
            onClick={(event) => {
              onClose();
              item.onSelect(event);
            }}
          >
            <span className="context-icon">{item.icon}</span>
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

export type PaletteEntry = {
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  shortcut?: string;
  group: string;
  keywords?: string;
  run: () => void;
};

/** Ctrl+K: jump to any conversation or page, or run an action, by typing a few letters. */
export function CommandPalette({ entries, onClose }: { entries: PaletteEntry[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((entry) => {
      const text = `${entry.label} ${entry.detail ?? ''} ${entry.keywords ?? ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [entries, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const choose = (entry?: PaletteEntry) => {
    if (!entry) return;
    onClose();
    entry.run();
  };
  let lastGroup = '';
  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="命令面板">
        <label className="palette-input">
          <Search size={16} />
          <input
            autoFocus
            placeholder="搜索对话、页面或操作…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setActive((value) => (matches.length ? (value + step + matches.length) % matches.length : 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(matches[active]);
              } else if (event.key === 'Escape') onClose();
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="palette-list" ref={list} role="listbox">
          {matches.length === 0 && <p className="palette-empty">没有匹配的结果</p>}
          {matches.map((entry, index) => {
            const heading = entry.group !== lastGroup ? entry.group : '';
            lastGroup = entry.group;
            return (
              <div key={entry.id}>
                {heading && <div className="palette-group">{heading}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? 'active' : ''}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(entry)}
                >
                  <span className="palette-icon">{entry.icon}</span>
                  <span className="palette-label">
                    {entry.label}
                    {entry.detail && <small>{entry.detail}</small>}
                  </span>
                  {entry.shortcut ? <kbd>{entry.shortcut}</kbd> : index === active && <CornerDownLeft size={13} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const shortcutList: Array<[string, string]> = [
  ['Ctrl+Shift+F', '搜索对话内容'],
  ['Ctrl+F', '在对话中查找'],
  ['Ctrl+K', '命令面板：搜索对话、页面和操作'],
  ['Ctrl+B', '切换侧边栏'],
  ['Ctrl+N', '新对话'],
  ['Ctrl+点击对话', '在右侧分屏打开'],
  ['Ctrl+\\', '关闭分屏'],
  ['Ctrl+Shift+O', '在新窗口打开当前对话'],
  ['Ctrl+1 … 9', '切换到侧边栏第 1–9 个对话'],
  ['Ctrl+Tab', '下一个对话'],
  ['Ctrl+Shift+U', '当前对话标为未读'],
  ['Ctrl+Shift+J', '跳到下一条待处理或未读对话'],
  ['Ctrl+,', '设置'],
  ['Ctrl+= / Ctrl+- / Ctrl+0', '放大 / 缩小 / 还原'],
  ['Ctrl+/', '快捷键一览'],
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="palette shortcut-help" role="dialog" aria-label="快捷键">
        <h2>快捷键</h2>
        <dl>
          {shortcutList.map(([keys, label]) => (
            <div key={keys}>
              <dt>
                {keys.split(' / ').map((part) => (
                  <kbd key={part}>{part}</kbd>
                ))}
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** True when this key event should not be taken over by an app shortcut (typing in a field). */
const typing = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
};

/** Global shortcuts; `map` keys look like "ctrl+k", "ctrl+shift+u", "ctrl+1". */
export function useShortcuts(map: Record<string, (event: KeyboardEvent) => void>) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key =
        event.key === 'Tab' ? 'tab' : event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
      const name = `ctrl+${event.shiftKey && key !== '?' ? 'shift+' : ''}${key}`;
      const handler = ref.current[name];
      // Ctrl+K, Ctrl+N and friends work from the composer too; plain editing keys stay with the field.
      if (!handler || (typing(event) && ['ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z'].includes(name))) return;
      event.preventDefault();
      handler(event);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}

const seenKey = 'comborunner.seen';
const readSeen = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(seenKey) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

/**
 * Unread markers: a conversation that changed since it was last on screen gets a dot. New conversations
 * start as read; "mark as unread" stores an empty marker.
 */
export function useUnread(conversations: Conversation[], visible: string[]) {
  const [seen, setSeen] = useState<Record<string, string>>(readSeen);
  // A menu can stay open across updates; its action must mark the latest snapshot as read.
  const latest = useRef({ seen, conversations });
  latest.current = { seen, conversations };
  const save = (next: Record<string, string>) => {
    setSeen(next);
    try {
      localStorage.setItem(seenKey, JSON.stringify(next));
    } catch {
      /* Unread markers are a convenience; without storage they reset on restart. */
    }
  };
  useEffect(() => {
    let changed = false;
    const next = { ...seen };
    for (const conversation of conversations) {
      const onScreen = visible.includes(conversation.id) && document.hasFocus();
      if (next[conversation.id] === undefined || (onScreen && next[conversation.id] !== conversation.updatedAt)) {
        next[conversation.id] = conversation.updatedAt;
        changed = true;
      }
    }
    if (changed) save(next);
  });
  useEffect(() => {
    const focus = () => setSeen((value) => ({ ...value }));
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  return {
    unread: (conversation: Conversation) =>
      !visible.includes(conversation.id) &&
      seen[conversation.id] !== undefined &&
      seen[conversation.id]! < conversation.updatedAt,
    markUnread: (id: string) => save({ ...seen, [id]: '' }),
    markRead: (conversation: Conversation) => save({ ...seen, [conversation.id]: conversation.updatedAt }),
    markAllRead: () =>
      save({
        ...latest.current.seen,
        ...Object.fromEntries(latest.current.conversations.map((item) => [item.id, item.updatedAt])),
      }),
  };
}

const done = new Set<Workflow['status']>(['completed', 'failed', 'cancelled', 'interrupted', 'blocked']);
const waiting = new Set<Workflow['status']>(['waiting-approval', 'waiting-confirmation']);

/**
 * Who already sees a task: Run history shows its selected task together with that task's own sub-tasks, a chat pane
 * every task in its conversation.
 */
export function taskShown(selectedRunsTaskId: string | undefined, visibleConversationIds: readonly string[]) {
  return (workflow: Workflow) =>
    selectedRunsTaskId !== undefined
      ? workflow.id === selectedRunsTaskId || workflow.delegation?.parentId === selectedRunsTaskId
      : visibleConversationIds.includes(workflow.conversationId);
}

/** The desktop notification title: the conversation's own title, else a singular Chat fallback. */
export function finishNotificationTitle(conversationTitle?: string): string {
  if (conversationTitle) return shownTitle(conversationTitle);
  // An untitled conversation is one chat, not the plural Chats navigation heading.
  return translateInterfaceText('聊天');
}

/** A system notification when a task finishes or needs a reply, per the "notify on finish" setting. */
export function useFinishNotifications(
  workflows: Workflow[] | undefined,
  conversations: Conversation[],
  mode: Settings['notifyOnFinish'],
  settings: Pick<Settings, 'notifySound'> | undefined,
  visible: (workflow: Workflow) => boolean,
  open: (conversationId: string) => void,
) {
  const previous = useRef<Map<string, Workflow['status']> | undefined>(undefined);
  useEffect(() => {
    if (!workflows) return;
    const before = previous.current;
    previous.current = new Map(workflows.map((workflow) => [workflow.id, workflow.status]));
    if (!before || (mode ?? 'background') === 'never' || typeof Notification === 'undefined') return;
    for (const workflow of workflows) {
      const was = before.get(workflow.id);
      if (!was || was === workflow.status) continue;
      const finished = done.has(workflow.status) && !done.has(was);
      const asks = waiting.has(workflow.status) && !waiting.has(was);
      if (!finished && !asks) continue;
      if ((mode ?? 'background') === 'background' && document.hasFocus() && visible(workflow)) continue;
      const conversationTitle = conversations.find((item) => item.id === workflow.conversationId)?.title;
      const title = finishNotificationTitle(conversationTitle);
      const body = translateInterfaceText(
        asks
          ? '等待你的确认'
          : workflow.status === 'completed'
            ? '任务已完成'
            : workflow.status === 'failed'
              ? '任务失败'
              : '任务已停止',
      );
      const notice = new Notification(title, { body, tag: workflow.id, silent: settings?.notifySound === false });
      notice.onclick = () => {
        window.focus();
        open(workflow.conversationId);
      };
    }
  }, [workflows]);
}
