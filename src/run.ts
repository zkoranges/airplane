import { spawn } from "node:child_process";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; env?: Record<string, string>; timeoutMs?: number } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    let killed = false;
    let timer: any = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, opts.timeoutMs);
    }
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: killed ? 124 : code ?? 1,
        stdout,
        stderr: killed ? stderr + "\n[airplane] process timed out and was killed" : stderr,
      });
    });
    if (opts.input) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

// Spawn with streaming stdout (line-based). Returns a handle you can kill.
export function spawnStreaming(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  onStdout: (chunk: string) => void,
  onStderr?: (chunk: string) => void
) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => onStdout(d.toString()));
  child.stderr.on("data", (d) => (onStderr ? onStderr(d.toString()) : onStdout(d.toString())));
  let killed = false;
  let timer: any = null;
  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, opts.timeoutMs);
  }
  const done = new Promise<{ code: number; timedOut: boolean }>((resolve) => {
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, timedOut: killed });
    });
  });
  return {
    child,
    done,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    },
  };
}
