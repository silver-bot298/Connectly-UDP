import express from "express";
import http from "http";
import net from "net";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import WebSocket, { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BRIDGE_HOST = process.env.DATAGRAM_BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.DATAGRAM_BRIDGE_PORT || 8765);
const UDP_HOST = process.env.DATAGRAM_UDP_HOST || "127.0.0.1";
const UDP_PORT = Number(process.env.DATAGRAM_UDP_PORT || 9001);

const spawnedChildren: ChildProcess[] = [];

function resolvePythonExecutable(): string {
  const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    const check = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    if (check.status === 0) {
      return cmd;
    }
  }
  return "python3";
}

function isTcpPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function waitForBridgeReady(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTcpPortOpen(BRIDGE_HOST, BRIDGE_PORT)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function ensurePythonBackends(): Promise<void> {
  if (process.env.DATAGRAM_EXTERNAL_BACKEND === "true") {
    return;
  }

  const bridgeRunning = await isTcpPortOpen(BRIDGE_HOST, BRIDGE_PORT);
  if (bridgeRunning) {
    console.log(`[SERVER] Detected running Python bridge at ${BRIDGE_HOST}:${BRIDGE_PORT}`);
    return;
  }

  const py = resolvePythonExecutable();
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    DATAGRAM_UDP_HOST: "0.0.0.0",
    DATAGRAM_UDP_PORT: String(UDP_PORT),
    DATAGRAM_BRIDGE_HOST: BRIDGE_HOST,
    DATAGRAM_BRIDGE_PORT: String(BRIDGE_PORT),
  };

  console.log(`[SERVER] Starting Python UDP Server (SOCK_DGRAM :${UDP_PORT})...`);
  const udpProc = spawn(py, [path.join(__dirname, "backend", "udp_server.py")], {
    cwd: __dirname,
    env,
    stdio: "inherit",
  });
  spawnedChildren.push(udpProc);

  await new Promise((r) => setTimeout(r, 350));

  console.log(`[SERVER] Starting Python Client Bridge (HTTP/WS :${BRIDGE_PORT} -> UDP ${UDP_HOST}:${UDP_PORT})...`);
  const bridgeProc = spawn(
    py,
    [
      path.join(__dirname, "backend", "bridge.py"),
      "--host",
      BRIDGE_HOST,
      "--port",
      String(BRIDGE_PORT),
      "--udp-host",
      UDP_HOST,
      "--udp-port",
      String(UDP_PORT),
    ],
    {
      cwd: __dirname,
      env,
      stdio: "inherit",
    }
  );
  spawnedChildren.push(bridgeProc);

  await waitForBridgeReady();
}

function cleanupChildren() {
  for (const child of spawnedChildren) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }
}

process.on("SIGINT", () => {
  cleanupChildren();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupChildren();
  process.exit(0);
});
process.on("exit", cleanupChildren);

async function startServer() {
  await ensurePythonBackends();

  const app = express();
  const httpServer = http.createServer(app);

  // Proxy /api/* HTTP requests to the Python Client Bridge
  app.use("/api", (req, res) => {
    const targetPath = req.originalUrl;
    const headers: Record<string, string | string[]> = {};
    if (req.headers["content-type"]) {
      headers["content-type"] = req.headers["content-type"];
    }
    if (req.headers["authorization"]) {
      headers["authorization"] = req.headers["authorization"];
    }
    if (req.headers["content-length"]) {
      headers["content-length"] = req.headers["content-length"];
    }

    const proxyReq = http.request(
      {
        hostname: BRIDGE_HOST,
        port: BRIDGE_PORT,
        path: targetPath,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).json({
          error: `Python Client Bridge unreachable at ${BRIDGE_HOST}:${BRIDGE_PORT}: ${err.message}`,
        });
      }
    });

    req.pipe(proxyReq);
  });

  // Proxy /ws WebSocket connections to the Python Client Bridge
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url || "/";
    if (!url.startsWith("/ws")) {
      return;
    }
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const targetUrl = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}${url}`;
      const bridgeWs = new WebSocket(targetUrl);
      const pendingToBridge: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

      bridgeWs.on("open", () => {
        for (const item of pendingToBridge) {
          bridgeWs.send(item.data, { binary: item.isBinary });
        }
        pendingToBridge.length = 0;
      });

      clientWs.on("message", (data, isBinary) => {
        if (bridgeWs.readyState === WebSocket.OPEN) {
          bridgeWs.send(data, { binary: isBinary });
        } else if (bridgeWs.readyState === WebSocket.CONNECTING) {
          pendingToBridge.push({ data, isBinary });
        }
      });

      bridgeWs.on("message", (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      clientWs.on("close", () => {
        if (bridgeWs.readyState === WebSocket.OPEN || bridgeWs.readyState === WebSocket.CONNECTING) {
          bridgeWs.close();
        }
      });

      bridgeWs.on("close", () => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close();
        }
      });

      bridgeWs.on("error", () => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1011, "Python bridge connection error");
        }
      });
    });
  });

  if (process.env.NODE_ENV === "production") {
    const distDir = path.join(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] DATAGRAM web gateway running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("[SERVER] Fatal startup error:", err);
  cleanupChildren();
  process.exit(1);
});
