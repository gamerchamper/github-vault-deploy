const setup = require('../services/setup');

const pending = new Map();

async function ensureSetup(req, res, next) {
  if (!req.user?.id) return next();

  const userId = req.user.id;
  if (pending.has(userId)) {
    try {
      await Promise.race([
        pending.get(userId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('setup timeout')), 15000)),
      ]);
    } catch { /* setup may retry */ }
    return next();
  }

  const promise = setup.ensureUserSetup(userId);
  pending.set(userId, promise);
  try {
    await promise;
  } catch (err) {
    console.error(`Setup failed for user ${userId}:`, err.message);
  } finally {
    pending.delete(userId);
  }
  next();
}

module.exports = { ensureSetup };
