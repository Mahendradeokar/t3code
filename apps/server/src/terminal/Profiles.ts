import * as Fs from "node:fs";
import * as PathNode from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  TerminalProfileUnavailableError,
  type TerminalProfile,
  type TerminalProfilesResult,
  type TerminalProfileSelection,
} from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";

const WINDOWS_PATH_KEYS = ["PATH", "Path", "path"] as const;
const POSIX_SHELL_NAMES = ["bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "pwsh"];

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = WINDOWS_PATH_KEYS.map((key) => env[key]).find(Boolean) ?? "";
  return raw.split(platform === "win32" ? ";" : ":").filter(Boolean);
}

function executablePath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  if (name.includes("/") || name.includes("\\")) return name;
  for (const directory of pathEntries(env, platform)) {
    const candidate = PathNode.join(directory, name);
    if (Fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function canonicalPath(value: string): string {
  try {
    return Fs.realpathSync.native(value);
  } catch {
    return PathNode.normalize(value);
  }
}

function profileName(executable: string, platform: NodeJS.Platform): string {
  const base = PathNode.basename(executable).toLowerCase();
  if (base === "pwsh" || base === "pwsh.exe") return "PowerShell";
  if (platform === "win32") {
    if (base === "bash.exe") {
      return /(?:^|[\\/])git(?:[\\/]|$)/i.test(executable) ? "Git Bash" : "Bash";
    }
    if (base === "powershell.exe") return "Windows PowerShell";
    if (base === "cmd.exe") return "Command Prompt";
  }
  return base.replace(/\.exe$/i, "");
}

function argsFor(executable: string, platform: NodeJS.Platform): string[] {
  const base = PathNode.basename(executable).toLowerCase();
  if (
    platform === "win32" &&
    base === "bash.exe" &&
    /(?:^|[\\/])git(?:[\\/]|$)/i.test(executable)
  ) {
    return ["--login", "-i"];
  }
  if (platform !== "win32" && base === "zsh") return ["-o", "nopromptsp"];
  if (base === "pwsh" || base === "pwsh.exe" || base === "powershell.exe") {
    return ["-NoLogo"];
  }
  return [];
}

function addCandidate(
  candidates: Array<{ executable: string; args: string[] }>,
  executable: string | null,
  platform: NodeJS.Platform,
) {
  if (!executable || !Fs.existsSync(executable)) return;
  const canonical = canonicalPath(executable);
  const key = platform === "win32" ? canonical.toLowerCase() : canonical;
  if (
    candidates.some((candidate) => {
      const candidatePath = canonicalPath(candidate.executable);
      return (platform === "win32" ? candidatePath.toLowerCase() : candidatePath) === key;
    })
  )
    return;
  candidates.push({ executable: canonical, args: argsFor(canonical, platform) });
}

function discoverTerminalProfiles(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<TerminalProfile> {
  const candidates: Array<{ executable: string; args: string[] }> = [];
  if (platform === "win32") {
    for (const name of ["pwsh.exe", "powershell.exe", "cmd.exe", "bash.exe"]) {
      addCandidate(candidates, executablePath(name, env, platform), platform);
    }
    const roots = [
      env.ProgramW6432,
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA,
    ].filter((value): value is string => Boolean(value));
    for (const root of roots) {
      addCandidate(candidates, PathNode.join(root, "Git", "bin", "bash.exe"), platform);
      addCandidate(candidates, PathNode.join(root, "Git", "usr", "bin", "bash.exe"), platform);
      addCandidate(candidates, PathNode.join(root, "PowerShell", "7", "pwsh.exe"), platform);
    }
  } else {
    let shells: string[] = [];
    try {
      shells = Fs.readFileSync("/etc/shells", "utf8")
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#"));
    } catch {
      shells = POSIX_SHELL_NAMES;
    }
    for (const shell of [...POSIX_SHELL_NAMES, ...shells]) {
      addCandidate(candidates, executablePath(shell, env, platform) ?? shell, platform);
    }
  }
  const profiles: TerminalProfile[] = [];
  const names = new Set<string>();
  for (const candidate of candidates) {
    const name = profileName(candidate.executable, platform);
    // One logical profile is shown even when PATH, /etc/shells, and known
    // install roots all point at different copies of the same shell.
    const nameKey = name.toLocaleLowerCase();
    if (names.has(nameKey)) continue;
    names.add(nameKey);
    profiles.push({
      id: `${canonicalPath(candidate.executable)}\u0000${candidate.args.join("\u0000")}`,
      name,
      executable: candidate.executable,
      args: candidate.args,
    });
  }
  return profiles.sort((left, right) => left.name.localeCompare(right.name));
}

function resolveProfileSelection(
  profiles: ReadonlyArray<TerminalProfile>,
  selection: TerminalProfileSelection | null,
): TerminalProfile | null {
  if (!selection) return null;
  return (
    profiles.find(
      (profile) =>
        profile.executable === selection.executable &&
        JSON.stringify(profile.args) === JSON.stringify(selection.args),
    ) ?? null
  );
}

export class TerminalProfiles extends Context.Service<
  TerminalProfiles,
  {
    readonly discover: () => Effect.Effect<TerminalProfilesResult>;
    readonly setDefault: (
      selection: TerminalProfileSelection,
    ) => Effect.Effect<
      TerminalProfile,
      TerminalProfileUnavailableError | ServerSettings.ServerSettingsError
    >;
  }
>()("t3/terminal/Profiles") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const settings = yield* ServerSettings.ServerSettingsService;

  const discover = Effect.fn("terminal.profiles.discover")(function* () {
    const profiles = discoverTerminalProfiles(platform, process.env);
    const current = yield* settings.getSettings;
    const selected = resolveProfileSelection(profiles, current.defaultTerminalProfile);
    const fallbackName =
      platform === "win32" ? "pwsh.exe" : PathNode.basename(process.env.SHELL ?? "bash");
    const fallback =
      profiles.find(
        (profile) =>
          PathNode.basename(profile.executable).toLowerCase() === fallbackName.toLowerCase(),
      ) ??
      profiles[0] ??
      null;
    const defaultProfile = selected ?? fallback;
    if (defaultProfile && (!current.defaultTerminalProfile || !selected)) {
      yield* settings.updateSettings({
        defaultTerminalProfile: {
          executable: defaultProfile.executable,
          args: defaultProfile.args,
        },
      });
    }
    return {
      profiles,
      defaultProfileId: defaultProfile?.id ?? null,
    };
  });

  const setDefault = Effect.fn("terminal.profiles.setDefault")(function* (
    selection: TerminalProfileSelection,
  ) {
    const profiles = discoverTerminalProfiles(platform, process.env);
    const profile = resolveProfileSelection(profiles, selection);
    if (!profile)
      return yield* new TerminalProfileUnavailableError({ profileId: selection.executable });
    yield* settings.updateSettings({ defaultTerminalProfile: selection });
    return profile;
  });

  return TerminalProfiles.of({ discover, setDefault });
});

export const layer = Layer.effect(TerminalProfiles, make);
