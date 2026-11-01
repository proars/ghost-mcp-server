import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

export const KEY_ID = "a".repeat(24);
export const KEY_SECRET = "b".repeat(64);
export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Checks the Ghost JWT the same way Ghost does: HS256 with the hex-decoded secret. */
export function verifyJwt(authorization) {
  const match = /^Ghost (.+)$/.exec(authorization ?? "");
  if (!match) {
    return "missing Ghost scheme";
  }
  const [header, payload, signature] = match[1].split(".");
  const expected = createHmac("sha256", Buffer.from(KEY_SECRET, "hex"))
    .update(`${header}.${payload}`)
    .digest("base64url");
  if (expected !== signature) {
    return "bad signature";
  }
  const head = JSON.parse(Buffer.from(header, "base64url"));
  const body = JSON.parse(Buffer.from(payload, "base64url"));
  if (head.alg !== "HS256" || head.typ !== "JWT" || head.kid !== KEY_ID) {
    return "bad header";
  }
  if (body.aud !== "/admin/" || !(body.exp > body.iat) || body.exp - body.iat > 300) {
    return "bad payload";
  }
  return "ok";
}

/** A fake Ghost Admin API that records every request and answers with a queued or default reply. */
export async function startMock() {
  const requests = [];
  const queue = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://mock");
      requests.push({
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        jwt: verifyJwt(req.headers.authorization),
        body: Buffer.concat(chunks),
      });
      const reply = queue.shift() ?? { status: 200, json: { mock: "ok" } };
      if (reply.destroy) {
        req.socket.destroy();
        return;
      }
      const headers = { ...(reply.headers ?? {}) };
      let body = reply.body;
      if (reply.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(reply.json);
      }
      res.writeHead(reply.status ?? 200, headers);
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    last: () => requests.at(-1),
    reply: (response) => queue.push(response),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const GUARD_PATH = fileURLToPath(new URL("./guard-env.mjs", import.meta.url));
export const GUARD_MARKER = "PROJECT_ENV_READ_ATTEMPT";

/**
 * Environment for a spawned server. Tests never read the project .env: the loader is switched off
 * (unless a test asks otherwise) and the guard preload reports any attempt to open that file.
 * A value of null removes the variable.
 */
export function serverEnv(env = {}, { skipDotenv = true } = {}) {
  const result = { ...process.env, GUARD_ENV_PATH: `${PROJECT_ROOT}.env`, ...env };
  if (skipDotenv) {
    result.GHOST_MCP_SKIP_DOTENV = "1";
  } else {
    delete result.GHOST_MCP_SKIP_DOTENV;
  }
  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === undefined) {
      delete result[key];
    }
  }
  return result;
}

export function serverArgs() {
  return ["--import", GUARD_PATH, "--import", "tsx", "src/index.ts"];
}

/** Starts the real server over stdio and returns a minimal MCP client. */
export async function startServer(env, options) {
  const child = spawn(process.execPath, serverArgs(), {
    cwd: PROJECT_ROOT,
    env: serverEnv(env, options),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data));

  const pending = new Map();
  let buffer = "";
  let stdoutNoise = "";
  child.stdout.on("data", (data) => {
    buffer += data;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) {
        continue;
      }
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      } catch {
        stdoutNoise += `${line}\n`;
      }
    }
  });

  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return {
    stderr: () => stderr,
    stdoutNoise: () => stdoutNoise,
    listTools: async () => (await rpc("tools/list", {})).result.tools,
    /** Returns { isError, text, json } for a tool call. */
    call: async (name, args = {}) => {
      const message = await rpc("tools/call", { name, arguments: args });
      const result = message.result ?? { isError: true, content: [{ text: JSON.stringify(message.error) }] };
      const text = result.content[0].text;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: result.isError === true, text, json };
    },
    close: () => {
      child.kill();
    },
  };
}

/** Puts concrete values into {param} placeholders. */
export function fillPath(template, values = {}) {
  return template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `${name}_1`);
}
