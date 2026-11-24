import { cleanGrokDiagnostic } from '../../shared/grok-usage.ts';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { externalAgentCatalog, externalAgentIds, type ExternalAgentId } from '../../shared/external-agents.ts';
import type { WebSelectors } from '../../shared/web-bridge.ts';
import type { WebAgentCooldown, WebQuota } from '../../shared/external-agents.ts';
import { parseVisibleWebUsage, redactedUsageSample, usageSignatureSchema, webQuotaSchema } from './usage.ts';

/*
 * Settings for the external agents (data dir, external-agents.json) and the per-site selectors of the web agents
 * (web-agent-selectors.json). Neither holds anything secret: sign-ins live in each agent's own browser profile.
 */

const selectorText = z.string().max(500).optional();
const selectorsSchema = z.object({ input: selectorText, send: selectorText, reply: selectorText, stop: selectorText });
const agentSchema = z.object({
  added: z.boolean().optional(),
  enabled: z.boolean().optional(),
  botId: z.string().max(200).optional(),
  usageEnabled: z.boolean().optional(),
  usageSource: z.enum(['separate', 'cursor-editor']).optional(),
  /** Grok Bot: the usage account's hash the user confirmed as their chat account, for the current usage source. */
  usageAccountConfirmed: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  usageLoginCreated: z.boolean().optional(),
  usageAttemptedAt: z.string().datetime().optional(),
  usageSignedOut: z.boolean().optional(),
  grokDiagnostic: z.unknown().transform(cleanGrokDiagnostic).optional(),
  riskAcceptedAt: z.string().max(40).optional(),
  url: z.string().max(2000).optional(),
  usageUrl: z.string().max(2000).optional(),
  cooldown: z
    .object({ reason: z.string().max(400), observedAt: z.string(), resetsAt: z.string().nullable() })
    .optional(),
  quota: webQuotaSchema.optional(),
  usageSignatures: z.array(usageSignatureSchema).max(4).optional(),
  usageDiagnostics: z.array(z.string().max(240).transform(redactedUsageSample)).max(4).optional(),
  detection: z.object({ at: z.string().max(40), ok: z.boolean(), note: z.string().max(400) }).optional(),
});
const configSchema = z.object({
  version: z.literal(1),
  agents: z.object(Object.fromEntries(externalAgentIds.map((id) => [id, agentSchema.optional()]))),
});
const selectorFileSchema = z.object({
  version: z.literal(1),
  replySafetyVersion: z.literal(1).optional(),
  sites: z.record(
    z.string(),
    selectorsSchema.extend({ origin: z.string().max(500).optional(), updatedAt: z.string().max(40).optional() }),
  ),
});
export type AgentSettings = z.infer<typeof agentSchema>;

/** Defaults and background observations alone do not mean the user added a bot. */
function legacyAgentAdded(saved: AgentSettings): boolean {
  return (
    ['enabled', 'botId', 'usageEnabled', 'usageSource', 'url', 'usageUrl'].some(
      (key) => saved[key as keyof AgentSettings] !== undefined,
    ) ||
    saved.usageLoginCreated === true ||
    !!saved.riskAcceptedAt
  );
}

// Site notices only; chat replies are never input to these patterns.
export const webLimitPatterns = [
  /\byou(?:'|’)?(?:ve| have) reached (?:your|the) (?:usage |message |weekly )?limit\b/i,
  /\b(?:usage|rate|message|weekly|token) limit(?: reached| exceeded)?\b/i,
  /\b(?:quota|tokens?|allowance) (?:exhausted|used up)\b/i,
  /(?:已(?:达到?|用尽)上限|已达上限|(?:额度|配额|次数|用量|令牌)已(?:用完|耗尽)|用量限制)/,
];

export function parseWebReset(text: string, now = Date.now()): string | null {
  const relative =
    text.match(
      /(?:try again|resets?|available again)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|hours?|minutes?|seconds?)\s*)+)/i,
    ) ?? text.match(/((?:\d+(?:\.\d+)?\s*(?:天|小时|小時|分钟|分鐘|秒)\s*)+)\s*后(?:重置|恢复|再试)/);
  if (relative) {
    let ms = 0;
    for (const match of relative[1]!.matchAll(
      /(\d+(?:\.\d+)?)\s*(days?|hours?|minutes?|seconds?|天|小时|小時|分钟|分鐘|秒)/gi,
    )) {
      const unit = match[2]!.toLowerCase();
      ms +=
        Number(match[1]) *
        (/^day|天/.test(unit)
          ? 86_400_000
          : /^hour|小时|小時/.test(unit)
            ? 3_600_000
            : /^minute|分钟|分鐘/.test(unit)
              ? 60_000
              : 1000);
    }
    if (ms > 0 && ms <= 366 * 86_400_000) return new Date(now + ms).toISOString();
  }
  const date =
    text.match(
      /(?:resets?\s*(?:on|at|:)?|重置(?:时间)?\s*[:：]?|将于)\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:[T\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT)?)?)/i,
    ) ??
    text.match(
      /(?:resets?\s*(?:on|at|:)?|重置时间\s*[:：]?)\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}(?:\s+(?:at\s+)?\d{1,2}:\d{2}(?:\s*[AP]M)?(?:\s+(?:UTC|GMT))?)?)/i,
    ) ??
    text.match(/(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?)\s*(?:后)?重置/);
  if (date) {
    const value = Date.parse(
      date[1]!
        .replace(/年|月/g, '-')
        .replace(/日/g, '')
        .replace(/\s+at\s+/i, ' '),
    );
    if (Number.isFinite(value)) return new Date(value).toISOString();
  }
  const shortDate =
    text.match(/(?:将在|将于)\s*(\d{1,2})月\s*(\d{1,2})日(?:重置)?/) ?? text.match(/(\d{1,2})月\s*(\d{1,2})日\s*重置/);
  const english = text.match(
    /resets?\s+(?:on\s+)?(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?!\d)/i,
  );
  if (shortDate || english) {
    const month = shortDate
      ? Number(shortDate[1]) - 1
      : ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
          english![1]!.slice(0, 3).toLowerCase(),
        );
    const day = Number((shortDate ?? english)![2]);
    const current = new Date(now);
    let value = new Date(current.getFullYear(), month, day);
    if (value.getMonth() !== month || value.getDate() !== day) return null;
    if (value.getTime() <= now) value = new Date(current.getFullYear() + 1, month, day);
    return value.toISOString();
  }
  const clock = text.match(/(?:resets?\s+at|重置时间\s*[:：])\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*(UTC|GMT)?/i);
  if (clock) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59 || (clock[3] && (hours < 1 || hours > 12))) return null;
    if (clock[3]) hours = (hours % 12) + (/pm/i.test(clock[3]) ? 12 : 0);
    const value = new Date(now);
    if (clock[4]) value.setUTCHours(hours, minutes, 0, 0);
    else value.setHours(hours, minutes, 0, 0);
    if (value.getTime() <= now) value.setDate(value.getDate() + 1);
    return value.toISOString();
  }
  return null;
}

export function detectWebLimit(text: string, siteNotice = false, now = Date.now()): WebAgentCooldown | undefined {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!siteNotice || clean.length > 1000 || !webLimitPatterns.some((pattern) => pattern.test(clean))) return;
  // Explanations and quotations in generic status regions are not an exhaustion notice.
  if (
    /\b(?:if|example|means|explains?|about|not reached|haven't reached|limit is)\b|limit\s*:\s*\d|例如|如果|解释|尚未|未达到/i.test(
      clean,
    )
  )
    return;
  if (
    !/reached|exceeded|exhausted|used up|try again|已(?:达|达到|用完|耗尽|用尽)/i.test(clean) &&
    !/^(?:(?:usage|rate|message|weekly|token) limit[.!]?|用量限制)$/i.test(clean)
  )
    return;
  const resetsAt = parseWebReset(clean, now);
  if (resetsAt && Date.parse(resetsAt) <= now) return;
  return { reason: clean.slice(0, 400), observedAt: new Date(now).toISOString(), resetsAt };
}

export function parseWebUsage(text: string, now = Date.now(), structuredOnly = false): WebQuota {
  const visible = parseVisibleWebUsage(text, now, parseWebReset);
  if (visible) return visible;
  if (structuredOnly || /从不过期|never expires|no expiration/i.test(text))
    return { status: 'unknown', source: '网页用量页', observedAt: new Date(now).toISOString(), windows: [] };
  const percentage =
    text.match(/(?:used|usage|consumed|已用|已使用|用量|已消耗)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i) ??
    text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:used|consumed|已用|已使用|已消耗)/i);
  const left =
    text.match(/(?:remaining|left|available|剩余|可用)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i) ??
    text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:remaining|left|available|剩余|可用)/i);
  const tokens =
    text.match(
      /(?:Muse\s*)?(?:tokens?|令牌|代币)\s*(?:used|已用|已使用)?\s*[:：]?\s*([\d,]+)\s*(?:of|\/|共|总计)\s*([\d,]+)/i,
    ) ?? text.match(/([\d,]+)\s*(?:of|\/)\s*([\d,]+)\s*(?:Muse\s*)?(?:tokens?|令牌|代币)/i);
  const used = percentage
    ? Number(percentage[1])
    : left
      ? 100 - Number(left[1])
      : tokens && Number(tokens[2]!.replace(/,/g, '')) > 0
        ? (Number(tokens[1]!.replace(/,/g, '')) / Number(tokens[2]!.replace(/,/g, ''))) * 100
        : undefined;
  const observedAt = new Date(now).toISOString();
  return {
    status: used !== undefined && Number.isFinite(used) && used >= 0 && used <= 100 ? 'known' : 'unknown',
    source: '网页用量页',
    observedAt,
    windows:
      used !== undefined && Number.isFinite(used) && used >= 0 && used <= 100
        ? [{ id: 'web-usage', label: '网页用量', usedPercent: used, resetsAt: parseWebReset(text, now), observedAt }]
        : [],
  };
}

/** Visible site chrome, excluding known chat bubbles and editable fields. Runs in the isolated page world. */
export const webUsageSnapshot = (replySelector = '', includeText = true) => String.raw`(() => {
  const visible = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > .05;
  };
  const chat = '[data-message-author-role], [data-role="assistant"], [data-role="user"], [class*="chat-message" i], [class*="assistant-message" i], [class*="user-message" i], [class*="markdown" i], textarea, input, [contenteditable], [role="textbox"]';
  const reply = ${JSON.stringify(replySelector)};
  const inReply = el => { try { return reply && (el.closest(reply) || el.querySelector(reply)); } catch { return false; } };
  const excluded = el => el.closest(chat) || el.querySelector(chat) || inReply(el);
  const notices = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [class*="banner" i], [class*="error" i], [data-testid*="limit" i], [data-testid*="toast" i]'))
    .filter(el => visible(el) && !excluded(el)).map(el => (el.innerText || '').trim()).filter(text => text && text.length <= 1000);
  if (!${includeText}) return { notices, text: '', url: location.href };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const text = [], anchors = []; let node, length = 0, previousRow = null;
  while ((node = walker.nextNode()) && length < 100000) {
    const el = node.parentElement;
    if (el && visible(el) && !inReply(el) && !el.closest(chat + ', script, style, [hidden], [aria-hidden="true"]')) {
      let row = el;
      while (row.parentElement && row !== document.body && /^(inline|contents)/.test(getComputedStyle(row).display)) row = row.parentElement;
      if (previousRow && previousRow !== row) text.push('\n');
      text.push(node.textContent); length += node.textContent.length; previousRow = row;
      if (/每周限额|weekly (?:limit|allowance)|额外的?使用额度|(?:extra|additional) usage/i.test(node.textContent)) anchors.push(el);
    }
  }
  const usageBlocks = [];
  for (const anchor of anchors) {
    let row = anchor, sample = (anchor.innerText || '').trim();
    for (let depth = 0; row && row !== document.body && depth < 6; depth++, row = row.parentElement) {
      if (excluded(row)) break;
      const value = (row.innerText || '').trim();
      if (!value || value.length > 2000) break;
      if (/每周限额|weekly (?:limit|allowance)/i.test(value) && /额外的?使用额度|(?:extra|additional) usage/i.test(value)) break;
      sample = value;
      if (/(?:已使用|used|usage)\s*[:：]?\s*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*used/i.test(value)) {
        const parent = row.parentElement;
        if (parent && parent !== document.body && !excluded(parent)) {
          const full = (parent.innerText || '').trim();
          if (full.length <= 2000 && !(/每周限额|weekly (?:limit|allowance)/i.test(full) && /额外的?使用额度|(?:extra|additional) usage/i.test(full))) sample = full;
        }
        break;
      }
    }
    if (sample && !usageBlocks.includes(sample)) usageBlocks.push(sample);
  }
  return { notices, text: text.join(' '), usageBlocks: usageBlocks.slice(0, 8), url: location.href };
})()`;

/**
 * Generic starting points only: the page is re-checked on every message, and what worked there is written back.
 * Edit web-agent-selectors.json in the data folder when a site needs something specific.
 */
// Page labels to match, not interface text: written as escapes ("发送", "停止") so the translation scan skips them.
const sendLabel = '\u53d1\u9001';
const stopLabel = '\u505c\u6b62';
const genericSelectors: WebSelectors = {
  input: 'textarea, div[contenteditable="true"]',
  send: `button[type="submit"], button[aria-label*="Send" i], button[aria-label*="${sendLabel}"]`,
  stop: `button[aria-label*="Stop" i], button[aria-label*="${stopLabel}"]`,
};
export const defaultSelectors: Record<string, WebSelectors> = {
  muse: { ...genericSelectors },
};

type JsonRead<T> = { status: 'missing' } | { status: 'ok'; data: T } | { status: 'invalid' };

function readJsonState<T>(file: string, schema: z.ZodType<T>): JsonRead<T> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid' };
  }
  try {
    return { status: 'ok', data: schema.parse(JSON.parse(raw)) };
  } catch {
    return { status: 'invalid' };
  }
}
function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, file);
}

export const invalidExternalAgentConfigMessage = '外部智能体设置文件格式无效，请先修复或备份 external-agents.json。';

export class ExternalAgentConfig {
  readonly file: string;
  readonly selectorsFile: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'external-agents.json');
    this.selectorsFile = join(dataDir, 'web-agent-selectors.json');
  }
  hasError(): boolean {
    return readJsonState(this.file, configSchema).status === 'invalid';
  }
  private read() {
    const state = readJsonState(this.file, configSchema);
    return state.status === 'ok' ? state.data : { version: 1 as const, agents: {} };
  }
  agent(id: ExternalAgentId): AgentSettings & { url?: string } {
    const saved = this.read().agents[id] ?? {};
    const defaults = externalAgentCatalog[id];
    return {
      enabled: saved.enabled ?? false,
      ...saved,
      added: saved.added ?? legacyAgentAdded(saved),
      ...(id === 'grok-bot' ? { url: undefined, usageEnabled: saved.usageEnabled ?? true } : {}),
      ...(defaults.kind === 'web' ? { url: saved.url ?? defaults.defaultUrl ?? '' } : {}),
    };
  }
  update(id: ExternalAgentId, patch: AgentSettings, options?: { background?: boolean }) {
    const state = readJsonState(this.file, configSchema);
    if (state.status === 'invalid') {
      if (options?.background) return;
      throw new Error(invalidExternalAgentConfigMessage);
    }
    const config = state.status === 'ok' ? state.data : { version: 1 as const, agents: {} };
    const saved = config.agents[id] ?? {};
    const next = {
      ...saved,
      // Persist the previous addition state before background observations can add fields.
      added: saved.added ?? legacyAgentAdded(saved),
      ...patch,
    };
    if (JSON.stringify(config.agents[id]) === JSON.stringify(next)) return;
    config.agents[id] = next;
    writeJson(this.file, config);
  }
  /** Code defaults with the saved file on top; the file is created with the defaults so it can be edited. */
  selectors(id: string, url?: string): WebSelectors {
    const state = readJsonState(this.selectorsFile, selectorFileSchema);
    if (state.status === 'invalid') return { ...defaultSelectors[id] };
    let file = state.status === 'ok' ? state.data : undefined;
    if (!file) {
      file = {
        version: 1,
        replySafetyVersion: 1,
        sites: Object.fromEntries(Object.entries(defaultSelectors).map(([k, v]) => [k, { ...v }])),
      };
      try {
        writeJson(this.selectorsFile, file);
      } catch {
        /* The defaults still apply. */
      }
    }
    // Legacy reply selectors were learned from mutations alone. Their CSS cannot tell us whether
    // they selected a geometric sidebar, so invalidate all once and relearn with the page checks.
    if (!file.replySafetyVersion) {
      for (const site of Object.values(file.sites)) delete site.reply;
      file.replySafetyVersion = 1;
      try {
        writeJson(this.selectorsFile, file);
      } catch {
        /* Safe in-memory defaults still apply. */
      }
    }
    const { origin: savedOrigin, updatedAt: _updatedAt, ...saved } = file.sites[id] ?? {};
    const wantedOrigin = url ? URL.parse(url)?.origin : undefined;
    if (wantedOrigin && savedOrigin && savedOrigin !== wantedOrigin) return { ...defaultSelectors[id] };
    return { ...defaultSelectors[id], ...Object.fromEntries(Object.entries(saved).filter(([, value]) => value)) };
  }
  resetSelectors(id: string) {
    const state = readJsonState(this.selectorsFile, selectorFileSchema);
    if (state.status !== 'ok' || !state.data.sites[id]) return;
    delete state.data.sites[id];
    writeJson(this.selectorsFile, state.data);
  }
  /** What worked on the page replaces the saved value; a selector that was not found is left as it was. */
  saveSelectors(id: string, found: WebSelectors, url?: string) {
    if (readJsonState(this.selectorsFile, selectorFileSchema).status === 'invalid') return;
    this.selectors(id, url); // Run the one-time migration before saving newly validated selectors.
    const clean = Object.fromEntries(
      Object.entries(found).filter(([key, value]) => ['input', 'send', 'reply', 'stop'].includes(key) && value),
    ) as WebSelectors;
    if (!Object.keys(clean).length) return;
    const state = readJsonState(this.selectorsFile, selectorFileSchema);
    if (state.status === 'invalid') return;
    const file = state.status === 'ok' ? state.data : { version: 1 as const, sites: {} };
    const origin = url ? URL.parse(url)?.origin : undefined;
    const existing = file.sites[id];
    const sameOrigin = !origin || !existing?.origin || existing.origin === origin;
    file.sites[id] = {
      ...defaultSelectors[id],
      ...(sameOrigin ? existing : {}),
      ...selectorsSchema.parse(clean),
      ...(origin ? { origin } : {}),
      updatedAt: new Date().toISOString(),
    };
    writeJson(this.selectorsFile, file);
  }
}
