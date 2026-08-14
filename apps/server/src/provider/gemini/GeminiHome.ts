import * as NodeOS from "node:os";

import type { GeminiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

const GeminiAuthSettings = Schema.Struct({
  security: Schema.optional(
    Schema.Struct({
      auth: Schema.optional(
        Schema.Struct({
          selectedType: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeGeminiAuthSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(GeminiAuthSettings),
);

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
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveGeminiConfigDir(config, environment);
  const contents = yield* fileSystem
    .readFileString(path.join(configDir, "settings.json"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return undefined;
  const settings = Option.getOrUndefined(decodeGeminiAuthSettings(contents));
  return settings?.security?.auth?.selectedType?.trim() || undefined;
});

export const makeGeminiEnvironment = Effect.fn("makeGeminiEnvironment")(function* (
  config: Pick<GeminiSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const configuredHome = config.homePath.trim();
  if (configuredHome.length === 0) return resolvedBaseEnv;

  const path = yield* Path.Path;
  return {
    ...resolvedBaseEnv,
    GEMINI_CLI_HOME: path.resolve(expandHomePath(configuredHome)),
  };
});
