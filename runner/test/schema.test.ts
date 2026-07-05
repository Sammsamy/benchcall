import { describe, expect, it } from 'vitest';
import { forGoogle, strictify } from '../src/llm/schema.js';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    items: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } } },
    },
  },
};

describe('strictify', () => {
  it('adds additionalProperties:false and full required lists to all objects', () => {
    const strict = strictify(schema) as {
      additionalProperties?: boolean;
      required?: string[];
      properties: { items: { items: { additionalProperties?: boolean; required?: string[] } } };
    };
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(['name', 'items']);
    expect(strict.properties.items.items.additionalProperties).toBe(false);
    expect(strict.properties.items.items.required).toEqual(['id']);
  });

  it('does not mutate the input', () => {
    strictify(schema);
    expect((schema as { additionalProperties?: boolean }).additionalProperties).toBeUndefined();
  });
});

describe('forGoogle', () => {
  it('strips additionalProperties everywhere', () => {
    const cleaned = forGoogle(strictify(schema)) as {
      additionalProperties?: boolean;
      properties: { items: { items: { additionalProperties?: boolean } } };
    };
    expect(cleaned.additionalProperties).toBeUndefined();
    expect(cleaned.properties.items.items.additionalProperties).toBeUndefined();
  });
});
