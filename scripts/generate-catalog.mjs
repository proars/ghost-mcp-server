// Generates src/catalog.ts from GHOST_API.list.
// Usage: npm run catalog
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LIST_PATH = fileURLToPath(new URL("../GHOST_API.list", import.meta.url));
const OUT_PATH = fileURLToPath(new URL("../src/catalog.ts", import.meta.url));

const GROUP_RE = /^(\d+)\. (.+?) — (.+?) \(routes: (\d+)\)$/;
const ROUTE_RE = /^(GET|POST|PUT|DELETE)\s+(\/admin\/\S*)\s+((?:\[[^\]]+\]\s*)+)—\s*(.*)$/;
const META_RE = /^\s+handler=([\w.]+); R:(\d+); MCP=(\S+?)(;.*)?$/;
const ACCESS = ["I", "U", "SESSION", "FLOW", "PUBLIC"];

/** Parses the route catalog section of GHOST_API.list. */
export function parseList(text) {
  const lines = text.split("\n");
  const sha = /Snapshot of the official main branch: (\w+)/.exec(text)?.[1];
  if (!sha) {
    throw new Error("Snapshot SHA not found in GHOST_API.list");
  }
  const start = lines.findIndex((line) => line.startsWith("COMPLETE ROUTE CATALOG"));
  const end = lines.findIndex((line) => line.startsWith("COVERAGE BY THE CURRENT MCP SERVER"));
  if (start < 0 || end < 0) {
    throw new Error("Catalog section markers not found in GHOST_API.list");
  }

  const routes = [];
  const declared = new Map();
  let group = "";
  for (let i = start; i < end; i++) {
    const groupMatch = GROUP_RE.exec(lines[i]);
    if (groupMatch) {
      group = groupMatch[2];
      declared.set(group, Number(groupMatch[4]));
    }
    const routeMatch = ROUTE_RE.exec(lines[i]);
    if (!routeMatch) {
      continue;
    }
    const [, method, path, tags, summary] = routeMatch;
    const tagList = [...tags.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
    const access = tagList.filter((tag) => ACCESS.includes(tag));
    const source = tagList.filter((tag) => tag === "doc" || tag === "src");
    if (access.length !== 1 || source.length !== 1) {
      throw new Error(`Bad access/source tags: ${lines[i]}`);
    }
    const meta = META_RE.exec(lines[i + 1] ?? "");
    if (!meta) {
      throw new Error(`Missing handler line after: ${lines[i]}`);
    }
    const extra = {};
    for (const part of (meta[4] ?? "").split(";").map((item) => item.trim()).filter(Boolean)) {
      if (part.startsWith("flag=")) {
        extra.flag = part.slice(5);
      } else if (part.startsWith("upload=")) {
        extra.upload = part.slice(7).split(",");
      } else if (part === "token-url") {
        extra.tokenUrl = true;
      } else {
        throw new Error(`Unknown route attribute "${part}" after: ${lines[i]}`);
      }
    }
    routes.push({
      method,
      path: path.slice("/admin".length),
      handler: meta[1],
      access: access[0],
      group,
      source: source[0],
      summary: summary.trim(),
      extra,
      tool: meta[3] === "no" ? null : meta[3],
    });
  }

  const keys = routes.map((route) => `${route.method} ${route.path}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Duplicate method + path pairs in GHOST_API.list");
  }
  for (const [name, count] of declared) {
    const actual = routes.filter((route) => route.group === name).length;
    if (actual !== count) {
      throw new Error(`Group ${name} declares ${count} routes but lists ${actual}`);
    }
  }
  return { sha, routes };
}

function extraSource(extra) {
  const parts = [];
  if (extra.flag) {
    parts.push(`flag: ${JSON.stringify(extra.flag)}`);
  }
  if (extra.upload) {
    parts.push(`upload: ${JSON.stringify(extra.upload)}`);
  }
  if (extra.tokenUrl) {
    parts.push("tokenUrl: true");
  }
  return parts.length ? `, { ${parts.join(", ")} }` : "";
}

export function renderCatalog({ sha, routes }) {
  const rows = routes.map((route) => {
    const fields = [route.method, route.path, route.handler, route.access, route.group, route.source, route.summary]
      .map((item) => JSON.stringify(item))
      .join(", ");
    return `  [${fields}${extraSource(route.extra)}],`;
  });
  return `// Generated from GHOST_API.list (TryGhost/Ghost commit ${sha}).
// Do not edit by hand: change GHOST_API.list, run "npm run catalog", then run "npm test".

export type Access = "I" | "U" | "SESSION" | "FLOW" | "PUBLIC";

export interface RouteExtra {
  flag?: string;
  upload?: string[];
  tokenUrl?: true;
}

// [method, path relative to /ghost/api/admin, handler, access, group, source (doc|src), summary, extra]
export type Route = [
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  handler: string,
  access: Access,
  group: string,
  source: "doc" | "src",
  summary: string,
  extra?: RouteExtra,
];

/**
 * access: I = passes the integration-token allowlist, U = needs a staff user token or session,
 * SESSION = needs a user cookie session, FLOW = login/recovery/setup flow, PUBLIC = no authentication.
 */
export const CATALOG: Route[] = [
${rows.join("\n")}
];
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const parsed = parseList(readFileSync(LIST_PATH, "utf8"));
  writeFileSync(OUT_PATH, renderCatalog(parsed));
  console.log(`Wrote ${parsed.routes.length} routes to src/catalog.ts (commit ${parsed.sha}).`);
}
