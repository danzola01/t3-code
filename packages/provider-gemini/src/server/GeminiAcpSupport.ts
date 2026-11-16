import { type GeminiSettings, ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { geminiSessionModeForPolicy } from "./GeminiPermissions.ts";
import { readGeminiSelectedAuthMethod } from "./GeminiHome.ts";

const GEMINI_AUTH_METHOD_OAUTH = "oauth-personal";
const GEMINI_AUTH_METHOD_API_KEY = "gemini-api-key";
const GEMINI_AUTH_METHOD_VERTEX_AI = "vertex-ai";
const GEMINI_AUTH_METHOD_GATEWAY = "gateway";
const GEMINI_DRIVER_KIND = ProviderDriverKind.make("gemini");

type GeminiAcpRuntimeGeminiSettings = Pick<
  GeminiSettings,
  "authMethod" | "binaryPath" | "homePath" | "launchArgs" | "sandbox" | "skipTrust" | "policyPath"
>;
type GeminiAcpSpawnSettings = Pick<GeminiSettings, "binaryPath" | "launchArgs"> &
  Partial<Pick<GeminiSettings, "sandbox" | "skipTrust" | "policyPath">>;

interface GeminiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly geminiSettings: GeminiAcpRuntimeGeminiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimePolicy?: Pick<ProviderAdapterV2RuntimePolicy, "interactionMode"> &
    Partial<Pick<ProviderAdapterV2RuntimePolicy, "runtimeMode" | "maxRuntimeMode">>;
}

export function buildGeminiAcpSpawnInput(
  geminiSettings: GeminiAcpSpawnSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimePolicy?: Pick<ProviderAdapterV2RuntimePolicy, "interactionMode"> &
    Partial<Pick<ProviderAdapterV2RuntimePolicy, "runtimeMode" | "maxRuntimeMode">>,
): AcpSessionRuntime.AcpSpawnInput {
  let args = [...tokenizeCliArgs(geminiSettings?.launchArgs)];
  const hasFlag = (...names: string[]) =>
    args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
  if (geminiSettings?.sandbox && !hasFlag("--sandbox", "-s")) args.push("--sandbox");
  if (geminiSettings?.skipTrust && !hasFlag("--skip-trust")) args.push("--skip-trust");
  if (geminiSettings?.policyPath?.trim() && !hasFlag("--policy"))
    args.push("--policy", geminiSettings.policyPath.trim());
  const approvalMode =
    runtimePolicy?.interactionMode === "plan"
      ? "plan"
      : runtimePolicy?.runtimeMode !== undefined
        ? geminiSessionModeForPolicy({ ...runtimePolicy, runtimeMode: runtimePolicy.runtimeMode })
        : undefined;
  if (approvalMode !== undefined) {
    const restricted =
      runtimePolicy?.interactionMode === "plan" ||
      runtimePolicy?.runtimeMode !== "full-access" ||
      (runtimePolicy.maxRuntimeMode !== undefined &&
        runtimePolicy.maxRuntimeMode !== "full-access");
    const normalized: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "--approval-mode") {
        index++;
        continue;
      }
      if (
        arg.startsWith("--approval-mode=") ||
        ["--yolo", "-y"].some((flag) => arg === flag || arg.startsWith(`${flag}=`))
      )
        continue;
      if (restricted && (arg === "--allowed-tools" || arg.startsWith("--allowed-tools="))) {
        if (arg === "--allowed-tools")
          while (args[index + 1] && !args[index + 1]!.startsWith("-")) index++;
        continue;
      }
      normalized.push(arg);
    }
    args = normalized;
    args.push("--approval-mode", approvalMode === "autoEdit" ? "auto_edit" : approvalMode);
  }
  if (!hasFlag("--acp", "--experimental-acp")) args.push("--acp");
  return {
    command: geminiSettings?.binaryPath || "gemini",
    args,
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

export const makeGeminiAcpRuntime = Effect.fn("makeGeminiAcpRuntime")(function* (
  input: GeminiAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const persistedAuthMethod = yield* readGeminiSelectedAuthMethod(
    input.geminiSettings ?? { homePath: "" },
    input.environment,
    input.cwd,
  );
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      authenticateEagerly: true,
      cancelBehavior: "wait-for-prompt",
      retainInitialToolCallContent: true,
      spawn: buildGeminiAcpSpawnInput(
        input.geminiSettings,
        input.cwd,
        input.environment,
        input.runtimePolicy,
      ),
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

export function applyGeminiAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setSessionModel" | "setModel"
  >;
  readonly startResult: AcpSessionRuntime.AcpSessionRuntimeStartResult;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const currentModelId =
    input.startResult.sessionSetupResult.models?.currentModelId?.trim() || undefined;
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(currentModelId);
  }
  const switchModel =
    input.startResult.initializeResult.protocolVersion === 1
      ? input.runtime.setSessionModel(input.requestedModelId)
      : input.runtime.setModel(input.requestedModelId);
  return switchModel.pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
