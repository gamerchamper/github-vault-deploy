// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('GitHub Vault explorer', () => {
  test('login screen loads', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('.login-card h1')).toContainText('GitHub Vault');
  });

  test('share page shell loads', async ({ page }) => {
    const res = await page.goto('/share/invalid-token-test');
    expect(res?.status()).toBeLessThan(500);
  });

  test('playlist share page shell loads', async ({ page }) => {
    const res = await page.goto('/share/p/invalid-playlist-token');
    expect(res?.status()).toBeLessThan(500);
    await expect(page.locator('#share-loading, #share-page')).toBeVisible();
  });

  test('collection share page shell loads', async ({ page }) => {
    const res = await page.goto('/share/c/invalid-collection-token');
    expect(res?.status()).toBeLessThan(500);
    await expect(page.locator('#collection-share-app, #share-loading')).toBeVisible();
  });
});
