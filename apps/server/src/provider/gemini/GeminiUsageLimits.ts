import type { GeminiSettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { makeUnavailableUsageLimits, makeUsageLimits } from "../providerUsageLimits.ts";
import { resolveGeminiAuthMethodId } from "./GeminiAcpSupport.ts";
import { readGeminiSelectedAuthMethod, resolveGeminiConfigDir } from "./GeminiHome.ts";

// Gemini CLI's public installed-app OAuth client. Keep this boundary aligned with
// https://github.com/google-gemini/gemini-cli/blob/v0.59.0/packages/core/src/code_assist/oauth2.ts
const CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal";
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const Credentials = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expiry_date: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
});
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(Credentials));
const TokenResponse = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number });
const AccountResponse = Schema.Struct({ id: Schema.String, email: Schema.optional(Schema.String) });
const Tier = Schema.Struct({ name: Schema.optional(Schema.String) });
const CodeAssistResponse = Schema.Struct({
  cloudaicompanionProject: Schema.optional(Schema.NullOr(Schema.String)),
  currentTier: Schema.optional(Schema.NullOr(Tier)),
  paidTier: Schema.optional(Schema.NullOr(Tier)),
});
const QuotaResponse = Schema.Struct({
  buckets: Schema.optional(
    Schema.Array(
      Schema.Struct({
        modelId: Schema.optional(Schema.String),
        tokenType: Schema.optional(Schema.String),
        remainingFraction: Schema.optional(Schema.Number),
        resetTime: Schema.optional(Schema.String),
      }),
    ),
  ),
});

/** Keep distinct model/token quotas separate; duplicate buckets use the tightest limit. */
export function geminiQuotaToLimits(response: typeof QuotaResponse.Type, checkedAt: string) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const bucket of response.buckets ?? []) {
    const model = bucket.modelId?.trim();
    const remaining = bucket.remainingFraction;
    if (!model || remaining === undefined || !Number.isFinite(remaining)) continue;
    const type = bucket.tokenType?.trim();
    const id = encodeIdentity([model, type ?? ""]);
    const usedPercent = 100 * (1 - Math.max(0, Math.min(1, remaining)));
    const previous = windows.get(id);
    if (previous && previous.usedPercent >= usedPercent) continue;
    const reset = bucket.resetTime ? DateTime.make(bucket.resetTime) : Option.none();
    windows.set(id, {
      id,
      kind: "other",
      label: type ? `${model} · ${type}` : model,
      usedPercent,
      ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
    });
  }
  return makeUsageLimits({ checkedAt, windows: windows.values() });
}

/** Reads existing OAuth credentials without writing to Gemini home or falling back to sign-in. */
export const makeGeminiUsageReader = Effect.fn("makeGeminiUsageReader")(function* (
  settings: GeminiSettings,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const client = yield* HttpClient.HttpClient;
  let refreshed: { credential: string; token: string; expiresAt: number } | undefined;
  let lastAccount:
    | {
        credential: string;
        project: string;
        accountId: string;
        email: string | undefined;
        plan: string | undefined;
      }
    | undefined;

  const read = Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const unavailable = (message: string) => ({
      email: undefined,
      plan: undefined,
      usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported", message }),
    });
    const persisted = yield* readGeminiSelectedAuthMethod(settings, environment);
    const method = resolveGeminiAuthMethodId(
      settings,
      environment,
      {
        protocolVersion: 1,
        authMethods: ["oauth-personal", "gemini-api-key", "vertex-ai", "gateway"].map((id) => ({
          id,
          name: id,
        })),
      },
      persisted,
    );
    if (method !== "oauth-personal") {
      return unavailable("Gemini quota reporting requires Google sign-in / Gemini Code Assist.");
    }
    // Alternate deployments and encrypted/ADC credentials belong to the CLI.
    if (
      environment.CODE_ASSIST_ENDPOINT?.trim() ||
      environment.CODE_ASSIST_API_VERSION?.trim() ||
      environment.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
      environment.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE === "true"
    ) {
      return unavailable(
        "Gemini quota reporting does not support this credential or endpoint setup.",
      );
    }
    const configDir = yield* resolveGeminiConfigDir(settings, environment);
    const contents = yield* fs.readFileString(path.join(configDir, "oauth_creds.json")).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
    );
    const credentials = yield* decodeCredentials(contents);
    const override = environment.GOOGLE_GENAI_USE_GCA
      ? environment.GOOGLE_CLOUD_ACCESS_TOKEN?.trim()
      : undefined;
    if (
      !override &&
      (credentials.type || (!credentials.access_token && !credentials.refresh_token))
    ) {
      return unavailable("No supported Gemini Google login found. Sign in with Gemini CLI first.");
    }
    const credential = override || credentials.refresh_token || credentials.access_token!;
    // A known credential identity makes a failed read unable to inherit another login's bars.
    const configuredProject =
      environment.GOOGLE_CLOUD_PROJECT?.trim() || environment.GOOGLE_CLOUD_PROJECT_ID?.trim();
    const previousAccount =
      lastAccount?.credential === credential && lastAccount.project === (configuredProject ?? "")
        ? lastAccount
        : undefined;
    let accountId =
      previousAccount?.accountId ??
      Hex.encode(
        yield* crypto.digest(
          "SHA-256",
          new TextEncoder().encode(encodeIdentity([credential, configuredProject ?? ""])),
        ),
      );
    const probeFailed = () => ({
      email: previousAccount?.email,
      plan: previousAccount?.plan,
      usageLimits: {
        ...makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Gemini could not read quota. Check the CLI login and Google Cloud project.",
        }),
        accountId,
      },
    });
    return yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const refresh = Effect.fn(function* () {
        if (!credentials.refresh_token || override) return undefined;
        const response = yield* client.execute(
          HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: CLIENT_ID,
              client_secret: CLIENT_SECRET,
              refresh_token: credentials.refresh_token,
              grant_type: "refresh_token",
            }),
          ),
        );
        const token = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(
          yield* HttpClientResponse.filterStatusOk(response),
        );
        refreshed = {
          credential,
          token: token.access_token,
          expiresAt: now + token.expires_in * 1000,
        };
        return token.access_token;
      });
      let accessToken =
        override ||
        (refreshed?.credential === credential && refreshed.expiresAt > now + 60_000
          ? refreshed.token
          : credentials.expiry_date === undefined || credentials.expiry_date > now + 60_000
            ? credentials.access_token
            : undefined);
      if (!accessToken) accessToken = yield* refresh();
      if (!accessToken) return probeFailed();
      const execute = Effect.fn(function* (request: HttpClientRequest.HttpClientRequest) {
        let response = yield* client.execute(
          request.pipe(HttpClientRequest.bearerToken(accessToken!)),
        );
        if (response.status === 401 && credentials.refresh_token && !override) {
          accessToken = yield* refresh();
          if (accessToken) {
            response = yield* client.execute(
              request.pipe(HttpClientRequest.bearerToken(accessToken)),
            );
          }
        }
        return yield* HttpClientResponse.filterStatusOk(response);
      });
      const account = yield* HttpClientResponse.schemaBodyJson(AccountResponse)(
        yield* execute(HttpClientRequest.get("https://www.googleapis.com/oauth2/v2/userinfo")),
      );
      const info = yield* HttpClientResponse.schemaBodyJson(CodeAssistResponse)(
        yield* execute(
          HttpClientRequest.post(`${CODE_ASSIST_URL}:loadCodeAssist`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              ...(configuredProject ? { cloudaicompanionProject: configuredProject } : {}),
              metadata: {
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
                ...(configuredProject ? { duetProject: configuredProject } : {}),
              },
            }),
          ),
        ),
      );
      const project = configuredProject || info.cloudaicompanionProject?.trim();
      const email = account.email?.trim() || undefined;
      const plan = info.paidTier?.name?.trim() || info.currentTier?.name?.trim() || undefined;
      if (!project) {
        return {
          ...probeFailed(),
          email,
          plan,
          usageLimits: {
            ...probeFailed().usageLimits,
            unavailable: {
              reason: "probeFailed" as const,
              message: "Set GOOGLE_CLOUD_PROJECT on this Gemini instance to read company quota.",
            },
          },
        };
      }
      accountId = Hex.encode(
        yield* crypto.digest(
          "SHA-256",
          new TextEncoder().encode(encodeIdentity([account.id, project])),
        ),
      );
      lastAccount = { credential, project: configuredProject ?? "", accountId, email, plan };
      const quota = yield* HttpClientResponse.schemaBodyJson(QuotaResponse)(
        yield* execute(
          HttpClientRequest.post(`${CODE_ASSIST_URL}:retrieveUserQuota`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ project }),
          ),
        ),
      );
      return { email, plan, usageLimits: { ...geminiQuotaToLimits(quota, checkedAt), accountId } };
    }).pipe(Effect.timeout("15 seconds"), Effect.orElseSucceed(probeFailed));
  }).pipe(
    Effect.withSpan("GeminiUsageReader.read"),
    Effect.catch(() =>
      DateTime.now.pipe(
        Effect.map((now) => ({
          email: undefined,
          plan: undefined,
          usageLimits: makeUnavailableUsageLimits({
            checkedAt: DateTime.formatIso(now),
            reason: "probeFailed",
            message: "Gemini could not read its Google login or quota.",
          }),
        })),
      ),
    ),
  );
  return { read };
});
