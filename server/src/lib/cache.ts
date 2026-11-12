interface Entry<V> {
  value: Promise<V>;
  expires: number;
}

/** Cache TTL đơn giản trong RAM; lưu Promise để gộp các request trùng nhau đang chạy. */
export class TtlCache {
  private readonly store = new Map<string, Entry<unknown>>();

  constructor(private readonly ttlMs: number) {}

  getOrLoad<V>(key: string, loader: () => Promise<V>, ttlMs = this.ttlMs): Promise<V> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<V>;
    const value = loader();
    this.store.set(key, { value, expires: now + ttlMs });
    // Không cache lỗi
    value.catch(() => {
      if (this.store.get(key)?.value === value) this.store.delete(key);
    });
    return value;
  }

  /** Xoá mọi key bắt đầu bằng prefix */
  invalidate(prefix = ''): number {
    let n = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        n++;
      }
    }
    return n;
  }
}
