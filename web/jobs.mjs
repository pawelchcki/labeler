const KEY = 'labeler.pending-print.v1';

/** Persist before the first raster write; never resume a partially transmitted job. */
export class PrintGuard {
  constructor(storage) { this.storage = storage; }
  get pending() {
    try { return Boolean(this.storage.getItem(KEY)); }
    catch { return false; }
  }
  start() { this.storage.setItem(KEY, String(Date.now())); }
  clear() { this.storage.removeItem(KEY); }
}
