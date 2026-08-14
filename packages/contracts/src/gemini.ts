import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";
import { makeBinaryPathSetting, makeProviderSettingsSchema } from "./settings.ts";

/**
 * Instance-local Gemini CLI configuration.
 *
 * This intentionally lives outside the legacy `settings.providers` object.
 * Gemini instances are registered through the open `providerInstances` list,
 * which keeps the fork-specific provider from widening the core settings
 * schema and makes upstream settings migrations less likely to conflict.
 */
export const GeminiSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("gemini").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Gemini CLI binary used by this instance.",
        providerSettingsForm: { placeholder: "gemini", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "GEMINI_CLI_HOME path",
        description: "Custom Gemini CLI home used to isolate settings, skills, and credentials.",
        providerSettingsForm: {
          placeholder: "~/.gemini-t3",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    authMethod: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "ACP authentication method",
        description:
          "Optional Gemini ACP method id: oauth-personal, gemini-api-key, vertex-ai, or gateway. When empty, T3 selects a compatible advertised method.",
        providerSettingsForm: {
          placeholder: "oauth-personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description:
          "Additional arguments passed to Gemini CLI before --acp (for example --skip-trust or --extensions name).",
        providerSettingsForm: {
          placeholder: "e.g. --skip-trust",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "authMethod", "launchArgs"],
  },
);
export type GeminiSettings = typeof GeminiSettings.Type;
