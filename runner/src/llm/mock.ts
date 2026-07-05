import { JSONParseError } from './json.js';
import type {
  CompleteJSONOptions,
  CompleteOptions,
  CompleteResult,
  JSONResult,
  LLMProvider,
} from './types.js';

interface QueuedText {
  kind: 'text';
  text: string;
}
interface QueuedJSON {
  kind: 'json';
  data: unknown;
}
interface QueuedError {
  kind: 'error';
  error: Error;
}
type Queued = QueuedText | QueuedJSON | QueuedError;

/**
 * Deterministic provider for unit tests — no network, no keys.
 * Queue responses in the order the code under test will request them.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock' as const;
  private queue: Queued[] = [];
  /** Every request this provider served, for assertions. */
  readonly calls: Array<{ kind: 'complete' | 'completeJSON'; opts: CompleteOptions }> = [];

  queueText(text: string): this {
    this.queue.push({ kind: 'text', text });
    return this;
  }

  queueJSON(data: unknown): this {
    this.queue.push({ kind: 'json', data });
    return this;
  }

  queueError(error: Error): this {
    this.queue.push({ kind: 'error', error });
    return this;
  }

  private next(): Queued {
    const item = this.queue.shift();
    if (!item) throw new Error('MockProvider queue is empty — test queued too few responses');
    if (item.kind === 'error') throw item.error;
    return item;
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    this.calls.push({ kind: 'complete', opts });
    const item = this.next();
    const text = item.kind === 'text' ? item.text : JSON.stringify((item as QueuedJSON).data);
    return { text, usage: { inputTokens: 10, outputTokens: 10 }, costUsd: 0, priced: true, model: 'mock' };
  }

  async completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<JSONResult<T>> {
    this.calls.push({ kind: 'completeJSON', opts });
    const item = this.next();
    const data = item.kind === 'json' ? item.data : JSON.parse((item as QueuedText).text);
    const raw = JSON.stringify(data);
    // Mirror real providers: validation failures carry the raw output so the
    // repair loop behaves identically in tests.
    let validated: T;
    try {
      validated = opts.validate(data);
    } catch (err) {
      throw new JSONParseError(err instanceof Error ? err.message : String(err), raw);
    }
    return {
      data: validated,
      usage: { inputTokens: 10, outputTokens: 10 },
      costUsd: 0,
      priced: true,
      model: 'mock',
      raw,
    };
  }
}
