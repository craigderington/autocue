const VIDEO_FORMATS = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];
const DISCONNECTED = 'A camera or microphone disconnected. Your available footage is ready to download.';

export function recordingOptions(Recorder) {
  const mimeType = VIDEO_FORMATS.find((format) => Recorder.isTypeSupported?.(format));
  return { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 2_500_000 };
}

export function recordingFilename(title, mimeType, date = new Date()) {
  const name = title.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80) || 'take';
  const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
  return `${name}-${date.toISOString().replace(/[:.]/g, '-')}.${extension}`;
}

export function cameraError(error) {
  if (['NotAllowedError', 'SecurityError'].includes(error?.name)) return 'Camera or microphone access was denied. Allow both in your browser’s site settings, then try again.';
  if (['NotFoundError', 'OverconstrainedError'].includes(error?.name)) return 'A camera and microphone are both needed. Connect them, then try again.';
  if (['NotReadableError', 'AbortError'].includes(error?.name)) return 'The camera or microphone could not start. Close other apps using them and try again.';
  return 'Recording could not start. Check your camera and microphone, then try again.';
}

export class CameraRecorder {
  constructor({ mediaDevices = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder,
    onChange = () => {}, onTake = () => {}, onError = () => {},
    maxBytes = 256 * 1024 * 1024, maxDurationMs = 15 * 60 * 1000, monitorIntervalMs = 250 } = {}) {
    Object.assign(this, { mediaDevices, Recorder, onChange, onTake, onError, maxBytes, maxDurationMs, monitorIntervalMs });
    this.state = 'idle';
    this.stream = null;
    this.recorder = null;
    this.generation = 0;
    this.disposed = false;
  }

  get supported() { return Boolean(this.mediaDevices?.getUserMedia && this.Recorder); }
  get active() { return this.state === 'recording' || this.state === 'stopping'; }

  change(state) {
    this.state = state;
    if (!this.disposed) this.onChange(this);
  }

  stopTracks() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  clearTimers() {
    clearTimeout(this.limitTimer);
    clearInterval(this.monitorTimer);
  }

  async enable() {
    if (this.disposed || this.state !== 'idle') return;
    if (!this.supported) return this.onError('Camera recording is unavailable. Use a current browser on localhost or HTTPS.');
    const generation = ++this.generation;
    this.change('opening');
    try {
      const stream = await this.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      });
      if (this.disposed || this.generation !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      if (!stream.getAudioTracks().length || !stream.getVideoTracks().length) throw new DOMException('Missing device', 'NotFoundError');
      stream.getTracks().forEach((track) => track.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        if (this.active) this.stop(DISCONNECTED);
        else {
          this.disable();
          this.onError('A camera or microphone disconnected. Reconnect it and enable the camera again.');
        }
      }, { once: true }));
      this.change('ready');
    } catch (error) {
      if (this.disposed || this.generation !== generation) return;
      this.stopTracks();
      this.change('idle');
      this.onError(cameraError(error));
    }
  }

  disable() {
    if (this.active) { this.stop(); return; }
    ++this.generation;
    this.stopTracks();
    this.change('idle');
  }

  start() {
    if (this.disposed || this.state !== 'ready') return;
    try {
      const recorder = new this.Recorder(this.stream, recordingOptions(this.Recorder));
      this.recorder = recorder;
      this.chunks = [];
      this.bytes = 0;
      this.stopReason = '';
      recorder.addEventListener('dataavailable', ({ data }) => {
        if (this.disposed || this.recorder !== recorder || !data?.size) return;
        this.chunks.push(data);
        this.bytes += data.size;
        if (this.bytes >= this.maxBytes) this.stop('This take reached the recording size limit. Download it before starting another.');
      });
      recorder.addEventListener('error', () => {
        this.stopReason = 'The browser interrupted recording. Any available footage is ready to download.';
        if (recorder.state !== 'inactive') this.stop(this.stopReason);
        // The MediaRecorder error sequence emits final data and a stop event.
      });
      recorder.addEventListener('stop', () => {
        if (this.disposed || this.recorder !== recorder) return;
        this.clearTimers();
        const blob = new Blob(this.chunks, { type: recorder.mimeType || this.chunks[0]?.type || 'video/webm' });
        this.chunks = [];
        this.recorder = null;
        this.stopTracks();
        this.change('idle');
        if (blob.size) this.onTake(blob, this.stopReason);
        else this.onError('No footage was captured. Enable the camera and try another take.');
      }, { once: true });
      recorder.start(1000);
      this.startedAt = performance.now();
      this.change('recording');
      this.limitTimer = setTimeout(() => this.stop('This take reached 15 minutes. Download it before starting another.'), this.maxDurationMs);
      // Track.stop() need not emit ended. Also detect stopped tracks directly,
      // so capture cannot silently continue with only one working device.
      this.monitorTimer = setInterval(() => {
        if (this.stream?.getTracks().some((track) => track.readyState === 'ended')) this.stop(DISCONNECTED);
      }, this.monitorIntervalMs);
    } catch (error) {
      this.clearTimers();
      this.recorder = null;
      this.chunks = [];
      this.stopTracks();
      this.change('idle');
      this.onError(cameraError(error));
    }
  }

  stop(reason = '') {
    if (this.state !== 'recording') return;
    if (reason) this.stopReason = reason;
    this.clearTimers();
    this.change('stopping');
    if (this.recorder.state === 'inactive') return;
    try { this.recorder.stop(); }
    catch {
      this.recorder = null;
      this.chunks = [];
      this.stopTracks();
      this.change('idle');
      this.onError('The browser could not finish this take. Try recording again.');
    }
  }

  dispose() {
    this.disposed = true;
    ++this.generation;
    this.clearTimers();
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* The page is closing. */ }
    }
    this.stopTracks();
    this.recorder = null;
    this.chunks = [];
    this.state = 'idle';
  }
}

export function setupRecording({ notify, getTitle, onActivityChange }) {
  const $ = (id) => document.getElementById(id);
  let takeUrl = '';
  let unsaved = false;
  let takeTitle = '';
  let ticker;
  const preview = $('camera-preview');
  const review = $('take-preview');
  const download = $('download-take');
  const recorder = new CameraRecorder({
    onChange: render,
    onError(message) { $('recording-help').textContent = message; notify(message); },
    onTake(blob, reason) {
      review.pause();
      review.removeAttribute('src');
      review.load();
      if (takeUrl) URL.revokeObjectURL(takeUrl);
      takeUrl = URL.createObjectURL(blob);
      unsaved = true;
      review.src = takeUrl;
      download.href = takeUrl;
      download.download = recordingFilename(takeTitle, blob.type);
      download.textContent = `Download .${blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
      render();
      notify(reason || 'Take ready. Review it, then download it to keep a copy.');
    },
  });

  function updateTimer() {
    const seconds = Math.max(0, Math.floor((performance.now() - recorder.startedAt) / 1000));
    $('recording-timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function render() {
    const { state, stream, active } = recorder;
    const ready = state === 'ready';
    $('recording-panel').dataset.state = state;
    $('recording-status').textContent = ({ idle: takeUrl ? 'Your take is ready' : 'Camera + microphone', opening: 'Waiting for camera access', ready: 'Camera ready', recording: 'Recording', stopping: 'Finishing your take…' })[state];
    $('recording-help').textContent = ({ idle: takeUrl ? 'Download to keep it. Takes are cleared when you leave this page.' : 'Record yourself while you read. Your take stays on this device.', opening: 'Allow your camera and microphone in the browser prompt.', ready: 'Frame your shot, then record. Up to 15 minutes per take.', recording: 'Scrolling and recording are independent. Stop when your take is finished.', stopping: 'Saving your footage in this tab.' })[state];
    $('record-camera').disabled = active || !recorder.supported;
    $('record-camera').textContent = state === 'opening' ? 'Cancel camera request' : active ? 'Camera on' : ready ? 'Turn camera off' : 'Enable camera';
    $('record-toggle').hidden = !(ready || active);
    $('record-toggle').disabled = state === 'stopping';
    $('record-toggle').textContent = active ? 'Stop recording' : 'Record take';
    $('recording-timer').hidden = !active;
    $('review-take').hidden = !takeUrl || active || state === 'opening';
    download.hidden = !takeUrl || active || state === 'opening';
    $('camera-frame').hidden = !stream;
    if (preview.srcObject !== stream) {
      preview.srcObject = stream;
      if (stream) preview.play().catch(() => {});
    }
    clearInterval(ticker);
    if (active) { updateTimer(); ticker = setInterval(updateTimer, 250); }
    else $('recording-timer').textContent = '00:00';
    onActivityChange(active);
    if (!recorder.supported) $('recording-help').textContent = 'Camera recording is unavailable. Use a current browser on localhost or HTTPS.';
  }

  $('record-camera').addEventListener('click', () => {
    if (recorder.state === 'idle') recorder.enable();
    else recorder.disable();
  });
  $('record-toggle').addEventListener('click', () => {
    if (recorder.state === 'ready') { takeTitle = getTitle(); recorder.start(); }
    else recorder.stop();
  });
  $('review-take').addEventListener('click', () => $('take-dialog').showModal());
  $('close-take').addEventListener('click', () => $('take-dialog').close());
  $('take-dialog').addEventListener('close', () => review.pause());
  download.addEventListener('click', () => { unsaved = false; });
  window.addEventListener('beforeunload', (event) => {
    if (recorder.active || unsaved) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => {
    clearInterval(ticker);
    recorder.dispose();
    review.pause();
    if (takeUrl) URL.revokeObjectURL(takeUrl);
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });
  render();
}
