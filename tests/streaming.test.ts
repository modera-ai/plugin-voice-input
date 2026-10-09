import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StreamingRecognizer } from "../src/streaming";
import { SpeechBackend } from "../src/backend";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function childFixture(autoReply = false) {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
    kill: vi.fn(),
  });
  child.stdin.write.mockImplementation((line: string) => {
    if (autoReply && JSON.parse(line).audio)
      queueMicrotask(() => child.stdout.emit("data", '{"text":"临时文字"}\n'));
    return true;
  });
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
  return child;
}
function wave() {
  const bytes = Buffer.alloc(32044);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(32000, 40);
  return bytes.toString("base64");
}
it("loads one process, enforces backpressure and handles fragmented replies", async () => {
  const child = childFixture(),
    signal = new AbortController().signal;
  const worker = new StreamingRecognizer("python", { threads: 1 }, signal);
  try {
    const first = worker.accept("audio", false, signal);
    await expect(worker.accept("duplicate", false, signal)).rejects.toThrow(
      "busy",
    );
    child.stdout.emit("data", '{"text":"你');
    child.stdout.emit("data", '好"}\n');
    await expect(first).resolves.toBe("你好");
    const final = worker.accept("tail", true, signal);
    child.stdout.emit("data", '{"text":"你好世界"}\n');
    await expect(final).resolves.toBe("你好世界");
    expect(spawn).toHaveBeenCalledOnce();
  } finally {
    worker.close();
  }
  expect(child.kill).toHaveBeenCalledOnce();
});
it("cancels pending chunks and prevents reuse of a closed process", async () => {
  const child = childFixture(),
    lifetime = new AbortController(),
    call = new AbortController();
  const worker = new StreamingRecognizer("python", {}, lifetime.signal);
  const pending = worker.accept("audio", false, call.signal);
  call.abort();
  await expect(pending).rejects.toThrow("cancelled");
  await expect(worker.accept("late", false, lifetime.signal)).rejects.toThrow(
    "cancelled",
  );
  lifetime.abort();
  worker.close();
  expect(child.kill).toHaveBeenCalledOnce();
});
it("terminates a hung process and settles invalid output", async () => {
  vi.useFakeTimers();
  const child = childFixture(),
    signal = new AbortController().signal;
  const worker = new StreamingRecognizer("python", {}, signal);
  const pending = worker.accept("audio", false, signal);
  const rejected = expect(pending).rejects.toThrow("expired");
  await vi.advanceTimersByTimeAsync(130000);
  await rejected;
  expect(child.kill).toHaveBeenCalledOnce();
  const second = new StreamingRecognizer("python", {}, signal);
  const invalid = second.accept("audio", false, signal);
  child.stdout.emit("data", '{"text":42}\n');
  await expect(invalid).rejects.toThrow("Invalid");
});
it("bounds recording sessions, rejects repeated chunks and expires idle model memory", async () => {
  vi.useFakeTimers();
  const child = childFixture(true),
    signal = new AbortController().signal;
  vi.spyOn(SpeechBackend.prototype, "ready").mockResolvedValue(true);
  const backend = new SpeechBackend("unused");
  try {
    await expect(
      backend.preview("a", 0, wave(), "zipformer-small", 1, signal, signal),
    ).resolves.toBe("临时文字");
    await expect(
      backend.preview("a", 0, wave(), "zipformer-small", 1, signal, signal),
    ).rejects.toThrow("Out-of-order");
    await expect(
      backend.preview("a", 1, wave(), "zipformer-small", 1, signal, signal),
    ).resolves.toBe("临时文字");
    expect(spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15000);
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(
      backend.preview("a", 2, wave(), "zipformer-small", 1, signal, signal),
    ).rejects.toThrow("unavailable");
  } finally {
    backend.close();
  }
});
it("reserves a session during initialization and closes it before a late model load", async () => {
  childFixture(true);
  const signal = new AbortController().signal;
  let resolveReady: (ready: boolean) => void;
  vi.spyOn(SpeechBackend.prototype, "ready").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveReady = resolve;
      }),
  );
  const backend = new SpeechBackend("unused");
  const pending = backend.preview(
    "a",
    0,
    wave(),
    "zipformer-small",
    1,
    signal,
    signal,
  );
  await expect(
    backend.preview("a", 0, wave(), "zipformer-small", 1, signal, signal),
  ).rejects.toThrow("busy");
  backend.closeStream("a");
  resolveReady!(true);
  await expect(pending).rejects.toThrow("closed");
  expect(spawn).not.toHaveBeenCalled();
});
