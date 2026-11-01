// Preloaded into every server process the tests start (node --import test/guard-env.mjs).
// It reports, and blocks, any attempt to open the project .env file, so a test can never pick up
// real credentials by accident. The path comes from GUARD_ENV_PATH.
import fs from "node:fs";
import { resolve } from "node:path";

const guarded = process.env.GUARD_ENV_PATH ? resolve(process.env.GUARD_ENV_PATH) : undefined;

function check(target) {
  if (!guarded || (typeof target !== "string" && !(target instanceof URL) && !Buffer.isBuffer(target))) {
    return;
  }
  const path = target instanceof URL ? target.pathname : String(target);
  if (resolve(path) === guarded) {
    // dotenv swallows errors, so the marker must be written where the test can see it.
    fs.writeSync(2, `PROJECT_ENV_READ_ATTEMPT ${guarded}\n`);
    throw new Error(`Tests must not read ${guarded}`);
  }
}

for (const name of ["readFileSync", "openSync", "readFile", "open", "createReadStream", "existsSync", "statSync"]) {
  const original = fs[name];
  if (typeof original === "function") {
    fs[name] = function (target, ...rest) {
      check(target);
      return original.call(this, target, ...rest);
    };
  }
}

for (const name of ["readFile", "open", "stat"]) {
  const original = fs.promises[name];
  fs.promises[name] = async function (target, ...rest) {
    check(target);
    return original.call(this, target, ...rest);
  };
}
