import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Exercise each engine's real MediaRecorder with generated video and audio.
// No physical camera or microphone is opened by these tests.
async function syntheticDevices(page) {
  const nativeFakeDevices = page.context().browser().browserType().name() === 'firefox';
  await page.addInitScript((nativeFakeDevices) => {
    window.testCameraRequests = 0;
    window.testCameraStreams = [];
    if (nativeFakeDevices) {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        window.testCameraRequests++;
        const stream = await original(constraints);
        window.testCameraStreams.push(stream);
        return stream;
      };
      return;
    }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          window.testCameraRequests++;
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          const context = canvas.getContext('2d');
          let frame = 0;
          const draw = () => {
            context.fillStyle = frame++ % 2 ? '#7aa2f7' : '#1a1b26';
            context.fillRect(0, 0, 320, 180);
          };
          draw();
          const interval = setInterval(draw, 60);
          const video = canvas.captureStream(15);
          const audio = new AudioContext();
          const oscillator = audio.createOscillator();
          const destination = audio.createMediaStreamDestination();
          oscillator.connect(destination);
          oscillator.start();
          await audio.resume();
          const stream = new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]);
          for (const track of stream.getTracks()) {
            const original = track.stop.bind(track);
            track.stop = () => {
              original();
              if (stream.getTracks().every((item) => item.readyState === 'ended')) {
                clearInterval(interval);
                oscillator.stop();
                audio.close();
              }
            };
          }
          window.testCameraStreams.push(stream);
          return stream;
        },
      },
    });
  }, nativeFakeDevices);
}

async function open(page) {
  await page.goto('/');
  await expect(page.locator('#script .word').first()).toBeVisible();
}

async function requireRecording(page) {
  const available = await page.evaluate(() => typeof window.MediaRecorder === 'function');
  const linuxWebKit = process.platform === 'linux' && page.context().browser().browserType().name() === 'webkit';
  test.skip(!available && linuxWebKit, 'This Linux WebKit build has MediaRecorder compiled out; native encoding needs a Safari/macOS or iOS check.');
  expect(available, 'Native MediaRecorder must be present for encoding tests').toBe(true);
}

async function enable(page) {
  await requireRecording(page);
  await page.getByRole('button', { name: 'Enable camera', exact: true }).click();
  await expect(page.locator('#recording-status')).toHaveText('Camera ready');
  await expect.poll(() => page.locator('#camera-preview').evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(2);
}

async function start(page) {
  await enable(page);
  await page.getByRole('button', { name: 'Record take', exact: true }).click();
  await expect(page.locator('#recording-status')).toHaveText('Recording');
  await expect(page.locator('#recording-timer')).not.toHaveText('00:00');
}

async function stop(page) {
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(page.locator('#recording-status')).toHaveText('Your take is ready');
  await expect(page.locator('#download-take')).toBeVisible();
}

test('reports recording capabilities and matches the available controls', async ({ page, browserName }, testInfo) => {
  await open(page);
  const capabilities = await page.evaluate(() => ({
    secure: window.isSecureContext,
    mediaRecorder: typeof window.MediaRecorder,
    getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
    formats: ['video/webm', 'video/mp4'].filter((type) => window.MediaRecorder?.isTypeSupported(type)),
  }));
  console.info(browserName, capabilities);
  await testInfo.attach('recording-capabilities.json', { body: JSON.stringify(capabilities, null, 2), contentType: 'application/json' });
  const supported = capabilities.mediaRecorder === 'function' && capabilities.getUserMedia === 'function';
  if (supported) await expect(page.locator('#record-camera')).toBeEnabled();
  else await expect(page.locator('#record-camera')).toBeDisabled();
});

test('only requests devices when enabled and turns both off on demand', async ({ page }) => {
  await syntheticDevices(page);
  await open(page);
  expect(await page.evaluate(() => window.testCameraRequests)).toBe(0);
  await enable(page);
  expect(await page.evaluate(() => window.testCameraStreams[0].getTracks().map((track) => track.kind).sort())).toEqual(['audio', 'video']);
  await page.getByRole('button', { name: 'Turn camera off' }).click();
  await expect(page.locator('#camera-frame')).toBeHidden();
  expect(await page.evaluate(() => window.testCameraStreams[0].getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
});

test('records independently of scrolling and downloads a decodable take', async ({ page }, testInfo) => {
  await syntheticDevices(page);
  await open(page);
  await start(page);
  await page.getByRole('button', { name: 'Start reading' }).click();
  await expect(page.getByRole('button', { name: 'Pause reading' })).toBeVisible();
  await expect.poll(async () => Number(await page.locator('#progress').inputValue())).toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#status')).toContainText('PAUSED');
  await expect(page.locator('#recording-status')).toHaveText('Recording');
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: 'Resume reading' }).click();
  await page.getByRole('button', { name: 'Pause reading' }).click();
  await expect(page.locator('#recording-status')).toHaveText('Recording');
  await page.screenshot({ path: testInfo.outputPath('recording.png'), fullPage: true });
  await stop(page);
  expect(await page.evaluate(() => window.testCameraStreams[0].getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
  await page.getByRole('button', { name: 'Review take' }).click();
  await expect(page.getByRole('dialog', { name: 'Review your take' })).toBeVisible();
  await expect.poll(() => page.locator('#take-preview').evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(2);
  expect(await page.locator('#take-preview').evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
  await page.locator('#take-preview').evaluate((video) => video.play());
  await expect.poll(() => page.locator('#take-preview').evaluate((video) => video.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Close take review' }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#download-take').click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^The-opening-take-.*\.(webm|mp4)$/);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  expect((await readFile(file)).byteLength).toBeGreaterThan(1000);
});

test('permission denial is actionable and keeps script playback available', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
  });
  await open(page);
  await requireRecording(page);
  await page.getByRole('button', { name: 'Enable camera', exact: true }).click();
  await expect(page.locator('#recording-help')).toContainText('access was denied');
  await expect(page.getByRole('button', { name: 'Enable camera', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Start reading' }).click();
  await expect(page.locator('#status')).toHaveText('READING IN PROGRESS');
});

test('cancelling a pending permission request closes devices that arrive late', async ({ page }) => {
  await syntheticDevices(page);
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = (constraints) => new Promise((resolve) => { window.resolveCamera = async () => resolve(await getUserMedia(constraints)); });
  });
  await open(page);
  await requireRecording(page);
  await page.getByRole('button', { name: 'Enable camera', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel camera request' }).click();
  await page.evaluate(() => window.resolveCamera());
  await expect.poll(() => page.evaluate(() => window.testCameraStreams[0]?.getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#camera-frame')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Enable camera', exact: true })).toBeEnabled();
});

test('unsupported recording explains the fallback without requesting devices', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined }); });
  await open(page);
  await expect(page.getByRole('button', { name: 'Enable camera', exact: true })).toBeDisabled();
  await expect(page.locator('#recording-help')).toContainText('recording is unavailable');
});

test('device interruption finalizes the available footage', async ({ page }) => {
  await syntheticDevices(page);
  await open(page);
  await start(page);
  await page.evaluate(() => {
    const track = document.getElementById('camera-preview').srcObject.getVideoTracks()[0];
    track.stop();
  });
  await expect(page.locator('#recording-status')).toHaveText('Your take is ready');
  await expect(page.locator('#toast')).toContainText('disconnected');
  await expect(page.locator('#download-take')).toBeVisible();
});

test('a new take replaces the old URL only after it finishes', async ({ page }) => {
  await syntheticDevices(page);
  await open(page);
  await start(page);
  await stop(page);
  const firstUrl = await page.locator('#download-take').getAttribute('href');
  await page.evaluate(() => {
    window.revokedUrls = [];
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { window.revokedUrls.push(url); original(url); };
  });
  await start(page);
  expect(await page.evaluate(() => window.revokedUrls)).not.toContain(firstUrl);
  await stop(page);
  expect(await page.locator('#download-take').getAttribute('href')).not.toBe(firstUrl);
  expect(await page.evaluate(() => window.revokedUrls)).toContain(firstUrl);
});

test('recording controls remain usable in fullscreen', async ({ page }) => {
  await syntheticDevices(page);
  await open(page);
  test.skip(!await page.evaluate(() => document.fullscreenEnabled === true), 'Element fullscreen is unavailable on this device profile.');
  await start(page);
  await page.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('prompter');
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeInViewport();
  await stop(page);
  await page.getByRole('button', { name: 'Leave fullscreen' }).click();
});

test('capture panel fits narrow screens and warns before losing an unsaved take', async ({ page }) => {
  await syntheticDevices(page);
  await open(page);
  await page.setViewportSize({ width: 360, height: 900 });
  await start(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await stop(page);
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
});

test('records with native synthetic camera and microphone devices', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit uses a real encoder with generated video/audio streams.');
  await open(page);
  await start(page);
  expect(await page.locator('#camera-preview').evaluate((video) => video.srcObject.getTracks().map((track) => track.kind).sort())).toEqual(['audio', 'video']);
  await stop(page);
});
