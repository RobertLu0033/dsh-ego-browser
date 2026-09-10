import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEnsureWorker, proxyPost } from "../src/cast-server.ts";
import type { ResolvedConfig } from "../src/types.ts";

describe("cast server worker proxy", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      for await (const _chunk of req) {}
      const payload = JSON.stringify({ ok: false, code: "capture-target-stale" });
      res.writeHead(409, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("preserves the worker HTTP status and JSON error", async () => {
    const result = await proxyPost(port, "/api/input", { targetId: "missing" });
    expect(result!.status).toBe(409);
    expect((result!.body as { code?: string }).code).toBe("capture-target-stale");
  });
});

describe("cast server worker spawn", () => {
  const savedStateDir = process.env.EGO_LINUX_STATE_DIR;
  let stateDir: string;
  let healthServer: Server;
  let healthPort: number;

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "ego-cast-worker-test-"));
    process.env.EGO_LINUX_STATE_DIR = stateDir;
    // castStatePath() appends `/ego-lite-linux` unless the dir already ends
    // with that segment; mirror the layout so the mock worker's state file
    // lands where knownWorkerState() reads it.
    mkdirSync(join(stateDir, "ego-lite-linux"), { recursive: true });
    healthServer = createServer(async (_req: IncomingMessage, res: ServerResponse) => {
      const payload = JSON.stringify({ ok: true });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    });
    await new Promise<void>((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
    healthPort = (healthServer.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    if (savedStateDir === undefined) delete process.env.EGO_LINUX_STATE_DIR;
    else process.env.EGO_LINUX_STATE_DIR = savedStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("spawns the ego-cast worker with a cwd (DSH SubprocessSpawnSpec requires it)", async () => {
    let captured: Record<string, unknown> | null = null;
    const ctx = {
      subprocess: {
        spawn: (spec: Record<string, unknown>) => {
          captured = spec;
          // Simulate the worker publishing its loopback state, so the
          // ensureWorker readiness poll succeeds immediately.
          writeFileSync(join(stateDir, "ego-lite-linux", "ego-cast.json"), JSON.stringify({ port: healthPort, pid: process.pid }));
          return { done: Promise.resolve({ exitCode: 0, signal: null }) };
        },
      },
    } as never;
    const cfg = {
      captureBackend: "cdp",
      streamProfile: "balanced",
      cdpFps: 20,
      cdpQuality: 65,
      cdpMaxWidth: 1280,
      cdpBackstopIntervalMs: 3000,
      ffmpegFps: 20,
      ffmpegMaxWidth: 1280,
      ffmpegBitrateKbps: 4000,
      ffmpegEncoder: "h264_videotoolbox",
      ffmpegPath: "/opt/homebrew/bin/ffmpeg",
    } as unknown as ResolvedConfig;

    const ensureWorker = makeEnsureWorker(ctx, cfg, null);
    const readyPort = await ensureWorker();

    expect(readyPort).toBe(healthPort);
    expect(captured).not.toBeNull();
    expect(captured!.cwd).toBe(process.cwd());
    expect(captured!.argv).toHaveLength(3);
    expect((captured!.argv as string[])[0]).toBe(process.execPath);
    expect((captured!.argv as string[])[1]).toMatch(/ego-cast-worker\.mjs$/);
    const initCfg = JSON.parse((captured!.argv as string[])[2]) as { captureBackend?: string };
    expect(initCfg.captureBackend).toBe("cdp");
  });
});
