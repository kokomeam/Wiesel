/**
 * Thin child-process helpers for the conversion worker. Keeps the
 * binary-not-installed path explicit so the worker can fail GRACEFULLY (mark the
 * job failed with a friendly message) instead of crashing the whole process.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** A failure with both a technical message (logged) and a user-facing one
 *  (stored on the deck import + shown in the failed card). */
export class WorkerError extends Error {
  readonly userMessage: string;
  constructor(message: string, userMessage: string) {
    super(message);
    this.name = "WorkerError";
    this.userMessage = userMessage;
  }
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function run(
  bin: string,
  args: string[],
  opts: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 128 * 1024 * 1024,
      env: opts.env ?? process.env,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new WorkerError(
        `Binary not found: ${bin}`,
        "Preview tools are unavailable on the server."
      );
    }
    throw err;
  }
}

/** True if a CLI exists on PATH (probes `--version`; ENOENT ⇒ missing). */
export async function commandExists(bin: string): Promise<boolean> {
  try {
    await execFileP(bin, ["--version"], { timeout: 20_000 });
    return true;
  } catch (err) {
    // ENOENT = not installed; any other error means it ran (and thus exists).
    return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}
