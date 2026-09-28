import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInWorkspace } from "./sandbox";

/** A repeat hint only: timings, coordinates and stack line numbers may vary.
 * The original output remains the evidence presented to the model. */
export function failureSignature(output: string): string {
  return output
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function workspaceEntry(workspace: string, relative: string, kind: "file" | "directory" = "file"): string | null {
  try {
    const abs = resolveInWorkspace(workspace, relative);
    if (!fs.existsSync(abs)) return null;
    const stat = fs.statSync(abs);
    return kind === "file" ? (stat.isFile() ? abs : null) : stat.isDirectory() ? abs : null;
  } catch {
    return null;
  }
}

/** Look for conventional Python test files without traversing symlinks or
 * unbounded generated trees. */
function hasPythonTests(workspace: string, relative: string, depth = 2): boolean {
  const directory = workspaceEntry(workspace, relative, "directory");
  if (!directory) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true }).slice(0, 500);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && /^(?:test_.*|.*_test)\.py$/i.test(entry.name)) return true;
    if (depth > 0 && entry.isDirectory() && hasPythonTests(workspace, path.join(relative, entry.name), depth - 1)) return true;
  }
  return false;
}

/** Conventional checks use fixed commands and never interpolate manifest text.
 * Caller-owned acceptance commands take precedence in the final gate. */
export function projectVerification(workspace: string): string | undefined {
  const commands: string[] = [];
  const packageFile = workspaceEntry(workspace, "package.json");
  if (packageFile) {
    try {
      if (fs.statSync(packageFile).size > 1024 * 1024) commands.push("npm run build --if-present");
      else {
        const data = JSON.parse(fs.readFileSync(packageFile, "utf8"));
        const scripts = data && typeof data === "object" && !Array.isArray(data) ? data.scripts : null;
        if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
          for (const name of ["build", "test", "test:e2e"]) {
            if (typeof scripts[name] === "string" && scripts[name].trim()) commands.push(`npm run ${name}`);
          }
        }
      }
    } catch {
      // npm reports malformed package metadata precisely; never interpolate it.
      commands.push("npm run build --if-present");
    }
  }

  const pythonProject =
    workspaceEntry(workspace, "pyproject.toml") || workspaceEntry(workspace, "setup.cfg") || workspaceEntry(workspace, "pytest.ini");
  const pythonConfig =
    workspaceEntry(workspace, "pytest.ini") ||
    workspaceEntry(workspace, "tox.ini") ||
    (() => {
      const file = workspaceEntry(workspace, "pyproject.toml");
      if (!file) return null;
      try {
        return /\[tool\.pytest(?:\.|\])/i.test(fs.readFileSync(file, "utf8").slice(0, 256 * 1024)) ? file : null;
      } catch {
        return null;
      }
    })();
  if (pythonProject && (pythonConfig || hasPythonTests(workspace, "tests") || hasPythonTests(workspace, ".", 0))) {
    commands.push("python -m pytest -q");
  }

  const composerFile = workspaceEntry(workspace, "composer.json");
  if (composerFile) {
    try {
      if (fs.statSync(composerFile).size <= 1024 * 1024) {
        const data = JSON.parse(fs.readFileSync(composerFile, "utf8"));
        const scripts = data && typeof data === "object" && !Array.isArray(data) ? (data as any).scripts : null;
        if (scripts && typeof scripts === "object" && !Array.isArray(scripts) && typeof scripts.test === "string" && scripts.test.trim()) {
          commands.push("composer test");
        }
      }
    } catch {
      // malformed composer metadata: never interpolate it.
    }
  }

  if (workspaceEntry(workspace, "go.mod")) commands.push("go test ./...");
  if (workspaceEntry(workspace, "Cargo.toml")) commands.push("cargo test --workspace");
  const dotnetExtensions = [".sln", ".slnx", ".csproj", ".fsproj", ".vbproj"];
  try {
    if (
      fs
        .readdirSync(workspace)
        .slice(0, 500)
        .some((name) => dotnetExtensions.some((ext) => name.toLowerCase().endsWith(ext)) && !!workspaceEntry(workspace, name))
    )
      commands.push("dotnet test --nologo");
  } catch {
    /* an unreadable workspace root simply has no discovered .NET check */
  }

  const maven = workspaceEntry(workspace, "pom.xml");
  if (maven) {
    if (workspaceEntry(workspace, process.platform === "win32" ? "mvnw.cmd" : "mvnw")) {
      commands.push(process.platform === "win32" ? ".\\mvnw.cmd test" : "./mvnw test");
    } else commands.push("mvn test");
  } else if (workspaceEntry(workspace, "build.gradle") || workspaceEntry(workspace, "build.gradle.kts")) {
    if (workspaceEntry(workspace, process.platform === "win32" ? "gradlew.bat" : "gradlew")) {
      commands.push(process.platform === "win32" ? ".\\gradlew.bat test" : "./gradlew test");
    } else commands.push("gradle test");
  }
  return commands.length ? [...new Set(commands)].join(" && ") : undefined;
}

/** Split a `cmd1 && cmd2` chain without breaking quoted `&&` (ex: `node -e "a && b"`).
 * Only `&&` outside single, double and backtick quotes separates commands. */
export function splitVerification(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < command.length) {
        cur += command[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      parts.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

/** Merge several verification chains, keeping each step once, in order. */
export function mergeVerificationCommands(...cmds: (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cmds) {
    if (!c) continue;
    for (const p of splitVerification(c)) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out.join(" && ");
}
