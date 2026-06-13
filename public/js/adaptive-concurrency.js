const AdaptiveConcurrency = {
  MAX: 32,
  MIN: 1,
  EVAL_INTERVAL_MS: 2000,
  DROP_RATIO: 0.82,
  STABLE_RATIO: 0.94,
  STABLE_WINDOWS_TO_RAMP: 2,

  shrinkLimit(limit) {
    if (limit <= this.MIN) return this.MIN;
    if (limit > 24) return Math.max(this.MIN, limit - 8);
    if (limit > 12) return Math.max(this.MIN, limit - 4);
    if (limit > 6) return Math.max(this.MIN, limit - 2);
    return Math.max(this.MIN, limit - 1);
  },

  createPool(itemCount, options = {}) {
    const maxCap = options.max ?? this.MAX;
    const initial = options.initial ?? maxCap;
    let maxLimit = maxCap;
    let limit = Math.min(initial, maxCap, Math.max(this.MIN, itemCount));
    let inFlight = 0;
    const waitQueue = [];

    let bytesDone = 0;
    let lastSampleAt = Date.now();
    let lastSampleBytes = 0;
    let lastThroughput = null;
    let stableWindows = 0;
    let evalTimer = null;

    const wakeWaiters = () => {
      while (inFlight < limit && waitQueue.length) {
        inFlight++;
        waitQueue.shift()();
      }
    };

    const acquire = () => new Promise((resolve) => {
      if (inFlight < limit) {
        inFlight++;
        resolve();
      } else {
        waitQueue.push(resolve);
      }
    });

    const release = () => {
      inFlight--;
      wakeWaiters();
    };

    const recordBytes = (n) => {
      bytesDone += n;
    };

    const evaluate = () => {
      const now = Date.now();
      const elapsed = (now - lastSampleAt) / 1000;
      if (elapsed < this.EVAL_INTERVAL_MS / 1000) return;

      const delta = bytesDone - lastSampleBytes;
      const throughput = delta / elapsed;

      if (lastThroughput != null && lastThroughput > 0) {
        if (delta === 0 && inFlight > 0) {
          limit = this.shrinkLimit(limit);
          stableWindows = 0;
        } else if (throughput > 0) {
          const ratio = throughput / lastThroughput;
          if (ratio < this.DROP_RATIO) {
            limit = this.shrinkLimit(limit);
            stableWindows = 0;
          } else if (ratio >= this.STABLE_RATIO) {
            stableWindows += 1;
            if (stableWindows >= this.STABLE_WINDOWS_TO_RAMP && limit < maxLimit) {
              limit += 1;
              stableWindows = 0;
            }
          } else {
            stableWindows = 0;
          }
          lastThroughput = throughput;
        }
      } else if (throughput > 0) {
        lastThroughput = throughput;
      }

      lastSampleAt = now;
      lastSampleBytes = bytesDone;
      wakeWaiters();
    };

    return {
      get limit() { return limit; },
      get maxWorkers() { return maxCap; },
      acquire,
      release,
      recordBytes,
      start() {
        if (!evalTimer) evalTimer = setInterval(evaluate, AdaptiveConcurrency.EVAL_INTERVAL_MS);
      },
      stop() {
        if (evalTimer) clearInterval(evalTimer);
        evalTimer = null;
      },
    };
  },

  async map(items, pool, fn) {
    if (!items.length) return;
    pool.start();
    try {
      let index = 0;
      const workers = Array.from({ length: Math.min(pool.maxWorkers, items.length) }, async () => {
        while (index < items.length) {
          const i = index++;
          await pool.acquire();
          try {
            await fn(items[i], i);
          } finally {
            pool.release();
          }
        }
      });
      await Promise.all(workers);
    } finally {
      pool.stop();
    }
  },
};
