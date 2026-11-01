import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseList } from "../scripts/generate-catalog.mjs";
import {
  fillPath,
  GUARD_MARKER,
  KEY_ID,
  KEY_SECRET,
  PROJECT_ROOT,
  serverArgs,
  serverEnv,
  startMock,
  startServer,
} from "./helpers.mjs";

const API = "/ghost/api/admin";
const list = parseList(await readFile(join(PROJECT_ROOT, "GHOST_API.list"), "utf8"));
const packageJson = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8"));

let mock;
let server;
let tmp;
let png;
let zip;
let csv;
let tools;

before(async () => {
  mock = await startMock();
  server = await startServer({
    GHOST_API_URL: `http://127.0.0.1:${mock.port}/`,
    GHOST_ADMIN_API_KEY: `${KEY_ID}:${KEY_SECRET}`,
  });
  tmp = await mkdtemp(join(tmpdir(), "ghost-mcp-test-"));
  png = join(tmp, "pic.png");
  zip = join(tmp, "theme.zip");
  csv = join(tmp, "members.csv");
  await writeFile(png, Buffer.from("89504e470d0a1a0a", "hex"));
  await writeFile(zip, Buffer.from("504b0304", "hex"));
  await writeFile(csv, "email\na@example.com\n");
  tools = await server.listTools();
});

after(async () => {
  server.close();
  await mock.close();
  await rm(tmp, { recursive: true, force: true });
});

const toolByName = (name) => tools.find((tool) => tool.name === name);

async function allEndpoints() {
  const { json } = await server.call("ghost_list_endpoints", { limit: 300 });
  return json.endpoints;
}

test("tools: unique names, valid schemas, annotations", () => {
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(tools.length, 59);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(typeof tool.description, "string", tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
  }
  for (const name of ["ghost_api_request", "ghost_list_endpoints", "update_post_seo", "update_post_tags"]) {
    assert.ok(toolByName(name), name);
  }
  assert.ok(tools.filter((tool) => tool.name.startsWith("delete_")).every((tool) => tool.annotations.destructiveHint));
  assert.ok(tools.filter((tool) => tool.name.startsWith("get_")).every((tool) => tool.annotations.readOnlyHint));
  assert.equal(toolByName("ghost_api_request").annotations.destructiveHint, true);
});

test("tool descriptions warn when a route is closed to integration keys", async () => {
  const endpoints = await allEndpoints();
  const closed = endpoints.filter((endpoint) => endpoint.tool && !["I", "PUBLIC"].includes(endpoint.access));
  assert.deepEqual(closed.map((endpoint) => endpoint.tool).sort(), ["delete_user", "update_user"]);
  for (const endpoint of closed) {
    assert.match(toolByName(endpoint.tool).description, /not available to Admin API integration keys/);
  }
  assert.doesNotMatch(toolByName("get_posts").description, /integration keys/);
  assert.ok(tools.every((tool) => !/REST pattern/.test(tool.description)));
});

test("dedicated tools are exactly the MCP= entries of GHOST_API.list", async () => {
  const fromList = Object.fromEntries(
    list.routes.filter((route) => route.tool).map((route) => [route.tool, `${route.method} ${route.path}`])
  );
  const fromServer = Object.fromEntries(
    (await allEndpoints()).filter((endpoint) => endpoint.tool).map((endpoint) => [endpoint.tool, `${endpoint.method} ${endpoint.path}`])
  );
  assert.equal(Object.keys(fromList).length, 55);
  assert.deepEqual(fromServer, fromList);
});

test("every one of the 253 catalog routes is reachable through ghost_api_request", async () => {
  const failures = [];
  for (const route of list.routes) {
    const args = { method: route.method, path: fillPath(route.path, {}) };
    if (route.extra.upload) {
      args.files = Object.fromEntries(route.extra.upload.map((field) => [field, png]));
    }
    const before = mock.requests.length;
    const result = await server.call("ghost_api_request", args);
    const sent = mock.requests[before];
    const label = `${route.method} ${route.path}`;
    if (result.isError || !sent) {
      failures.push(`${label}: ${result.text}`);
      continue;
    }
    if (sent.method !== route.method || sent.pathname !== `${API}${args.path}`) {
      failures.push(`${label}: sent ${sent.method} ${sent.pathname}`);
    }
    if (sent.jwt !== "ok" || sent.headers["accept-version"] !== "v5.0") {
      failures.push(`${label}: auth headers ${sent.jwt} ${sent.headers["accept-version"]}`);
    }
    if (route.extra.upload) {
      const body = sent.body.toString("latin1");
      const multipart = sent.headers["content-type"]?.startsWith("multipart/form-data");
      if (!multipart || !route.extra.upload.every((field) => body.includes(`name="${field}"`))) {
        failures.push(`${label}: multipart fields missing`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("every dedicated tool calls its catalog route", async () => {
  const failures = [];
  const routeByTool = new Map(list.routes.filter((route) => route.tool).map((route) => [route.tool, route]));
  for (const [name, route] of routeByTool) {
    const schema = toolByName(name).inputSchema;
    const args = {};
    for (const [, param] of route.path.matchAll(/\{(\w+)\}/g)) {
      args[param] = "x1";
    }
    if (schema.required.includes("data")) {
      args.data = { updated_at: "2026-01-01T00:00:00.000Z", name: "n" };
    }
    if (schema.required.includes("file_path")) {
      args.file_path = route.path.includes("themes") ? zip : png;
    }
    const before = mock.requests.length;
    const result = await server.call(name, args);
    const sent = mock.requests[before];
    if (result.isError || !sent) {
      failures.push(`${name}: ${result.text}`);
      continue;
    }
    const expectedPath = `${API}${route.path.replace(/\{\w+\}/g, "x1")}`;
    if (sent.method !== route.method || sent.pathname !== expectedPath) {
      failures.push(`${name}: sent ${sent.method} ${sent.pathname}, expected ${route.method} ${expectedPath}`);
    }
    if (sent.jwt !== "ok") {
      failures.push(`${name}: bad jwt ${sent.jwt}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("get_posts sends compact fields, include and a validated limit", async () => {
  await server.call("get_posts", { limit: 5, page: 2.9 });
  const sent = mock.last();
  assert.equal(sent.pathname, `${API}/posts/`);
  assert.equal(sent.query.limit, "5");
  assert.equal(sent.query.page, "2");
  assert.equal(sent.query.include, "tags");
  assert.match(sent.query.fields, /^id,title,slug,status,updated_at/);

  const count = mock.requests.length;
  assert.equal((await server.call("get_posts", { limit: 0 })).isError, true);
  assert.equal((await server.call("get_posts", { limit: "5" })).isError, true);
  assert.equal(mock.requests.length, count);
});

test("path parameters are encoded and dot segments are refused", async () => {
  await server.call("get_post_by_slug", { slug: "hello world/é" });
  assert.equal(mock.last().pathname, `${API}/posts/slug/hello%20world%2F%C3%A9/`);

  const count = mock.requests.length;
  for (const id of ["..", "."]) {
    assert.equal((await server.call("get_post", { id })).isError, true, id);
    assert.equal((await server.call("update_post_seo", { id, updated_at: "u", meta_title: "t" })).isError, true, id);
  }
  assert.equal(mock.requests.length, count);
});

test("post and page updates require updated_at and wrap the body", async () => {
  const count = mock.requests.length;
  const missing = await server.call("update_post", { id: "p1", data: { title: "x" } });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /updated_at/);
  assert.equal((await server.call("update_page", { id: "p1", data: {} })).isError, true);
  assert.equal(mock.requests.length, count);

  await server.call("update_post", {
    id: "p1",
    data: { updated_at: "2026-01-01T00:00:00.000Z", title: "x" },
    save_revision: true,
    newsletter: "weekly",
    email_segment: "status:free",
  });
  const sent = mock.last();
  assert.equal(sent.method, "PUT");
  assert.equal(sent.pathname, `${API}/posts/p1/`);
  assert.deepEqual(sent.query, { save_revision: "true", newsletter: "weekly", email_segment: "status:free" });
  assert.equal(sent.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(sent.body), { posts: [{ updated_at: "2026-01-01T00:00:00.000Z", title: "x" }] });
});

test("update_post_seo and update_post_tags validate and send the right body", async () => {
  mock.reply({ json: { posts: [{ id: "p1", updated_at: "new", meta_title: "T" }] } });
  const seo = await server.call("update_post_seo", { id: "p1", updated_at: "u", meta_title: "T", og_title: "O" });
  assert.equal(seo.isError, false);
  assert.deepEqual(seo.json, { id: "p1", updated_at: "new", meta_title: "T" });
  assert.deepEqual(JSON.parse(mock.last().body), { posts: [{ updated_at: "u", meta_title: "T", og_title: "O" }] });

  const count = mock.requests.length;
  assert.equal((await server.call("update_post_seo", { id: "p1", updated_at: "u" })).isError, true);
  assert.equal((await server.call("update_post_tags", { id: "p1", updated_at: "u", tags: ["a", " "] })).isError, true);
  assert.equal((await server.call("update_post_tags", { id: "p1", updated_at: "u", tags: "a" })).isError, true);
  assert.equal(mock.requests.length, count);

  mock.reply({ json: { posts: [{ id: "p1", updated_at: "new", tags: [{ name: "SEO" }, { name: "Ghost" }] }] } });
  const tagged = await server.call("update_post_tags", { id: "p1", updated_at: "u", tags: [" SEO ", "SEO", "Ghost"] });
  assert.deepEqual(JSON.parse(mock.last().body).posts[0].tags, [{ name: "SEO" }, { name: "Ghost" }]);
  assert.deepEqual(tagged.json.tags, ["SEO", "Ghost"]);
});

test("responses: 204 has no body, Ghost errors are readable, hints explain access", async () => {
  mock.reply({ status: 204 });
  const deleted = await server.call("delete_post", { id: "p1" });
  assert.deepEqual(deleted.json, { ok: true, status: 204 });

  mock.reply({ status: 409, json: { errors: [{ message: "Saving failed!", type: "UpdateCollisionError", context: "stale" }] } });
  const conflict = await server.call("update_post", { id: "p1", data: { updated_at: "old" } });
  assert.equal(conflict.isError, true);
  assert.match(conflict.text, /409 UpdateCollisionError: Saving failed! \(stale\)/);
  assert.doesNotMatch(conflict.text, /Hint/);

  mock.reply({ status: 403, json: { errors: [{ message: "Permission denied", type: "NoPermissionError" }] } });
  const staff = await server.call("ghost_api_request", { method: "GET", path: "/integrations/" });
  assert.match(staff.text, /403 NoPermissionError: Permission denied\. Hint: .*staff user/);

  mock.reply({ status: 403, json: { errors: [{ message: "No", type: "NoPermissionError" }] } });
  const session = await server.call("ghost_api_request", { method: "DELETE", path: "/db/" });
  assert.match(session.text, /cookie session/);

  mock.reply({ status: 404, json: { errors: [{ message: "Post not found", type: "NotFoundError" }] } });
  const missing = await server.call("get_post", { id: "nope" });
  assert.match(missing.text, /404 NotFoundError: Post not found\. Hint: .*catalog/);

  mock.reply({ status: 404, json: { errors: [{ message: "Resource not found", type: "NotFoundError" }] } });
  const unknown = await server.call("ghost_api_request", { method: "GET", path: "/nope/" });
  assert.match(unknown.text, /not in the route catalog/);

  mock.reply({ status: 502, body: "<html>bad gateway</html>", headers: { "Content-Type": "text/html" } });
  const gateway = await server.call("get_site");
  assert.equal(gateway.isError, true);
  assert.match(gateway.text, /Ghost API 502/);
});

test("downloads: text is returned inline, files go to save_to, nothing is overwritten", async () => {
  mock.reply({ headers: { "Content-Type": "text/csv" }, body: "id,title\n1,a\n" });
  const inline = await server.call("ghost_api_request", { method: "GET", path: "/posts/export/" });
  assert.equal(inline.json.text, "id,title\n1,a\n");
  assert.equal(inline.json.content_type, "text/csv");

  const bytes = Buffer.from([0, 1, 2, 3, 250, 251]);
  mock.reply({ headers: { "Content-Type": "application/zip" }, body: bytes });
  const noPath = await server.call("ghost_api_request", { method: "GET", path: "/themes/casper/download/" });
  assert.equal(noPath.json.bytes, 6);
  assert.match(noPath.json.note, /save_to/);

  const target = join(tmp, "casper.zip");
  mock.reply({ headers: { "Content-Type": "application/zip" }, body: bytes });
  const saved = await server.call("ghost_api_request", { method: "GET", path: "/themes/casper/download/", save_to: target });
  assert.deepEqual(saved.json, { ok: true, status: 200, saved_to: target, bytes: 6, content_type: "application/zip" });
  assert.deepEqual(await readFile(target), bytes);

  const count = mock.requests.length;
  const again = await server.call("ghost_api_request", { method: "GET", path: "/themes/casper/download/", save_to: target });
  assert.equal(again.isError, true);
  assert.match(again.text, /already exists/);
  assert.deepEqual(await readFile(target), bytes);

  const relative = await server.call("ghost_api_request", { method: "GET", path: "/posts/export/", save_to: "out.csv" });
  assert.equal(relative.isError, true);
  assert.match(relative.text, /absolute/);

  const hiddenTarget = await server.call("ghost_api_request", {
    method: "GET",
    path: "/posts/export/",
    save_to: join(tmp, ".ssh", "authorized_keys"),
  });
  assert.equal(hiddenTarget.isError, true);
  assert.match(hiddenTarget.text, /hidden/);

  const deleting = await server.call("ghost_api_request", { method: "DELETE", path: "/posts/p1/", save_to: target });
  assert.equal(deleting.isError, true);
  assert.equal(mock.requests.length, count, "a bad save_to must fail before any request is sent");
});

test("uploads send multipart with the MIME type Ghost checks", async () => {
  mock.reply({ json: { images: [{ url: "http://x/a.png", ref: "r1" }] } });
  const image = await server.call("upload_image", { file_path: png, ref: "r1", purpose: "icon" });
  assert.equal(image.isError, false);
  let sent = mock.last();
  let body = sent.body.toString("latin1");
  assert.equal(sent.pathname, `${API}/images/upload/`);
  assert.match(sent.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(body, /name="file"; filename="pic\.png"\r\nContent-Type: image\/png/);
  assert.match(body, /name="purpose"\r\n\r\nicon/);
  assert.match(body, /name="ref"\r\n\r\nr1/);

  await server.call("upload_image", { file_path: png });
  assert.match(mock.last().body.toString("latin1"), /name="purpose"\r\n\r\nimage/);

  await server.call("upload_theme", { file_path: zip });
  body = mock.last().body.toString("latin1");
  assert.match(body, /filename="theme\.zip"\r\nContent-Type: application\/zip/);
  assert.doesNotMatch(body, /name="purpose"/);

  await server.call("ghost_api_request", { method: "POST", path: "/members/upload/", files: { membersfile: csv } });
  body = mock.last().body.toString("latin1");
  assert.match(body, /name="membersfile"; filename="members\.csv"\r\nContent-Type: text\/csv/);

  await server.call("ghost_api_request", {
    method: "POST",
    path: "/media/upload/",
    files: { file: png, thumbnail: png },
    fields: { purpose: "video" },
  });
  body = mock.last().body.toString("latin1");
  assert.match(body, /name="thumbnail"/);
  assert.match(body, /name="purpose"\r\n\r\nvideo/);

  const count = mock.requests.length;
  assert.equal((await server.call("upload_image", { file_path: png, purpose: "banner" })).isError, true);
  assert.equal((await server.call("upload_image", { file_path: "/nonexistent/x.png" })).isError, true);
  assert.equal((await server.call("upload_image", { file_path: "relative.png" })).isError, true);
  const hidden = await server.call("upload_image", { file_path: join(tmp, ".ssh", "id_rsa.png") });
  assert.equal(hidden.isError, true);
  assert.match(hidden.text, /hidden/);
  const hiddenRaw = await server.call("ghost_api_request", {
    method: "POST",
    path: "/files/upload/",
    files: { file: "/Users/someone/.aws/credentials" },
  });
  assert.equal(hiddenRaw.isError, true);
  assert.match(hiddenRaw.text, /hidden/);
  const noFiles = await server.call("ghost_api_request", { method: "POST", path: "/media/upload/" });
  assert.equal(noFiles.isError, true);
  assert.match(noFiles.text, /multipart.*file: .*thumbnail: /);
  const both = await server.call("ghost_api_request", { method: "POST", path: "/files/upload/", files: { file: png }, body: {} });
  assert.equal(both.isError, true);
  const emptyPath = await server.call("ghost_api_request", { method: "POST", path: "/files/upload/", files: { file: "" } });
  assert.equal(emptyPath.isError, true);
  assert.equal(mock.requests.length, count);
});

test("ghost_api_request refuses paths that could leave the Admin API", async () => {
  const count = mock.requests.length;
  const bad = [
    "tags/",
    "/../settings/",
    "/posts/../../content/",
    "/posts/?x=1",
    "/posts/#x",
    "//evil.com/",
    "/a\\b",
    "/posts/%2e%2e/%2e%2e/",
    "/posts/%2E%2E/",
    "/posts/.%2e/",
    "/a%2fb/",
    "/a%5Cb/",
    "/a b/",
    "/a\nb/",
  ];
  for (const path of bad) {
    const result = await server.call("ghost_api_request", { method: "GET", path });
    assert.equal(result.isError, true, JSON.stringify(path));
  }
  assert.equal((await server.call("ghost_api_request", { method: "PATCH", path: "/posts/" })).isError, true);
  assert.equal((await server.call("ghost_api_request", { method: "GET", path: "/posts/", query: { a: {} } })).isError, true);
  assert.equal(mock.requests.length, count);

  await server.call("ghost_api_request", { method: "GET", path: "/users/email/a%40b.c/", query: { include: "roles", limit: 3 } });
  assert.equal(mock.last().pathname, `${API}/users/email/a%40b.c/`);
  assert.deepEqual(mock.last().query, { include: "roles", limit: "3" });
});

test("ghost_list_endpoints filters, searches and paginates the catalog", async () => {
  const all = (await server.call("ghost_list_endpoints", { limit: 300 })).json;
  assert.equal(all.total, 253);
  assert.equal(all.returned, 253);

  const defaultPage = (await server.call("ghost_list_endpoints")).json;
  assert.equal(defaultPage.returned, 50);

  const session = (await server.call("ghost_list_endpoints", { access: "SESSION" })).json;
  assert.deepEqual(
    session.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort(),
    ["DELETE /db/", "POST /authentication/reset/", "PUT /users/owner/"]
  );

  const members = (await server.call("ghost_list_endpoints", { group: "members", method: "GET" })).json;
  assert.ok(members.total > 5);
  assert.ok(members.endpoints.every((endpoint) => endpoint.method === "GET" && endpoint.path.startsWith("/members/")));

  const noTool = (await server.call("ghost_list_endpoints", { without_dedicated_tool: true, limit: 300 })).json;
  assert.equal(noTool.total, 253 - 55);
  assert.ok(noTool.endpoints.every((endpoint) => endpoint.tool === null));

  const gifts = (await server.call("ghost_list_endpoints", { search: "gift" })).json;
  assert.ok(gifts.total >= 6);

  const uploads = (await server.call("ghost_list_endpoints", { search: "upload", limit: 300 })).json;
  const media = uploads.endpoints.find((endpoint) => endpoint.path === "/media/upload/");
  assert.deepEqual(media.upload, ["file", "thumbnail"]);

  const flagged = (await server.call("ghost_list_endpoints", { group: "apps" })).json;
  assert.ok(flagged.endpoints.every((endpoint) => endpoint.flag === "apps"));

  const tokenUrl = (await server.call("ghost_list_endpoints", { search: "flush" })).json;
  assert.ok(tokenUrl.endpoints.every((endpoint) => endpoint.token_url === true));

  const page = (await server.call("ghost_list_endpoints", { offset: 250, limit: 10 })).json;
  assert.equal(page.returned, 3);
  assert.equal((await server.call("ghost_list_endpoints", { offset: 999 })).json.returned, 0);
  assert.equal((await server.call("ghost_list_endpoints", { limit: "x" })).isError, true);
});

test("large responses are truncated with a hint", async () => {
  mock.reply({ json: { big: "x".repeat(150_000) } });
  const result = await server.call("ghost_api_request", { method: "GET", path: "/posts/" });
  assert.equal(result.isError, false);
  assert.match(result.text, /truncated: the response has \d+ characters/);
  assert.ok(result.text.length < 100_400);
});

test("unknown tools are an error and stdout carries only protocol messages", async () => {
  assert.equal((await server.call("nope")).isError, true);
  assert.equal(server.stdoutNoise(), "");
  assert.match(server.stderr(), /running on stdio with 59 tools/);
});

test("server version matches package.json", async () => {
  const source = await readFile(join(PROJECT_ROOT, "src/index.ts"), "utf8");
  assert.equal(/SERVER_VERSION = "([^"]+)"/.exec(source)[1], packageJson.version);
});

function runWith(env, options) {
  return spawnSync(process.execPath, serverArgs(), {
    cwd: PROJECT_ROOT,
    env: serverEnv(env, options),
    encoding: "utf8",
    input: "",
    timeout: 30_000,
  });
}

test("startup fails clearly without configuration and never prints the key", () => {
  const missing = runWith({ GHOST_API_URL: "", GHOST_ADMIN_API_KEY: "" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing configuration: GHOST_API_URL and GHOST_ADMIN_API_KEY/);

  const secret = "topsecretvalue123";
  const invalid = runWith({ GHOST_API_URL: "http://127.0.0.1:1", GHOST_ADMIN_API_KEY: secret });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid format/);
  assert.equal(invalid.stderr.includes(secret), false);
  assert.equal(invalid.stdout, "");
});

test("redirects are never followed: no credentials or bodies leave the Admin API", async () => {
  const other = await startMock();
  try {
    const cases = [
      { name: "same origin, outside the Admin API", status: 302, location: "/ghost/api/content/posts/?key=x" },
      { name: "other origin", status: 301, location: `http://127.0.0.1:${other.port}/ghost/api/admin/posts/` },
      { name: "other protocol", status: 301, location: "https://example.invalid/ghost/api/admin/posts/" },
      { name: "307 with a JSON body", status: 307, location: `http://127.0.0.1:${other.port}/x/` },
      { name: "308 with a JSON body", status: 308, location: `http://127.0.0.1:${other.port}/x/` },
    ];
    for (const { name, status, location } of cases) {
      const count = mock.requests.length;
      mock.reply({ status, headers: { Location: location } });
      const result = await server.call("update_post", { id: "p1", data: { updated_at: "u", title: "t" } });
      assert.equal(result.isError, true, name);
      assert.match(result.text, new RegExp(`${status}`), name);
      assert.match(result.text, /redirect/i, name);
      assert.match(result.text, /GHOST_API_URL/, name);
      assert.equal(mock.requests.length, count + 1, `${name}: exactly one request`);
    }

    const count = mock.requests.length;
    mock.reply({ status: 307, headers: { Location: `http://127.0.0.1:${other.port}/upload/` } });
    const upload = await server.call("upload_image", { file_path: png });
    assert.equal(upload.isError, true);
    assert.equal(mock.requests.length, count + 1);

    mock.reply({ status: 302, headers: { Location: "/ghost/api/admin/posts/" } });
    mock.reply({ status: 302, headers: { Location: "/ghost/api/admin/posts/" } });
    const loop = await server.call("get_posts");
    assert.equal(loop.isError, true);
    assert.equal(mock.requests.length, count + 2, "a redirect loop must stop at the first answer");
    mock.reply({ json: { mock: "drain" } });
    await server.call("get_site");

    assert.equal(other.requests.length, 0, "nothing may reach the redirect targets");
    const normal = await server.call("get_site");
    assert.equal(normal.isError, false);
  } finally {
    await other.close();
  }
});

test("annotations describe the real effect of every tool", () => {
  const readOnly = (tool) => tool.name.startsWith("get_") || tool.name === "ghost_list_endpoints";
  const additive = (tool) =>
    tool.name.startsWith("create_") ||
    tool.name.startsWith("copy_") ||
    tool.name === "upload_image" ||
    tool.name === "invite_user";
  const destructive = (tool) =>
    tool.name.startsWith("update_") ||
    tool.name.startsWith("delete_") ||
    ["activate_theme", "upload_theme", "ghost_api_request"].includes(tool.name);

  for (const tool of tools) {
    const classes = [readOnly(tool), additive(tool), destructive(tool)].filter(Boolean).length;
    assert.equal(classes, 1, `${tool.name} must fall into exactly one class`);
    if (readOnly(tool)) {
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations.destructiveHint, false, tool.name);
    } else if (additive(tool)) {
      assert.equal(tool.annotations.readOnlyHint, false, tool.name);
      assert.equal(tool.annotations.destructiveHint, false, tool.name);
    } else {
      assert.equal(tool.annotations.readOnlyHint, false, tool.name);
      assert.equal(tool.annotations.destructiveHint, true, tool.name);
    }
  }
  for (const name of ["update_post", "update_page", "update_post_seo", "update_post_tags", "activate_theme", "upload_theme"]) {
    assert.equal(toolByName(name).annotations.destructiveHint, true, name);
  }
});

async function writeEnvFile(name, lines) {
  const file = join(tmp, name);
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

test("the project .env is never read when configuration is already supplied", async () => {
  const supplied = {
    GHOST_API_URL: `http://127.0.0.1:${mock.port}`,
    GHOST_ADMIN_API_KEY: `${KEY_ID}:${KEY_SECRET}`,
  };
  const withoutSkip = await startServer(supplied, { skipDotenv: false });
  try {
    assert.equal((await withoutSkip.call("get_site")).isError, false);
    assert.doesNotMatch(withoutSkip.stderr(), new RegExp(GUARD_MARKER));
  } finally {
    withoutSkip.close();
  }
  assert.doesNotMatch(server.stderr(), new RegExp(GUARD_MARKER));

  const startup = runWith(supplied, { skipDotenv: false });
  assert.doesNotMatch(startup.stderr, new RegExp(GUARD_MARKER));
});

test("configuration can come from a synthetic env file, and the environment wins", async () => {
  const file = await writeEnvFile("synthetic.env", [
    `GHOST_API_URL=http://127.0.0.1:${mock.port}`,
    `GHOST_ADMIN_API_KEY=${KEY_ID}:${KEY_SECRET}`,
  ]);
  const fromFile = await startServer(
    { GHOST_API_URL: null, GHOST_ADMIN_API_KEY: null, GHOST_MCP_ENV_FILE: file },
    { skipDotenv: false }
  );
  try {
    const count = mock.requests.length;
    assert.equal((await fromFile.call("get_site")).isError, false);
    assert.equal(mock.requests.length, count + 1);
    assert.equal(mock.last().jwt, "ok");
    assert.doesNotMatch(fromFile.stderr(), new RegExp(GUARD_MARKER));
  } finally {
    fromFile.close();
  }

  const partial = await writeEnvFile("partial.env", [
    "GHOST_API_URL=http://127.0.0.1:1",
    `GHOST_ADMIN_API_KEY=${KEY_ID}:${KEY_SECRET}`,
  ]);
  const mixed = await startServer(
    { GHOST_API_URL: `http://127.0.0.1:${mock.port}`, GHOST_ADMIN_API_KEY: null, GHOST_MCP_ENV_FILE: partial },
    { skipDotenv: false }
  );
  try {
    const count = mock.requests.length;
    assert.equal((await mixed.call("get_site")).isError, false, "the URL from the environment must win");
    assert.equal(mock.requests.length, count + 1);
  } finally {
    mixed.close();
  }
});

test("real project credentials never become a fallback", async () => {
  const missingFile = join(tmp, "does-not-exist.env");
  const result = runWith(
    { GHOST_API_URL: null, GHOST_ADMIN_API_KEY: null, GHOST_MCP_ENV_FILE: missingFile },
    { skipDotenv: false }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing configuration/);
  assert.doesNotMatch(result.stderr, new RegExp(GUARD_MARKER));

  const skipped = runWith({ GHOST_API_URL: null, GHOST_ADMIN_API_KEY: null }, { skipDotenv: true });
  assert.notEqual(skipped.status, 0);
  assert.match(skipped.stderr, /Missing configuration/);
  assert.doesNotMatch(skipped.stderr, new RegExp(GUARD_MARKER));
});

test("README and package metadata agree on the staff-token limits and the Node version", async () => {
  const readme = await readFile(join(PROJECT_ROOT, "README.md"), "utf8");
  const restricted = ["DELETE /db/", "PUT /users/owner/", "POST /authentication/reset/"];
  for (const route of restricted) {
    assert.ok(readme.includes(route), `README must name ${route}`);
  }
  const session = (await allEndpoints())
    .filter((endpoint) => endpoint.access === "SESSION")
    .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    .sort();
  assert.deepEqual(session, [...restricted].sort());

  assert.equal(packageJson.engines.node, ">=20");
  assert.match(readme, /Node\.js 20 or newer/);
  assert.match(readme, /badge\/node-%3E%3D20-/);
  assert.doesNotMatch(readme, /Node\.js 18|node-%3E%3D18/);
});

test("truncated answers to a mutation never suggest running it again", async () => {
  const big = { json: { big: "x".repeat(150_000) } };

  mock.reply(big);
  const created = await server.call("create_tag", { data: { name: "n" } });
  assert.equal(created.isError, false);
  assert.match(created.text, /truncated: the response has \d+ characters/);
  assert.match(created.text, /already carried out/i);
  assert.match(created.text, /do not repeat/i);
  assert.doesNotMatch(created.text, /narrow it with/i);

  mock.reply(big);
  const raw = await server.call("ghost_api_request", { method: "DELETE", path: "/tags/t1/" });
  assert.match(raw.text, /already carried out/i);
  assert.doesNotMatch(raw.text, /narrow it with/i);

  mock.reply(big);
  const read = await server.call("ghost_api_request", { method: "GET", path: "/posts/" });
  assert.match(read.text, /narrow it with fields, filter or limit/i);
  mock.reply(big);
  const listing = await server.call("get_posts");
  assert.match(listing.text, /narrow it with fields, filter or limit/i);
});

test("a redirect answer gives method-aware guidance through the tools", async () => {
  const cases = [
    { name: "update_post", args: { id: "p1", data: { updated_at: "u" } }, mutation: true },
    { name: "delete_post", args: { id: "p1" }, mutation: true },
    { name: "create_tag", args: { data: { name: "n" } }, mutation: true },
    { name: "ghost_api_request", args: { method: "POST", path: "/exports/" }, mutation: true },
    { name: "get_posts", args: {}, mutation: false },
  ];
  for (const { name, args, mutation } of cases) {
    const count = mock.requests.length;
    mock.reply({ status: 303, headers: { Location: "/ghost/api/admin/elsewhere/" } });
    const result = await server.call(name, args);
    assert.equal(result.isError, true, name);
    assert.equal(mock.requests.length, count + 1, `${name}: exactly one request`);
    assert.doesNotMatch(result.text, /try again/i, name);
    if (mutation) {
      assert.match(result.text, /may have completed/i, name);
      assert.match(result.text, /before repeating/i, name);
    } else {
      assert.match(result.text, /canonical URL/, name);
      assert.doesNotMatch(result.text, /may have completed/i, name);
    }
  }
});

test("a save_to ending in a path separator is refused through the tool, before any request", async () => {
  const count = mock.requests.length;
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    const result = await server.call("ghost_api_request", {
      method,
      path: "/exports/",
      save_to: `${join(tmp, "new-file.json")}/`,
    });
    assert.equal(result.isError, true, method);
    assert.match(result.text, /must name a file/, method);
  }
  assert.equal(mock.requests.length, count, "no request may be sent");
  await assert.rejects(readFile(join(tmp, "new-file.json")));
});
