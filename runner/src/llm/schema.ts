/**
 * Helpers to adapt one hand-written JSON Schema to each provider's
 * structured-output dialect.
 */

type JSONSchema = Record<string, unknown>;

function walk(schema: JSONSchema, visit: (node: JSONSchema) => void): void {
  visit(schema);
  const props = schema.properties as Record<string, JSONSchema> | undefined;
  if (props) Object.values(props).forEach((p) => walk(p, visit));
  if (schema.items && typeof schema.items === 'object') walk(schema.items as JSONSchema, visit);
  for (const key of ['anyOf', 'allOf', 'oneOf'] as const) {
    const arr = schema[key] as JSONSchema[] | undefined;
    if (Array.isArray(arr)) arr.forEach((s) => walk(s, visit));
  }
}

function clone(schema: JSONSchema): JSONSchema {
  return JSON.parse(JSON.stringify(schema)) as JSONSchema;
}

/**
 * Anthropic structured outputs and OpenAI strict mode both require
 * `additionalProperties: false` on every object; OpenAI additionally requires
 * every property listed in `required`. Our schemas avoid optional fields, so
 * making all properties required is lossless.
 */
export function strictify(schema: JSONSchema): JSONSchema {
  const out = clone(schema);
  walk(out, (node) => {
    if (node.type === 'object' && node.properties) {
      node.additionalProperties = false;
      node.required = Object.keys(node.properties as Record<string, unknown>);
    }
  });
  return out;
}

/** Gemini's responseSchema dialect rejects additionalProperties — strip it. */
export function forGoogle(schema: JSONSchema): JSONSchema {
  const out = clone(schema);
  walk(out, (node) => {
    delete node.additionalProperties;
    delete node.$schema;
  });
  return out;
}
