const ADAPTIVE_CONCURRENCY = {
  MAX: 32,
  MIN: 1,
  EVAL_INTERVAL_MS: 2000,
  DROP_RATIO: 0.82,
  STABLE_RATIO: 0.94,
  STABLE_WINDOWS_TO_RAMP: 2,
};

function shrinkLimit(limit, min) {
  if (limit <= min) return min;
  if (limit > 16) return Math.max(min, limit - 6);
  if (limit > 8) return Math.max(min, limit - 3);
  if (limit > 4) return Math.max(min, limit - 2);
  return Math.max(min, limit - 1);
}

function createAdaptivePool(itemCount, options = {}) {
  const maxCap = options.max ?? ADAPTIVE_CONCURRENCY.MAX;
  const min = options.min ?? ADAPTIVE_CONCURRENCY.MIN;
  const getMax = options.getMax ?? null;
  const initial = options.initial ?? maxCap;

  let maxLimit = maxCap;
  let limit = Math.min(
    initial,
    maxCap,
    Math.max(min, itemCount || maxCap)
  );
  let inFlight = 0;
  const waitQueue = [];

  let bytesDone = 0;
  let lastSampleAt = Date.now();
  let lastSampleBytes = 0;
  let lastThroughput = null;
  let stableWindows = 0;
  let evalTimer = null;

  const refreshMax = () => {
    if (getMax) maxLimit = Math.max(min, Math.min(maxCap, getMax()));
    if (limit > maxLimit) limit = maxLimit;
  };

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
    refreshMax();

    const now = Date.now();
    const elapsed = (now - lastSampleAt) / 1000;
    if (elapsed < ADAPTIVE_CONCURRENCY.EVAL_INTERVAL_MS / 1000) return;

    const delta = bytesDone - lastSampleBytes;
    const throughput = delta / elapsed;

    if (lastThroughput != null && lastThroughput > 0) {
      if (delta === 0 && inFlight > 0) {
        limit = shrinkLimit(limit, min);
        stableWindows = 0;
      } else if (throughput > 0) {
        const ratio = throughput / lastThroughput;
        if (ratio < ADAPTIVE_CONCURRENCY.DROP_RATIO) {
          limit = shrinkLimit(limit, min);
          stableWindows = 0;
        } else if (ratio >= ADAPTIVE_CONCURRENCY.STABLE_RATIO) {
          stableWindows += 1;
          if (stableWindows >= ADAPTIVE_CONCURRENCY.STABLE_WINDOWS_TO_RAMP && limit < maxLimit) {
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
      refreshMax();
      if (!evalTimer) evalTimer = setInterval(evaluate, ADAPTIVE_CONCURRENCY.EVAL_INTERVAL_MS);
    },
    stop() {
      if (evalTimer) clearInterval(evalTimer);
      evalTimer = null;
    },
  };
}

async function mapAdaptive(items, pool, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  pool.start();
  try {
    let index = 0;
    const workerCount = Math.min(pool.maxWorkers, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const i = index++;
        await pool.acquire();
        try {
          results[i] = await fn(items[i], i);
        } finally {
          pool.release();
        }
      }
    });
    await Promise.all(workers);
    return results;
  } finally {
    pool.stop();
  }
}

module.exports = {
  ADAPTIVE_CONCURRENCY,
  createAdaptivePool,
  mapAdaptive,
};
