import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const deploymentFiles = [
  ".github/workflows/deploy-self-host.yml",
  "deploy/self-host/deploy.sh"
];

for (const filePath of deploymentFiles) {
  test(`${filePath} uses the lockfile and waits for application readiness`, async () => {
    const source = await fs.readFile(filePath, "utf8");
    assert.match(source, /npm (?:--prefix "\$APP_DIR" )?ci --omit=dev/);
    assert.doesNotMatch(source, /npm (?:--prefix "\$APP_DIR" )?install --omit=dev/);
    assert.match(source, /APP_PORT/);
    assert.match(source, /http:\/\/127\.0\.0\.1:\$\{APP_PORT\}\/healthz/);
    assert.doesNotMatch(source, /http:\/\/127\.0\.0\.1:3000\/healthz/);
    assert.match(source, /curl[^\n]*(?:--fail|-f)/);
    assert.match(source, /for\s+[^\n]+\s+in\s+\$?\([^\n]*seq\s+1\s+[1-9][0-9]*\)/);
    assert.match(source, /exit 1/);
  });
}


test("Vercel routes /healthz to the health API", async () => {
  const config = JSON.parse(await fs.readFile("vercel.json", "utf8"));
  assert.ok(config.rewrites.some((rewrite) => (
    rewrite.source === "/healthz" && rewrite.destination === "/api/health"
  )));
  await fs.access("api/health.mjs");
});
