// run_command: one-shot foreground commands, cwd-locked to the workspace.
// Shell picking matters on Windows: local models emit POSIX commands, so we
// prefer Git Bash when it exists, skip WSL's System32 bash (different
// filesystem world), and fall back to PowerShell. The chosen shell is named in
// the system prompt so the model knows what dialect to write.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { binSearchDirs, truncateMiddle } from "../util";

export interface ShellInfo {
  exe: string;
  argsFor: (cmd: string) => string[];
  label: string; // goes into the system prompt
}

let cached: ShellInfo | null = null;

export function pickShell(): ShellInfo {
  if (cached) return cached;
  if (process.platform === "win32") {
    // 1. Git Bash réel dans les dossiers d'installation standards
    const candidates = [
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        cached = {
          exe: p,
          argsFor: (cmd) => ["-o", "pipefail", "-c", cmd],
          label: "bash (Git Bash)",
        };
        return cached;
      }
    }
    // 2. Recherche bash sur PATH en excluant System32 ET WindowsApps (alias cassés)
    try {
      const where = spawnSync("where.exe", ["bash"], { encoding: "utf8" });
      if (where.status === 0) {
        const found = where.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((p) => p && !p.toLowerCase().includes("system32") && !p.toLowerCase().includes("windowsapps") && fs.existsSync(p));
        if (found) {
          cached = {
            exe: found,
            argsFor: (cmd) => ["-o", "pipefail", "-c", cmd],
            label: "bash (Git Bash)",
          };
          return cached;
        }
      }
    } catch {
      // Ignorer si where.exe échoue
    }

    // 3. PowerShell 7 moderne (pwsh.exe) si installé
    const pwshCandidates = [
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "PowerShell", "7", "pwsh.exe"),
    ];
    for (const p of pwshCandidates) {
      if (p && fs.existsSync(p)) {
        cached = {
          exe: p,
          argsFor: (cmd) => ["-NoProfile", "-NonInteractive", "-Command", cmd],
          label: "PowerShell 7",
        };
        return cached;
      }
    }

    // 4. Repli sur Windows PowerShell natif
    cached = {
      exe: "powershell.exe",
      argsFor: (cmd) => ["-NoProfile", "-NonInteractive", "-Command", cmd],
      label: "PowerShell",
    };
    return cached;
  }
  const sh = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  cached = {
    exe: sh,
    argsFor: (cmd) => (sh.endsWith("/bash") ? ["-o", "pipefail", "-lc", cmd] : ["-lc", cmd]),
    label: path.basename(sh),
  };
  return cached;
}

export function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

const OUTPUT_CAP = 8000;
/** Override with SMOL_SHELL_TIMEOUT_MS (used by the demo and by tests). */
function shellTimeoutMs(): number {
  const raw = Number(process.env.SMOL_SHELL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : 120_000;
}
const DEFAULT_TIMEOUT_MS = shellTimeoutMs();

/**
 * Live handle on a running shell command. The UI reads it to show real time
 * left, and acts on it: extend the deadline, hand the process to the
 * background task runner, or cancel it for real.
 */
export interface ShellControl {
  readonly command: string;
  readonly startedAt: number;
  /** Absolute ms epoch of the auto-kill; null once detached or finished. */
  deadline: number | null;
  /** Assigned by the caller: hands the still-running process to the task runner. */
  adopt?: (proc: import("child_process").ChildProcess, command: string, seed: string) => string;
  /** Push the auto-kill deadline out by `ms`; false when the run is over. */
  extend(ms: number): boolean;
  /** Stop waiting, keep the process alive in the background; returns its task id. */
  detach(): string | null;
  /** Kill it now and resolve the run as cancelled. */
  cancel(): void;
}

/** Runs currently waiting on a timeout, most recent first on lookup. */
const liveShells = new Set<ShellControl>();

export function liveShellList(): { command: string; startedAt: number; deadline: number | null }[] {
  return [...liveShells].map((c) => ({ command: c.command, startedAt: c.startedAt, deadline: c.deadline }));
}

export function findLiveShell(command: string): ShellControl | null {
  let found: ShellControl | null = null;
  for (const c of liveShells) if (c.command === command && c.startedAt >= (found?.startedAt ?? 0)) found = c;
  return found;
}

/** Keep bash alive while ordinary background jobs own its output pipes. On
 * Windows taskkill cannot find descendants after their shell has exited. */
export function managedCommand(shell: ShellInfo, command: string): string {
  return /(?:^|[\\/])bash(?:\.exe)?$/.test(shell.exe)
    ? `${command}\n__smol_command_status=$?\nwait\nexit "$__smol_command_status"`
    : command;
}

/** Windows-only folders that are not generic tool dirs: Ollama, PowerShell 7,
 * Git. The generic toolchain dirs (~/.local/bin, cargo, ...) come from
 * binSearchDirs() in mcp.ts so resolution and PATH never drift apart. */
function windowsOnlyDirs(): string[] {
  if (process.platform !== "win32") return [];
  return [
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Programs", "Ollama"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin"),
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0"),
    process.env.SystemRoot ?? "C:\\Windows",
  ];
}

export function shellEnv(): NodeJS.ProcessEnv {
  // Same folders the command resolver searches, so a program smolcoder can find
  // can always find its own helpers. Kept in one place: a hardcoded list here
  // silently broke servers whose runtime lived in ~/.local/bin (uvx).
  const searchDirs = process.platform === "win32" ? [...windowsOnlyDirs(), ...binSearchDirs()] : [];
  const inheritedPath = process.platform === "win32" ? (process.env.Path ?? process.env.PATH ?? "") : (process.env.PATH ?? "");
  const pathParts = [...searchDirs, inheritedPath.split(path.delimiter)].flat().filter(Boolean);
  const seen = new Set<string>();
  const rawPath = pathParts
    .filter((part) => {
      const key = process.platform === "win32" ? part.toLowerCase() : part;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(path.delimiter);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === "win32") {
    // Windows treats PATH/Path as the same variable, while MSYS and cmd
    // disagree about which duplicate wins. Keep one canonical key so npm
    // child processes inherit the Node installation reliably.
    delete env.PATH;
    env.Path = rawPath;
  } else {
    env.PATH = rawPath;
  }
  return env;
}

export function runCommand(command: string, cwd: string, signal?: AbortSignal, onCtl?: (ctl: ShellControl) => void): Promise<string> {
  if (signal?.aborted) return Promise.resolve("Error: commande annulée avant le démarrage");
  return new Promise((resolve) => {
    const shell = pickShell();
    let output = "";
    let finished = false;
    const started = Date.now();
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    const procEnv = shellEnv();
    const projectCommand = process.platform === "win32" && /(?:^|[\s;&|])(?:npm|npx|pnpm|yarn)(?:\.cmd)?(?:\s|$)/i.test(command);
    const exe = projectCommand ? (process.env.ComSpec ?? "cmd.exe") : shell.exe;
    const args = projectCommand ? ["/d", "/s", "/c", command] : shell.argsFor(managedCommand(shell, command));

    const proc = spawn(exe, args, {
      cwd,
      env: procEnv,
      detached: process.platform !== "win32", // process group for killTree
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (chunk: Buffer) => {
      // Keep the end of a long build/test log: failures usually appear there.
      // Dropping all output after 32k hid the actual failure from the model.
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_CAP * 4) output = truncateMiddle(output, OUTPUT_CAP * 4);
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);

    const release = () => liveShells.delete(ctl);
    const stopWaiting = () => {
      finished = true;
      clearTimeout(timer);
      cleanup();
    };
    const destroy = () => {
      try {
        killTree(proc.pid!);
        proc.stdout.destroy();
        proc.stderr.destroy();
      } catch {
        /* déjà parti */
      }
    };

    // User interrupt (esc / ctrl+c / web stop button): kill the whole tree now.
    const onAbort = () => {
      if (finished) return;
      stopWaiting();
      release();
      destroy();
      resolve(`${output.trim() ? `${truncateMiddle(output, OUTPUT_CAP)}\n` : ""}[command cancelled by the user before it finished]`);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    const killTimeout = () => {
      if (finished) return;
      stopWaiting();
      release();
      destroy();
      resolve(
        `Error: ${truncateMiddle(output, OUTPUT_CAP)}\n[command timed out after ${Math.round(timeoutMs / 1000)}s and was killed. For tests/builds, isolate the stuck test or phase and inspect its loop or initialization before rerunning. For a persistent dev server, use task {"action": "start"}.]`
      );
    };
    let timer = setTimeout(killTimeout, timeoutMs);

    const ctl: ShellControl = {
      command,
      startedAt: started,
      deadline: started + timeoutMs,
      extend(ms: number) {
        if (finished || ctl.deadline === null) return false;
        const extra = Math.max(1000, Math.floor(ms));
        clearTimeout(timer);
        timeoutMs += extra;
        ctl.deadline = ctl.deadline + extra;
        timer = setTimeout(killTimeout, Math.max(1, ctl.deadline - Date.now()));
        return true;
      },
      detach(): string | null {
        if (finished || ctl.deadline === null) return null;
        if (!ctl.adopt) return null;
        stopWaiting();
        release();
        ctl.deadline = null;
        const id = ctl.adopt(proc, command, output);
        const seed = output.trim() ? truncateMiddle(output, OUTPUT_CAP) : "";
        resolve(
          `[moved to background as task ${id} — the process keeps running. ` +
            `Check it with task {"action": "logs", "task_id": "${id}"}; a status line arrives when it finishes.]` +
            (seed ? `\nOutput so far:\n${seed}` : "")
        );
        return id;
      },
      cancel() {
        if (finished) return;
        stopWaiting();
        release();
        destroy();
        resolve(`${output.trim() ? `${truncateMiddle(output, OUTPUT_CAP)}\n` : ""}[command cancelled by the user]`);
      },
    };
    liveShells.add(ctl);
    onCtl?.(ctl);

    proc.on("error", (err) => {
      if (finished) return;
      stopWaiting();
      release();
      resolve(`Error: could not start command: ${err.message}`);
    });

    proc.on("close", (code) => {
      if (finished) return;
      stopWaiting();
      release();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const body = output.trim() ? truncateMiddle(output, OUTPUT_CAP) : "(no output)";
      resolve(`${code !== 0 ? `Error: command exited with code ${code ?? "?"}\n` : ""}${body}\n[exit code ${code ?? "?"} in ${secs}s]`);
    });

    if (signal?.aborted) onAbort();
  });
}
