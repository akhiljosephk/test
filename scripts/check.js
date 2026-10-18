"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
for (const dir of ["scripts", "tests", "src/main/resources/static"])
  for (const file of fs.readdirSync(dir))
    if (/\.(js|cjs)$/.test(file))
      execFileSync(process.execPath, ["--check", path.join(dir, file)], {
        stdio: "inherit",
      });
console.log("Browser and test-tool JavaScript syntax checks passed.");
