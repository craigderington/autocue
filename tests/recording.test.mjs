import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraRecorder, cameraError, recordingFilename, recordingOptions } from '../public/recording.js';

class FakeTrack extends EventTarget {
  stopped = false;
  get readyState() { return this.stopped ? 'ended' : 'live'; }
  stop() { this.stopped = true; }
}

function stream() {
  const video = new FakeTrack();
  const audio = new FakeTrack();
  return { getTracks: () => [video, audio], getAudioTracks: () => [audio], getVideoTracks: () => [video] };
}

class FakeRecorder extends EventTarget {
  static isTypeSupported(type) { return type === 'video/webm'; }
  state = 'inactive';
  mimeType = 'video/webm';
  start() { this.state = 'recording'; }
  emitData(value) {
    const event = new Event('dataavailable');
    event.data = new Blob([value], { type: this.mimeType });
    this.dispatchEvent(event);
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.emitData('final frame');
      this.dispatchEvent(new Event('stop'));
    });
  }
}

function session(options = {}) {
  const source = stream();
  const takes = [];
  const errors = [];
  const recorder = new CameraRecorder({ mediaDevices: { getUserMedia: async () => source }, Recorder: FakeRecorder,
    onTake: (blob, reason) => takes.push({ blob, reason }), onError: (error) => errors.push(error), ...options });
  return { recorder, source, takes, errors };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('camera access is deferred until explicitly enabled', async () => {
  let requests = 0;
  const { recorder } = session({ mediaDevices: { getUserMedia: async () => { requests++; return stream(); } } });
  assert.equal(requests, 0);
  await recorder.enable();
  assert.equal(requests, 1);
  assert.equal(recorder.state, 'ready');
  recorder.dispose();
});

test('stopping includes final data and releases both devices', async () => {
  const { recorder, source, takes } = session();
  await recorder.enable();
  recorder.start();
  recorder.recorder.emitData('first frame');
  recorder.stop();
  assert.equal(recorder.state, 'stopping');
  await flush();
  assert.equal(recorder.state, 'idle');
  assert.equal(await takes[0].blob.text(), 'first framefinal frame');
  assert.ok(source.getTracks().every((track) => track.stopped));
  assert.equal(recorder.recorder, null);
  assert.deepEqual(recorder.chunks, []);
});

test('cancelling permission stops devices even when permission resolves late', async () => {
  let resolve;
  const source = stream();
  const { recorder } = session({ mediaDevices: { getUserMedia: () => new Promise((callback) => { resolve = callback; }) } });
  const pending = recorder.enable();
  assert.equal(recorder.state, 'opening');
  recorder.disable();
  resolve(source);
  await pending;
  assert.equal(recorder.state, 'idle');
  assert.equal(recorder.stream, null);
  assert.ok(source.getTracks().every((track) => track.stopped));
});

test('permission failures leave a usable idle session', async () => {
  const { recorder, errors } = session({ mediaDevices: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
  await recorder.enable();
  assert.equal(recorder.state, 'idle');
  assert.match(errors[0], /denied/);
});

test('recorder startup failure releases devices', async () => {
  class BrokenRecorder extends FakeRecorder { start() { throw new Error('encoder failed'); } }
  const { recorder, source, errors } = session({ Recorder: BrokenRecorder });
  await recorder.enable();
  recorder.start();
  assert.equal(recorder.state, 'idle');
  assert.ok(source.getTracks().every((track) => track.stopped));
  assert.equal(errors.length, 1);
});

test('a device disconnect finalizes available footage', async () => {
  const { recorder, source, takes } = session();
  await recorder.enable();
  recorder.start();
  source.getVideoTracks()[0].dispatchEvent(new Event('ended'));
  await flush();
  assert.equal(takes.length, 1);
  assert.match(takes[0].reason, /disconnected/);
  assert.ok(source.getTracks().every((track) => track.stopped));
});

test('a stopped track is detected even without an ended event', async () => {
  const done = Promise.withResolvers();
  const { recorder, source } = session({ monitorIntervalMs: 10, onTake: (blob, reason) => done.resolve(reason) });
  await recorder.enable();
  recorder.start();
  source.getVideoTracks()[0].stop();
  assert.match(await done.promise, /disconnected/);
  assert.ok(source.getTracks().every((track) => track.stopped));
});

test('the size limit finalizes a take without dropping its final chunk', async () => {
  const { recorder, takes } = session({ maxBytes: 3 });
  await recorder.enable();
  recorder.start();
  recorder.recorder.emitData('1234');
  await flush();
  assert.equal(takes.length, 1);
  assert.equal(await takes[0].blob.text(), '1234final frame');
  assert.match(takes[0].reason, /size limit/);
});

test('the duration limit stops and releases the capture', async () => {
  const done = Promise.withResolvers();
  const { recorder, source } = session({ maxDurationMs: 10, onTake: (blob, reason) => done.resolve(reason) });
  await recorder.enable();
  recorder.start();
  assert.match(await done.promise, /15 minutes/);
  assert.ok(source.getTracks().every((track) => track.stopped));
});

test('disposal releases devices and ignores late recorder events', async () => {
  const { recorder, source, takes } = session();
  await recorder.enable();
  recorder.start();
  recorder.dispose();
  await flush();
  assert.ok(source.getTracks().every((track) => track.stopped));
  assert.equal(takes.length, 0);
});

test('format negotiation supports MP4 and the browser default', () => {
  assert.equal(recordingOptions({ isTypeSupported: (type) => type === 'video/mp4' }).mimeType, 'video/mp4');
  assert.equal(recordingOptions({ isTypeSupported: () => false }).mimeType, undefined);
});

test('download names reflect the actual container and sanitize script titles', () => {
  assert.match(recordingFilename('../../My / take', 'video/mp4;codecs=avc1', new Date('2026-01-01T00:00:00Z')), /^My-take-.*\.mp4$/);
  assert.match(recordingFilename('', 'video/webm'), /^take-.*\.webm$/);
  assert.match(cameraError({ name: 'NotFoundError' }), /both needed/);
});
