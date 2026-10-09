import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

// Opt-in network/CPU smoke test: node plugins/voice-input/tests/smoke.mjs <cache-directory>
const cache = process.argv[2];
const model = process.argv[3] ?? "sensevoice";
const modelSource = process.env.VOICE_MODEL_SOURCE ?? "huggingface.co";
if (!["sensevoice", "zipformer-small", "zipformer-bilingual"].includes(model))
  throw new Error("Unknown test model");
if (!cache)
  throw new Error("Provide a model cache directory for this opt-in smoke test");
const temporary = await mkdtemp(join(tmpdir(), "modera-speech-smoke-"));
try {
  const bundle = join(temporary, "backend.cjs");
  await build({
    entryPoints: [resolve("plugins/voice-input/src/backend.ts")],
    outfile: bundle,
    platform: "node",
    format: "cjs",
    bundle: true,
  });
  const { SpeechBackend } = createRequire(import.meta.url)(bundle);
  const backend = new SpeechBackend(resolve(cache));
  const signal = AbortSignal.timeout(20 * 60 * 1000);
  if (!(await backend.ready(model))) {
    console.log("Installing private runtime and downloading model...");
    await backend.install(
      process.env.VOICE_PYTHON ?? "python",
      signal,
      modelSource,
      (next) => console.log(JSON.stringify(next)),
      [model],
    );
  }
  const response = await fetch(
    `https://${modelSource}/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365bae/test_wavs/zh.wav`,
    { signal },
  );
  if (!response.ok)
    throw new Error(`Fixture download failed: ${response.status}`);
  const audio = Buffer.from(await response.arrayBuffer());
  // The fixture may contain WAV metadata chunks. Normalize it using the isolated Python runtime.
  const { runProcess } = createRequire(import.meta.url)(bundle);
  const normalized = await runProcess(
    backend.python,
    [
      "-c",
      "import sys,base64,io,wave; w=wave.open(io.BytesIO(base64.b64decode(sys.stdin.read()))); b=io.BytesIO(); o=wave.open(b,'wb'); o.setparams(w.getparams()); o.writeframes(w.readframes(w.getnframes())); o.close(); print(base64.b64encode(b.getvalue()).decode())",
    ],
    signal,
    audio.toString("base64"),
    5120060,
  );
  const started = Date.now();
  const text = await backend.transcribe(
    normalized.trim(),
    "zh",
    2,
    signal,
    model,
  );
  if (!/[\u3400-\u9fff]/.test(text) || text.includes("\ufffd"))
    throw new Error("Expected intact Chinese transcription");
  console.log(
    JSON.stringify({ text, elapsedMs: Date.now() - started }).replace(
      /[\u0080-\uffff]/g,
      (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
    ),
  );
  if (model !== "sensevoice") {
    const bytes = Buffer.from(normalized.trim(), "base64");
    let sequence = 0,
      partial = "";
    try {
      for (let offset = 44; offset < bytes.length; offset += 19200) {
        const data = bytes.subarray(offset, offset + 19200);
        if (data.length < 6400) break;
        const chunk = Buffer.concat([bytes.subarray(0, 44), data]);
        chunk.writeUInt32LE(chunk.length - 8, 4);
        chunk.writeUInt32LE(data.length, 40);
        partial = await backend.preview(
          "smoke",
          sequence++,
          chunk.toString("base64"),
          model,
          2,
          signal,
          signal,
        );
      }
      if (!partial.trim() || sequence < 2)
        throw new Error("Expected incremental speech recognition");
      console.log(
        JSON.stringify({ model, chunks: sequence, partial }).replace(
          /[\u0080-\uffff]/g,
          (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
        ),
      );
    } finally {
      backend.close();
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
