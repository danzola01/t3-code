import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { GeminiSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import { resolveUsageLimitsAfterProbe } from "../providerUsageLimits.ts";
import { geminiQuotaToLimits, makeGeminiUsageReader } from "./GeminiUsageLimits.ts";

const settings = Schema.decodeSync(GeminiSettings);
const checkedAt = "2026-10-08T12:00:00.000Z";
const Json = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const encodeJson = Schema.encodeSync(Json);
const decodeJson = Schema.decodeSync(Json);
const login = (credentials: unknown = { access_token: "access", refresh_token: "refresh" }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(home, ".gemini"));
    yield* fs.writeFileString(
      path.join(home, ".gemini", "oauth_creds.json"),
      encodeJson(credentials),
    );
    return { home, config: settings({ homePath: home, authMethod: "oauth-personal" }) };
  });

describe("Gemini quota mapping", () => {
  it("reports genuine zero, keeps quotas separate, and uses the tightest duplicate", () => {
    const limits = geminiQuotaToLimits(
      {
        buckets: [
          { modelId: "gemini-pro", remainingFraction: 0, resetTime: "2026-10-09T00:00:00Z" },
          { modelId: "gemini-flash", remainingFraction: 1 },
          { modelId: "gemini-pro", remainingFraction: 0.5 },
          { modelId: "gemini-pro", tokenType: "tokens", remainingFraction: 0.25 },
          { modelId: "missing" },
          { modelId: "invalid", remainingFraction: Number.NaN },
        ],
      },
      checkedAt,
    );
    assert.equal(limits.windows.length, 3);
    assert.equal(limits.windows.find((w) => w.label === "gemini-flash")?.usedPercent, 0);
    assert.deepInclude(
      limits.windows.find((w) => w.label === "gemini-pro"),
      {
        usedPercent: 100,
        resetsAt: "2026-10-09T00:00:00.000Z",
        kind: "other",
      },
    );
    assert.equal(limits.windows.find((w) => w.label === "gemini-pro · tokens")?.usedPercent, 75);
    assert.deepEqual(geminiQuotaToLimits({}, checkedAt).windows, []);
  });
});

it.layer(NodeServices.layer.pipe(Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux"))))(
  "Gemini OAuth quota reader",
  (it) => {
    it.effect("discovers the company project and scopes identity to account and project", () =>
      Effect.gen(function* () {
        const { config } = yield* login();
        const requests: string[] = [];
        let project = "company-one";
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(request.url);
            const body = request.url.endsWith("userinfo")
              ? { id: "account-one", email: "worker@example.com" }
              : request.url.endsWith(":loadCodeAssist")
                ? {
                    cloudaicompanionProject: project,
                    currentTier: { name: "Code Assist Enterprise" },
                  }
                : { buckets: [{ modelId: "gemini-pro", remainingFraction: 0.6 }] };
            if (request.url.endsWith(":retrieveUserQuota")) {
              assert.equal(request.body._tag, "Uint8Array");
              if (request.body._tag === "Uint8Array") {
                assert.deepEqual(decodeJson(new TextDecoder().decode(request.body.body)), {
                  project,
                });
              }
            }
            return HttpClientResponse.fromWeb(request, Response.json(body));
          }),
        );
        const reader = yield* makeGeminiUsageReader(config, {}).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        const first = yield* reader.read;
        assert.equal(first.email, "worker@example.com");
        assert.equal(first.plan, "Code Assist Enterprise");
        assert.equal(first.usageLimits.windows[0]?.usedPercent, 40);
        const same = yield* reader.read;
        assert.equal(same.usageLimits.accountId, first.usageLimits.accountId);
        project = "company-two";
        const other = yield* reader.read;
        assert.notEqual(other.usageLimits.accountId, first.usageLimits.accountId);
        assert.isFalse(requests.some((url) => /onboard|generateContent/.test(url)));
      }),
    );

    it.effect(
      "refreshes expired tokens silently, caches them in memory, and leaves CLI credentials intact",
      () =>
        Effect.gen(function* () {
          const { config, home } = yield* login({
            access_token: "expired",
            refresh_token: "refresh",
            expiry_date: 0,
          });
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          let refreshes = 0;
          const client = HttpClient.make((request) =>
            Effect.sync(() => {
              let body: unknown;
              if (request.url.endsWith("/token")) {
                refreshes++;
                body = { access_token: "fresh", expires_in: 3600 };
              } else {
                assert.equal(request.headers.authorization, "Bearer fresh");
                body = request.url.endsWith("userinfo")
                  ? { id: "account" }
                  : request.url.endsWith(":loadCodeAssist")
                    ? { cloudaicompanionProject: "project" }
                    : { buckets: [{ modelId: "pro", remainingFraction: 0 }] };
              }
              return HttpClientResponse.fromWeb(request, Response.json(body));
            }),
          );
          const reader = yield* makeGeminiUsageReader(config, {}).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          );
          assert.equal((yield* reader.read).usageLimits.windows[0]?.usedPercent, 100);
          yield* reader.read;
          assert.equal(refreshes, 1);
          assert.include(
            yield* fs.readFileString(path.join(home, ".gemini", "oauth_creds.json")),
            "expired",
          );
        }),
    );

    it.effect(
      "keeps last good quota through API failures, but clears it after changing login",
      () =>
        Effect.gen(function* () {
          const { config, home } = yield* login();
          let fail = false;
          const client = HttpClient.make((request) =>
            Effect.sync(() =>
              HttpClientResponse.fromWeb(
                request,
                fail
                  ? Response.json({}, { status: 503 })
                  : Response.json(
                      request.url.endsWith("userinfo")
                        ? { id: "account", email: "worker@example.com" }
                        : request.url.endsWith(":loadCodeAssist")
                          ? { cloudaicompanionProject: "project" }
                          : { buckets: [{ modelId: "pro", remainingFraction: 0.5 }] },
                    ),
              ),
            ),
          );
          const reader = yield* makeGeminiUsageReader(config, {}).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          );
          const first = (yield* reader.read).usageLimits;
          fail = true;
          const failedRead = yield* reader.read;
          assert.equal(failedRead.email, "worker@example.com");
          const failed = failedRead.usageLimits;
          assert.equal(failed.unavailable?.reason, "probeFailed");
          assert.strictEqual(
            resolveUsageLimitsAfterProbe({ published: first, probed: failed }),
            first,
          );
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.writeFileString(
            path.join(home, ".gemini", "oauth_creds.json"),
            '{"access_token":"other"}',
          );
          const changed = (yield* reader.read).usageLimits;
          assert.strictEqual(
            resolveUsageLimitsAfterProbe({ published: first, probed: changed }),
            changed,
          );
        }),
    );

    it.effect("uses the configured project and retries unauthorized requests after refresh", () =>
      Effect.gen(function* () {
        const { config } = yield* login();
        let refreshes = 0;
        let unauthorized = 0;
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.url.endsWith("/token")) {
              refreshes++;
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ access_token: "fresh", expires_in: 3600 }),
              );
            }
            if (request.headers.authorization !== "Bearer fresh") {
              unauthorized++;
              return HttpClientResponse.fromWeb(request, Response.json({}, { status: 401 }));
            }
            let body: unknown = { id: "account" };
            if (request.url.endsWith(":loadCodeAssist")) {
              assert.equal(request.body._tag, "Uint8Array");
              if (request.body._tag === "Uint8Array") {
                assert.deepInclude(decodeJson(new TextDecoder().decode(request.body.body)), {
                  cloudaicompanionProject: "configured-project",
                });
              }
              body = { cloudaicompanionProject: "discovered-project" };
            } else if (request.url.endsWith(":retrieveUserQuota")) {
              assert.equal(request.body._tag, "Uint8Array");
              if (request.body._tag === "Uint8Array") {
                assert.deepEqual(decodeJson(new TextDecoder().decode(request.body.body)), {
                  project: "configured-project",
                });
              }
              body = { buckets: [{ modelId: "pro", remainingFraction: 0.75 }] };
            }
            return HttpClientResponse.fromWeb(request, Response.json(body));
          }),
        );
        const reader = yield* makeGeminiUsageReader(config, {
          GOOGLE_CLOUD_PROJECT: "configured-project",
          GOOGLE_CLOUD_PROJECT_ID: "other-project",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        assert.equal((yield* reader.read).usageLimits.windows[0]?.usedPercent, 25);
        yield* reader.read;
        assert.equal(unauthorized, 1);
        assert.equal(refreshes, 1);
      }),
    );

    it.effect(
      "never reads company quota for API keys, Vertex, encrypted storage, or custom endpoints",
      () =>
        Effect.gen(function* () {
          const { config } = yield* login();
          let requests = 0;
          const client = HttpClient.make(() => {
            requests++;
            return Effect.die("unexpected quota request");
          });
          for (const authMethod of ["gemini-api-key", "vertex-ai", "gateway"]) {
            const reader = yield* makeGeminiUsageReader({ ...config, authMethod }, {}).pipe(
              Effect.provideService(HttpClient.HttpClient, client),
            );
            assert.equal((yield* reader.read).usageLimits.unavailable?.reason, "unsupported");
          }
          for (const environment of [
            { GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: "true" },
            { CODE_ASSIST_ENDPOINT: "https://proxy.example" },
          ]) {
            const reader = yield* makeGeminiUsageReader(config, environment).pipe(
              Effect.provideService(HttpClient.HttpClient, client),
            );
            assert.equal((yield* reader.read).usageLimits.unavailable?.reason, "unsupported");
          }
          assert.equal(requests, 0);
        }),
    );

    it.effect("reports missing company project and token refresh failure as unavailable", () =>
      Effect.gen(function* () {
        const { config } = yield* login();
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(request.url.endsWith("userinfo") ? { id: "account" } : {}),
            ),
          ),
        );
        const reader = yield* makeGeminiUsageReader(config, {}).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        assert.include(
          (yield* reader.read).usageLimits.unavailable?.message ?? "",
          "GOOGLE_CLOUD_PROJECT",
        );
        const expired = yield* login({ refresh_token: "revoked", expiry_date: 0 });
        const broken = yield* makeGeminiUsageReader(expired.config, {}).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({}, { status: 400 })),
              ),
            ),
          ),
        );
        assert.equal((yield* broken.read).usageLimits.unavailable?.reason, "probeFailed");
      }),
    );
  },
);
