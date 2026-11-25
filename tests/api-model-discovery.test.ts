import '../src/server/platform/under-test.ts';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { ModelConfig } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js';
import { composeModelProvider } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js';
import { apiPreset, metaModelIds } from '../src/shared/api-providers.ts';
import type { ExecuteContext, ModelInfo, RunEvent } from '../src/shared/types.ts';
import { apiEnvironment, apiTarget, syncApiModelsConfig, saveApiKey } from '../src/server/api-providers.ts';
import { Controller } from '../src/server/controller.ts';
import {
  apiCatalog,
  apiMediaModels,
  clearApiModelList,
  mergeApiModels,
  readApiModelList,
  refreshApiModelList,
} from '../src/server/api-model-discovery.ts';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { probeFreeSource } from '../src/server/free-sources.ts';
import { createPiAdapter, piModels } from '../src/server/adapters/pi.ts';
import { assertTestUrl, testDirectory } from '../src/server/platform/under-test.ts';
import { selectAutomaticModel } from '../src/server/model-selection.ts';
import { autoPickable, route } from '../src/server/routing.ts';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const key = 'SYNTHETIC_DISCOVERY_KEY';
const providers = ['deepseek', 'openai', 'anthropic', 'xai', 'google', 'moonshot', 'moonshot-cn', 'openrouter'];
const unknowns: Record<string, string> = {
  deepseek: 'deepseek-release-test',
  openai: 'gpt-99-test',
  anthropic: 'claude-release-test',
  xai: 'grok-release-test',
  google: 'gemini-release-test',
  moonshot: 'kimi-release-test',
  'moonshot-cn': 'kimi-release-test',
  openrouter: 'synthetic/chat-release-test',
};
const targetFor = (id: string, suffix = '') =>
  apiTarget(process.cwd(), join(testDirectory(), id + suffix), apiPreset(id)!, `api-${id}${suffix}`, id);
/**
 * A catalog model the provider's own list can name. Pi's catalog order is not a contract, and OpenRouter's
 * "~vendor/model-latest" aliases are not IDs discovery accepts.
 */
const knownModel = (target: ReturnType<typeof targetFor>) =>
  apiCatalog(target).find((model) => /^[a-zA-Z0-9]/.test(model.id))!;
const demand = { tier: 'strong' as const, effort: 'high', goal: 'quality' as const };

test('OpenAI media picker enables chatgpt-image models while DALL-E stays unsupported', () => {
  const target = targetFor('openai', '-chatgpt-image');
  mkdirSync(target.agentDir!, { recursive: true });
  writeFileSync(
    join(target.agentDir!, 'model-list.json'),
    JSON.stringify({
      preset: 'openai',
      checkedAt: Date.now(),
      ids: [],
      retired: [],
      images: ['gpt-image-2', 'chatgpt-image-latest', 'chatgpt-image-2026-01-01', 'dall-e-3'],
    }),
  );
  const models = apiMediaModels(target);
  assert.equal(models.find((model) => model.id === 'openai/chatgpt-image-latest')?.unsupported, undefined);
  assert.equal(models.find((model) => model.id === 'openai/chatgpt-image-2026-01-01')?.unsupported, undefined);
  assert.equal(models.find((model) => model.id === 'openai/dall-e-3')?.unsupported, true);
  assert.equal(models[0]?.id, 'openai/gpt-image-2');
});

for (const id of providers)
  test(`${id}: official host, auth, chat filter, merge, cache and Pi config`, async (t) => {
    const target = { ...targetFor(id), apiBaseUrl: 'https://never-send-a-key.invalid' };
    const preset = apiPreset(id)!;
    const known = knownModel(target);
    assert.ok(known);
    const unknown = unknowns[id];
    const rows = [
      known.id,
      unknown,
      `${unknown}-embedding`,
      `${unknown}-tts`,
      `${unknown}-image`,
      `${unknown}-moderation`,
      `gpt-${key}`,
      '!unsafe',
      unknown,
    ].map((name) => ({
      id: name,
      name: `models/${name}`,
      output_modalities: name.endsWith('-image') ? ['image'] : ['text'],
      architecture: { output_modalities: name.endsWith('-image') ? ['image'] : ['text'] },
      supportedGenerationMethods: name.endsWith('-embedding') ? ['embedContent'] : ['generateContent'],
      displayName: key,
      description: key,
    }));
    const body = { data: rows, models: rows };
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      const header = id === 'anthropic' ? 'x-api-key' : id === 'google' ? 'x-goog-api-key' : 'authorization';
      assert.equal(req.headers[header], header === 'authorization' ? `Bearer ${key}` : key);
      if (id === 'anthropic') assert.equal(req.headers['anthropic-version'], '2023-06-01');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
    await listenForFetch(server);
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const localFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, new URL(preset.endpoint!.baseUrl).origin);
      assert.equal(
        url.pathname,
        id === 'google'
          ? '/v1beta/models'
          : id === 'xai'
            ? '/v1/language-models'
            : id === 'deepseek'
              ? '/models'
              : id === 'openrouter'
                ? '/api/v1/models'
                : '/v1/models',
      );
      if (id === 'anthropic') assert.equal(url.searchParams.get('limit'), '1000');
      if (id === 'google') assert.equal(url.searchParams.get('pageSize'), '1000');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
    };
    const now = Date.now();
    await Promise.all([
      refreshApiModelList(target, key, localFetch, now),
      refreshApiModelList(target, key, localFetch, now),
    ]);
    assert.equal(requests, 1);
    await refreshApiModelList(target, key, localFetch, now + 86_399_999);
    assert.equal(requests, 1);
    assert.deepEqual(readApiModelList(target)?.ids, [known.id, unknown]);
    const catalog = piModels({ models: apiCatalog(target) });
    const merged = mergeApiModels(target, catalog);
    const knownId = `${preset.runtimeProvider}/${known.id}`;
    assert.deepEqual(
      merged.find((model) => model.id === knownId),
      catalog.find((model) => model.id === knownId),
    );
    assert.equal(merged.length, catalog.length + 1, 'unlisted catalog models stay');
    const fresh = merged.at(-1)!;
    assert.equal(fresh.price, undefined);
    assert.deepEqual(fresh, {
      id: `${preset.runtimeProvider}/${unknown}`,
      label: unknown,
      efforts: [],
      discovered: true,
    });
    assert.equal(autoPickable(fresh), false);
    assert.equal(selectAutomaticModel([fresh], 'pi', demand), undefined);
    assert.notEqual(selectAutomaticModel(merged, 'pi', demand)?.id, fresh.id);
    syncApiModelsConfig(target, preset);
    const configText = readFileSync(join(target.agentDir!, 'models.json'), 'utf8');
    const config = JSON.parse(configText).providers[preset.runtimeProvider];
    assert.deepEqual(
      config.models.map((model: any) => model.id),
      [unknown],
    );
    const api = id === 'xai' ? 'openai-responses' : preset.endpoint!.api;
    assert.deepEqual(config.models, [{ id: unknown, api }]);
    assert.equal(config.baseUrl, undefined);
    assert.equal(config.api, undefined);
    assert.equal(config.apiKey, undefined);
    assert.ok(!JSON.stringify(merged).includes(key));
    assert.ok(!configText.includes(key));
    assert.ok(!readFileSync(join(target.agentDir!, 'model-list.json'), 'utf8').includes(key));
    await refreshApiModelList(target, key, localFetch, now + 86_400_000);
    assert.equal(requests, 2);
  });

test('OpenRouter catalog Claude keeps its Anthropic address after discovery', async () => {
  const target = targetFor('openrouter', '-claude');
  const preset = apiPreset('openrouter')!;
  await refreshApiModelList(
    target,
    key,
    async () =>
      new Response(
        JSON.stringify({
          data: [{ id: unknowns.openrouter, architecture: { output_modalities: ['text'] } }],
        }),
      ),
  );
  syncApiModelsConfig(target, preset);
  const config = await ModelConfig.load(join(target.agentDir!, 'models.json'));
  assert.equal(config.getError(), undefined);
  const base = builtinProviders().find((provider) => provider.id === 'openrouter')!;
  const models = composeModelProvider('openrouter', base, config, undefined).getModels();
  const claude = models.filter((model) => model.api === 'anthropic-messages');
  assert.ok(claude.length > 0);
  for (const model of claude) assert.equal(model.baseUrl, 'https://openrouter.ai/api');
  const discovered = models.find((model) => model.id === unknowns.openrouter)!;
  assert.equal(discovered.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(discovered.api, 'openai-completions');
  assert.equal(discovered.maxTokens, 16384);
  assert.equal(discovered.contextWindow, 128000);
});

test('success then timeout preserves discovered models and retirement while updating checkedAt', async () => {
  const target = targetFor('openai', '-keep-cache');
  const now = Date.now();
  const retired = apiCatalog(target)[0].id;
  await refreshApiModelList(
    target,
    key,
    async () =>
      new Response(JSON.stringify({ data: [{ id: unknowns.openai }, { id: retired, shutdown_date: '2000-01-01' }] })),
    now,
  );
  const before = readApiModelList(target)!;
  await refreshApiModelList(
    target,
    key,
    async () => {
      throw new DOMException('synthetic timeout', 'TimeoutError');
    },
    now + 86_400_000,
  );
  assert.deepEqual(readApiModelList(target), { ...before, checkedAt: now + 86_400_000 });
  syncApiModelsConfig(target, apiPreset('openai')!);
  const models = JSON.parse(readFileSync(join(target.agentDir!, 'models.json'), 'utf8')).providers.openai.models;
  assert.equal(models[0].id, unknowns.openai);
  assert.ok(mergeApiModels(target, piModels({ models: apiCatalog(target) })).some((model) => model.discovered));
});

test('OpenAI Luna chat models are discoverable while instruct models are excluded', async () => {
  const target = targetFor('openai', '-luna');
  const ids = ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-99-luna', 'gpt-99-instruct'];
  await refreshApiModelList(target, key, async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) })));
  assert.deepEqual(readApiModelList(target)?.ids, ids.slice(0, 3));
  assert.ok(
    mergeApiModels(target, piModels({ models: apiCatalog(target) })).some((model) => model.id === 'openai/gpt-99-luna'),
  );
});

test('clearing a card allows immediate discovery and ignores the old in-flight result', async () => {
  const target = targetFor('deepseek', '-clear');
  let finish!: (response: Response) => void;
  const old = refreshApiModelList(
    target,
    key,
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  clearApiModelList(target);
  await refreshApiModelList(
    target,
    key,
    async () => new Response(JSON.stringify({ data: [{ id: unknowns.deepseek }] })),
  );
  finish(new Response('{"data":[]}'));
  await old;
  assert.deepEqual(readApiModelList(target)?.ids, [unknowns.deepseek]);
  clearApiModelList(target);
  assert.equal(existsSync(join(target.agentDir!, 'model-list.json')), false);
  await refreshApiModelList(target, key, async () => new Response('{"data":[]}'));
  assert.deepEqual(readApiModelList(target)?.ids, []);
});

test('replacing a key clears that card cooldown and cache before checking the corrected key', async (t) => {
  const target = targetFor('deepseek', '-replace');
  const other = targetFor('deepseek', '-other');
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = join(testDirectory(), 'replacement-keys');
  t.after(() => {
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
  });
  for (const card of [target, other])
    await refreshApiModelList(card, key, async () => new Response('{}', { status: 401 }));
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, {
    targets: [target],
    freeHealth: { clear() {} },
    cooldown: { clear() {} },
    inbox: { resolve() {} },
    targetGeneration: 0,
    apiBalances: {},
    apiWorkspaceLookups: {},
    // replaceApiKey runs inside the account-mutation queue.
    apiMutations: Promise.resolve(),
    store: { setConfig() {} },
  });
  t.mock.method(controller, 'broadcast', () => {});
  t.mock.method(controller, 'apiProviders', () => []);
  let refreshed!: Promise<void>;
  t.mock.method(controller as any, 'checkApiKey', () => {
    assert.equal(readApiModelList(target), undefined);
    refreshed = refreshApiModelList(
      target,
      key,
      async () => new Response(JSON.stringify({ data: [{ id: unknowns.deepseek }] })),
    );
  });
  await controller.replaceApiKey(target.id, 'SYNTHETIC_CORRECTED_KEY');
  await refreshed;
  assert.deepEqual(readApiModelList(target)?.ids, [unknowns.deepseek]);
  assert.ok(readApiModelList(other));
});

test('401, timeout, malformed list and missing key silently retain the catalog and throttle failures', async () => {
  for (const failure of ['401', 'timeout', 'malformed', 'no-key']) {
    const target = targetFor('deepseek', `-${failure}`);
    let calls = 0;
    const mock: typeof fetch = async () => {
      calls++;
      if (failure === 'timeout') throw new DOMException(`never retain ${key}`, 'TimeoutError');
      return new Response(JSON.stringify(failure === 'malformed' ? { data: null } : {}), {
        status: failure === '401' ? 401 : 200,
      });
    };
    const catalog = piModels({ models: apiCatalog(target) });
    await refreshApiModelList(target, failure === 'no-key' ? undefined : key, mock);
    await refreshApiModelList(target, failure === 'no-key' ? undefined : key, mock);
    assert.equal(calls, failure === 'no-key' ? 0 : 1);
    assert.deepEqual(mergeApiModels(target, catalog), catalog);
  }
});

test('an unwritable cache still limits metadata requests to once a day', async () => {
  const target = targetFor('deepseek', '-bad-cache');
  mkdirSync(target.agentDir!, { recursive: true });
  const file = join(target.agentDir!, 'not-a-directory');
  writeFileSync(file, 'synthetic', 'utf8');
  const broken = { ...target, agentDir: file };
  let calls = 0;
  const mock: typeof fetch = async () => {
    calls++;
    return new Response('{"data":[]}');
  };
  await refreshApiModelList(broken, key, mock);
  await refreshApiModelList(broken, key, mock);
  assert.equal(calls, 1);
});

test('a damaged discovery cache cannot turn Pi custom models into priced automatic candidates', async () => {
  const target = targetFor('deepseek', '-corrupt');
  await refreshApiModelList(
    target,
    key,
    async () => new Response(JSON.stringify({ data: [{ id: unknowns.deepseek }] })),
  );
  syncApiModelsConfig(target, apiPreset('deepseek')!);
  writeFileSync(join(target.agentDir!, 'model-list.json'), '{broken', 'utf8');
  const catalog = piModels({ models: apiCatalog(target) });
  const custom: ModelInfo = {
    id: `deepseek/${unknowns.deepseek}`,
    label: unknowns.deepseek,
    efforts: ['off'],
    price: { input: 0, output: 0 },
  };
  assert.deepEqual(mergeApiModels(target, [...catalog, custom]), catalog);
});

test('test guard refuses API config and discovery outside synthetic directories', async () => {
  const target = { ...targetFor('deepseek', '-isolated'), agentDir: 'C:/pugport-forbidden-fixture' };
  assert.throws(() => syncApiModelsConfig(target, apiPreset('deepseek')!), /outside test directory/);
  let calls = 0;
  await refreshApiModelList(target, key, async () => {
    calls++;
    return new Response('{"data":[]}');
  });
  assert.equal(calls, 0);
  assert.equal(readApiModelList(target), undefined);
});

test('providers outside discovery keep their existing model configuration', () => {
  const target = targetFor('mistral', '-existing');
  mkdirSync(target.agentDir!, { recursive: true });
  const file = join(target.agentDir!, 'models.json');
  const content = '{"providers":{"mistral":{"headers":{"x-synthetic":"keep"}}}}\n';
  writeFileSync(file, content, 'utf8');
  syncApiModelsConfig(target, apiPreset('mistral')!);
  assert.equal(readFileSync(file, 'utf8'), content);
});

test('official retirement dates hide expired models and keep future, invalid or undocumented flags', async () => {
  for (const provider of ['openai', 'openrouter']) {
    const target = targetFor(provider, '-retired');
    const known = knownModel(target);
    const prefix = provider === 'openai' ? 'gpt-' : 'synthetic/';
    const ids = ['expired', 'future', 'invalid', 'legacy', 'precedence'].map((id) => prefix + id);
    await refreshApiModelList(
      target,
      key,
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: known.id, shutdown_date: '2000-01-01' },
              { id: ids[0], expiration_date: '2000-01-01' },
              { id: ids[1], expiration_date: '2999-01-01' },
              { id: ids[2], shutdown_date: 'invalid' },
              { id: ids[3], retired: true, status: 'retired' },
              { id: ids[4], shutdown_date: '2999-01-01', expiration_date: '2000-01-01' },
            ].map((item) => ({ ...item, architecture: { output_modalities: ['text'] } })),
          }),
        ),
    );
    assert.deepEqual(readApiModelList(target)?.retired, [known.id, ids[0]]);
    assert.deepEqual(readApiModelList(target)?.ids, ids.slice(1));
    const catalog = piModels({ models: apiCatalog(target) });
    const knownId = `${apiPreset(provider)!.runtimeProvider}/${known.id}`;
    assert.ok(catalog.some((model) => model.id === knownId));
    assert.ok(!mergeApiModels(target, catalog).some((model) => model.id === knownId));
  }
});

test('parent and Pi child reject non-loopback hosts even when the model base URL override is missing', () => {
  assert.throws(() => assertTestUrl('https://provider.invalid/models'), /under test/);
  const target = targetFor('deepseek', '-guard');
  const env = apiEnvironment(target, apiPreset('deepseek')!, key, {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
  });
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "try { await fetch('https://provider.invalid/chat/completions'); process.exitCode = 9; } catch (e) { if (!e.message.includes('under test')) process.exitCode = 8; else console.log('blocked'); }",
    ],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(output.trim(), 'blocked');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1');
});

test('a redirect cannot forward the card key to another host', async (t) => {
  let leaked = 0;
  const other = createServer((_req, res) => {
    leaked++;
    res.end('{}');
  });
  await listenForFetch(other);
  const address = other.address();
  assert.ok(address && typeof address !== 'string');
  const source = createServer((_req, res) => {
    res.writeHead(302, { location: `http://localhost:${address.port}/stolen` });
    res.end();
  });
  await listenForFetch(source);
  t.after(() => {
    source.closeAllConnections();
    other.closeAllConnections();
    source.close();
    other.close();
  });
  const local = source.address();
  assert.ok(local && typeof local !== 'string');
  const target = targetFor('deepseek', '-redirect');
  await refreshApiModelList(target, key, (_input, init) => fetch(`http://127.0.0.1:${local.port}/models`, init));
  assert.equal(leaked, 0);
  const catalog = piModels({ models: apiCatalog(target) });
  assert.deepEqual(mergeApiModels(target, catalog), catalog);
});

test('controller returns the catalog immediately and publishes background models without exposing the key', async (t) => {
  const target = targetFor('deepseek', '-background');
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = join(testDirectory(), 'synthetic-keys');
  t.after(() => {
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
  });
  await saveApiKey(target.id, key);
  const snapshot = await createPiAdapter({ key: () => undefined }).discover(target);
  const catalog = [...snapshot.models];
  let finish!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', (input: unknown) => {
    assert.equal(String(input), 'https://api.deepseek.com/models');
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, { targets: [target], snapshots: [snapshot], targetGeneration: 0, closed: false });
  let published!: () => void;
  const changed = new Promise<void>((resolve) => {
    published = resolve;
  });
  t.mock.method(controller, 'broadcast', () => published());
  assert.equal(controller.refreshApiModels(target.id), undefined);
  assert.deepEqual(snapshot.models, catalog, 'the picker does not await metadata');
  finish(new Response(JSON.stringify({ data: [{ id: unknowns.deepseek }] })));
  await changed;
  assert.equal(snapshot.models.at(-1)?.discovered, true);
  assert.ok(!JSON.stringify(snapshot).includes(key));
  assert.equal(snapshot.note, undefined);
});

for (const { id, knownFlash } of [
  ...['deepseek', 'openai', 'anthropic', 'google'].map((id) => ({ id, knownFlash: false })),
  { id: 'deepseek', knownFlash: true },
  { id: 'meta-model-api', knownFlash: false },
])
  test(
    knownFlash
      ? 'DeepSeek Flash 1017 uses the canonical API ID and selected low effort through real Pi'
      : id === 'meta-model-api'
        ? 'Meta Model API: real Pi streams text and usage, surfaces errors and refuses exhausted budgets'
        : `${id}: manual unknown model goes through Pi to loopback with the exact ID and no invented cost`,
    { timeout: 60_000 },
    async (t) => {
      const target = targetFor(id, '-chat');
      const preset = apiPreset(id)!;
      const meta = id === 'meta-model-api';
      const modelId = meta ? 'muse-spark-1.3' : knownFlash ? 'deepseek-flash' : unknowns[id];
      await refreshApiModelList(
        target,
        key,
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: modelId }],
              models: [{ name: `models/${modelId}`, supportedGenerationMethods: ['generateContent'] }],
            }),
          ),
      );
      const bodies: any[] = [];
      let failureStatus = 0;
      const server = createServer(async (req, res) => {
        assert.equal(
          req.url,
          id === 'anthropic'
            ? '/v1/messages?beta=true'
            : id === 'openai'
              ? '/responses'
              : id === 'google'
                ? `/models/${modelId}:streamGenerateContent?alt=sse`
                : '/chat/completions',
        );
        assert.equal(
          req.headers[id === 'anthropic' ? 'x-api-key' : id === 'google' ? 'x-goog-api-key' : 'authorization'],
          id === 'anthropic' || id === 'google' ? key : `Bearer ${key}`,
        );
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        bodies.push(request);
        if (failureStatus) {
          res.writeHead(failureStatus, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: failureStatus === 401 ? 'Invalid API key' : 'Rate limit exceeded' } }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (event: Record<string, unknown>) =>
          res.write(
            `${typeof event.type === 'string' ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
          );
        if (id === 'anthropic') {
          send({
            type: 'message_start',
            message: {
              id: 'synthetic',
              type: 'message',
              role: 'assistant',
              model: modelId,
              content: [],
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          });
          send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic answer.' } });
          send({ type: 'content_block_stop', index: 0 });
          send({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 2 },
          });
          send({ type: 'message_stop' });
          res.end();
          return;
        }
        if (id === 'openai') {
          send({
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'msg', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
          });
          send({
            type: 'response.content_part.added',
            output_index: 0,
            content_index: 0,
            item_id: 'msg',
            part: { type: 'output_text', text: '', annotations: [] },
          });
          send({
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            item_id: 'msg',
            delta: 'Synthetic answer.',
          });
          send({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Synthetic answer.', annotations: [] }],
            },
          });
          send({
            type: 'response.completed',
            response: {
              id: 'synthetic',
              status: 'completed',
              model: modelId,
              output: [
                {
                  type: 'message',
                  id: 'msg',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Synthetic answer.', annotations: [] }],
                },
              ],
              usage: {
                input_tokens: 3,
                output_tokens: 2,
                total_tokens: 5,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          });
          res.end();
          return;
        }
        if (id === 'google') {
          send({
            candidates: [
              { content: { role: 'model', parts: [{ text: 'Synthetic answer.' }] }, finishReason: 'STOP', index: 0 },
            ],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
            modelVersion: modelId,
          });
          res.end();
          return;
        }
        for (const [delta, finish] of [
          [{ role: 'assistant', content: 'Synthetic answer.' }, null],
          [{}, 'stop'],
        ]) {
          res.write(
            `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
          );
        }
        res.end('data: [DONE]\n\n');
      });
      await listenForFetch(server);
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      mkdirSync(target.agentDir!, { recursive: true });
      const adapter = createPiAdapter({
        key: () => key,
        environment: (value) => {
          const env = apiEnvironment(value, preset, key, {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
          });
          const file = join(value.agentDir!, 'models.json');
          const config = JSON.parse(readFileSync(file, 'utf8'));
          const provider = config.providers[preset.runtimeProvider];
          if (knownFlash || meta) provider.baseUrl = `http://127.0.0.1:${address.port}`;
          else provider.models[0].baseUrl = `http://127.0.0.1:${address.port}`;
          writeFileSync(file, JSON.stringify(config), 'utf8');
          if (meta)
            writeFileSync(
              join(value.agentDir!, 'settings.json'),
              JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
            );
          return env;
        },
        spawn: async (value, args, options) =>
          spawn(process.execPath, [...value.args!, ...args, '--no-context-files'], {
            cwd: target.agentDir,
            env: options?.env,
            windowsHide: true,
            stdio: 'pipe',
          }),
        terminate: async (child) => {
          if (child.exitCode !== null) return;
          const closed = once(child, 'close');
          child.kill();
          await closed;
        },
      });
      const snapshot = await adapter.discover(target);
      snapshot.accounting = { mode: 'usage', source: 'synthetic API' };
      assert.equal(snapshot.status, 'ready');
      const model = snapshot.models.find((model) => model.id === `${preset.runtimeProvider}/${modelId}`)!;
      assert.equal(model.id, `${preset.runtimeProvider}/${modelId}`);
      if (knownFlash) assert.deepEqual(model.efforts, ['off', 'low', 'high', 'max']);
      assert.equal(bodies.length, 0);
      const settings = {
        refreshSeconds: 60,
        reservePercent: 10,
        maxQuotaAgeSeconds: 180,
        preferCli: true,
        designProvider: 'claude',
        architectureProvider: 'codex',
        routineProvider: 'codex',
        unknownQuotaPolicy: 'manual-only',
        defaultProjectPath: target.agentDir!,
        maxConcurrentRuns: 2,
      } as const;
      const input = {
        prompt: 'Synthetic hello.',
        projectPath: target.agentDir!,
        kind: 'general' as const,
        permissionMode: 'read-only' as const,
        runtimeId: target.id,
        model: model.id,
        ...(knownFlash ? { effort: 'low' } : {}),
        untrustedContent: true,
      };
      const selected = route(input, [snapshot], settings);
      assert.equal(selected.model, model.id);
      if (!knownFlash && !meta)
        assert.notEqual(route({ ...input, model: undefined }, [snapshot], settings).model, model.id);
      if (meta) assert.equal(route({ ...input, model: undefined }, [snapshot], settings).model, model.id);
      const events: RunEvent[] = [];
      await adapter.execute({
        target,
        dataDir: target.agentDir!,
        input,
        route: selected,
        signal: AbortSignal.timeout(30_000),
        emit: (event) => events.push(event),
        approve: async () => false,
      });
      assert.equal(bodies.length, 1);
      if (id !== 'google') assert.equal(bodies[0].model, modelId);
      assert.equal(bodies[0].reasoning_effort, knownFlash ? 'low' : undefined);
      if (knownFlash) assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
      assert.ok(events.some((event) => event.type === 'text' && event.text?.includes('Synthetic answer.')));
      if (!knownFlash && !meta) assert.ok(!events.some((event) => event.data?.costUsd !== undefined));
      if (meta) {
        const usage = events.find((event) => event.type === 'usage')!.data!;
        assert.equal(usage.input, 3);
        assert.equal(usage.output, 2);
        assert.equal(usage.totalTokens, 5);
        assert.ok(Math.abs(Number(usage.costUsd) - 0.00001225) < 1e-12);
        const policy = apiBudgetPolicy({ limitUsd: 1, perRunUsd: 1 });
        assert.throws(
          () => route(input, [{ ...snapshot, apiBudgetState: apiBudgetView(policy, 1, 0) }], settings),
          /预算/,
        );
        assert.equal(bodies.length, 1);
        const context: ExecuteContext = {
          target,
          dataDir: target.agentDir!,
          input,
          route: selected,
          signal: AbortSignal.timeout(30_000),
          emit: (event) => events.push(event),
          approve: async () => false,
        };
        await assert.rejects(
          adapter.execute({
            ...context,
            route: { ...selected, model: 'pugport-meta/muse-unknown' },
            apiBudget: { maxCostUsd: 1 },
          }),
          /api-budget-usage-unknown/,
        );
        await assert.rejects(
          adapter.execute({ ...context, apiBudget: { maxCostUsd: 1, expiresAt: '2000-01-01T00:00:00Z' } }),
          /api-budget-expired/,
        );
        assert.equal(bodies.length, 1);
        for (const [status, code] of [
          [401, 'api-key-auth-or-configuration'],
          [429, 'quota-or-rate-limit'],
        ] as const) {
          failureStatus = status;
          const before: number = bodies.length;
          await assert.rejects(adapter.execute({ ...context, signal: AbortSignal.timeout(15_000) }), (error: Error) => {
            assert.match(error.message, new RegExp(code));
            const detail = (error as Error & { detail?: string }).detail ?? '';
            assert.match(detail, /Invalid API key|Rate limit exceeded/);
            assert.ok(!detail.includes(key));
            assert.ok(!error.message.includes(key));
            return true;
          });
          assert.equal(bodies.length, before + 1);
        }
      }
      assert.ok(!JSON.stringify(events).includes(key));
      assert.ok(!JSON.stringify(snapshot).includes(key));
    },
  );

test('picker exposes a new badge, unknown price and tooltip without strength choices', async () => {
  const harness = uiHarness(await uiBundle('src/ui/Workspace.tsx'));
  const target = targetFor('deepseek', '-ui');
  const model: ModelInfo = {
    id: 'deepseek/deepseek-release-test',
    label: 'deepseek-release-test',
    efforts: [],
    discovered: true,
  };
  const tree = harness.render('WorkspaceExecutionFields', {
    state: { targets: [target], runtimes: [{ id: target.id, models: [model] }] },
    policy: 'api-only',
    selection: target.id,
    model: model.id,
    onSelection() {},
    onModel() {},
  });
  const option = findNode(tree, (node) => node.type === 'option' && node.props.value === model.id)!;
  assert.equal(option.props['data-discovered'], true);
  assert.match(option.props.title, /价格未知/);
  assert.match(text(tree), /deepseek-release-test/);
  harness.unmount();
});

test('Meta discovery authenticates, allowlists standard text, caches failures and isolates replacement keys', async (t) => {
  const target = targetFor('meta-model-api', '-discovery');
  let requests = 0;
  let status = 200;
  let activeKey = key;
  let ids = [
    ...metaModelIds,
    'muse-spark-1.3-contributor',
    'muse-spark-1.2-contributor',
    'muse-image-1.0',
    'muse-voice-1.0',
    'muse-spark-9.9',
    'unrelated-text',
  ];
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer ' + activeKey);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  await listenForFetch(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const localFetch: typeof fetch = (input, init) => {
    assert.equal(String(input), 'https://api.meta.ai/v1/models');
    assert.equal(init?.redirect, 'error');
    return fetch('http://127.0.0.1:' + address.port + '/v1/models', init);
  };
  const now = Date.now();
  await Promise.all([
    refreshApiModelList(target, key, localFetch, now),
    refreshApiModelList(target, key, localFetch, now),
  ]);
  assert.equal(requests, 1);
  assert.deepEqual(readApiModelList(target)?.ids, metaModelIds);
  await refreshApiModelList(target, key, localFetch, now + 1);
  assert.equal(requests, 1);
  for (const [code, error] of [
    [401, 'authentication-required'],
    [429, 'quota-or-rate-limit'],
    [500, 'runtime-request-failed'],
  ] as const) {
    status = code;
    assert.equal((await probeFreeSource(target, key, localFetch)).error, error);
  }
  const beforeFailure = requests;
  await refreshApiModelList(target, key, localFetch, now + 86_400_000);
  assert.equal(requests, beforeFailure + 1);
  assert.deepEqual(readApiModelList(target)?.ids, metaModelIds);
  await refreshApiModelList(target, key, localFetch, now + 86_400_001);
  assert.equal(requests, beforeFailure + 1);
  let finish!: (response: Response) => void;
  const pending = refreshApiModelList(
    target,
    key,
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    now + 172_800_000,
  );
  clearApiModelList(target);
  status = 200;
  activeKey = 'SYNTHETIC_REPLACEMENT_META_KEY';
  ids = ['muse-spark-1.3'];
  await refreshApiModelList(target, activeKey, localFetch, now + 172_800_001);
  finish(new Response(JSON.stringify({ data: [{ id: 'muse-wonder-1.0' }] })));
  await pending;
  assert.deepEqual(readApiModelList(target)?.ids, ['muse-spark-1.3']);
  const other = targetFor('meta-model-api', '-other-key');
  assert.equal(readApiModelList(other), undefined);
  await refreshApiModelList(other, activeKey, localFetch, now);
  clearApiModelList(target);
  assert.deepEqual(readApiModelList(other)?.ids, ['muse-spark-1.3']);
  const file = join(target.agentDir!, 'model-list.json');
  writeFileSync(
    file,
    JSON.stringify({
      preset: 'meta-model-api',
      checkedAt: now,
      ids: ['muse-spark-1.3-contributor', 'muse-unknown'],
      retired: [],
    }),
  );
  syncApiModelsConfig(target, apiPreset('meta-model-api')!);
  const generated = JSON.parse(readFileSync(join(target.agentDir!, 'models.json'), 'utf8'));
  assert.deepEqual(
    generated.providers['pugport-meta'].models.map((model: { id: string }) => model.id),
    metaModelIds,
  );
  const merged = mergeApiModels(target, piModels({ models: apiCatalog(target) }));
  assert.equal(merged.length, 4);
  assert.ok(merged.every((model) => model.price && model.price.input > 0 && !model.discovered));
});

test('a same-day list cached before media models were kept refreshes once to pick up image models', async () => {
  const target = targetFor('openai', '-media-upgrade');
  mkdirSync(target.agentDir!, { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(target.agentDir!, 'model-list.json'),
    JSON.stringify({ preset: 'openai', checkedAt: now - 1000, ids: ['gpt-5.5'], retired: [] }),
  );
  let calls = 0;
  const list = async () => {
    calls++;
    return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-image-2' }] }));
  };
  await refreshApiModelList(target, key, list, now);
  assert.equal(calls, 1);
  assert.deepEqual(readApiModelList(target)?.images, ['gpt-image-2']);
  await refreshApiModelList(target, key, list, now + 1000);
  assert.equal(calls, 1, 'the refreshed list is fresh for the rest of the day');
});
