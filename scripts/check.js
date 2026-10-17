"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
for (const dir of ["backend", "public", "scripts"])
  for (const file of fs.readdirSync(dir))
    if (file.endsWith(".js"))
      execFileSync(process.execPath, ["--check", path.join(dir, file)], {
        stdio: "inherit",
      });
for (const file of ["app.js", "server.js"])
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log("JavaScript syntax checks passed.");
