import type {
  GeminiSettings,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { parse as parseYamlDocument } from "yaml";

import { resolveGeminiConfigDir } from "./GeminiHome.ts";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const TOML_EXTENSION = ".toml";
const MAX_INJECTED_FILE_BYTES = 1_000_000;
const MAX_INJECTED_DIRECTORY_FILES = 100;

const GeminiCommandDefinition = Schema.Struct({
  prompt: Schema.String,
  description: Schema.optional(Schema.String),
});
const decodeGeminiCommandDefinition = Schema.decodeUnknownOption(GeminiCommandDefinition);

const GeminiSettingsFile = Schema.Struct({
  skills: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      disabled: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
const decodeGeminiSettingsFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(GeminiSettingsFile),
);

export interface GeminiCustomCommand {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly path: string;
  readonly scope: "user" | "project";
}

export interface GeminiCatalog {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export const GEMINI_ACP_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "about", description: "Show Gemini CLI version and environment information." },
  { name: "extensions", description: "List active Gemini CLI extensions." },
  { name: "help", description: "Show available Gemini ACP commands." },
  { name: "init", description: "Create or update project context instructions." },
  {
    name: "memory",
    description: "Inspect or refresh Gemini CLI memory.",
    input: { hint: "show | refresh | add <text>" },
  },
  { name: "restore", description: "Restore files from a Gemini CLI checkpoint." },
];

function sanitizeCommandSegment(segment: string): string {
  const sanitized = segment.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return sanitized.length > 50 ? `${sanitized.slice(0, 47)}...` : sanitized;
}

const listRelativeFiles = Effect.fn("gemini.listRelativeFiles")(function* (
  root: string,
  suffix: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem
    .readDirectory(root, { recursive: true })
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  return entries.filter((entry) => entry.toLowerCase().endsWith(suffix)).sort();
});

function parseSkillMetadata(contents: string): {
  readonly malformed: boolean;
  readonly name?: string;
  readonly description?: string;
} {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return { malformed: false };
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { malformed: true };
    }
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    return {
      malformed: false,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
  } catch {
    return { malformed: true };
  }
}

const readSkillSettings = Effect.fn("gemini.readSkillSettings")(function* (
  configDir: string,
): Effect.fn.Return<
  { readonly enabled: boolean; readonly disabled: ReadonlySet<string> },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fileSystem
    .readFileString(path.join(configDir, "settings.json"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return { enabled: true, disabled: new Set<string>() };
  return Option.match(decodeGeminiSettingsFile(contents), {
    onNone: () => ({ enabled: true, disabled: new Set<string>() }),
    onSome: (settings) => ({
      enabled: settings.skills?.enabled ?? true,
      disabled: new Set(settings.skills?.disabled ?? []),
    }),
  });
});

export const discoverGeminiSkills = Effect.fn("discoverGeminiSkills")(function* (
  config: Pick<GeminiSettings, "homePath">,
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveGeminiConfigDir(config, environment);
  const skillSettings = yield* readSkillSettings(configDir);
  const roots = [
    { directory: path.join(configDir, "skills"), scope: "user" as const },
    ...(cwd ? [{ directory: path.join(cwd, ".gemini", "skills"), scope: "project" as const }] : []),
  ];
  const skillsByName = new Map<string, ServerProviderSkill>();

  for (const root of roots) {
    for (const relativePath of yield* listRelativeFiles(root.directory, "skill.md")) {
      const skillPath = path.join(root.directory, relativePath);
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) continue;
      const metadata = parseSkillMetadata(contents);
      if (metadata.malformed) continue;
      const directoryName = path.basename(path.dirname(skillPath)).trim();
      const name = metadata.name ?? directoryName;
      if (!name) continue;
      skillsByName.set(name, {
        name,
        path: skillPath,
        scope: root.scope,
        enabled: skillSettings.enabled && !skillSettings.disabled.has(name),
        ...(metadata.description ? { description: metadata.description } : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

export const discoverGeminiCustomCommands = Effect.fn("discoverGeminiCustomCommands")(function* (
  config: Pick<GeminiSettings, "homePath">,
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<GeminiCustomCommand>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveGeminiConfigDir(config, environment);
  const roots = [
    { directory: path.join(configDir, "commands"), scope: "user" as const },
    ...(cwd
      ? [{ directory: path.join(cwd, ".gemini", "commands"), scope: "project" as const }]
      : []),
  ];
  const commandsByName = new Map<string, GeminiCustomCommand>();

  for (const root of roots) {
    for (const relativePath of yield* listRelativeFiles(root.directory, TOML_EXTENSION)) {
      const commandPath = path.join(root.directory, relativePath);
      const contents = yield* fileSystem
        .readFileString(commandPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) continue;

      const parsed = yield* Effect.try(() => parseToml(contents)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const definition = Option.getOrUndefined(decodeGeminiCommandDefinition(parsed));
      if (!definition) continue;

      const withoutExtension = relativePath.slice(0, -TOML_EXTENSION.length);
      const name = withoutExtension
        .split(/[\\/]/u)
        .map(sanitizeCommandSegment)
        .filter(Boolean)
        .join(":");
      if (!name) continue;
      commandsByName.set(name, {
        name,
        prompt: definition.prompt,
        path: commandPath,
        scope: root.scope,
        description:
          definition.description?.trim().slice(0, 100) ||
          `Custom command from ${path.basename(commandPath)}`,
      });
    }
  }

  return [...commandsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

export const discoverGeminiCatalog = Effect.fn("discoverGeminiCatalog")(function* (
  config: Pick<GeminiSettings, "homePath">,
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<GeminiCatalog, never, FileSystem.FileSystem | Path.Path> {
  const [customCommands, skills] = yield* Effect.all([
    discoverGeminiCustomCommands(config, cwd, environment),
    discoverGeminiSkills(config, cwd, environment),
  ]);
  const slashCommands = new Map(
    GEMINI_ACP_SLASH_COMMANDS.map((command) => [command.name, command] as const),
  );
  for (const command of customCommands) {
    slashCommands.set(command.name, {
      name: command.name,
      description: command.description,
      input: { hint: "arguments" },
    });
  }
  return { slashCommands: [...slashCommands.values()], skills };
});

function extractInjections(text: string, trigger: "@{" | "!{") {
  const injections: Array<{
    readonly content: string;
    readonly startIndex: number;
    readonly endIndex: number;
  }> = [];
  let index = 0;
  while (index < text.length) {
    const startIndex = text.indexOf(trigger, index);
    if (startIndex < 0) break;
    let cursor = startIndex + trigger.length;
    let depth = 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "{") depth += 1;
      if (text[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) break;
    injections.push({
      content: text.slice(startIndex + trigger.length, cursor - 1).trim(),
      startIndex,
      endIndex: cursor,
    });
    index = cursor;
  }
  return injections;
}

const injectGeminiFiles = Effect.fn("injectGeminiFiles")(function* (
  prompt: string,
  cwd: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const injections = extractInjections(prompt, "@{");
  let result = prompt;
  for (const injection of injections.toReversed()) {
    const resolved = path.resolve(cwd, injection.content);
    const relative = path.relative(cwd, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;

    let replacement: string | undefined;
    const directContents = yield* fileSystem
      .readFileString(resolved)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (directContents !== undefined) {
      replacement = directContents.slice(0, MAX_INJECTED_FILE_BYTES);
    } else {
      const entries = (yield* listRelativeFiles(resolved, ""))
        .filter((entry) => !entry.includes(`${path.sep}.git${path.sep}`))
        .slice(0, MAX_INJECTED_DIRECTORY_FILES);
      let remaining = MAX_INJECTED_FILE_BYTES;
      const chunks: string[] = [];
      for (const entry of entries) {
        if (remaining <= 0) break;
        const contents = yield* fileSystem
          .readFileString(path.join(resolved, entry))
          .pipe(Effect.orElseSucceed(() => undefined));
        if (contents === undefined) continue;
        const chunk = `\n--- ${entry} ---\n${contents}`.slice(0, remaining);
        chunks.push(chunk);
        remaining -= chunk.length;
      }
      if (chunks.length > 0) replacement = chunks.join("");
    }
    if (replacement !== undefined) {
      result = `${result.slice(0, injection.startIndex)}${replacement}${result.slice(injection.endIndex)}`;
    }
  }
  return result;
});

function preserveShellInjectionsForAgent(prompt: string): string {
  const injections = extractInjections(prompt, "!{");
  let result = prompt;
  for (const injection of injections.toReversed()) {
    const replacement = [
      "\n<gemini-custom-command-shell-injection>",
      "Run this command with your shell tool, subject to the active approval policy, and use its output at this point:",
      injection.content,
      "</gemini-custom-command-shell-injection>\n",
    ].join("\n");
    result = `${result.slice(0, injection.startIndex)}${replacement}${result.slice(injection.endIndex)}`;
  }
  return result;
}

function escapeShellArgument(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `"${value.replaceAll('"', '\\"').replace(/([%&|<>^])/gu, "^$1")}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function substituteCommandArguments(
  prompt: string,
  args: string,
  platform: NodeJS.Platform,
): string {
  let result = prompt;
  for (const injection of extractInjections(prompt, "!{").toReversed()) {
    const resolved = injection.content.replaceAll("{{args}}", escapeShellArgument(args, platform));
    result = `${result.slice(0, injection.startIndex)}!{${resolved}}${result.slice(injection.endIndex)}`;
  }
  return result.replaceAll("{{args}}", args);
}

export const expandGeminiCustomCommand = Effect.fn("expandGeminiCustomCommand")(function* (
  config: Pick<GeminiSettings, "homePath">,
  cwd: string,
  input: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(input.trim());
  if (!match) return input;
  const commandName = match[1] ?? "";
  const args = match[2] ?? "";
  const command = (yield* discoverGeminiCustomCommands(config, cwd, environment)).find(
    (candidate) => candidate.name === commandName,
  );
  if (!command) return input;

  const usesArgs = command.prompt.includes("{{args}}");
  const platform = yield* HostProcessPlatform;
  const withArguments = usesArgs
    ? substituteCommandArguments(command.prompt, args, platform)
    : args
      ? `${command.prompt}\n\n${input.trim()}`
      : command.prompt;
  const withFiles = yield* injectGeminiFiles(withArguments, cwd);
  return preserveShellInjectionsForAgent(withFiles);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export const expandGeminiSkillMentions = Effect.fn("expandGeminiSkillMentions")(function* (
  config: Pick<GeminiSettings, "homePath">,
  cwd: string,
  input: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const skills = yield* discoverGeminiSkills(config, cwd, environment);
  const requested = skills
    .filter((skill) => skill.enabled)
    .filter((skill) =>
      new RegExp(`(^|\\s)\\$${escapeRegExp(skill.name)}(?=\\s|$)`, "u").test(input),
    )
    .map((skill) => skill.name);
  if (requested.length === 0) return input;
  return [
    "<gemini-skill-activation>",
    `Activate these Gemini CLI skills with the activate_skill tool before proceeding: ${requested.join(", ")}`,
    "</gemini-skill-activation>",
    "",
    input,
  ].join("\n");
});
