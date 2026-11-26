import { parseCursorModel } from '../shared/model-family.ts';
import type { ModelInfo, Provider, Settings } from '../shared/types.ts';

export type ModelTier = 'light' | 'standard' | 'strong';
export const terraPolicy = 'strong-first' as 'standard' | 'strong' | 'strong-first';
export const strongCostFamilies = ['codex', 'claude', 'cursor'] as const;
type Goal = NonNullable<Settings['routeGoal']>;
/** longWrite: a writable step expected to run long or required to change files. */
export type ModelDemand = { tier: ModelTier; effort: string; goal: Goal; longWrite?: boolean };
type Profile = { tier: ModelTier; family?: string; version: number[]; implicit: boolean };

const levels = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const tierLabels: Record<ModelTier, string> = { light: '轻量', standard: '常规', strong: '高能力' };

/** Local scheduling policy, not benchmark scores or an estimate of token prices. */
export function modelDemand(goal: Goal, complex: boolean, preferLight: boolean): ModelDemand {
  return {
    goal,
    tier: goal === 'quality' || (complex && goal !== 'save') ? 'strong' : preferLight ? 'light' : 'standard',
    effort:
      goal === 'quality'
        ? complex
          ? 'xhigh'
          : 'high'
        : goal === 'save'
          ? complex
            ? 'medium'
            : 'low'
          : complex
            ? 'high'
            : preferLight
              ? 'low'
              : 'medium',
  };
}

/** Use only models actually supplied by discovery. Unknown families stay conservative, not "best". */
function profile(model: ModelInfo, provider: Provider): Profile {
  // Cursor's -fast is a serving-speed option of the same model, not a smaller model.
  const id = (provider === 'cursor' ? parseCursorModel(model.id).family : model.id.toLowerCase())
    .split('/')
    .at(-1)!
    .replace(/\[[^\]]*\]/g, '');
  const label = model.label.toLowerCase().replace(/\[[^\]]*\]/g, '');
  const identify = (text: string) => {
    const word = (pattern: string) => new RegExp(`(?:^|[^a-z0-9])(${pattern})(?=$|[^a-z0-9])`, 'i').exec(text)?.[1];
    // Gemini 4 names its models after elements; only the ones Google lists as flagship reasoning count as strong (#53).
    const strong = word('astra|opus|fable|heavy') || (/gemini/i.test(id) ? word('pro|argon|carbon|neon') : undefined);
    const light =
      word('luna|haiku|mini|nano|flash|lite|small') || (provider !== 'cursor' && /grok/i.test(id) && word('fast'));
    const standard = word('sol|terra|sonnet|composer') || (/grok/i.test(text) ? 'grok' : undefined);
    return { family: strong || light || standard, strong, light };
  };
  const fromId = identify(id);
  // IDs win over descriptive labels. opusplan is a mixed workflow, not a fixed Opus model.
  const { family, strong, light } = id === 'opusplan' ? {} : fromId.family ? fromId : identify(label);

  // Compare generations only within a recognized family. Do not compare Opus's 5 with Astra's 6.
  const version = (
    (id.match(/\d+(?:[.-]\d+)*/) ?? label.match(/\d+(?:[.-]\d+)*/))?.[0].split(/[.-]/).map(Number) ?? []
  ).filter((n) => n < 1000);
  const modernTerra = family === 'terra' && ((version[0] ?? 0) > 6 || (version[0] === 6 && (version[1] ?? 0) >= 1));
  const tier: ModelTier = model.lightweight
    ? 'light'
    : strong || (modernTerra && terraPolicy !== 'standard')
      ? 'strong'
      : light
        ? 'light'
        : 'standard';
  if (provider === 'pi') {
    const parts: number[] = [];
    const generation = id.match(/\d+(?:[.-]\d+)*/);
    if (generation) {
      let offset = generation.index!;
      for (const part of generation[0].split(/[.-]/)) {
        const following = id[offset + part.length];
        if (/[a-z]/i.test(following ?? '') || part.length >= 4) break;
        parts.push(Number(part));
        offset += part.length + 1;
      }
    }
    return {
      tier,
      family: id.split(/\d/)[0].replace(/[-_.:]v?$/, '') || id,
      version: parts,
      implicit: /^(auto|default|best|opusplan)$/i.test(id),
    };
  }
  return { tier, family, version, implicit: /^(auto|default|best|opusplan)$/i.test(id) };
}

export const modelTier = (model: ModelInfo, provider: Provider): ModelTier => profile(model, provider).tier;
export const isEffortLevel = (value: string): boolean => levels.includes(value);

function effortDistance(actual: string | undefined, desired: string): number {
  if (!actual || !levels.includes(actual)) return levels.length;
  return Math.abs(levels.indexOf(actual) - levels.indexOf(desired));
}

/** Never invent an effort, and never use off merely because the requested automatic level is absent. */
export function automaticEffort(model: ModelInfo, desired: string): string | undefined {
  const active = model.efforts.filter((effort) => effort !== 'off' && effort !== 'none');
  const recognized = active.filter((effort) => levels.includes(effort));
  if (recognized.length)
    return [...recognized].sort(
      (a, b) => effortDistance(a, desired) - effortDistance(b, desired) || levels.indexOf(a) - levels.indexOf(b),
    )[0];
  return (
    (model.defaultEffort && active.includes(model.defaultEffort) ? model.defaultEffort : active[0]) || model.efforts[0]
  );
}

/** Capability/quota/explicit-selection filters are owned by the router and run before this ranking. */
export function selectAutomaticModel(
  models: ModelInfo[],
  provider: Provider,
  demand: ModelDemand,
): ModelInfo | undefined {
  models = models.filter((model) => !model.discovered);
  const order: Record<ModelTier, ModelTier[]> = {
    light: ['light', 'standard', 'strong'],
    standard: ['standard', 'strong', 'light'],
    strong: ['strong', 'standard', 'light'],
  };
  const nonLight = models.filter((model) => modelTier(model, provider) !== 'light');
  const eligible = demand.tier !== 'light' && nonLight.length ? nonLight : models;
  const families = new Map<string, number>();
  const defaults = new Set(
    models.filter((model) => model.catalogDefault).map((model) => profile(model, provider).family),
  );
  const ranked = eligible.map((model, index) => {
    const info = profile(model, provider);
    const group = ['sol', 'terra'].includes(info.family ?? '')
      ? 'codex-standard'
      : ['opus', 'fable'].includes(info.family ?? '')
        ? 'claude-strong'
        : (info.family ?? `unknown-${index}`);
    if (!families.has(group)) families.set(group, index);
    return { model, index, profile: info, groupIndex: families.get(group)! };
  });
  ranked.sort((a, b) => {
    const implicit = Number(a.profile.implicit) - Number(b.profile.implicit);
    if (implicit) return implicit;
    // Fable may use separate usage credits: keep automatic preference in quality-first mode.
    if (demand.goal !== 'quality') {
      const fable = Number(a.profile.family === 'fable') - Number(b.profile.family === 'fable');
      if (fable) return fable;
    }
    const tier = order[demand.tier].indexOf(a.profile.tier) - order[demand.tier].indexOf(b.profile.tier);
    if (tier) return tier;
    if (provider === 'codex' && demand.tier === 'strong' && terraPolicy !== 'standard') {
      // Terra is fast but often stops halfway through a long implementation: long writes go to Astra.
      const terraFirst = terraPolicy === 'strong-first' && !demand.longWrite;
      const rank = (info: Profile) =>
        info.family === 'astra'
          ? terraFirst
            ? 1
            : 0
          : info.family === 'terra' && info.tier === 'strong'
            ? terraFirst
              ? 0
              : 1
            : 2;
      const preferred = rank(a.profile) - rank(b.profile);
      if (preferred) return preferred;
    }
    if (provider === 'pi') {
      const preferred = Number(defaults.has(b.profile.family)) - Number(defaults.has(a.profile.family));
      if (preferred) return preferred;
    }
    // Group order makes this a total ordering: an unknown model between two Sol versions cannot
    // prevent the newer Sol from winning, while unrelated families keep the CLI's relative priority.
    if (a.groupIndex !== b.groupIndex) return a.groupIndex - b.groupIndex;
    if (a.profile.family !== b.profile.family) {
      const familyOrder = ['fable', 'opus', 'sol', 'terra'];
      return familyOrder.indexOf(a.profile.family ?? '') - familyOrder.indexOf(b.profile.family ?? '');
    }
    if (a.profile.family && a.profile.family === b.profile.family) {
      for (let i = 0; i < Math.max(a.profile.version.length, b.profile.version.length); i++) {
        const newer = (b.profile.version[i] ?? 0) - (a.profile.version[i] ?? 0);
        if (newer) return newer;
      }
      if (provider === 'cursor') {
        const av = parseCursorModel(a.model.id);
        const bv = parseCursorModel(b.model.id);
        const variant =
          effortDistance(av.effort, demand.effort) - effortDistance(bv.effort, demand.effort) ||
          Number(av.fast) - Number(bv.fast);
        if (variant) return variant;
      }
    }
    if (provider === 'pi') return a.model.id.length - b.model.id.length || a.index - b.index;
    // Preserve the CLI's order between otherwise equivalent or unclassified families.
    return a.index - b.index;
  });
  return ranked[0]?.model;
}

export function modelSelectionReasons(
  model: ModelInfo,
  provider: Provider,
  demand: ModelDemand,
  pinned: boolean,
  effort?: string,
  pinnedEffort = false,
  /** A calling executor suggested this effort for its sub-task: a target, not the user's pin. */
  callerEffort = false,
  /** The account's catalog, so the Astra/Terra line names a real alternative. */
  catalog: ModelInfo[] = [],
): string[] {
  const selected = profile(model, provider);
  const offers = (family: string) =>
    catalog.some((item) => {
      const info = profile(item, provider);
      return info.family === family && info.tier === 'strong';
    });
  const codexStrong = !pinned && provider === 'codex' && demand.tier === 'strong' && selected.tier === 'strong';
  return [
    pinned
      ? `用户指定模型：${model.id}`
      : `自动模型选择：目标${tierLabels[demand.tier]}档，选择 ${model.id}（${tierLabels[selected.tier]}档）`,
    ...(!pinned && selected.tier !== demand.tier
      ? ['目标档位在当前策略与可用目录中不可用，已从通过能力与额度筛选的模型中回退选择']
      : []),
    ...(!pinned && !selected.family ? ['未识别的模型家族按常规档保守处理，不推断其性能或费用'] : []),
    ...(codexStrong && demand.longWrite && selected.family === 'astra' && offers('terra')
      ? [`要改文件的实现步骤用 ${model.id}：terra 快，但长实现常做到一半就停，留给短任务、只读、评审和规划`]
      : codexStrong && demand.longWrite && selected.family === 'terra'
        ? [`要改文件的实现步骤本应用 astra，但它现在不可用，改用 ${model.id}`]
        : codexStrong && !demand.longWrite && selected.family === 'terra' && offers('astra')
          ? [`短任务、只读、评审或规划用更快的 ${model.id}；要改文件的实现步骤用 astra`]
          : []),
    ...(!pinned && provider === 'pi'
      ? [`模型组：${selected.family || model.id}；版本：${selected.version.join('.') || '未标注'}`]
      : []),
    ...(effort
      ? [
          pinnedEffort
            ? `用户指定思考强度：${effort}`
            : callerEffort
              ? effort !== demand.effort
                ? `调用方建议思考强度：${effort}（目标 ${demand.effort}，使用模型支持的最近级别）`
                : `调用方建议思考强度：${effort}`
              : effort !== demand.effort
                ? `自动思考强度：${effort}（目标 ${demand.effort}，使用模型支持的最近级别）`
                : `自动思考强度：${effort}`,
        ]
      : []),
    ...(!effort && provider === 'cursor' && parseCursorModel(model.id).effort
      ? [`思考强度由所选 Cursor 模型变体提供：${parseCursorModel(model.id).effort}`]
      : []),
  ];
}
