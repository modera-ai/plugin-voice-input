import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type StreamingModel = "zipformer-small" | "zipformer-bilingual";
export type SpeechModel = "sensevoice" | StreamingModel;
export const streamingModels = {
  "zipformer-small": {
    repository: "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23",
    revision: "204ad33",
    decoder: "decoder-epoch-99-avg-1.onnx",
  },
  "zipformer-bilingual": {
    repository: "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
    revision: "98590b7",
    decoder: "decoder-epoch-99-avg-1.onnx",
  },
} as const;
export const streamingScript = String.raw`
import sys,json,base64,io,wave
import numpy as np
import sherpa_onnx
config=json.loads(sys.stdin.readline())
recognizer=sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=config['tokens'],encoder=config['encoder'],decoder=config['decoder'],joiner=config['joiner'],
    num_threads=config['threads'],sample_rate=16000,feature_dim=80,provider='cpu',
    decoding_method='greedy_search',enable_endpoint_detection=False)
stream=recognizer.create_stream()
for line in sys.stdin:
    request=json.loads(line)
    with wave.open(io.BytesIO(base64.b64decode(request['audio'])), 'rb') as w:
        samples=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').astype(np.float32)/32768.0
    stream.accept_waveform(16000,samples)
    if request.get('final'):
        stream.accept_waveform(16000,np.zeros(8000,dtype=np.float32))
        stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    print(json.dumps({'text':recognizer.get_result(stream)},ensure_ascii=True),flush=True)
`;

/** One model load per recording. At most one request is in flight. */
export class StreamingRecognizer {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending:
    | { resolve: (text: string) => void; reject: (error: unknown) => void }
    | undefined;
  private buffer = "";
  private stderr = "";
  private failure?: Error;
  private readonly lifetime: ReturnType<typeof setTimeout>;
  private readonly abort: () => void;
  constructor(
    python: string,
    config: Record<string, unknown>,
    private readonly signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.child = spawn(python, ["-u", "-c", streamingScript], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    this.abort = () => this.close(new Error("Speech session cancelled"));
    signal.addEventListener("abort", this.abort, { once: true });
    this.lifetime = setTimeout(
      () => this.close(new Error("Speech session expired")),
      130000,
    );
    this.lifetime.unref();
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 100000) {
        this.close(new Error("Invalid streaming speech output"));
        return;
      }
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const result = JSON.parse(line);
        if (
          typeof result.text !== "string" ||
          result.text.length > 20000 ||
          !this.pending
        )
          throw new Error("Invalid streaming speech result");
        const pending = this.pending;
        this.pending = undefined;
        pending.resolve(result.text.trim());
      } catch (cause) {
        this.close(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.child.on("error", (error) => this.close(error));
    this.child.on("close", (code) =>
      this.close(new Error(`Speech stream closed (${code}): ${this.stderr}`)),
    );
    this.child.stdin.on("error", (error) => this.close(error));
    this.child.stdin.write(JSON.stringify(config) + "\n");
    if (signal.aborted) this.abort();
  }
  async accept(
    audio: string,
    final: boolean,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error("Speech stream is busy");
    const abort = () => this.close(new Error("Speech chunk cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        this.pending = { resolve, reject };
        this.child.stdin.write(JSON.stringify({ audio, final }) + "\n");
        if (signal.aborted) abort();
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  close(error = new Error("Speech session closed")) {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.lifetime);
    this.signal.removeEventListener("abort", this.abort);
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
    this.child.kill();
  }
}
