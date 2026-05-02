export class AsyncMutex {
  private _lock: Promise<void> = Promise.resolve();
  private _isLocked = false;

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const willLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    const prev = this._lock;
    this._lock = this._lock.then(() => willLock);
    await prev;

    this._isLocked = true;
    try {
      return await fn();
    } finally {
      this._isLocked = false;
      release!();
    }
  }

  get isLocked(): boolean {
    return this._isLocked;
  }
}
