import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.mjs';

export const providerIds = ['chatgpt', 'claude'];
// Suggestions, not an account entitlement list. Exact IDs remain selectable.
const suggestions = {
  chatgpt: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol'],
  claude: ['sonnet', 'opus', 'haiku', 'fable'],
};

export function validateModelName(model) {
  if (typeof model !== 'string' || model.length > 100 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\[1m\])?$/.test(model)) {
    throw new ApiError(400, 'invalid_model', 'Enter a model ID using letters, numbers, dots, hyphens, or underscores (optionally ending in [1m]).');
  }
  return model;
}

export function defaultModels(config) {
  return config.modelSettings?.defaults() || { chatgpt: config.chatgptModel, claude: config.claudeModel };
}

export function resolveModel(id, config) {
  if (providerIds.includes(id)) return { provider: id, model: defaultModels(config)[id] };
  const match = typeof id === 'string' && /^(chatgpt|claude)\/(.+)$/.exec(id);
  if (!match) throw new ApiError(400, 'unknown_model', 'Use chatgpt or claude for a saved default, or provider/model-id for a specific model.');
  return { provider: match[1], model: validateModelName(match[2]) };
}

export function modelCatalog(config) {
  const defaults = defaultModels(config);
  return providerIds.flatMap(provider => {
    const common = { object: 'model', created: 0, owned_by: provider === 'chatgpt' ? 'openai' : 'anthropic', provider };
    return [
      { ...common, id: provider, label: `Saved default (${defaults[provider]})` },
      ...[...new Set([defaults[provider], ...suggestions[provider]])].map(model => ({ ...common, id: `${provider}/${model}`, label: model })),
    ];
  });
}

export async function createModelSettings(dataDir, initial) {
  const file = path.join(dataDir, 'models.json');
  let defaults = { ...initial };
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (!saved || Array.isArray(saved) || Object.keys(saved).length !== 2 || !providerIds.every(id => Object.hasOwn(saved, id))) throw new Error('Invalid saved model settings.');
    defaults = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const value of Object.values(defaults)) validateModelName(value);
  let pending = Promise.resolve();
  return {
    defaults: () => ({ ...defaults }),
    save(provider, model) {
      if (!providerIds.includes(provider)) throw new ApiError(400, 'unknown_provider', 'Choose chatgpt or claude.');
      validateModelName(model);
      const operation = pending.then(async () => {
        const updated = { ...defaults, [provider]: model };
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          await rename(temporary, file);
          defaults = updated;
          return { ...defaults };
        } finally { await rm(temporary, { force: true }); }
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}
