import * as NodeOS from "node:os";

import type { GeminiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import { expandHomePath } from "../../pathExpansion.ts";

const GeminiDiscoverySettings = Schema.Struct({
  security: Schema.optional(
    Schema.Struct({
      folderTrust: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
      auth: Schema.optional(
        Schema.Struct({
          selectedType: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  skills: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      disabled: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
const decodeGeminiSettings = Schema.decodeUnknownOption(fromLenientJson(GeminiDiscoverySettings));

export const resolveGeminiConfigDir = Effect.fn("resolveGeminiConfigDir")(function* (
  config: Pick<GeminiSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configured = config.homePath.trim() || environment.GEMINI_CLI_HOME?.trim() || "";
  const homeRoot = configured ? path.resolve(expandHomePath(configured)) : NodeOS.homedir();
  return path.join(homeRoot, ".gemini");
});

export const readGeminiSelectedAuthMethod = Effect.fn("readGeminiSelectedAuthMethod")(function* (
  config: Pick<GeminiSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const settings = yield* readGeminiDiscoverySettings(config, environment, cwd);
  return settings.selectedAuthMethod;
});

// Only mirror the settings needed for discovery. Gemini remains responsible for
// workspace trust, remote administrative policy, and execution permissions.
export const readGeminiDiscoverySettings = Effect.fn("readGeminiDiscoverySettings")(function* (
  config: Pick<GeminiSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveGeminiConfigDir(config, environment);
  const platform = yield* HostProcessPlatform;
  const systemPath =
    environment.GEMINI_CLI_SYSTEM_SETTINGS_PATH ||
    (platform === "darwin"
      ? "/Library/Application Support/GeminiCli/settings.json"
      : platform === "win32"
        ? "C:\\ProgramData\\gemini-cli\\settings.json"
        : "/etc/gemini-cli/settings.json");
  const files = [
    environment.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ||
      path.join(path.dirname(systemPath), "system-defaults.json"),
    path.join(configDir, "settings.json"),
    systemPath,
  ];
  const readSettings = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((contents) => Option.getOrUndefined(decodeGeminiSettings(contents))),
      Effect.orElseSucceed(() => undefined),
    );
  const layers = yield* Effect.forEach(files, readSettings);
  const folderTrustEnabled = layers.reduce(
    (enabled, settings) => settings?.security?.folderTrust?.enabled ?? enabled,
    true,
  );
  const workspaceTrusted =
    cwd !== undefined &&
    (yield* isGeminiWorkspaceTrusted(configDir, cwd, environment, folderTrustEnabled));
  if (cwd && workspaceTrusted && path.resolve(cwd) !== path.dirname(configDir)) {
    layers.splice(2, 0, yield* readSettings(path.join(cwd, ".gemini", "settings.json")));
  }
  let selectedAuthMethod: string | undefined;
  let skillsEnabled = true;
  const disabledSkills = new Set<string>();
  for (const settings of layers) {
    selectedAuthMethod = settings?.security?.auth?.selectedType?.trim() || selectedAuthMethod;
    skillsEnabled = settings?.skills?.enabled ?? skillsEnabled;
    for (const name of settings?.skills?.disabled ?? []) disabledSkills.add(name);
  }
  return { selectedAuthMethod, skillsEnabled, disabledSkills, workspaceTrusted };
});

const decodeTrustedFolders = Schema.decodeUnknownOption(
  fromLenientJson(
    Schema.Record(Schema.String, Schema.Literals(["TRUST_FOLDER", "TRUST_PARENT", "DO_NOT_TRUST"])),
  ),
);

const isGeminiWorkspaceTrusted = Effect.fn("isGeminiWorkspaceTrusted")(function* (
  configDir: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  enabled: boolean,
) {
  if (
    environment.GEMINI_RESTRICTED_MODE === "true" ||
    environment.GEMINI_CLI_TRUST_WORKSPACE === "false"
  )
    return false;
  if (environment.GEMINI_CLI_TRUST_WORKSPACE === "true" || !enabled) return true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fs
    .readFileString(
      environment.GEMINI_CLI_TRUSTED_FOLDERS_PATH || path.join(configDir, "trustedFolders.json"),
    )
    .pipe(Effect.orElseSucceed(() => "{}"));
  const rules = Option.getOrUndefined(decodeTrustedFolders(contents));
  if (!rules) return false;
  const location = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  let matchLength = -1;
  let trusted = false;
  for (const [rule, level] of Object.entries(rules)) {
    const effective = level === "TRUST_PARENT" ? path.dirname(rule) : rule;
    const canonical = yield* fs
      .realPath(effective)
      .pipe(Effect.orElseSucceed(() => path.resolve(effective)));
    const relative = path.relative(canonical, location);
    if (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      rule.length > matchLength
    ) {
      matchLength = rule.length;
      trusted = level !== "DO_NOT_TRUST";
    }
  }
  return trusted;
});

export const makeGeminiEnvironment = Effect.fn("makeGeminiEnvironment")(function* (
  config: Pick<GeminiSettings, "homePath"> & Partial<Pick<GeminiSettings, "launchArgs">>,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = tokenizeCliArgs(config.launchArgs).includes("--skip-trust")
    ? { ...(baseEnv ?? process.env), GEMINI_CLI_TRUST_WORKSPACE: "true" }
    : (baseEnv ?? process.env);
  const configuredHome = config.homePath.trim();
  if (configuredHome.length === 0) return resolvedBaseEnv;

  const path = yield* Path.Path;
  return {
    ...resolvedBaseEnv,
    GEMINI_CLI_HOME: path.resolve(expandHomePath(configuredHome)),
  };
});
