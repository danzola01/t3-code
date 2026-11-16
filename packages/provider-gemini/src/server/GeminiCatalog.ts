import type {
  GeminiSettings,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parse as parseYamlDocument } from "yaml";

import type * as EffectAcpSchema from "effect-acp/compat";

import { discoverGeminiExtensions } from "./GeminiExtensions.ts";
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
  readonly scope: "user" | "project" | "extension";
}

export interface GeminiCatalog {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const GEMINI_ACP_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
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

const discoverGeminiSkills = Effect.fn("discoverGeminiSkills")(function* (
  config: Pick<GeminiSettings, "homePath"> & Partial<Pick<GeminiSettings, "launchArgs">>,
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveGeminiConfigDir(config, environment);
  const settings = yield* readGeminiDiscoverySettings(config, environment, cwd);
  const extensions = yield* discoverGeminiExtensions(config, cwd, environment);
  const roots = [
    ...extensions.map((extension) => ({
      directory: path.join(extension.directory, "skills"),
      scope: "extension" as const,
    })),
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
  config: Pick<GeminiSettings, "homePath"> & Partial<Pick<GeminiSettings, "launchArgs">>,
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<GeminiCustomCommand>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveGeminiConfigDir(config, environment);
  const settings = yield* readGeminiDiscoverySettings(config, environment, cwd);
  const extensions = yield* discoverGeminiExtensions(config, cwd, environment);
  const roots = [
    ...extensions.map((extension) => ({
      directory: path.join(extension.directory, "commands"),
      scope: "extension" as const,
      prefix: `${sanitizeCommandSegment(extension.name)}:`,
    })),
    {
      directory: path.join(path.dirname(configDir), ".agents", "commands"),
      scope: "user" as const,
    },
    { directory: path.join(configDir, "commands"), scope: "user" as const },
    ...(cwd && settings.workspaceTrusted
      ? [
          { directory: path.join(cwd, ".agents", "commands"), scope: "project" as const },
          { directory: path.join(cwd, ".gemini", "commands"), scope: "project" as const },
        ]
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

      const parsed = yield* Effect.try({
        try: () => parseToml(contents),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
      const definition = Option.getOrUndefined(decodeGeminiCommandDefinition(parsed));
      if (!definition) continue;

      const withoutExtension = relativePath.slice(0, -TOML_EXTENSION.length);
      const localName = withoutExtension
        .split(/[\\/]/u)
        .map(sanitizeCommandSegment)
        .filter(Boolean)
        .join(":");
      if (!localName) continue;
      const name = ("prefix" in root ? root.prefix : "") + localName;
      commandsByName.set(name, {
        name,
        prompt:
          root.scope === "extension"
            ? definition.prompt.replaceAll("${extensionPath}", () => path.dirname(root.directory))
            : definition.prompt,
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
  config: Pick<GeminiSettings, "homePath"> & Partial<Pick<GeminiSettings, "launchArgs">>,
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
  const braced = extractInjections(prompt, "@{");
  const bare = [...prompt.matchAll(/(?<![\w@/])@([a-zA-Z0-9_./-]+)/gu)]
    .filter(
      (match) =>
        !braced.some((entry) => match.index >= entry.startIndex && match.index < entry.endIndex),
    )
    .map((match) => {
      const content = match[1]!.replace(/[.]+$/u, "");
      return { content, startIndex: match.index, endIndex: match.index + content.length + 1 };
    });
  for (const injection of [...braced, ...bare].sort(
    (left, right) => right.startIndex - left.startIndex,
  )) {
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

function preserveShellInjectionForAgent(command: string): string {
  return [
    "\n<gemini-custom-command-shell-injection>",
    "Run this command with your shell tool, subject to the active approval policy, and use its output at this point:",
    command,
    "</gemini-custom-command-shell-injection>\n",
  ].join("\n");
}

class GeminiCommandExpansionError extends Schema.TaggedError<GeminiCommandExpansionError>()(
  "GeminiCommandExpansionError",
  {
    commandPath: Schema.String,
    reason: Schema.Literals(["exit", "timeout", "outputLimit", "process"]),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Gemini custom-command expansion failed (${this.reason}${this.exitCode === undefined ? "" : `, exit ${this.exitCode}`}). Check the command definition before retrying.`;
  }
}

const executeShellInjection = Effect.fn("GeminiCatalog.executeShellInjection")(function* (
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  commandPath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make("/bin/sh", ["-c", command], {
        cwd,
        env: environment,
        extendEnv: false,
        stdin: "ignore",
      }),
    );
    const [stdout, exitCode, stderr] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 1024 * 1024 }),
        child.exitCode,
        collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }),
      ],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0 || stdout.truncated)
      return yield* new GeminiCommandExpansionError({
        commandPath,
        reason: Number(exitCode) !== 0 ? "exit" : "outputLimit",
        exitCode: Number(exitCode),
        cause: { stderr: stderr.text, truncated: stderr.truncated },
      });
    return stdout.text;
  }).pipe(
    Effect.scoped,
    Effect.timeout("5 seconds"),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(new GeminiCommandExpansionError({ commandPath, reason: "timeout", cause })),
      PlatformError: (cause) =>
        Effect.fail(new GeminiCommandExpansionError({ commandPath, reason: "process", cause })),
    }),
  );
});

function escapeShellArgument(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `"${value.replaceAll('"', '\\"').replace(/([%&|<>^])/gu, "^$1")}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const COMMAND_ARGUMENT_PATTERN = /\{\{args\}\}|\$@|\$([1-9]\d*)/gu;

function substituteCommandArguments(
  prompt: string,
  args: string,
  shell: boolean,
  platform: NodeJS.Platform,
): string {
  const tokens = tokenizeCliArgs(args);
  let quote: "'" | '"' | undefined;
  let cursor = 0;
  return prompt.replace(
    COMMAND_ARGUMENT_PATTERN,
    (placeholder: string, position: string | undefined, offset: number) => {
      while (cursor < offset) {
        const char = prompt[cursor++];
        if (char === "\\" && quote !== "'") cursor++;
        else if (char === quote) quote = undefined;
        else if (!quote && (char === "'" || char === '"')) quote = char;
      }
      const escaped = cursor > offset;
      cursor = offset + placeholder.length;
      if (shell && escaped) return placeholder;
      const value = position !== undefined ? (tokens[Number(position) - 1] ?? "") : args;
      if (!shell) return value;
      const values = placeholder === "$@" ? tokens : [value];
      if (platform !== "win32" && quote === "'")
        return values.map((token) => token.replaceAll("'", `'"'"'`)).join("' '");
      if (platform !== "win32" && quote === '"')
        return values.map((token) => token.replace(/[\\"$`]/gu, "\\$&")).join('" "');
      return values.map((token) => escapeShellArgument(token, platform)).join(" ");
    },
  );
}

export const expandGeminiCustomCommand = Effect.fn("expandGeminiCustomCommand")(function* (
  config: Pick<GeminiSettings, "homePath"> &
    Partial<Pick<GeminiSettings, "sandbox" | "policyPath" | "launchArgs">>,
  cwd: string,
  input: string,
  environment: NodeJS.ProcessEnv = process.env,
  runtimePolicy?: Pick<
    ProviderAdapterV2RuntimePolicy,
    "runtimeMode" | "interactionMode" | "approvalPolicy" | "sandboxPolicy" | "maxRuntimeMode"
  >,
): Effect.fn.Return<
  { readonly text: string; readonly resources: ReadonlyArray<EffectAcpSchema.ContentBlock> },
  GeminiCommandExpansionError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(input.trim());
  if (!match) return { text: input, resources: [] };
  const commandName = match[1] ?? "";
  const args = match[2] ?? "";
  const command = (yield* discoverGeminiCustomCommands(config, cwd, environment)).find(
    (candidate) => candidate.name === commandName,
  );
  if (!command) return { text: input, resources: [] };

  const platform = yield* HostProcess.Platform;
  const trust = yield* readGeminiDiscoverySettings(config, environment, cwd);
  const launchArgs = tokenizeCliArgs(config.launchArgs);
  // Host expansion cannot enforce Gemini's sandbox or policy engine.
  const extensions = yield* discoverGeminiExtensions(config, cwd, environment);
  const canExecute =
    extensions.length === 0 &&
    trust.workspaceTrusted &&
    !trust.requiresNativeShellExecution &&
    platform !== "win32" &&
    runtimePolicy?.runtimeMode === "full-access" &&
    runtimePolicy.interactionMode !== "plan" &&
    (runtimePolicy.maxRuntimeMode === undefined ||
      runtimePolicy.maxRuntimeMode === "full-access") &&
    runtimePolicy.approvalPolicy === undefined &&
    runtimePolicy.sandboxPolicy === undefined &&
    !config.sandbox &&
    !config.policyPath?.trim() &&
    !environment.GEMINI_SANDBOX &&
    !environment.SANDBOX &&
    !launchArgs.some((arg) =>
      ["-s", "--sandbox", "--policy", "--admin-policy", "--approval-mode", "--yolo", "-y"].some(
        (flag) => arg === flag || arg.startsWith(`${flag}=`),
      ),
    );
  let cursor = 0;
  let expanded = "";
  // Parse the template before substitution so arguments and stdout cannot introduce executable blocks.
  for (const injection of extractInjections(command.prompt, "!{")) {
    expanded += substituteCommandArguments(
      command.prompt.slice(cursor, injection.startIndex),
      args,
      false,
      platform,
    );
    const shellCommand = substituteCommandArguments(injection.content, args, true, platform);
    const hasArguments = /\{\{args\}\}|\$@|\$[1-9]\d*/u.test(injection.content);
    const hasNestedShellSyntax = /`|\$\(|<</u.test(injection.content);
    const output =
      canExecute && !(hasArguments && hasNestedShellSyntax)
        ? yield* executeShellInjection(shellCommand, cwd, environment, command.path)
        : undefined;
    expanded += output ?? preserveShellInjectionForAgent(shellCommand);
    cursor = injection.endIndex;
  }
  expanded += substituteCommandArguments(command.prompt.slice(cursor), args, false, platform);
  if (!/\{\{args\}\}|\$@|\$[1-9]\d*/u.test(command.prompt) && args)
    expanded += `\n\n${input.trim()}`;
  return yield* linkGeminiFiles(expanded, cwd);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export const expandGeminiSkillMentions = Effect.fn("expandGeminiSkillMentions")(function* (
  config: Pick<GeminiSettings, "homePath"> & Partial<Pick<GeminiSettings, "launchArgs">>,
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
