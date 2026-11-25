import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelTier } from '../src/server/model-selection.ts';
const model = (id: string) => ({ id, label: id, efforts: [] });

test('Gemini API model profiles retain their tiers', () => {
  for (const [id, tier] of [
    ['gemini-2.5-pro', 'strong'],
    ['gemini-3-pro-preview', 'strong'],
    ['gemini-2.5-flash', 'light'],
    ['gemini-3.1-flash-lite', 'light'],
    ['gemini-4-argon', 'strong'],
    ['google/gemini-4-argon', 'strong'],
    // An element name PugPort has not been told about stays conservative.
    ['gemini-4-neon', 'standard'],
    ['auto', 'standard'],
  ])
    assert.equal(modelTier(model(id!), 'pi'), tier);
});
