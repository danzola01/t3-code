// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { GeminiSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { makeGeminiTextGeneration } from "./GeminiTextGeneration.ts";

const decodeGeminiSettings = Schema.decodeSync(GeminiSettings);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../../apps/server/scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeAcpGeminiWrapper(directory: string, environment: Record<string, string>) {
  const binaryPath = NodePath.join(directory, "gemini");
  NodeFS.writeFileSync(
    binaryPath,
    [
      "#!/bin/sh",
      ...Object.entries(environment).map(
        ([key, value]) => `export ${key}=${shellSingleQuote(value)}`,
      ),
      'if [ "$1" != "--acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

const testLayer = NodeServices.layer;

it.layer(testLayer)("GeminiTextGeneration", (it) => {
  it.effect("uses ACP for structured text-generation jobs, including fenced replies", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gemini-text-acp-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const reply = {
        subject: "Add Gemini provider",
        body: "Wire Gemini CLI through ACP.",
      };
      const json = encodeUnknownJson(reply);
      for (const response of [json, `Here is the commit message:\n\`\`\`json\n${json}\n\`\`\``]) {
        const binaryPath = makeAcpGeminiWrapper(directory, {
          T3_ACP_PROMPT_RESPONSE_TEXT: response,
        });
        const textGeneration = yield* makeGeminiTextGeneration(
          decodeGeminiSettings({ binaryPath, authMethod: "oauth-personal", homePath: directory }),
        );

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: directory,
          branch: "feature/gemini",
          stagedSummary: "M packages/provider-gemini/src/server/GeminiDriver.ts",
          stagedPatch: "diff --git a/GeminiDriver.ts b/GeminiDriver.ts",
          modelSelection: createModelSelection(ProviderInstanceId.make("gemini"), "composer-2"),
        });

        expect(generated).toEqual(reply);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("keeps invalid replies as operation-specific text-generation errors", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gemini-text-invalid-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      for (const response of ["not JSON", encodeUnknownJson({ subject: 42, body: "" })]) {
        const binaryPath = makeAcpGeminiWrapper(directory, {
          T3_ACP_PROMPT_RESPONSE_TEXT: response,
        });
        const textGeneration = yield* makeGeminiTextGeneration(
          decodeGeminiSettings({ binaryPath, authMethod: "oauth-personal", homePath: directory }),
        );
        const result = yield* textGeneration
          .generateCommitMessage({
            cwd: directory,
            branch: "feature/gemini",
            stagedSummary: "M GeminiDriver.ts",
            stagedPatch: "diff --git a/GeminiDriver.ts b/GeminiDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("gemini"), "composer-2"),
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "TextGenerationError",
            operation: "generateCommitMessage",
            detail: "Gemini Agent returned invalid structured output.",
          },
        });
      }
    }).pipe(Effect.scoped),
  );
});
