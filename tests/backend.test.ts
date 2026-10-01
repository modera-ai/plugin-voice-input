import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWave, runProcess, downloadModelFile, installationError } from "../src/backend";

function wave(seconds = 1) {
  const bytes = Buffer.alloc(44 + seconds * 32000);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
it("rejects malformed, stereo and oversized recordings before invoking inference", () => {
  expect(() => validateWave(wave().toString("base64"))).not.toThrow();
  const stereo = wave(); stereo.writeUInt16LE(2, 22);
  expect(() => validateWave(stereo.toString("base64"))).toThrow("PCM16");
  expect(() => validateWave(wave(121).toString("base64"))).toThrow();
  expect(() => validateWave("garbage")).toThrow();
});
it("captures process errors and cancels an active inference process", async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], controller.signal);
  controller.abort(new Error("Cancelled"));
  await expect(running).rejects.toThrow("Cancelled");
  await expect(runProcess(process.execPath, ["-e", "process.stderr.write('broken');process.exit(1)"], new AbortController().signal)).rejects.toThrow("broken");
});

it("reports byte progress and publishes the model only after a complete download", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-download-"));
  const target = join(root, "model");
  const report = vi.fn();
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close();
  } }), { headers: { "content-length": "4" } }));
  try {
    await downloadModelFile("https://example.test/model", target, 0, new AbortController().signal, report);
    expect(report.mock.calls[0]?.[0]).toEqual({ completed: 0, total: 4 });
    expect(report.mock.lastCall?.[0]).toEqual({ completed: 4, total: 4 });
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3, 4]));
    await expect(access(target + ".partial")).rejects.toThrow();
  } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
});

it("reports downloaded bytes without inventing a percentage when the size is unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-download-"));
  const report = vi.fn();
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3])));
  try {
    await downloadModelFile("https://example.test/model", join(root, "model"), 0, new AbortController().signal, report);
    expect(report.mock.lastCall?.[0]).toEqual({ completed: 3 });
  } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
});

it("cleans failed partial downloads and allows a successful retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-download-"));
  const target = join(root, "model");
  const fetch = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { "content-length": "4" } }))
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-length": "4" } }));
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(downloadModelFile("https://example.test/model", target, 0, new AbortController().signal, () => {})).rejects.toThrow("Incomplete");
    await expect(access(target)).rejects.toThrow();
    await expect(access(target + ".partial")).rejects.toThrow();
    await downloadModelFile("https://example.test/model", target, 0, new AbortController().signal, () => {});
    expect((await readFile(target)).length).toBe(4);
  } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
});

it("keeps network error causes visible and bounds error text for the host protocol", () => {
  expect(installationError(new Error("fetch failed", { cause: { code: "ETIMEDOUT" } }))).toBe("fetch failed (ETIMEDOUT)");
  expect(installationError(new Error("x".repeat(5000))).length).toBeLessThanOrEqual(3500);
});
