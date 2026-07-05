/** Accumulates estimated spend on the customer's own keys across a run. */
export class CostTracker {
  private total = 0;
  private entries = 0;
  private unpriced = 0;

  add(usd: number, priced = true): void {
    this.total += usd;
    this.entries += 1;
    if (!priced) this.unpriced += 1;
  }

  get totalUsd(): number {
    return this.total;
  }

  get callCount(): number {
    return this.entries;
  }

  /** Calls whose model had no pricing entry — real spend is above totalUsd. */
  get unpricedCount(): number {
    return this.unpriced;
  }
}
