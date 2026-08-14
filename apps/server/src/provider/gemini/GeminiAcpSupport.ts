import { type GeminiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { readGeminiSelectedAuthMethod } from "./GeminiHome.ts";

const GEMINI_AUTH_METHOD_OAUTH = "oauth-personal";
const GEMINI_AUTH_METHOD_API_KEY = "gemini-api-key";
const GEMINI_AUTH_METHOD_VERTEX_AI = "vertex-ai";
const GEMINI_AUTH_METHOD_GATEWAY = "gateway";
const GEMINI_DRIVER_KIND = ProviderDriverKind.make("gemini");

type GeminiAcpRuntimeGeminiSettings = Pick<
  GeminiSettings,
  "authMethod" | "binaryPath" | "homePath" | "launchArgs"
>;
type GeminiAcpSpawnSettings = Pick<GeminiSettings, "binaryPath" | "launchArgs">;

interface GeminiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly geminiSettings: GeminiAcpRuntimeGeminiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildGeminiAcpSpawnInput(
  geminiSettings: GeminiAcpSpawnSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: geminiSettings?.binaryPath || "gemini",
    args: [...tokenizeCliArgs(geminiSettings?.launchArgs), "--acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export function resolveGeminiAuthMethodId(
  settings: Pick<GeminiSettings, "authMethod"> | null | undefined,
  environment: NodeJS.ProcessEnv | undefined,
  initializeResult: EffectAcpSchema.InitializeResponse,
  persistedAuthMethod?: string,
): string {
  const configured = settings?.authMethod.trim();
  if (configured) return configured;

  const available = new Set(initializeResult.authMethods?.map((method) => method.id) ?? []);
  const candidates = [
    ...(persistedAuthMethod ? [persistedAuthMethod] : []),
    ...(environment?.GOOGLE_GENAI_USE_GCA === "true" ? [GEMINI_AUTH_METHOD_OAUTH] : []),
    ...(environment?.GOOGLE_GENAI_USE_VERTEXAI === "true" ? [GEMINI_AUTH_METHOD_VERTEX_AI] : []),
    ...(environment?.GOOGLE_GEMINI_BASE_URL?.trim() ? [GEMINI_AUTH_METHOD_GATEWAY] : []),
    ...(environment?.GEMINI_API_KEY?.trim() ? [GEMINI_AUTH_METHOD_API_KEY] : []),
    GEMINI_AUTH_METHOD_OAUTH,
    GEMINI_AUTH_METHOD_API_KEY,
    GEMINI_AUTH_METHOD_VERTEX_AI,
    GEMINI_AUTH_METHOD_GATEWAY,
  ];
  return candidates.find((methodId) => available.has(methodId)) ?? GEMINI_AUTH_METHOD_OAUTH;
}

export const makeGeminiAcpRuntime = (
  input: GeminiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const persistedAuthMethod = yield* readGeminiSelectedAuthMethod(
      input.geminiSettings ?? { homePath: "" },
      input.environment,
    );
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGeminiAcpSpawnInput(input.geminiSettings, input.cwd, input.environment),
        authMethodId: (initializeResult) =>
          resolveGeminiAuthMethodId(
            input.geminiSettings,
            input.environment,
            initializeResult,
            persistedAuthMethod,
          ),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return runtime;
  });

export function resolveGeminiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "auto";
  return normalizeModelSlug(base, GEMINI_DRIVER_KIND) ?? "auto";
}

export function currentGeminiModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyGeminiAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
