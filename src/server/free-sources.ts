import './platform/under-test.ts';
import { mediaModelKind } from '../shared/model-groups.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiPreset, metaModelIds, validateFreeBaseUrl } from '../shared/api-providers.ts';
import type { RuntimeTarget } from '../shared/types.ts';

export type FreeModel = { id: string; name: string };
export type FreeProbe = {
  models: FreeModel[];
  retiredIds?: string[];
  /** Image and video models, listed in the picker's own groups; never part of the chat catalog. */
  imageModelIds?: string[];
  videoModelIds?: string[];
  error?: 'authentication-required' | 'quota-or-rate-limit' | 'runtime-network-error' | 'runtime-request-failed';
  retryAfterSeconds?: number;
};

/** Extract timing before diagnostics are redacted; never retain the provider's text. */
export function retryAfterSeconds(value: unknown, now = Date.now()): number | undefined {
  if (value instanceof Error) value = value.message;
  if (typeof value !== 'string') return;
  const raw = value.trim();
  const numericHeader = raw.match(/retry[-_ ]after["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)(?=$|[\s,"'}])/i);
  if (numericHeader && Number.isFinite(Number(numericHeader[1]))) return Number(numericHeader[1]);
  const match = raw.match(/retry[-_ ]after["']?\s*[:=]\s*["']?([^\r\n"'}]+)/i);
  const text = match?.[1]?.trim() ?? raw;
  const seconds = /^\d+(?:\.\d+)?(?:\s*s(?:econds?)?)?$/i.test(text) ? Number.parseFloat(text) : undefined;
  if (seconds !== undefined && Number.isFinite(seconds)) return seconds;
  if (/^[A-Za-z]{3},\s+\d/.test(text)) {
    const date = Date.parse(text);
    if (Number.isFinite(date)) return Math.max(0, (date - now) / 1000);
  }
}

export async function probeFreeSource(
  target: RuntimeTarget,
  key?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FreeProbe> {
  const preset = apiPreset(target.apiProvider);
  if (!preset?.endpoint) throw new Error('未知模型来源。');
  if (!preset.keyless && !key) return { models: [], error: 'authentication-required' };
  const paid = preset.tier !== 'free';
  const base = validateFreeBaseUrl(paid ? preset.endpoint.baseUrl : (target.apiBaseUrl ?? preset.endpoint.baseUrl));
  const discovery = preset.endpoint.discovery;
  const url =
    discovery === 'ollama-tags'
      ? `${base.replace(/\/v1$/, '')}/api/tags`
      : discovery === 'gemini'
        ? 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
        : discovery === 'github'
          ? 'https://models.github.ai/catalog/models'
          : `${base}/${discovery === 'xai' ? 'language-models' : 'models'}${discovery === 'anthropic' ? '?limit=1000' : ''}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Gemini supports this header, avoiding credentials in URLs and thrown fetch diagnostics.
  if (key)
    headers[discovery === 'gemini' ? 'x-goog-api-key' : 'Authorization'] =
      discovery === 'gemini' ? key : `Bearer ${key}`;
  if (discovery === 'anthropic') {
    delete headers.Authorization;
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    if (target.apiWorkspaceId) headers['anthropic-workspace-id'] = target.apiWorkspaceId;
  }
  try {
    const signal = AbortSignal.timeout(preset.local ? 1500 : 8000);
    const models: FreeModel[] = [];
    const retiredIds: string[] = [];
    const seen = new Set<string>();
    const response = await fetchImpl(url, {
      headers,
      signal,
      redirect: 'error',
    });
    if (!response.ok)
      return {
        models: [],
        error:
          response.status === 401 || response.status === 403
            ? 'authentication-required'
            : response.status === 429
              ? 'quota-or-rate-limit'
              : 'runtime-request-failed',
        ...(response.status === 429
          ? { retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')) }
          : {}),
      };
    const body = await response.json();
    const rows =
      discovery === 'ollama-tags' || discovery === 'gemini' || discovery === 'xai'
        ? body?.models
        : discovery === 'github'
          ? body
          : body?.data;
    if (!Array.isArray(rows)) return { models: [], error: 'runtime-request-failed' };
    const imageModelIds: string[] = [];
    const videoModelIds: string[] = [];
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue;
      // Gemini's image and video models generate with predict, not generateContent; a paid card lists them.
      if (
        discovery === 'gemini' &&
        (!Array.isArray(item.supportedGenerationMethods) ||
          !item.supportedGenerationMethods.includes('generateContent')) &&
        !(paid && typeof item.name === 'string' && mediaModelKind(item.name, item))
      )
        continue;
      if (
        discovery === 'openrouter-free' &&
        (typeof item.id !== 'string' ||
          !item.id.endsWith(':free') ||
          !item.pricing ||
          !['prompt', 'completion'].every(
            (field) =>
              ['number', 'string'].includes(typeof item.pricing[field]) &&
              String(item.pricing[field]).trim() !== '' &&
              Number(item.pricing[field]) === 0,
          ) ||
          Object.values(item.pricing).some((price) => price != null && price !== '' && Number(price) !== 0))
      )
        continue;
      const raw = discovery === 'ollama-tags' || discovery === 'gemini' ? item.name : item.id;
      const id = typeof raw === 'string' ? (discovery === 'gemini' ? raw.replace(/^models\//, '') : raw) : '';
      // Catalog text is untrusted; never copy a reflected key or interpolation into config.
      if (
        !id ||
        id.length > 256 ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id) ||
        (key && id.includes(key)) ||
        seen.has(id)
      )
        continue;
      seen.add(id);
      if (paid) {
        if (preset.id === 'meta-model-api' && !metaModelIds.includes(id)) continue;
        if (
          typeof (item.shutdown_date ?? item.expiration_date) === 'string' &&
          Date.parse(item.shutdown_date ?? item.expiration_date) <= Date.now()
        ) {
          retiredIds.push(id);
          continue;
        }
        // Image and video models are listed in their own picker groups, never in the chat catalog below.
        const media = mediaModelKind(id, item);
        if (media) {
          const list = media === 'image' ? imageModelIds : videoModelIds;
          if (list.length < 64) list.push(id);
          continue;
        }
        // List APIs without capability fields need a conservative family allowlist.
        // shortcut: new model families need a filter update when providers omit chat capabilities.
        if (/(?:embed|tts|whisper|transcrib|audio|realtime|image|dall-e|moderation|sora)/i.test(id)) continue;
        if (preset.id === 'openai' && /instruct/i.test(id)) continue;
        if (Array.isArray(item.output_modalities) && !item.output_modalities.includes('text')) continue;
        if (preset.id === 'openai' && !/^(?:gpt-|chatgpt-|chat-|o\d)/.test(id)) continue;
        if (preset.id === 'deepseek' && !id.startsWith('deepseek-')) continue;
        if (preset.id.startsWith('moonshot') && !/^(?:moonshot-|kimi-)/.test(id)) continue;
        if (discovery === 'anthropic' && !id.startsWith('claude-')) continue;
        if (discovery === 'openrouter' && !item.architecture?.output_modalities?.includes('text')) continue;
        if (discovery === 'xai' && !item.output_modalities?.includes('text')) continue;
      }
      models.push({ id, name: id });
      if (models.length === (paid ? 4000 : 200)) break;
    }
    return {
      models,
      ...(paid ? { retiredIds } : {}),
      ...(paid ? { imageModelIds, videoModelIds } : {}),
    };
  } catch {
    return { models: [], error: 'runtime-network-error' };
  }
}

export function freeModelsJson(target: RuntimeTarget, models: FreeModel[]) {
  const preset = apiPreset(target.apiProvider);
  if (preset?.tier !== 'free' || !preset.endpoint) throw new Error('未知免费来源。');
  return {
    providers: {
      [preset.runtimeProvider]: {
        baseUrl: validateFreeBaseUrl(target.apiBaseUrl ?? preset.endpoint.baseUrl),
        api: preset.endpoint.api,
        apiKey: preset.local ? 'local' : '$PUGPORT_SOURCE_KEY',
        models: models.map(({ id, name }) => ({
          id,
          name,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 4096,
        })),
      },
    },
  };
}

export function syncFreeSourceConfig(target: RuntimeTarget, models: FreeModel[]) {
  if (!target.agentDir) throw new Error('免费来源缺少独立配置目录。');
  mkdirSync(target.agentDir, { recursive: true });
  writeFileSync(join(target.agentDir, 'models.json'), `${JSON.stringify(freeModelsJson(target, models), null, 2)}\n`);
  // Verified against pi-coding-agent/docs/configuration.md and settings.md.
  if (!apiPreset(target.apiProvider)?.local)
    writeFileSync(
      join(target.agentDir, 'settings.json'),
      JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }, null, 2),
    );
}
