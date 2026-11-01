import { createHmac } from "node:crypto";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { readUploadFile, reserveDownload } from "./files.js";

// The project .env is read only when the configuration is not already in the environment, and
// never when GHOST_MCP_SKIP_DOTENV=1. GHOST_MCP_ENV_FILE points at a different file. Variables that
// are already set always win over the file.
const configSupplied = Boolean(process.env.GHOST_API_URL) && Boolean(process.env.GHOST_ADMIN_API_KEY);
if (!configSupplied && process.env.GHOST_MCP_SKIP_DOTENV !== "1") {
  dotenv.config({
    path: process.env.GHOST_MCP_ENV_FILE || fileURLToPath(new URL("../.env", import.meta.url)),
  });
}

const GHOST_API_URL = process.env.GHOST_API_URL;
const GHOST_ADMIN_API_KEY = process.env.GHOST_ADMIN_API_KEY;

if (!GHOST_API_URL || !GHOST_ADMIN_API_KEY) {
  throw new Error(
    "Missing configuration: GHOST_API_URL and GHOST_ADMIN_API_KEY must be set in the environment or in a .env file next to package.json, or in the file named by GHOST_MCP_ENV_FILE (see .env.example)."
  );
}

if (!/^[0-9a-f]{24}:[0-9a-f]{64}$/i.test(GHOST_ADMIN_API_KEY)) {
  throw new Error(
    "GHOST_ADMIN_API_KEY has an invalid format. Expected {id}:{secret}, where id is 24 hex characters and secret is 64 hex characters (Ghost Admin → Settings → Integrations)."
  );
}

const API_BASE = `${GHOST_API_URL.replace(/\/+$/, "")}/ghost/api/admin`;
const [KEY_ID, KEY_SECRET] = GHOST_ADMIN_API_KEY.split(":");
const ACCEPT_VERSION = "v5.0";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_INLINE_TEXT_BYTES = 200_000;

export type Method = "GET" | "POST" | "PUT" | "DELETE";
export type Query = Record<string, string | number | boolean>;

export class GhostError extends Error {
  status: number;
  type?: string;

  constructor(message: string, status: number, type?: string) {
    super(message);
    this.name = "GhostError";
    this.status = status;
    this.type = type;
  }
}

/** The request never produced an HTTP answer (connection lost, timeout, refused). */
export class GhostNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhostNetworkError";
  }
}

export function createToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT", kid: KEY_ID })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" })
  ).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(KEY_SECRET, "hex"))
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** Rejects paths that could leave /ghost/api/admin (dot segments, encoded slashes, query strings). */
export function assertSafePath(path: string): void {
  const unsafe =
    !path.startsWith("/") ||
    /[?#\\\s\u0000-\u001f]/.test(path) ||
    /\.\.|\/\//.test(path) ||
    /%(2e|2f|5c|00)/i.test(path);
  if (unsafe) {
    throw new Error(
      'Path must start with "/", be relative to /ghost/api/admin, and contain no "?", "#", "..", "//", backslashes, whitespace or encoded dots and slashes.'
    );
  }
}

/** Rejects a value that would become a dot segment when placed in a URL path. */
export function assertSafeSegment(name: string, value: string): void {
  if (value === "." || value === "..") {
    throw new Error(`Argument "${name}" must not be "." or "..".`);
  }
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".zip": "application/zip",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/vnd.wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".xml": "application/xml",
};

/** Ghost checks both the extension and the MIME type of an upload, so the type must match the file. */
export function mimeFor(fileName: string): string {
  return MIME_TYPES[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

export async function buildForm(
  files: Record<string, string>,
  fields: Record<string, string> = {}
): Promise<FormData> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  for (const [field, filePath] of Object.entries(files)) {
    const { buffer, name } = await readUploadFile(`File path for "${field}"`, filePath);
    form.append(field, new Blob([buffer], { type: mimeFor(name) }), name);
  }
  return form;
}

function buildQuery(query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export interface GhostResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

// Errors that prove the request was never sent, so repeating it is safe.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL"]);

function networkError(method: Method, error: unknown): GhostNetworkError {
  const failure = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = failure?.cause?.code ?? failure?.code;
  const detail = code ?? failure?.cause?.message ?? failure?.message ?? String(error);
  if (code && NOT_SENT_CODES.has(code)) {
    return new GhostNetworkError(
      `Ghost request failed: could not connect (${detail}). Nothing was sent. Check GHOST_API_URL.`
    );
  }
  if (method === "GET") {
    return new GhostNetworkError(`Ghost request failed: ${detail}.`);
  }
  return new GhostNetworkError(
    `Ghost request failed after it may have been sent: ${detail}. The operation may or may not have completed: check Ghost before repeating this ${method} request.`
  );
}

function redirectError(method: Method, status: number, location: string | null): GhostError {
  let target = "an unknown location";
  if (location) {
    try {
      const url = new URL(location, `${API_BASE}/`);
      target = `${url.origin}${url.pathname}`;
    } catch {
      target = "an unreadable location";
    }
  }
  const boundary =
    "Redirects are never followed, so the API key and the request body cannot leave the Admin API.";
  const fix =
    "set GHOST_API_URL to the canonical URL of your Ghost site (for example its https:// address or its admin domain)";
  if (method === "GET") {
    return new GhostError(
      `Ghost API ${status} redirect to ${target}. ${boundary} Fix it: ${fix}, then send the request again.`,
      status
    );
  }
  // A redirect is an answer, so Ghost has already received this POST, PUT or DELETE and may have
  // carried it out (a 303 after a POST usually means exactly that).
  return new GhostError(
    `Ghost API ${status} redirect to ${target}. The ${method} request was already sent, so the operation may have completed: check in Ghost whether it did before repeating it. ${boundary} After checking, ${fix}.`,
    status
  );
}

export async function ghostFetch(
  method: Method,
  path: string,
  query: Query = {},
  body?: unknown,
  form?: FormData
): Promise<GhostResponse> {
  const headers: Record<string, string> = {
    Authorization: `Ghost ${createToken()}`,
    "Accept-Version": ACCEPT_VERSION,
  };
  let payload: string | FormData | undefined;
  if (form) {
    payload = form;
  } else if (body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response: Response;
  let buffer: Buffer;
  try {
    response = await fetch(`${API_BASE}${path}${buildQuery(query)}`, {
      method,
      headers,
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw networkError(method, error);
  }
  const contentType = response.headers.get("content-type") ?? "";

  if (response.status >= 300 && response.status < 400) {
    throw redirectError(method, response.status, response.headers.get("location"));
  }

  if (!response.ok) {
    let first: any = undefined;
    try {
      first = JSON.parse(buffer.toString("utf8"))?.errors?.[0];
    } catch {
      first = undefined;
    }
    if (first?.message) {
      const type = first.type ? `${first.type}: ` : "";
      const context = first.context ? ` (${first.context})` : "";
      throw new GhostError(
        `Ghost API ${response.status} ${type}${first.message}${context}`,
        response.status,
        first.type
      );
    }
    throw new GhostError(`Ghost API ${response.status} ${response.statusText}`, response.status);
  }

  return { status: response.status, contentType, body: buffer };
}

export interface RequestOptions {
  saveTo?: string;
}

/** Sends a request and converts any kind of successful response into a JSON-serializable value. */
export async function ghostRequest(
  method: Method,
  path: string,
  query: Query = {},
  body?: unknown,
  form?: FormData,
  options: RequestOptions = {}
): Promise<unknown> {
  // The destination is validated and created before the request, so a bad save_to can never fail
  // after Ghost has already carried out a change.
  const reservation = options.saveTo ? await reserveDownload(options.saveTo) : undefined;

  let response: GhostResponse;
  try {
    response = await ghostFetch(method, path, query, body, form);
  } catch (error) {
    await reservation?.discard();
    throw error;
  }
  const { status, contentType, body: buffer } = response;

  if (reservation) {
    try {
      await reservation.write(buffer);
    } catch (error) {
      await reservation.discard();
      const failure = error as NodeJS.ErrnoException;
      throw new Error(
        `The ${method} request was sent and Ghost answered ${status}, but saving the response to ${options.saveTo} failed (${failure?.code ?? failure?.message}). The remote operation may have completed: do not repeat a POST, PUT or DELETE without checking Ghost first.`
      );
    }
    return { ok: true, status, saved_to: options.saveTo, bytes: buffer.length, content_type: contentType };
  }

  if (buffer.length === 0) {
    return { ok: true, status };
  }

  if (/json/i.test(contentType)) {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      // fall through and return the body as text
    }
  }

  const isText = /^text\/|json|xml|yaml|javascript/i.test(contentType);
  if (isText && buffer.length <= MAX_INLINE_TEXT_BYTES) {
    return { ok: true, status, content_type: contentType, text: buffer.toString("utf8") };
  }
  return {
    ok: true,
    status,
    content_type: contentType,
    bytes: buffer.length,
    note:
      method === "GET"
        ? "The response is binary or too large to show. Repeat the call with save_to set to an absolute file path to store it."
        : `The ${method} request was already carried out and Ghost answered ${status}. The response is binary or too large to show, and it was not saved because save_to was not set. Do not repeat the request to get it again: check the result in Ghost. Set save_to on the first call of a request that returns a file.`,
  };
}
