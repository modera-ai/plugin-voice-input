import { expect, it } from "vitest";
import { validateWave, runProcess } from "../src/backend";

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
