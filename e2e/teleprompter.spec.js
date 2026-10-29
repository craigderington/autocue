import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const state = path.resolve('.browser-test-state');
const dark = 'background = "#1a1b26"\nforeground = "#c0caf5"\naccent = "#7aa2f7"\nmode = "dark"\n';

async function editScript(page, script, title = 'A fresh take') {
  await page.getByRole('button', { name: 'Edit script' }).click();
  await page.getByLabel('Script title', { exact: true }).fill(title);
  await page.locator('#script-input').fill(script);
  await page.getByRole('button', { name: 'Use this script' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}

async function upload(page, name, content) {
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(content) });
  await expect(page.getByRole('button', { name: 'Import script' })).toBeEnabled();
}

async function neutralFocus(page) {
  await page.locator('#reading-window').focus();
}

test.beforeEach(async ({ page }) => {
  await writeFile(path.join(state, 'theme/colors.toml'), dark);
  await writeFile(path.join(state, 'theme.name'), 'test-night');
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.goto('/');
  await expect(page.locator('#word-count')).not.toHaveText('0 words');
  await expect(page.locator('#theme-name')).toHaveText('Test Night');
});

test('loads all local assets without runtime errors or external requests', async ({ page }) => {
  const errors = [];
  const external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:3417/')) external.push(request.url());
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'The opening take' })).toBeVisible();
  await expect(page.locator('#script .word').first()).toHaveText('You');
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('scrolls continuously, pauses, resumes, and restarts', async ({ page }) => {
  await page.getByRole('button', { name: 'Start reading' }).click();
  await page.clock.runFor(2000);
  const firstPosition = await page.locator('#reading-window').evaluate((el) => el.scrollTop);
  expect(firstPosition).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause reading' }).click();
  await page.clock.runFor(1000);
  expect(await page.locator('#reading-window').evaluate((el) => el.scrollTop)).toBeCloseTo(firstPosition, 0);
  await page.getByRole('button', { name: 'Resume reading' }).click();
  await page.clock.runFor(1000);
  expect(await page.locator('#reading-window').evaluate((el) => el.scrollTop)).toBeGreaterThan(firstPosition);
  await page.getByRole('button', { name: 'Restart script' }).click();
  await expect(page.locator('#progress')).toHaveValue('0');
  await expect(page.getByRole('button', { name: 'Start reading' })).toBeVisible();
});

test('keyboard controls change speed, mirror, playback, and restart', async ({ page }) => {
  await neutralFocus(page);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#speed')).toHaveValue('145');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#speed')).toHaveValue('140');
  await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: 'Mirror', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(page.locator('#status')).toHaveText('READING IN PROGRESS');
  await page.clock.runFor(500);
  await page.keyboard.press('Escape');
  await expect(page.locator('#status')).toContainText('PAUSED');
  await page.keyboard.press('r');
  await expect(page.locator('#progress')).toHaveValue('0');
});

test('native slider keyboard controls respect speed limits', async ({ page }) => {
  const slider = page.getByRole('slider', { name: 'Scroll speed in words per minute' });
  await slider.focus();
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('300');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('300');
  await page.keyboard.press('Home');
  await expect(slider).toHaveValue('40');
  await expect(page.locator('#speed-value')).toHaveText('40');
});

test('seeking to the end finishes the take and replay starts at the beginning', async ({ page }) => {
  await page.getByRole('slider', { name: 'Script position' }).focus();
  await page.keyboard.press('End');
  await expect(page.locator('#status')).toHaveText('THAT’S A WRAP');
  await page.getByRole('button', { name: 'Read again' }).click();
  await expect(page.locator('#progress')).toHaveValue('0');
  await page.clock.runFor(1000);
  await expect(page.locator('#status')).toHaveText('READING IN PROGRESS');
});

test('text size and viewport changes preserve reading position', async ({ page }) => {
  await page.getByRole('button', { name: 'Start reading' }).click();
  await page.clock.runFor(2000);
  await page.getByRole('button', { name: 'Pause reading' }).click();
  const position = await page.locator('#progress').inputValue();
  const before = await page.locator('#script').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await page.getByRole('button', { name: 'Increase text size' }).click();
  expect(await page.locator('#script').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(before + 4);
  await expect(page.locator('#progress')).toHaveValue(position);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.clock.runFor(100);
  await expect(page.locator('#progress')).toHaveValue(position);
});

test('manual scrolling pauses playback', async ({ page }) => {
  await page.getByRole('button', { name: 'Start reading' }).click();
  await page.clock.runFor(500);
  await page.locator('#reading-window').dispatchEvent('wheel', { deltaY: 120 });
  await expect(page.locator('#status')).toContainText('PAUSED');
  const position = await page.locator('#progress').inputValue();
  await page.clock.runFor(1000);
  await expect(page.locator('#progress')).toHaveValue(position);
});

test('editing renders literal text, resets the take, and leaves typing shortcuts alone', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit script' }).click();
  await page.locator('#script-input').fill('<img src=x onerror=alert(1)> These are my words.');
  await page.locator('#script-input').press('Space');
  await expect(page.locator('#status')).toHaveText('READY WHEN YOU ARE');
  await page.getByLabel('Script title', { exact: true }).fill('My opening');
  await page.getByRole('button', { name: 'Use this script' }).click();
  await expect(page.getByRole('heading', { name: 'My opening' })).toBeVisible();
  await expect(page.locator('#script')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#script img')).toHaveCount(0);
  await expect(page.locator('#sample-label')).toBeHidden();
  await expect(page.locator('#progress')).toHaveValue('0');
});

test('empty scripts are rejected without losing the previous script', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit script' }).click();
  await page.locator('#script-input').fill('   ');
  await page.getByRole('button', { name: 'Use this script' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close editor' }).click();
  await expect(page.getByRole('heading', { name: 'The opening take' })).toBeVisible();
});

test('one-word scripts finish and can restart', async ({ page }) => {
  await editScript(page, 'Hello.');
  await page.getByRole('button', { name: 'Start reading' }).click();
  await page.clock.runFor(1000);
  await expect(page.locator('#status')).toHaveText('THAT’S A WRAP');
  await expect(page.locator('#progress')).toHaveValue('1000');
});

for (const [name, content, expected] of [
  ['opening.txt', 'Hello from a text file.', 'Hello from a text file.'],
  ['opening.md', '# Opening\n\n**Hello** from [Markdown](https://example.com).', 'OpeningHello from Markdown.'],
  ['opening.markdown', '# A heading\n\nMore words.', 'A headingMore words.'],
]) {
  test(`imports ${name} through the real server`, async ({ page }) => {
    await upload(page, name, content);
    await expect(page.locator('#script-title')).toHaveText(name.replace(/\.[^.]+$/, ''));
    await expect(page.locator('#script')).toHaveText(expected);
  });
}

for (const [file, expected] of [['sample.docx', 'Words from a Word document.'], ['sample.pdf', 'Hello from the PDF script.']]) {
  test(`imports ${file} through the real server`, async ({ page }) => {
    await page.locator('#file-input').setInputFiles(path.join(state, file));
    await expect(page.locator('#script')).toHaveText(expected);
    await expect(page.locator('#sample-label')).toBeHidden();
  });
}

test('failed imports explain the error and preserve the current script', async ({ page }) => {
  await upload(page, 'broken.docx', 'not a Word document');
  await expect(page.locator('#toast')).toContainText('Word document could not be read');
  await expect(page.getByRole('heading', { name: 'The opening take' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start reading' })).toBeEnabled();
  await page.locator('#file-input').setInputFiles(path.join(state, 'scan.pdf'));
  await expect(page.locator('#toast')).toContainText('OCR');
});

test('network failures leave import controls usable', async ({ page }) => {
  await page.route('**/api/import?**', (route) => route.abort());
  await upload(page, 'opening.txt', 'A new script.');
  await expect(page.locator('#toast')).toContainText('The local server is unavailable');
  await expect(page.getByRole('button', { name: 'Import script' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start reading' })).toBeEnabled();
});

test('theme-file changes update the palette during playback', async ({ page }) => {
  await page.getByRole('button', { name: 'Start reading' }).click();
  await writeFile(path.join(state, 'theme/colors.toml'), 'background = "#fafafa"\nforeground = "#222222"\naccent = "#0055aa"\nmode = "light"\n');
  await writeFile(path.join(state, 'theme.name'), 'test-day');
  await page.clock.runFor(1600);
  await expect(page.locator('#theme-name')).toHaveText('Test Day');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim())).toBe('#fafafa');
  await expect(page.locator('#status')).toHaveText('READING IN PROGRESS');
});

test('saved preferences survive reload but script contents do not', async ({ page }) => {
  await page.locator('#speed').focus();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Increase text size' }).click();
  const size = await page.locator('#size-value').textContent();
  await page.getByRole('button', { name: 'Mirror', exact: true }).click();
  await editScript(page, 'A private temporary script.');
  await page.reload();
  await expect(page.locator('#speed')).toHaveValue('300');
  await expect(page.locator('#size-value')).toHaveText(size);
  await expect(page.getByRole('button', { name: 'Mirror', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'The opening take' })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('private temporary');
});

test('unavailable fullscreen shows a useful fallback', async ({ page }) => {
  await page.locator('#prompter').evaluate((el) => { el.requestFullscreen = () => Promise.reject(new Error('Unavailable')); });
  await page.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect(page.locator('#toast')).toContainText('Fullscreen is unavailable');
});

test('fullscreen works when the browser supports it', async ({ page }) => {
  const available = await page.evaluate(() => document.fullscreenEnabled === true);
  test.skip(!available, 'This browser/device does not expose element fullscreen.');
  await page.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('prompter');
  await page.getByRole('button', { name: 'Leave fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test('layout stays inside the viewport and dialogs remain usable', async ({ page }) => {
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.runFor(100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Import script' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start reading' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'All shortcuts' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close shortcuts' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('captures the default reading screen for visual review', async ({ page }, testInfo) => {
  await page.screenshot({ path: testInfo.outputPath('reading-view.png'), fullPage: true });
});

test('rapid play and pause never multiply the animation loop', async ({ page }) => {
  await page.locator('#play').click();
  await page.clock.runFor(1000);
  await page.locator('#play').click();
  const firstTake = Number(await page.locator('#progress').inputValue());
  await page.locator('#reset').click();
  for (let click = 0; click < 7; click++) await page.locator('#play').click();
  await page.clock.runFor(1000);
  await page.locator('#play').click();
  expect(Math.abs(Number(await page.locator('#progress').inputValue()) - firstTake)).toBeLessThanOrEqual(1);
});

test('pending wake-lock requests survive rapid pause and resume without leaking', async ({ page }) => {
  await page.evaluate(() => {
    window.testWakeRequests = [];
    window.testWakeReleases = 0;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: () => new Promise((resolve) => window.testWakeRequests.push(resolve)) },
    });
  });
  await page.locator('#play').click();
  await page.locator('#play').click();
  await page.locator('#play').click();
  expect(await page.evaluate(() => window.testWakeRequests.length)).toBe(1);
  await page.evaluate(() => window.testWakeRequests[0]({
    addEventListener() {},
    release: async () => { window.testWakeReleases++; },
  }));
  await page.locator('#play').click();
  await expect.poll(() => page.evaluate(() => window.testWakeReleases)).toBe(1);
});

test('visibility notifications pause a take', async ({ page }) => {
  await page.locator('#play').click();
  await page.clock.runFor(1000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#status')).toContainText('PAUSED');
});

test('theme polling recovers after a lost connection', async ({ page }) => {
  await page.route('**/api/theme', (route) => route.abort());
  await page.clock.runFor(1600);
  await expect(page.locator('#theme-name')).toHaveText('Theme connection lost');
  await page.unroute('**/api/theme');
  await page.clock.runFor(1600);
  await expect(page.locator('#theme-name')).toHaveText('Test Night');
});
