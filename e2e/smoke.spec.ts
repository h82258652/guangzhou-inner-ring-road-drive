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
  // driver performance chatter from software rendering is not an application error; shader errors are
  expect(errors.filter((e) => !/GPU stall|GL Driver Message|software WebGL/i.test(e))).toEqual([]);
});

interface RaceHandle {
  state: string;
  race: { state: string; clock: number; rivals: { car: { dyn: { vx: number } } }[] } | null;
}

test('starts a race against AI drivers with the rules switched off', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __game?: RaceHandle }).__game?.state === 'menu', null, { timeout: 150_000 });
  await page.locator('.seg[data-name="mode"] button[data-v="race"]').click();
  await page.locator('.seg[data-name="raceRivals"] button[data-v="3"]').click();
  await expect(page.locator('.menu .note')).toContainText('无视一切交通法规');
  // races start on the main line only
  expect(await page.locator('select[data-name="start"] option[value^="ramp:"]').count()).toBe(0);
  await page.locator('[data-act="start"]').click();
  await page.waitForFunction(() => (window as unknown as { __game: RaceHandle }).__game.race?.state === 'countdown');
  await expect(page.locator('.countdown')).toBeVisible();
  await expect(page.locator('.limit')).toBeHidden();
  await page.waitForFunction(() => (window as unknown as { __game: RaceHandle }).__game.race?.state === 'racing', null, { timeout: 30_000 });
  // the rivals get going
  await page.waitForFunction(() => (window as unknown as { __game: RaceHandle }).__game.race!.rivals.every((r) => r.car.dyn.vx > 8), null, { timeout: 60_000 });
  await expect(page.locator('.racepanel .pos')).toContainText('/4');
  expect(await page.locator('.stats .standing').count()).toBe(4);
  // one line per car in the standings
  const rowHeight = await page.locator('.stats .standing').first().evaluate((el) => el.getBoundingClientRect().height);
  expect(rowHeight).toBeLessThan(32);
  expect(errors.filter((e) => !/GPU stall|GL Driver Message|software WebGL/i.test(e))).toEqual([]);
});
