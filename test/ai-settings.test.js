const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_AI_CONFIG, AI_ROLES, validateAIConfig, modelEligibility, modelForRole } = require('../src/ai/settings');

const textModel = { id: 'example/text', inputModalities: ['text'], outputModalities: ['text'], supportedParameters: ['tools'], contextLength: 32000, maxCompletionTokens: 4000 };
const visionModel = { ...textModel, id: 'example/vision', inputModalities: ['text', 'image'] };

test('AI stays disabled until trusted config selects a model and explicitly enables it', () => {
  const config = validateAIConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.model, '');
  assert.deepEqual(config.roles, AI_ROLES);
  assert.equal(config.provider.data_collection, 'deny');
  assert.throws(() => validateAIConfig({ enabled: true }), /Select an OpenRouter model/);
  assert.equal(validateAIConfig({ enabled: true, model: 'example/text' }).enabled, true);
});

test('each role inherits the selected model and role overrides are validated against current catalog', () => {
  const config = validateAIConfig({ enabled: true, model: textModel.id, roleModels: { 'ui-ux': visionModel.id }, allowImages: true }, { models: [textModel, visionModel] });
  assert.equal(modelForRole(config, 'planner'), textModel.id);
  assert.equal(modelForRole(config, 'ui-ux'), visionModel.id);
  assert.throws(() => validateAIConfig({ enabled: true, model: textModel.id, allowImages: true }, { models: [textModel] }), /Image input/);
  assert.throws(() => validateAIConfig({ enabled: true, model: textModel.id }, { models: [] }), /absent/);
  assert.throws(() => validateAIConfig({ roleModels: { unknown: textModel.id } }), /invalid role/);
});

test('model eligibility distinguishes code-based UI review from image-based review', () => {
  assert.equal(modelEligibility(textModel).eligible, true);
  assert.equal(modelEligibility(textModel, { images: true }).eligible, false);
  assert.equal(modelEligibility(visionModel, { images: true }).eligible, true);
  assert.equal(modelEligibility({ ...textModel, supportedParameters: [] }).eligible, false);
  assert.equal(modelEligibility({ ...textModel, outputModalities: ['image'] }).eligible, false);
  assert.equal(modelEligibility({ ...textModel, id: 'openrouter/auto' }).eligible, false);
});

test('budgets, loop limits, and role selection reject bypasses and malformed input', () => {
  for (const value of [null, false, [], 'enabled']) assert.throws(() => validateAIConfig(value), /object/);
  for (const value of [
    { enabled: 'true' }, { maxToolRounds: 9 }, { maxToolRounds: -1 }, { maxCallsPerRun: 101 },
    { maxOutputTokens: 1000000 }, { maxCostUsd: Infinity }, { maxCostUsd: -1 }, { maxInputChars: 500001 },
    { roles: [] }, { roles: ['planner', 'planner'] }, { roles: ['execute-arbitrary-code'] },
    { model: 'https://attacker.example' }, { apiKey: 'do-not-save' }, { provider: { require_parameters: false } },
  ]) assert.throws(() => validateAIConfig(value));
  assert.equal(validateAIConfig({ maxCostUsd: 0 }).maxCostUsd, 0);
  assert.equal(validateAIConfig({ maxToolRounds: 0 }).maxToolRounds, 0);
});

test('path filters are relative, bounded, and cannot traverse out of a repository', () => {
  assert.deepEqual(validateAIConfig({ includePaths: ['src/**', '*.md'], excludePaths: ['**/*.key'] }).excludePaths, ['**/*.key']);
  for (const pattern of ['../outside', 'src/../../outside', '/etc/passwd', 'C:/secrets', 'src\\..\\secret', 'secret\0.txt']) assert.throws(() => validateAIConfig({ includePaths: [pattern] }), /path pattern/);
  assert.throws(() => validateAIConfig({ includePaths: [] }));
});

test('normalized settings do not mutate frozen defaults or caller-owned arrays', () => {
  const input = { roleModels: { security: 'example/special' }, roles: ['security'], provider: { only: ['Provider A'] } };
  const result = validateAIConfig(input);
  result.roleModels.security = 'example/changed';
  result.roles.push('planner');
  result.provider.only.push('Provider B');
  result.includePaths.push('other');
  assert.equal(input.roleModels.security, 'example/special');
  assert.deepEqual(input.roles, ['security']);
  assert.deepEqual(input.provider.only, ['Provider A']);
  assert.deepEqual(DEFAULT_AI_CONFIG.includePaths, ['**']);
});

test('configured output token limits must fit selected model context and completion bounds', () => {
  assert.throws(() => validateAIConfig({ model: textModel.id, maxOutputTokens: 5000 }, { models: [textModel] }), /exceeds the model limit/);
  assert.throws(() => validateAIConfig({ model: textModel.id }, { models: [{ ...textModel, contextLength: 2000 }] }), /insufficient context/);
});
