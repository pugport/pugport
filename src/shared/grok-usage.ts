export const grokUsageHint =
  'Grok Bot 由 Cursor 提供，账单在 cursor.com；请用你在 Grok Bot 里登录的同一个账号。这个窗口只读用量，看不到聊天记录。';
export const grokPlanMismatch =
  '读到的是 Cursor 账号自带的 Grok Bot 计划，不是 SuperGrok；如果 Grok Bot 里用的是别的账号，请换那个账号登录';
/**
 * Whether the account behind a Grok Bot usage reading is the chat account the user confirmed. `fingerprint` is the
 * reading account's hash, present only when the usage source reports a comparable identity.
 */
export type GrokUsageAccount = { status: 'matches' | 'different' | 'unverified'; fingerprint?: string };
export function grokUsageAccountLine(account: GrokUsageAccount): string {
  return account.status === 'matches'
    ? '用量账号与你确认的 Grok Bot 聊天账号一致'
    : account.status === 'different'
      ? '用量账号不是你确认的 Grok Bot 聊天账号，这份用量可能属于别的账号'
      : account.fingerprint
        ? '用量账号未核验：请确认它就是你在 Grok Bot 里聊天用的账号'
        : '用量账号未核验：这个用量来源不提供账号身份';
}
export const grokDiagnosticMessages = {
  success: '已读取用量',
  login: '需要登录 Grok Bot 用的账号',
  'human-check': '需要在用量窗口完成一次人机验证',
  'no-plan': '已登录，但这个账号没有 Grok Bot 计划',
  refused: '已登录，用量接口拒绝',
  unreachable: '用量接口不可达',
  'no-data': '页面没有用量数据',
  'load-failed': '用量页面加载失败',
  closed: '用量窗口已关闭',
  unavailable: '请在桌面版登录用量账号',
  error: '用量读取失败',
} as const;
export type GrokUsageDiagnostic = {
  code: keyof typeof grokDiagnosticMessages;
  step: 'login' | 'human-check' | 'navigation' | 'request' | 'parse';
  path: string;
  status?: number;
};
/** Fixed page paths only: URL queries and arbitrary path segments can contain account data. */
export function grokDiagnostic(
  code: GrokUsageDiagnostic['code'],
  step: GrokUsageDiagnostic['step'],
  url = '',
  status?: number,
): GrokUsageDiagnostic {
  let path = '/…';
  try {
    const value = new URL(url, 'https://cursor.com').pathname;
    if (['/', '/login', '/signin', '/dashboard', '/dashboard/spending'].includes(value)) path = value;
    else if (/\/dashboard\//.test(value)) path = '/dashboard/…';
  } catch {
    /* Do not copy malformed URLs. */
  }
  return { code, step, path, ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { status } : {}) };
}
export function cleanGrokDiagnostic(value: unknown): GrokUsageDiagnostic | undefined {
  const d = value as GrokUsageDiagnostic | undefined;
  if (
    !d ||
    !Object.hasOwn(grokDiagnosticMessages, d.code) ||
    !['login', 'human-check', 'navigation', 'request', 'parse'].includes(d.step)
  )
    return;
  return grokDiagnostic(d.code, d.step, typeof d.path === 'string' ? d.path : '', d.status);
}
export function grokDiagnosticLine(d: GrokUsageDiagnostic): string {
  const steps = {
    login: '登录',
    'human-check': '人机验证',
    navigation: '页面跳转',
    request: '接口读取',
    parse: '数据识别',
  };
  return `${grokDiagnosticMessages[d.code]}${d.status ? ` (${d.status})` : ''} · ${d.path} · ${steps[d.step]}`;
}
