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

import type * as EffectAcpSchema from "effect-acp/schema";

import { readGeminiDiscoverySettings, resolveGeminiConfigDir } from "./GeminiHome.ts";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const TOML_EXTENSION = ".toml";

const GeminiCommandDefinition = Schema.Struct({
  prompt: Schema.String,
  description: Schema.optional(Schema.String),
});
const decodeGeminiCommandDefinition = Schema.decodeUnknownOption(GeminiCommandDefinition);

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
    input: { hint: "show | refresh" },
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

export const discoverGeminiSkills = Effect.fn("discoverGeminiSkills")(function* (
  config: Pick<GeminiSettings, "homePath">,
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveGeminiConfigDir(config, environment);
  const settings = yield* readGeminiDiscoverySettings(config, environment, cwd);
  const roots = [
    { directory: path.join(configDir, "skills"), scope: "user" as const },
    { directory: path.join(path.dirname(configDir), ".agents", "skills"), scope: "user" as const },
    ...(cwd && settings.workspaceTrusted
      ? [
          { directory: path.join(cwd, ".gemini", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
        ]
      : []),
  ];
  const skillsByName = new Map<string, ServerProviderSkill>();

  for (const root of roots) {
    // Gemini loads SKILL.md and */SKILL.md. Read those paths directly so linked
    // skills work without recursively traversing their assets or repositories.
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): string[] => []));
    const skillFiles = [
      "SKILL.md",
      ...entries
        .filter((entry) => entry !== ".git" && entry !== "node_modules")
        .sort()
        .map((entry) => path.join(entry, "SKILL.md")),
    ];
    for (const relativePath of skillFiles) {
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
        enabled: settings.skillsEnabled && !settings.disabledSkills.has(name),
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
  const settings = yield* readGeminiDiscoverySettings(config, environment, cwd);
  const roots = [
    { directory: path.join(configDir, "commands"), scope: "user" as const },
    ...(cwd && settings.workspaceTrusted
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
  nativeCommands: ReadonlyArray<ServerProviderSlashCommand> = GEMINI_ACP_SLASH_COMMANDS,
): Effect.fn.Return<GeminiCatalog, never, FileSystem.FileSystem | Path.Path> {
  const [customCommands, skills] = yield* Effect.all([
    discoverGeminiCustomCommands(config, cwd, environment),
    discoverGeminiSkills(config, cwd, environment),
  ]);
  const slashCommands = new Map(nativeCommands.map((command) => [command.name, command] as const));
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

// ACP resource links leave ignore rules, file limits and access checks to Gemini.
const linkGeminiFiles = Effect.fn("linkGeminiFiles")(function* (prompt: string, cwd: string) {
  const path = yield* Path.Path;
  const resources: EffectAcpSchema.ContentBlock[] = [];
  let text = prompt;
  for (const injection of extractInjections(prompt, "@{").toReversed()) {
    if (!injection.content) continue;
    // Gemini 0.59 treats the file:// suffix as a path without URI decoding.
    resources.unshift({
      type: "resource_link",
      name: injection.content,
      uri: `file://${path.resolve(cwd, injection.content)}`,
    });
    text = `${text.slice(0, injection.startIndex)}@${injection.content}${text.slice(injection.endIndex)}`;
  }
  return { text, resources };
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
): Effect.fn.Return<
  { readonly text: string; readonly resources: ReadonlyArray<EffectAcpSchema.ContentBlock> },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(input.trim());
  if (!match) return { text: input, resources: [] };
  const commandName = match[1] ?? "";
  const args = match[2] ?? "";
  const command = (yield* discoverGeminiCustomCommands(config, cwd, environment)).find(
    (candidate) => candidate.name === commandName,
  );
  if (!command) return { text: input, resources: [] };

  const usesArgs = command.prompt.includes("{{args}}");
  const platform = yield* HostProcessPlatform;
  const withArguments = usesArgs
    ? substituteCommandArguments(command.prompt, args, platform)
    : args
      ? `${command.prompt}\n\n${input.trim()}`
      : command.prompt;
  const linked = yield* linkGeminiFiles(withArguments, cwd);
  return { ...linked, text: preserveShellInjectionsForAgent(linked.text) };
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
  if (!/(^|\s)\$\S/u.test(input)) return input;
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
