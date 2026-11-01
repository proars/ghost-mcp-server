import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseList } from "../scripts/generate-catalog.mjs";
import { CATALOG } from "../src/catalog.ts";
import { matchRoute, ROUTES, routeKey } from "../src/routes.ts";

const list = parseList(readFileSync(fileURLToPath(new URL("../GHOST_API.list", import.meta.url)), "utf8"));

test("catalog in code has exactly the routes of GHOST_API.list", () => {
  const fromList = list.routes.map((route) => `${route.method} ${route.path}`).sort();
  const fromCode = CATALOG.map(([method, path]) => `${method} ${path}`).sort();
  assert.equal(list.routes.length, 253);
  assert.deepEqual(fromCode, fromList);
});

test("every catalog field matches GHOST_API.list (run npm run catalog if this fails)", () => {
  assert.equal(CATALOG.length, list.routes.length);
  list.routes.forEach((expected, index) => {
    const [method, path, handler, access, group, source, summary, extra] = CATALOG[index];
    assert.deepEqual(
      { method, path, handler, access, group, source, summary, extra: extra ?? {} },
      {
        method: expected.method,
        path: expected.path,
        handler: expected.handler,
        access: expected.access,
        group: expected.group,
        source: expected.source,
        summary: expected.summary,
        extra: expected.extra,
      },
      `${expected.method} ${expected.path}`
    );
  });
});

test("access class totals match the list header", () => {
  const counts = {};
  for (const route of ROUTES) {
    counts[route.access] = (counts[route.access] ?? 0) + 1;
  }
  assert.deepEqual(counts, { PUBLIC: 1, I: 124, U: 116, SESSION: 3, FLOW: 9 });
  assert.equal(new Set(ROUTES.map((route) => route.group)).size, 54);
});

test("route keys are unique", () => {
  const keys = ROUTES.map((route) => routeKey(route.method, route.path));
  assert.equal(new Set(keys).size, keys.length);
});

test("matchRoute resolves every catalog route to itself", () => {
  for (const route of ROUTES) {
    const concrete = route.path.replace(/\{(\w+)\}/g, "value");
    const found = matchRoute(route.method, concrete);
    assert.ok(found, `${route.method} ${concrete} did not match`);
    assert.equal(routeKey(found.method, found.path), routeKey(route.method, route.path), concrete);
  }
});

test("matchRoute prefers static segments over parameters", () => {
  assert.equal(matchRoute("GET", "/posts/export/")?.handler, "posts.exportCSV");
  assert.equal(matchRoute("GET", "/posts/abc/")?.handler, "posts.read");
  assert.equal(matchRoute("PUT", "/users/owner/")?.handler, "users.transferOwnership");
  assert.equal(matchRoute("PUT", "/users/abc/")?.handler, "users.edit");
  assert.equal(matchRoute("GET", "/themes/active/")?.handler, "themes.readActive");
  assert.equal(matchRoute("GET", "/posts/abc")?.handler, "posts.read");
  assert.equal(matchRoute("GET", "/not/a/route/"), undefined);
});
