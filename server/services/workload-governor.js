const { AsyncLocalStorage } = require('async_hooks');

const INTERACTIVE_IDLE_MS = 20 * 1000;
const MAX_GITHUB_OPS = 6;
const MAX_BACKGROUND_OPS = 2;

const interactiveActivity = new Map();
const requestContext = new AsyncLocalStorage();

let githubOpsInFlight = 0;
let backgroundOpsInFlight = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noteInteractiveActivity(userId) {
  if (userId) interactiveActivity.set(userId, Date.now());
}

function isInteractivelyActive(userId) {
  if (!userId) return false;
  const last = interactiveActivity.get(userId);
  return !!last && (Date.now() - last < INTERACTIVE_IDLE_MS);
}

function getContext() {
  return requestContext.getStore() || { tier: 'interactive', userId: null };
}

function runWithContext(ctx, fn) {
  return requestContext.run(ctx, fn);
}

function runBackground(userId, fn) {
  return requestContext.run({ tier: 'background', userId }, fn);
}

async function acquireGitHubOp() {
  const ctx = getContext();
  const isBackground = ctx.tier === 'background';

  while (true) {
    if (githubOpsInFlight < MAX_GITHUB_OPS
      && (!isBackground || backgroundOpsInFlight < MAX_BACKGROUND_OPS)) {
      githubOpsInFlight += 1;
      if (isBackground) backgroundOpsInFlight += 1;
      return {
        release() {
          githubOpsInFlight = Math.max(0, githubOpsInFlight - 1);
          if (isBackground) backgroundOpsInFlight = Math.max(0, backgroundOpsInFlight - 1);
        },
      };
    }
    await sleep(30);
  }
}

function shouldDeferBackground(userId) {
  return isInteractivelyActive(userId);
}

function stats() {
  return {
    github_ops_in_flight: githubOpsInFlight,
    background_ops_in_flight: backgroundOpsInFlight,
    interactive_users: [...interactiveActivity.entries()]
      .filter(([, t]) => Date.now() - t < INTERACTIVE_IDLE_MS)
      .length,
  };
}

module.exports = {
  noteInteractiveActivity,
  isInteractivelyActive,
  shouldDeferBackground,
  getContext,
  runWithContext,
  runBackground,
  acquireGitHubOp,
  stats,
};
