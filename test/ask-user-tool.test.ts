import { describe, expect, it } from 'bun:test';
import askUserTool, { normalizeAskUserArgs, normalizeAskUserQuestions } from '../builtin/kits/workspace/tools/ask_user';

describe('native ask_user input compatibility', () => {
  it('publishes an object root accepted by OpenAI-compatible tool registration', () => {
    const parameters = JSON.parse(JSON.stringify(askUserTool.input_schema));
    expect(parameters.type).toBe('object');
    for (const keyword of ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not']) {
      expect(parameters).not.toHaveProperty(keyword);
    }
    expect(parameters.properties.questions.items.required).toEqual(['question', 'options']);
  });

  it('validates both envelopes locally without a root union', async () => {
    expect(await askUserTool.validateInput?.({ question: 'Which?', options: ['A', 'B'] })).toBeUndefined();
    for (const args of [{}, { question: 'Which?' }, { options: ['A'] }, { questions: [] }]) {
      expect(await askUserTool.validateInput?.(args)).toBeString();
    }
  });

  it('accepts the provider-compatible one-question envelope', async () => {
    const raw = {
      questions: [{
        question: 'Which direction?',
        header: 'Direction',
        options: ['Side-scrolling action', { label: 'Top-down shooter' }],
        multiSelect: false,
      }],
    };
    expect(normalizeAskUserArgs(raw)).toEqual({
      ...raw,
      question: 'Which direction?',
      header: 'Direction',
      options: raw.questions[0].options,
      multiSelect: false,
    });
    expect(await askUserTool.validateInput?.(raw)).toBeUndefined();
  });

  it('accepts and preserves up to three questions for one shared confirmation', async () => {
    const raw = {
      questions: [
        { id: 'direction', question: 'First?', options: ['A', 'B'] },
        { question: 'Second?', options: ['C', 'D'], multiSelect: true },
      ],
    };
    expect(await askUserTool.validateInput?.(raw)).toBeUndefined();
    expect(normalizeAskUserQuestions(raw)).toEqual([
      { id: 'direction', question: 'First?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
      { id: 'question-2', question: 'Second?', options: [{ label: 'C' }, { label: 'D' }], multiSelect: true },
    ]);
  });

  it('rejects more than three questions', async () => {
    expect(await askUserTool.validateInput?.({
      questions: Array.from({ length: 4 }, (_, index) => ({
        question: `Question ${index + 1}?`,
        options: ['A', 'B'],
      })),
    })).toContain('1–3');
  });

  it('rejects invalid rows before normalization instead of dropping them', async () => {
    expect(await askUserTool.validateInput?.({
      questions: [
        { id: 'valid', question: 'Valid?', options: ['A'] },
        { id: 'missing-question', options: ['B'] },
      ],
    })).toContain('non-empty');
    expect(await askUserTool.validateInput?.({
      questions: [{ question: 'Broken option?', options: [{ description: 'missing label' }] }],
    })).toContain('valid options');
    expect(await askUserTool.validateInput?.({
      questions: [
        { id: 'same', question: 'One?', options: ['A'] },
        { id: 'same', question: 'Two?', options: ['B'] },
      ],
    })).toContain('unique');
  });

  it('accepts one concrete option because the UI supplies Other', async () => {
    expect(await askUserTool.validateInput?.({
      questions: [{ question: 'Any custom notes?', options: [{ label: 'No extra notes' }] }],
    })).toBeUndefined();
  });

  it('still rejects a question with no concrete options', async () => {
    expect(await askUserTool.validateInput?.({
      questions: [{ question: 'Any custom notes?', options: [] }],
    })).toContain('1–5');
  });
});
