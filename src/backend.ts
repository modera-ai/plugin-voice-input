import { spawn } from "node:child_process";
import { access, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

const revision = "2365bae";
const modelUrl = `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/${revision}/`;
export interface InstallProgress {
  stage: "environment" | "dependencies" | "download" | "verify";
  file?: string;
  completed?: number;
  total?: number;
}

export async function downloadModelFile(url: string, target: string, minimum: number, signal: AbortSignal, report: (progress: Pick<InstallProgress, "completed" | "total">) => void): Promise<void> {
  const temporary = target + ".partial";
  try {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    const total = Number.isSafeInteger(length) && length > 0 && !response.headers.get("content-encoding") ? length : undefined;
    let completed = 0, lastUpdate = 0;
    const update = () => report({ completed, ...(total === undefined ? {} : { total }) });
    update();
    const counter = new Transform({ transform(chunk: Buffer, _encoding, next) {
      completed += chunk.length;
      if (completed > 300 * 1024 * 1024) { next(new Error("Model download exceeded size limit")); return; }
      if (Date.now() - lastUpdate >= 250) { lastUpdate = Date.now(); update(); }
      next(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(temporary), { signal });
    if (completed <= minimum || (total !== undefined && completed !== total)) throw new Error("Incomplete model download");
    await rename(temporary, target);
    update();
  } finally { await rm(temporary, { force: true }); }
}

export function installationError(cause: unknown): string {
  const error = cause as { message?: string; cause?: { message?: string; code?: string }; name?: string } | null;
  const message = error?.message ?? String(cause);
  const detail = error?.cause?.code ?? error?.cause?.message;
  return (detail && !message.includes(detail) ? `${message} (${detail})` : message).slice(0, 3500);
}
const recognitionScript = String.raw`
import sys,json,base64,io,wave
import numpy as np
import sherpa_onnx
request=json.load(sys.stdin)
with wave.open(io.BytesIO(base64.b64decode(request['audio'])), 'rb') as w:
    if w.getnchannels()!=1 or w.getsampwidth()!=2 or w.getframerate()!=16000:
        raise ValueError('Expected mono 16 kHz PCM16 WAV')
    samples=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').astype(np.float32)/32768.0
recognizer=sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=request['model'],tokens=request['tokens'],num_threads=request['threads'],
    use_itn=True,language=request['language'],provider='cpu')
stream=recognizer.create_stream()
stream.accept_waveform(16000,samples)
recognizer.decode_stream(stream)
print(json.dumps({'text':stream.result.text},ensure_ascii=True))
`;

export function runProcess(executable: string, args: string[], signal: AbortSignal, input?: string, outputLimit = 100000): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    let stdout = "", stderr = "", settled = false;
    const abort = () => { child.kill(); };
    signal.addEventListener("abort", abort, { once: true });
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve(stdout);
    };
    child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > outputLimit) { child.kill(); settle(new Error("Speech process output exceeded limit")); } });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", error => settle(new Error(`Cannot start ${executable}: ${error.message}`)));
    child.on("close", code => settle(code === 0 ? undefined : new Error(`Speech process failed (${code}): ${stderr}`)));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    if (signal.aborted) abort();
  });
}

export class SpeechBackend {
  constructor(readonly root: string) {}
  get python() { return join(this.root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"); }
  async ready(): Promise<boolean> {
    try {
      await access(join(this.root, "ready")); await access(this.python);
      return (await stat(join(this.root, "model.int8.onnx"))).size > 200000000 && (await stat(join(this.root, "tokens.txt"))).size > 100000;
    } catch { return false; }
  }
  async install(python: string, signal: AbortSignal, source = "huggingface.co", report: (progress: InstallProgress) => void = () => {}) {
    if (!["huggingface.co", "hf-mirror.com"].includes(source)) throw new Error("Unsupported model source");
    await mkdir(this.root, { recursive: true });
    await rm(join(this.root, "ready"), { force: true });
    report({ stage: "environment" });
    await runProcess(python, ["-m", "venv", join(this.root, "venv")], signal);
    report({ stage: "dependencies" });
    await runProcess(this.python, ["-m", "pip", "install", "--disable-pip-version-check", "sherpa-onnx==1.13.8", "numpy>=1.26,<3"], signal);
    for (const name of ["model.int8.onnx", "tokens.txt"]) {
      const target = join(this.root, name);
      const minimum = name === "tokens.txt" ? 100000 : 200000000;
      if (await stat(target).then(info => info.size > minimum, () => false)) continue;
      report({ stage: "download", file: name, completed: 0 });
      await downloadModelFile(modelUrl.replace("huggingface.co", source) + name, target, minimum, signal, progress => report({ stage: "download", file: name, ...progress }));
    }
    report({ stage: "verify" });
    await runProcess(this.python, ["-c", "import sherpa_onnx, numpy"], signal);
    signal.throwIfAborted();
    await writeFile(join(this.root, "ready"), revision, { signal });
  }
  async transcribe(audio: string, language: string, threads: number, signal: AbortSignal): Promise<string> {
    if (!await this.ready()) throw new Error("Install the local speech model first");
    validateWave(audio);
    const output = await runProcess(this.python, ["-c", recognitionScript], signal, JSON.stringify({ audio, model: join(this.root, "model.int8.onnx"), tokens: join(this.root, "tokens.txt"), language: language === "auto" ? "" : language, threads }));
    const result = JSON.parse(output);
    if (typeof result.text !== "string" || result.text.length > 20000) throw new Error("Invalid recognition result");
    return result.text.trim();
  }
}

export function validateWave(base64: string): void {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 6444 || bytes.length > 3840044 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.toString("ascii", 12, 16) !== "fmt " || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 16000 || bytes.readUInt16LE(34) !== 16 || bytes.toString("ascii", 36, 40) !== "data" || bytes.readUInt32LE(40) !== bytes.length - 44 || (bytes.length - 44) % 2 !== 0)
    throw new Error("Expected a 0.2-120 second mono 16 kHz PCM16 WAV recording");
}
