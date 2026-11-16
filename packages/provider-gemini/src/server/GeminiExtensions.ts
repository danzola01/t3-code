import type { GeminiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { readGeminiDiscoverySettings, resolveGeminiConfigDir } from "./GeminiHome.ts";

const Extension = Schema.Struct({ name: Schema.String });
const Installation = Schema.Struct({ type: Schema.String, source: Schema.String });
const Enablement = Schema.Record(
  Schema.String,
  Schema.Struct({ overrides: Schema.Array(Schema.String) }),
);

const readJson = Effect.fn("GeminiExtensions.readJson")(function* <A>(
  file: string,
  schema: Schema.Codec<A>,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.map((contents) =>
      Option.getOrUndefined(Schema.decodeOption(fromLenientJson(schema))(contents)),
    ),
    Effect.orElseSucceed(() => undefined),
  );
});

function normalizedPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  return normalized ? `/${normalized}/` : "/";
}

function ruleMatches(rule: string, cwd: string): boolean {
  const recursive = rule.endsWith("*");
  const pattern = normalizedPath(recursive ? rule.slice(0, -1) : rule) + (recursive ? "*" : "");
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "u").test(normalizedPath(cwd));
}

export const discoverGeminiExtensions = Effect.fn("discoverGeminiExtensions")(function* (
  config: Pick<GeminiSettings, "homePath"> & Partial<Pick<GeminiSettings, "launchArgs">>,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* readGeminiDiscoverySettings(config, environment, cwd);
  if (!cwd || !settings.workspaceTrusted) return [];
  const root = path.join(yield* resolveGeminiConfigDir(config, environment), "extensions");
  const enablement = yield* readJson(path.join(root, "extension-enablement.json"), Enablement);
  const args = tokenizeCliArgs(config.launchArgs);
  const selected: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("--extensions="))
      selected.push(...arg.slice("--extensions=".length).split(","));
    else if (arg === "--extensions" || arg === "-e") {
      while (args[index + 1] && !args[index + 1]!.startsWith("-"))
        selected.push(...args[++index]!.split(","));
    }
  }
  const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
  const extensions: Array<{ readonly name: string; readonly directory: string }> = [];
  for (const entry of entries.sort()) {
    const installed = path.join(root, entry);
    const metadata = yield* readJson(
      path.join(installed, ".gemini-extension-install.json"),
      Installation,
    );
    const directory =
      metadata?.type === "link" ? path.resolve(installed, metadata.source) : installed;
    const manifest = yield* readJson(path.join(directory, "gemini-extension.json"), Extension);
    if (!manifest?.name.trim()) continue;
    let enabled = true;
    for (const rule of enablement?.[manifest.name]?.overrides ?? []) {
      if (ruleMatches(rule.startsWith("!") ? rule.slice(1) : rule, cwd))
        enabled = !rule.startsWith("!");
    }
    if (selected.length)
      enabled = selected.some((name) => name.toLowerCase() === manifest.name.toLowerCase());
    if (!enabled) continue;
    if (settings.allowedExtensions.length) {
      if (
        !metadata ||
        !settings.allowedExtensions.some((pattern) => {
          try {
            return new RegExp(pattern).test(metadata.source);
          } catch {
            return false;
          }
        })
      )
        continue;
    } else if (
      settings.blockGitExtensions &&
      (metadata?.type === "git" || metadata?.type === "github-release")
    )
      continue;
    extensions.push({ name: manifest.name, directory });
  }
  return extensions;
});
