/**
 * @file tests/unit/lora_tag_parser_test.js
 * @description Unit tests for LoRA Dynamic Tag Parsing & Trigger Word Injection.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

export function parseLoraTags(promptText) {
  if (!promptText || typeof promptText !== 'string') return { cleanedPrompt: '', loras: [] };

  const loraRegex = /<lora:([^:>]+):([-\d.]+)(?::([-\d.]+))?>/g;
  const loras = [];
  let match;

  while ((match = loraRegex.exec(promptText)) !== null) {
    const name = match[1].trim();
    const strength = parseFloat(match[2]);
    const clipStrength = match[3] !== undefined ? parseFloat(match[3]) : undefined;

    loras.push({
      name,
      strength,
      ...(clipStrength !== undefined ? { model_strength: strength, clip_strength: clipStrength } : {})
    });
  }

  const cleanedPrompt = promptText
    .replace(/<lora:[^>]+>/g, '')
    .replace(/\s*,\s*(,\s*)+/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(^,\s*|,\s*$)/g, '')
    .trim();

  return { cleanedPrompt, loras };
}

export function formatLoraTags(selectedLoras, loraWeights) {
  if (!Array.isArray(selectedLoras) || selectedLoras.length === 0) return '';
  return selectedLoras.map(name => {
    const wt = (loraWeights && loraWeights[name] !== undefined) ? Number(loraWeights[name]) : 1.0;
    return `<lora:${name}:${wt}>`;
  }).join(' ');
}

export function insertTriggerWord(currentPrompt, triggerWord) {
  if (!triggerWord || typeof triggerWord !== 'string') return currentPrompt || '';
  const trimmedWord = triggerWord.trim();
  if (!trimmedWord) return currentPrompt || '';

  if (!currentPrompt || !currentPrompt.trim()) {
    return trimmedWord;
  }

  const regex = new RegExp(`(^|[,\\s])${trimmedWord.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}([,\\s]|$)`, 'i');
  if (regex.test(currentPrompt)) {
    return currentPrompt;
  }

  return `${trimmedWord}, ${currentPrompt.trim()}`;
}

export function insertMultipleTriggerWords(currentPrompt, triggerWords) {
  let prompt = currentPrompt || '';
  if (!Array.isArray(triggerWords)) return prompt;
  for (const word of triggerWords) {
    prompt = insertTriggerWord(prompt, word);
  }
  return prompt;
}

test('Extracts single standard <lora:name:weight> tag', () => {
  const raw = 'masterpiece, high fantasy sorceress <lora:darkbrush_sdxl:0.8>';
  const parsed = parseLoraTags(raw);

  assert.strictEqual(parsed.cleanedPrompt, 'masterpiece, high fantasy sorceress');
  assert.strictEqual(parsed.loras.length, 1);
  assert.strictEqual(parsed.loras[0].name, 'darkbrush_sdxl');
  assert.strictEqual(parsed.loras[0].strength, 0.8);
});

test('Extracts dual-weight <lora:name:model:clip> tag', () => {
  const raw = '1girl, cyberpunk neon alley <lora:CYBERPUNK_KREA_2:0.9:0.75>';
  const parsed = parseLoraTags(raw);

  assert.strictEqual(parsed.cleanedPrompt, '1girl, cyberpunk neon alley');
  assert.strictEqual(parsed.loras.length, 1);
  assert.strictEqual(parsed.loras[0].name, 'CYBERPUNK_KREA_2');
  assert.strictEqual(parsed.loras[0].strength, 0.9);
  assert.strictEqual(parsed.loras[0].model_strength, 0.9);
  assert.strictEqual(parsed.loras[0].clip_strength, 0.75);
});

test('Extracts multiple LoRA tags interleaved with prompt commas', () => {
  const raw = 'masterpiece, <lora:style_ghibli:0.7>, lush forest meadow, <lora:concept_floating_islands:1.2>, blue sky';
  const parsed = parseLoraTags(raw);

  assert.strictEqual(parsed.cleanedPrompt, 'masterpiece, lush forest meadow, blue sky');
  assert.strictEqual(parsed.loras.length, 2);
  assert.strictEqual(parsed.loras[0].name, 'style_ghibli');
  assert.strictEqual(parsed.loras[0].strength, 0.7);
  assert.strictEqual(parsed.loras[1].name, 'concept_floating_islands');
  assert.strictEqual(parsed.loras[1].strength, 1.2);
});

test('Handles boundary weights (negative weights, float precision, zero weight)', () => {
  const raw = 'test <lora:neg_detail:-0.5> <lora:zero_wt:0.0> <lora:high_prec:0.875>';
  const parsed = parseLoraTags(raw);

  assert.strictEqual(parsed.cleanedPrompt, 'test');
  assert.strictEqual(parsed.loras.length, 3);
  assert.strictEqual(parsed.loras[0].strength, -0.5);
  assert.strictEqual(parsed.loras[1].strength, 0.0);
  assert.strictEqual(parsed.loras[2].strength, 0.875);
});

test('Formats LoRA tags from selection array and weight dictionary', () => {
  const selected = ['CYBERPUNK_KREA_2', 'darkbrush_sdxl'];
  const weights = {
    CYBERPUNK_KREA_2: 0.9,
    darkbrush_sdxl: 0.75
  };

  const formatted = formatLoraTags(selected, weights);
  assert.strictEqual(formatted, '<lora:CYBERPUNK_KREA_2:0.9> <lora:darkbrush_sdxl:0.75>');
});

test('Falls back to default weight 1.0 when weight is missing', () => {
  const selected = ['unweighted_lora'];
  const weights = {};

  const formatted = formatLoraTags(selected, weights);
  assert.strictEqual(formatted, '<lora:unweighted_lora:1>');
});

test('Trigger word injection & deduplication', () => {
  assert.strictEqual(insertTriggerWord('', 'darkbrush'), 'darkbrush');
  assert.strictEqual(insertTriggerWord('ancient gothic cathedral', 'darkbrush'), 'darkbrush, ancient gothic cathedral');
  assert.strictEqual(insertTriggerWord('darkbrush, ancient cathedral', 'darkbrush'), 'darkbrush, ancient cathedral');

  const triggers = ['darkbrush', 'gothic fantasy', 'darkbrush'];
  const res = insertMultipleTriggerWords('cathedral in shadows', triggers);
  assert.strictEqual(res, 'gothic fantasy, darkbrush, cathedral in shadows');
});
