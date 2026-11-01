// In-process tests of the local file handling in src/client.ts: uploads, save_to reservation,
// symlinks, and what happens when a request or a save fails.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_ID, KEY_SECRET, startMock } from "./helpers.mjs";

// The client reads its configuration when it is first imported, so set it up first.
process.env.GHOST_MCP_SKIP_DOTENV = "1";
const mock = await startMock();
process.env.GHOST_API_URL = `http://127.0.0.1:${mock.port}`;
process.env.GHOST_ADMIN_API_KEY = `${KEY_ID}:${KEY_SECRET}`;
const { buildForm, ghostRequest } = await import("../src/client.ts");

let root;
const at = (...parts) => join(root, ...parts);
const text = (body) => ({ headers: { "Content-Type": "text/plain" }, body });

before(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "ghost-mcp-files-"));
  await fsp.mkdir(at("ok"));
  await fsp.mkdir(at("out"));
  await fsp.mkdir(at(".hidden"));
  await fsp.writeFile(at("ok", "pic.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await fsp.writeFile(at(".hidden", "secret.png"), "top secret");
  await fsp.symlink(at(".hidden", "secret.png"), at("link-to-hidden-file.png"));
  await fsp.symlink(at(".hidden"), at("link-to-hidden-dir"));
  await fsp.symlink(at("ok", "pic.png"), at("link-to-visible-file.png"));
  await fsp.symlink(at("out"), at("link-to-visible-dir"));
  await fsp.writeFile(at("not-a-dir"), "i am a file");
});

after(async () => {
  await mock.close();
  await fsp.chmod(at("readonly"), 0o700).catch(() => {});
  await fsp.rm(root, { recursive: true, force: true });
});

const requestCount = () => mock.requests.length;

async function assertRejectsBeforeDispatch(label, run, pattern) {
  const count = requestCount();
  await assert.rejects(run, pattern, label);
  assert.equal(requestCount(), count, `${label}: no request may be sent`);
}

test("uploads through symlinks into hidden places are refused", async () => {
  await assertRejectsBeforeDispatch(
    "symlink to a hidden file",
    () => buildForm({ file: at("link-to-hidden-file.png") }),
    /hidden/
  );
  await assertRejectsBeforeDispatch(
    "directory symlink into a hidden directory",
    () => buildForm({ file: at("link-to-hidden-dir", "secret.png") }),
    /hidden/
  );
  await assertRejectsBeforeDispatch(
    "a hidden path spelled directly",
    () => buildForm({ file: at(".hidden", "secret.png") }),
    /hidden/
  );
});

test("ordinary uploads still work, including through symlinks to visible files", async () => {
  for (const path of [at("ok", "pic.png"), at("link-to-visible-file.png")]) {
    const form = await buildForm({ file: path }, { purpose: "image" });
    const file = form.get("file");
    assert.equal(file.name, path.endsWith("link-to-visible-file.png") ? "link-to-visible-file.png" : "pic.png");
    assert.equal(file.type, "image/png");
    assert.equal(file.size, 8);
    assert.equal(form.get("purpose"), "image");
  }
});

test("uploads accept regular files only", async () => {
  await assertRejectsBeforeDispatch("a directory", () => buildForm({ file: at("ok") }), /regular file/);
  await assertRejectsBeforeDispatch("a missing file", () => buildForm({ file: at("ok", "nope.png") }), /ENOENT|exist/);
});

test("downloads into a hidden directory are refused before any request", async () => {
  await assertRejectsBeforeDispatch(
    "directory symlink into a hidden directory",
    () => ghostRequest("GET", "/posts/export/", {}, undefined, undefined, { saveTo: at("link-to-hidden-dir", "out.csv") }),
    /hidden/
  );
  await assertRejectsBeforeDispatch(
    "a hidden folder spelled directly",
    () => ghostRequest("DELETE", "/posts/p1/", {}, undefined, undefined, { saveTo: at(".hidden", "out.csv") }),
    /hidden/
  );
  assert.deepEqual(await fsp.readdir(at(".hidden")), ["secret.png"]);
});

test("ordinary downloads work, also through a directory symlink to a visible directory", async () => {
  mock.reply(text("id,title\n1,a\n"));
  const saved = await ghostRequest("GET", "/posts/export/", {}, undefined, undefined, { saveTo: at("out", "plain.csv") });
  assert.equal(saved.saved_to, at("out", "plain.csv"));
  assert.equal(await fsp.readFile(at("out", "plain.csv"), "utf8"), "id,title\n1,a\n");
  assert.equal((await fsp.stat(at("out", "plain.csv"))).mode & 0o777, 0o600);

  mock.reply(text("via link"));
  await ghostRequest("GET", "/posts/export/", {}, undefined, undefined, { saveTo: at("link-to-visible-dir", "linked.csv") });
  assert.equal(await fsp.readFile(at("out", "linked.csv"), "utf8"), "via link");
});

test("a bad save_to is refused before the request for POST, PUT and DELETE", async (t) => {
  await fsp.writeFile(at("out", "existing.bin"), "keep me");
  await fsp.symlink("/nonexistent/target", at("out", "dangling.bin"));
  await fsp.symlink(at("ok", "pic.png"), at("out", "link-to-file.bin"));
  await fsp.mkdir(at("readonly"));
  await fsp.chmod(at("readonly"), 0o500);

  const cases = [
    { label: "missing parent", saveTo: at("no-such-dir", "out.bin"), pattern: /does not exist/ },
    { label: "parent is a file", saveTo: at("not-a-dir", "out.bin"), pattern: /not a directory/ },
    { label: "existing destination", saveTo: at("out", "existing.bin"), pattern: /already exists/ },
    { label: "dangling symlink as destination", saveTo: at("out", "dangling.bin"), pattern: /already exists/ },
    { label: "symlink to a file as destination", saveTo: at("out", "link-to-file.bin"), pattern: /already exists/ },
    { label: "relative path", saveTo: "relative.bin", pattern: /absolute/ },
  ];
  if (process.getuid?.() !== 0) {
    cases.push({ label: "unwritable directory", saveTo: at("readonly", "out.bin"), pattern: /not writable|permission/i });
  } else {
    t.diagnostic("running as root: the permission case is skipped");
  }

  for (const { label, saveTo, pattern } of cases) {
    for (const method of ["POST", "PUT", "DELETE"]) {
      await assertRejectsBeforeDispatch(
        `${label} (${method})`,
        () => ghostRequest(method, "/posts/p1/", {}, undefined, undefined, { saveTo }),
        pattern
      );
    }
  }
  assert.equal(await fsp.readFile(at("out", "existing.bin"), "utf8"), "keep me");
  assert.equal(await fsp.readFile(at("ok", "pic.png")).then((buffer) => buffer.length), 8);
  await assert.rejects(fsp.stat(at("no-such-dir")));
});

test("two concurrent calls to the same save_to never overwrite each other", async () => {
  const target = at("out", "race.bin");
  mock.reply(text("winner"));
  const count = requestCount();
  const results = await Promise.allSettled([
    ghostRequest("GET", "/posts/export/", {}, undefined, undefined, { saveTo: target }),
    ghostRequest("GET", "/posts/export/", {}, undefined, undefined, { saveTo: target }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(requestCount(), count + 1, "only the call that reserved the file may send a request");
  assert.equal(await fsp.readFile(target, "utf8"), "winner");
});

test("a failed request leaves no reserved file behind", async () => {
  const before = (await fsp.readdir(at("out"))).sort();

  mock.reply({ status: 409, json: { errors: [{ message: "Saving failed!", type: "UpdateCollisionError" }] } });
  await assert.rejects(
    ghostRequest("PUT", "/posts/p1/", {}, { posts: [{}] }, undefined, { saveTo: at("out", "http-error.bin") }),
    /409 UpdateCollisionError/
  );

  mock.reply({ destroy: true });
  await assert.rejects(
    ghostRequest("DELETE", "/posts/p1/", {}, undefined, undefined, { saveTo: at("out", "network-error.bin") }),
    /may or may not have completed/
  );

  assert.deepEqual((await fsp.readdir(at("out"))).sort(), before);
});

test("network failures warn that a mutation may have happened, except for reads", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    mock.reply({ destroy: true });
    await assert.rejects(ghostRequest(method, "/posts/p1/"), /may or may not have completed.*before repeating/s, method);
  }
  mock.reply({ destroy: true });
  await assert.rejects(ghostRequest("GET", "/posts/"), (error) => {
    assert.match(error.message, /Ghost request failed/);
    assert.doesNotMatch(error.message, /may or may not have completed/);
    return true;
  });
});

test("when saving fails after the request was sent, the partial file is removed and the user is warned", async () => {
  const probe = await fsp.open(at("ok", "pic.png"));
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.writeFile;
  prototype.writeFile = async function () {
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  };
  try {
    const count = requestCount();
    mock.reply(text("payload"));
    await assert.rejects(
      ghostRequest("DELETE", "/posts/p1/", {}, undefined, undefined, { saveTo: at("out", "disk-full.bin") }),
      /request was sent.*may have completed.*do not repeat/is
    );
    assert.equal(requestCount(), count + 1);
    await assert.rejects(fsp.stat(at("out", "disk-full.bin")));
  } finally {
    prototype.writeFile = original;
  }
});

test("a redirect after a mutation warns that it may already have been carried out", async () => {
  const other = await startMock();
  try {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const count = requestCount();
      mock.reply({ status: 303, headers: { Location: `http://127.0.0.1:${other.port}/ghost/api/admin/exports/download/` } });
      await assert.rejects(ghostRequest(method, "/exports/", {}, method === "DELETE" ? undefined : { exports: [{}] }), (error) => {
        assert.match(error.message, /may have completed/i, method);
        assert.match(error.message, /before repeating/i, method);
        assert.match(error.message, /GHOST_API_URL/, method);
        assert.doesNotMatch(error.message, /try again/i, method);
        return true;
      });
      assert.equal(requestCount(), count + 1, `${method}: exactly one request`);
    }

    const count = requestCount();
    mock.reply({ status: 301, headers: { Location: `http://127.0.0.1:${other.port}/ghost/api/admin/posts/` } });
    await assert.rejects(ghostRequest("GET", "/posts/"), (error) => {
      assert.match(error.message, /canonical URL/);
      assert.match(error.message, /GHOST_API_URL/);
      assert.doesNotMatch(error.message, /may have completed|before repeating/i);
      return true;
    });
    assert.equal(requestCount(), count + 1);
    assert.equal(other.requests.length, 0, "redirect targets must receive nothing");
  } finally {
    await other.close();
  }
});

test("a binary or oversized answer to a mutation never tells the caller to repeat it", async () => {
  const zipBytes = Buffer.from([0x50, 0x4b, 3, 4, 250, 251]);
  const bigText = { headers: { "Content-Type": "text/csv" }, body: "x".repeat(250_000) };
  for (const method of ["POST", "PUT", "DELETE"]) {
    for (const [label, reply] of [
      ["binary", { headers: { "Content-Type": "application/zip" }, body: zipBytes }],
      ["oversized text", bigText],
    ]) {
      const count = requestCount();
      mock.reply(reply);
      const result = await ghostRequest(method, "/exports/");
      assert.equal(requestCount(), count + 1, `${method} ${label}: exactly one request`);
      assert.doesNotMatch(result.note, /repeat the call/i, `${method} ${label}`);
      assert.match(result.note, /already carried out/i, `${method} ${label}`);
      assert.match(result.note, /do not repeat/i, `${method} ${label}`);
      assert.match(result.note, /save_to on the first call/i, `${method} ${label}`);
    }
  }

  for (const [label, reply] of [
    ["binary", { headers: { "Content-Type": "application/zip" }, body: zipBytes }],
    ["oversized text", bigText],
  ]) {
    mock.reply(reply);
    const result = await ghostRequest("GET", "/exports/download/");
    assert.match(result.note, /Repeat the call with save_to/, `GET ${label} keeps the download guidance`);
  }
});

test("save_to on the first call of a mutation saves its response without sending it twice", async () => {
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 250, 251]);
  const target = at("out", "export.zip");
  const count = requestCount();
  mock.reply({ headers: { "Content-Type": "application/zip" }, body: bytes });
  const saved = await ghostRequest("POST", "/exports/", {}, undefined, undefined, { saveTo: target });
  assert.equal(requestCount(), count + 1, "the mutation must be sent exactly once");
  assert.deepEqual(await fsp.readFile(saved.saved_to), bytes);
});

test("a save_to that ends in a path separator is refused before any request", async () => {
  await fsp.mkdir(at("out", "existing-dir"), { recursive: true });
  await fsp.writeFile(at("out", "existing-dir", "keep.txt"), "keep");
  const before = (await fsp.readdir(at("out"))).sort();

  const spellings = [
    { label: "new name with a slash", saveTo: `${at("out", "new-file.json")}/` },
    { label: "new name with two slashes", saveTo: `${at("out", "new-file.json")}//` },
    { label: "missing folder with a slash", saveTo: `${at("out", "no-such-folder")}/` },
    { label: "existing folder with a slash", saveTo: `${at("out", "existing-dir")}/` },
    { label: "the download folder itself with a slash", saveTo: `${at("out")}/` },
  ];
  for (const { label, saveTo } of spellings) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      await assertRejectsBeforeDispatch(
        `${label} (${method})`,
        () => ghostRequest(method, "/exports/", {}, undefined, undefined, { saveTo }),
        /must name a file/
      );
    }
  }
  assert.deepEqual((await fsp.readdir(at("out"))).sort(), before, "nothing may be created or removed");
  assert.equal(await fsp.readFile(at("out", "existing-dir", "keep.txt"), "utf8"), "keep");

  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    await assertRejectsBeforeDispatch(
      `existing folder without a slash (${method})`,
      () => ghostRequest(method, "/exports/", {}, undefined, undefined, { saveTo: at("out", "existing-dir") }),
      /already exists/
    );
  }
  assert.deepEqual(await fsp.readdir(at("out", "existing-dir")), ["keep.txt"]);
});

test("every successful saved_to can be opened and holds the exact response", async () => {
  for (const [name, saveTo] of [
    ["plain", at("out", "usable-plain.json")],
    ["through a folder link", at("link-to-visible-dir", "usable-linked.json")],
    ["with a redundant segment", at("out", ".", "usable-dot.json")],
  ]) {
    const body = JSON.stringify({ name });
    mock.reply({ headers: { "Content-Type": "application/json" }, body });
    const saved = await ghostRequest("GET", "/exports/download/", {}, undefined, undefined, { saveTo });
    assert.equal(saved.saved_to, saveTo, name);
    assert.equal(await fsp.readFile(saved.saved_to, "utf8"), body, name);
  }
});

test("a path with a .. segment is refused with a message that names the real problem", async () => {
  const withDots = (...parts) => `${at(...parts)}/../${parts.at(-1)}`;
  const count = requestCount();

  await assert.rejects(buildForm({ file: `${at("ok")}/../ok/pic.png` }), (error) => {
    assert.match(error.message, /"\.\."/);
    assert.doesNotMatch(error.message, /hidden/);
    return true;
  });
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    await assert.rejects(
      ghostRequest(method, "/exports/", {}, undefined, undefined, { saveTo: `${at("out")}/../out/dots.bin` }),
      (error) => {
        assert.match(error.message, /"\.\."/, method);
        assert.doesNotMatch(error.message, /hidden/, method);
        return true;
      }
    );
  }
  assert.equal(requestCount(), count, "no request may be sent");
  await assert.rejects(fsp.stat(at("out", "dots.bin")));
  assert.ok(withDots("x").endsWith("/../x"));

  // A plain "." segment is harmless and still accepted, and a real hidden folder keeps its own message.
  await buildForm({ file: `${at("ok")}/./pic.png` });
  await assert.rejects(buildForm({ file: at(".hidden", "secret.png") }), /hidden/);
});
