import { run, spawnStreaming } from "./run";

// All Claude invocations use yolo mode per design doc.
const YOLO = "--dangerously-skip-permissions";

export async function claudeOneShot(
  cwd: string,
  prompt: string,
  opts: { timeoutMs?: number; onSpawn?: (kill: () => void) => void } = {}
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  let out = "";
  let err = "";
  const h = spawnStreaming(
    "claude",
    ["-p", prompt, YOLO],
    { cwd, timeoutMs: opts.timeoutMs },
    (c) => (out += c),
    (c) => (err += c)
  );
  opts.onSpawn?.(h.kill);
  const { code, timedOut } = await h.done;
  return { code, stdout: out, stderr: err, timedOut };
}

// Chat SSE — streams output chunks to caller
export function claudeChatStream(
  cwd: string,
  prompt: string,
  onChunk: (chunk: string) => void,
  opts: { timeoutMs?: number } = {}
) {
  return spawnStreaming(
    "claude",
    ["-p", prompt, YOLO],
    { cwd, timeoutMs: opts.timeoutMs },
    (c) => onChunk(c),
    (c) => onChunk(c)
  );
}

export async function claudeCheckPresent(): Promise<boolean> {
  const r = await run("claude", ["--version"]);
  return r.code === 0;
}
