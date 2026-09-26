// run_command: one-shot foreground commands, cwd-locked to the workspace.
// Shell picking matters on Windows: local models emit POSIX commands, so we
// prefer Git Bash when it exists, skip WSL's System32 bash (different
// filesystem world), and fall back to PowerShell. The chosen shell is named in
// the system prompt so the model knows what dialect to write.

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { truncateMiddle } from "../util";

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
			path.join(
				process.env["ProgramFiles"] ?? "C:\\Program Files",
				"Git",
				"bin",
				"bash.exe",
			),
			path.join(
				process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
				"Git",
				"bin",
				"bash.exe",
			),
			path.join(
				process.env["LOCALAPPDATA"] ?? "",
				"Programs",
				"Git",
				"bin",
				"bash.exe",
			),
			path.join(
				process.env["ProgramFiles"] ?? "C:\\Program Files",
				"Git",
				"usr",
				"bin",
				"bash.exe",
			),
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
					.find(
						(p) =>
							p &&
							!p.toLowerCase().includes("system32") &&
							!p.toLowerCase().includes("windowsapps") &&
							fs.existsSync(p),
					);
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
			path.join(
				process.env["ProgramFiles"] ?? "C:\\Program Files",
				"PowerShell",
				"7",
				"pwsh.exe",
			),
			path.join(
				process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
				"PowerShell",
				"7",
				"pwsh.exe",
			),
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
		argsFor: (cmd) =>
			sh.endsWith("/bash") ? ["-o", "pipefail", "-lc", cmd] : ["-lc", cmd],
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
const DEFAULT_TIMEOUT_MS = 120_000;

/** Keep bash alive while ordinary background jobs own its output pipes. On
 * Windows taskkill cannot find descendants after their shell has exited. */
export function managedCommand(shell: ShellInfo, command: string): string {
	return /(?:^|[\\/])bash(?:\.exe)?$/.test(shell.exe)
		? `${command}\n__smol_command_status=$?\nwait\nexit "$__smol_command_status"`
		: command;
}

export function shellEnv(): NodeJS.ProcessEnv {
	const winPathAdditions =
		process.platform === "win32"
			? [
					path.join(
						process.env.LOCALAPPDATA ?? "C:\\Users\\DELL\\AppData\\Local",
						"Programs",
						"Ollama",
					),
					"C:\\Program Files\\nodejs",
					"C:\\npm-global",
					path.join(
						process.env.APPDATA ?? "C:\\Users\\DELL\\AppData\\Roaming",
						"npm",
					),
					path.join(
						process.env.ProgramFiles ?? "C:\\Program Files",
						"PowerShell",
						"7",
					),
					path.join(
						process.env.ProgramFiles ?? "C:\\Program Files",
						"Git",
						"cmd",
					),
					path.join(
						process.env.ProgramFiles ?? "C:\\Program Files",
						"Git",
						"bin",
					),
					path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
					path.join(
						process.env.SystemRoot ?? "C:\\Windows",
						"System32",
						"WindowsPowerShell",
						"v1.0",
					),
					process.env.SystemRoot ?? "C:\\Windows",
				]
			: [];

	const inheritedPath =
		process.platform === "win32"
			? process.env.Path ?? process.env.PATH ?? ""
			: process.env.PATH ?? "";
	const pathParts = [...winPathAdditions, inheritedPath.split(path.delimiter)]
		.flat()
		.filter(Boolean);
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

export function runCommand(
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted)
		return Promise.resolve("Error: command cancelled before starting");
	return new Promise((resolve) => {
		const shell = pickShell();
		let output = "";
		let finished = false;
		const started = Date.now();
		const procEnv = shellEnv();
		const projectCommand = process.platform === "win32" &&
			/(?:^|[\s;&|])(?:npm|npx|pnpm|yarn)(?:\.cmd)?(?:\s|$)/i.test(command);
		const exe = projectCommand ? (process.env.ComSpec ?? "cmd.exe") : shell.exe;
		const args = projectCommand
			? ["/d", "/s", "/c", command]
			: shell.argsFor(managedCommand(shell, command));

		const proc = spawn(
			exe,
			args,
			{
				cwd,
				env: procEnv,
				detached: process.platform !== "win32", // process group for killTree
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		const append = (chunk: Buffer) => {
			// Keep the end of a long build/test log: failures usually appear there.
			// Dropping all output after 32k hid the actual failure from the model.
			output += chunk.toString("utf8");
			if (output.length > OUTPUT_CAP * 4)
				output = truncateMiddle(output, OUTPUT_CAP * 4);
		};
		proc.stdout.on("data", append);
		proc.stderr.on("data", append);

		// User interrupt (esc / ctrl+c / web stop button): kill the whole tree now.
		const onAbort = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			cleanup();
			killTree(proc.pid!);
			proc.stdout.destroy();
			proc.stderr.destroy();
			resolve(
				(output.trim() ? truncateMiddle(output, OUTPUT_CAP) + "\n" : "") +
					"[command cancelled by the user before it finished]",
			);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => signal?.removeEventListener("abort", onAbort);

		const timer = setTimeout(() => {
			if (finished) return;
			finished = true;
			cleanup();
			killTree(proc.pid!);
			proc.stdout.destroy();
			proc.stderr.destroy();
			resolve(
				"Error: " +
					truncateMiddle(output, OUTPUT_CAP) +
					`\n[command timed out after ${DEFAULT_TIMEOUT_MS / 1000}s and was killed. For tests/builds, isolate the stuck test or phase and inspect its loop or initialization before rerunning. For a persistent dev server, use task {"action": "start"}.]`,
			);
		}, DEFAULT_TIMEOUT_MS);

		proc.on("error", (err) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			cleanup();
			resolve(`Error: could not start command: ${err.message}`);
		});

		proc.on("close", (code) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			cleanup();
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const body = output.trim()
				? truncateMiddle(output, OUTPUT_CAP)
				: "(no output)";
			resolve(
				`${code !== 0 ? `Error: command exited with code ${code ?? "?"}\n` : ""}${body}\n[exit code ${code ?? "?"} in ${secs}s]`,
			);
		});

		if (signal?.aborted) onAbort();
	});
}
