// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GeminiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { checkGeminiProviderStatus } from "./GeminiProvider.ts";

const decodeSettings = Schema.decodeSync(GeminiSettings);
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

it.layer(NodeServices.layer)("Gemini readiness", (it) => {
  it.effect(
    "checks ACP installation without authenticating or creating a session in the server workspace",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-readiness-" });
        const binaryPath = path.join(home, "gemini-mock");
        const logPath = path.join(home, "requests.ndjson");
        const agentPath = NodeURL.fileURLToPath(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        yield* fs.writeFileString(
          binaryPath,
          `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.59.0; exit 0; fi\nexec ${quote(process.execPath)} ${quote(agentPath)} "$@"\n`,
        );
        yield* fs.chmod(binaryPath, 0o755);
        const snapshot = yield* checkGeminiProviderStatus(
          decodeSettings({ binaryPath, homePath: home }),
          { ...process.env, T3_ACP_REQUEST_LOG_PATH: logPath },
        );
        assert.equal(snapshot.status, "ready");
        assert.equal(snapshot.version, "0.59.0");
        assert.equal(snapshot.auth.status, "unknown");
        const requests = (yield* fs.readFileString(logPath))
          .trim()
          .split("\n")
          .map((line) => decodeRequest(line));
        assert.deepEqual(
          requests.map((request) => request.method),
          ["initialize"],
        );
        assert.isFalse(snapshot.requiresNewThreadForModelChange);
      }),
  );

  it.effect("reports a missing executable without implying an authentication failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-missing-" });
      const snapshot = yield* checkGeminiProviderStatus(
        decodeSettings({
          binaryPath: path.join(home, "does-not-exist"),
          homePath: home,
        }),
        {},
      );
      assert.isFalse(snapshot.installed);
      assert.equal(snapshot.auth.status, "unknown");
    }),
  );
});
