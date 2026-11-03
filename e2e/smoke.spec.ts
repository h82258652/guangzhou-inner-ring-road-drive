import { expect, test } from '@playwright/test';

interface GameHandle {
  state: string;
  player: { speedKmh: number; tracker: { edge: { kind: string; line: string | null } } } | null;
  traffic: { cars: unknown[] };
}

test('loads the city, starts a drive on line A and accelerates', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __game?: GameHandle }).__game?.state === 'menu', null, { timeout: 150_000 });
  await expect(page.locator('.menu h1')).toContainText('广州内环路');
  await page.locator('.seg[data-name="line"] button[data-v="A"]').click();
  await page.locator('select[data-name="start"]').selectOption('main:40');
  await page.locator('[data-act="start"]').click();
  await page.waitForFunction(() => (window as unknown as { __game?: GameHandle }).__game?.state === 'driving');
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => ((window as unknown as { __game?: GameHandle }).__game?.player?.speedKmh ?? 0) > 42, null, { timeout: 90_000 });
  await page.keyboard.up('KeyW');
  const info = await page.evaluate(() => {
    const g = (window as unknown as { __game: GameHandle }).__game;
    return { kind: g.player!.tracker.edge.kind, line: g.player!.tracker.edge.line, cars: g.traffic.cars.length };
  });
  expect(info.kind).toBe('main');
  expect(info.line).toBe('A');
  expect(info.cars).toBeGreaterThan(50);
  await expect(page.locator('.linebadge')).toContainText('内环路 A线');
  expect(errors.filter((e) => !/GPU stall|WebGL|GL_/i.test(e))).toEqual([]);
});
