import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  applyGeminiAcpModelSelection,
  buildGeminiAcpSpawnInput,
  resolveGeminiAcpBaseModelId,
  resolveGeminiAuthMethodId,
} from "./GeminiAcpSupport.ts";

const initializeResult = (ids: ReadonlyArray<string>): EffectAcpSchema.InitializeResponse => ({
  protocolVersion: 1,
  authMethods: ids.map((id) => ({ id, name: id })),
});

describe("GeminiAcpSupport", () => {
  it("builds an isolated ACP spawn and preserves quote-aware launch arguments", () => {
    expect(
      buildGeminiAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/gemini",
          launchArgs: '--extensions "company tools" --skip-trust',
        },
        "/tmp/project",
        { GEMINI_CLI_HOME: "/tmp/gemini-home" },
      ),
    ).toEqual({
      command: "/usr/local/bin/gemini",
      args: ["--extensions", "company tools", "--skip-trust", "--acp"],
      cwd: "/tmp/project",
      env: { GEMINI_CLI_HOME: "/tmp/gemini-home" },
    });
  });

  it("prefers explicit and persisted auth before Gemini's environment conventions", () => {
    const initialized = initializeResult([
      "oauth-personal",
      "gemini-api-key",
      "vertex-ai",
      "gateway",
    ]);
    expect(resolveGeminiAuthMethodId({ authMethod: "gateway" }, {}, initialized)).toBe("gateway");
    expect(resolveGeminiAuthMethodId({ authMethod: "" }, {}, initialized, "vertex-ai")).toBe(
      "vertex-ai",
    );
    expect(
      resolveGeminiAuthMethodId({ authMethod: "" }, { GEMINI_API_KEY: "key" }, initialized),
    ).toBe("gemini-api-key");
    expect(
      resolveGeminiAuthMethodId(
        { authMethod: "" },
        { GOOGLE_GENAI_USE_VERTEXAI: "true" },
        initialized,
      ),
    ).toBe("vertex-ai");
    expect(
      resolveGeminiAuthMethodId(
        { authMethod: "" },
        { GOOGLE_GEMINI_BASE_URL: "https://gateway.example.com" },
        initialized,
      ),
    ).toBe("gateway");
    expect(resolveGeminiAuthMethodId({ authMethod: "" }, {}, initialized)).toBe("oauth-personal");
  });

  it("normalizes empty model ids to Gemini's auto model", () => {
    expect(resolveGeminiAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveGeminiAcpBaseModelId("   ")).toBe("auto");
    expect(resolveGeminiAcpBaseModelId(" gemini-2.5-pro ")).toBe("gemini-2.5-pro");
  });

  it.effect("switches models through the negotiated protocol only when requested", () =>
    Effect.gen(function* () {
      for (const protocolVersion of [1, 2]) {
        const calls: string[] = [];
        const runtime = {
          setSessionModel: (modelId: string) =>
            protocolVersion === 1
              ? Effect.sync(() => {
                  calls.push(modelId);
                  return {};
                })
              : Effect.die("ACP v2 must use session configuration for model selection"),
          setModel: (modelId: string) =>
            protocolVersion === 2
              ? Effect.sync(() => {
                  calls.push(modelId);
                })
              : Effect.die("ACP v1 must use session/set_model"),
        };
        const input = {
          runtime,
          startResult: {
            sessionId: "session",
            modelConfigId: undefined,
            initializeResult: { protocolVersion },
            sessionSetupResult: {
              sessionId: "session",
              models: { currentModelId: " auto ", availableModels: [] },
            },
          },
          mapError: (cause: EffectAcpErrors.AcpError) => cause.message,
        };
        for (const requestedModelId of [undefined, "auto", "gemini-2.5-pro"]) {
          expect(yield* applyGeminiAcpModelSelection({ ...input, requestedModelId })).toBe(
            requestedModelId ?? "auto",
          );
        }
        expect(calls).toEqual(["gemini-2.5-pro"]);
      }
    }),
  );
});
