import { spawn } from "node:child_process";
import { access, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import {
  StreamingRecognizer,
  streamingModels,
  type SpeechModel,
  type StreamingModel,
} from "./streaming";

const revision = "2365bae";
const modelUrl = `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/${revision}/`;
export interface InstallProgress {
  stage: "environment" | "dependencies" | "download" | "verify";
  file?: string;
  completed?: number;
  total?: number;
}

export async function downloadModelFile(
  url: string,
  target: string,
  minimum: number,
  signal: AbortSignal,
  report: (progress: Pick<InstallProgress, "completed" | "total">) => void,
): Promise<void> {
  const temporary = target + ".partial";
  try {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body)
      throw new Error(`Model download failed: HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    const total =
      Number.isSafeInteger(length) &&
      length > 0 &&
      !response.headers.get("content-encoding")
        ? length
        : undefined;
    let completed = 0,
      lastUpdate = 0;
    const update = () =>
      report({ completed, ...(total === undefined ? {} : { total }) });
    update();
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        completed += chunk.length;
        if (completed > 300 * 1024 * 1024) {
          next(new Error("Model download exceeded size limit"));
          return;
        }
        if (Date.now() - lastUpdate >= 250) {
          lastUpdate = Date.now();
          update();
        }
        next(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as never),
      counter,
      createWriteStream(temporary),
      { signal },
    );
    if (completed <= minimum || (total !== undefined && completed !== total))
      throw new Error("Incomplete model download");
    await rename(temporary, target);
    update();
  } finally {
    await rm(temporary, { force: true });
  }
}

export function installationError(cause: unknown): string {
  const error = cause as {
    message?: string;
    cause?: { message?: string; code?: string };
    name?: string;
  } | null;
  const message = error?.message ?? String(cause);
  const detail = error?.cause?.code ?? error?.cause?.message;
  return (
    detail && !message.includes(detail) ? `${message} (${detail})` : message
  ).slice(0, 3500);
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

export function runProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  input?: string,
  outputLimit = 100000,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "",
      stderr = "",
      settled = false;
    const abort = () => {
      child.kill();
    };
    signal.addEventListener("abort", abort, { once: true });
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve(stdout);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > outputLimit) {
        child.kill();
        settle(new Error("Speech process output exceeded limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (error) =>
      settle(new Error(`Cannot start ${executable}: ${error.message}`)),
    );
    child.on("close", (code) =>
      settle(
        code === 0
          ? undefined
          : new Error(`Speech process failed (${code}): ${stderr}`),
      ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    if (signal.aborted) abort();
  });
}

export class SpeechBackend {
  private streams = new Map<
    string,
    {
      worker?: StreamingRecognizer;
      controller: AbortController;
      busy: boolean;
      sequence: number;
      bytes: number;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(readonly root: string) {}
  get python() {
    return join(
      this.root,
      "venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  }
  async ready(model: SpeechModel = "sensevoice"): Promise<boolean> {
    try {
      if (model !== "sensevoice") {
        await access(this.python);
        await access(join(this.root, model, "ready"));
        for (const file of this.modelFiles(model))
          if (
            (await stat(join(this.root, model, file))).size <
            (file === "tokens.txt" ? 1000 : 100000)
          )
            return false;
        return true;
      }
      await access(join(this.root, "ready"));
      await access(this.python);
      return (
        (await stat(join(this.root, "model.int8.onnx"))).size > 200000000 &&
        (await stat(join(this.root, "tokens.txt"))).size > 100000
      );
    } catch {
      return false;
    }
  }
  async install(
    python: string,
    signal: AbortSignal,
    source = "huggingface.co",
    report: (progress: InstallProgress) => void = () => {},
    models: readonly SpeechModel[] = ["sensevoice"],
  ) {
    if (!["huggingface.co", "hf-mirror.com"].includes(source))
      throw new Error("Unsupported model source");
    await mkdir(this.root, { recursive: true });
    report({ stage: "environment" });
    await runProcess(python, ["-m", "venv", join(this.root, "venv")], signal);
    report({ stage: "dependencies" });
    await runProcess(
      this.python,
      [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "sherpa-onnx==1.13.8",
        "numpy>=1.26,<3",
      ],
      signal,
    );
    for (const name of models.includes("sensevoice")
      ? ["model.int8.onnx", "tokens.txt"]
      : []) {
      const target = join(this.root, name);
      const minimum = name === "tokens.txt" ? 100000 : 200000000;
      if (
        await stat(target).then(
          (info) => info.size > minimum,
          () => false,
        )
      )
        continue;
      report({ stage: "download", file: name, completed: 0 });
      await downloadModelFile(
        modelUrl.replace("huggingface.co", source) + name,
        target,
        minimum,
        signal,
        (progress) => report({ stage: "download", file: name, ...progress }),
      );
    }
    for (const model of new Set(models)) {
      if (model === "sensevoice") continue;
      const definition = streamingModels[model];
      const directory = join(this.root, model);
      await mkdir(directory, { recursive: true });
      for (const name of this.modelFiles(model)) {
        const target = join(directory, name),
          minimum = name === "tokens.txt" ? 1000 : 100000;
        if (
          await stat(target).then(
            (info) => info.size > minimum,
            () => false,
          )
        )
          continue;
        report({ stage: "download", file: `${model}/${name}`, completed: 0 });
        await downloadModelFile(
          `https://${source}/csukuangfj/${definition.repository}/resolve/${definition.revision}/${name}`,
          target,
          minimum,
          signal,
          (next) =>
            report({ stage: "download", file: `${model}/${name}`, ...next }),
        );
      }
    }
    report({ stage: "verify" });
    await runProcess(this.python, ["-c", "import sherpa_onnx, numpy"], signal);
    signal.throwIfAborted();
    for (const model of new Set(models))
      await writeFile(
        join(this.root, ...(model === "sensevoice" ? [] : [model]), "ready"),
        model === "sensevoice" ? revision : streamingModels[model].revision,
        { signal },
      );
  }
  private modelFiles(model: StreamingModel) {
    return [
      "encoder-epoch-99-avg-1.int8.onnx",
      streamingModels[model].decoder,
      "joiner-epoch-99-avg-1.int8.onnx",
      "tokens.txt",
    ];
  }
  private createStream(
    model: StreamingModel,
    threads: number,
    signal: AbortSignal,
  ) {
    const files = this.modelFiles(model).map((file) =>
      join(this.root, model, file),
    );
    return new StreamingRecognizer(
      this.python,
      {
        encoder: files[0],
        decoder: files[1],
        joiner: files[2],
        tokens: files[3],
        threads,
      },
      signal,
    );
  }
  closeStream(id: string) {
    const entry = this.streams.get(id);
    if (!entry) return;
    this.streams.delete(id);
    clearTimeout(entry.timer);
    entry.controller.abort(new Error("Speech session closed"));
    entry.worker?.close();
  }
  close() {
    for (const id of this.streams.keys()) this.closeStream(id);
  }
  async preview(
    id: string,
    sequence: number,
    audio: string,
    model: StreamingModel,
    threads: number,
    lifetime: AbortSignal,
    signal: AbortSignal,
  ): Promise<string> {
    validateWave(audio);
    let entry = this.streams.get(id);
    if (!entry) {
      if (sequence !== 0 || this.streams.size >= 2)
        throw new Error("Speech session unavailable");
      entry = {
        controller: new AbortController(),
        busy: false,
        sequence: 0,
        bytes: 0,
      };
      this.streams.set(id, entry);
    }
    if (sequence !== entry.sequence)
      throw new Error("Out-of-order speech chunk");
    if (entry.busy) throw new Error("Speech stream is busy");
    entry.busy = true;
    entry.bytes += Buffer.from(audio, "base64").length - 44;
    if (entry.bytes > 3840000) {
      this.closeStream(id);
      throw new Error("Speech session exceeds duration limit");
    }
    clearTimeout(entry.timer);
    try {
      const sessionSignal = AbortSignal.any([
        lifetime,
        entry.controller.signal,
      ]);
      if (!entry.worker) {
        if (!(await this.ready(model)))
          throw new Error("Install the streaming speech model first");
        signal.throwIfAborted();
        sessionSignal.throwIfAborted();
        entry.worker = this.createStream(model, threads, sessionSignal);
      }
      const text = await entry.worker.accept(audio, false, signal);
      sessionSignal.throwIfAborted();
      entry.sequence++;
      entry.timer = setTimeout(() => this.closeStream(id), 15000);
      entry.timer.unref();
      return text;
    } catch (cause) {
      if (this.streams.get(id) === entry) this.closeStream(id);
      throw cause;
    } finally {
      entry.busy = false;
    }
  }
  async transcribe(
    audio: string,
    language: string,
    threads: number,
    signal: AbortSignal,
    model: SpeechModel = "sensevoice",
  ): Promise<string> {
    if (!(await this.ready(model)))
      throw new Error("Install the local speech model first");
    validateWave(audio);
    if (model !== "sensevoice") {
      const stream = this.createStream(model, threads, signal);
      try {
        return await stream.accept(audio, true, signal);
      } finally {
        stream.close();
      }
    }
    const output = await runProcess(
      this.python,
      ["-c", recognitionScript],
      signal,
      JSON.stringify({
        audio,
        model: join(this.root, "model.int8.onnx"),
        tokens: join(this.root, "tokens.txt"),
        language: language === "auto" ? "" : language,
        threads,
      }),
    );
    const result = JSON.parse(output);
    if (typeof result.text !== "string" || result.text.length > 20000)
      throw new Error("Invalid recognition result");
    return result.text.trim();
  }
}

export function validateWave(base64: string): void {
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length < 6444 ||
    bytes.length > 3840044 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.toString("ascii", 12, 16) !== "fmt " ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== 16000 ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString("ascii", 36, 40) !== "data" ||
    bytes.readUInt32LE(40) !== bytes.length - 44 ||
    (bytes.length - 44) % 2 !== 0
  )
    throw new Error(
      "Expected a 0.2-120 second mono 16 kHz PCM16 WAV recording",
    );
}
