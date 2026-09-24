"use strict";

const fs = require("node:fs");
const path = require("node:path");
const reportDirectory = process.report && process.report.directory;

if (typeof reportDirectory === "string" && reportDirectory.length > 0) {
  process.on("SIGUSR2", () => {
    try {
      const arrayBuffers = process.memoryUsage().arrayBuffers;
      if (!Number.isSafeInteger(arrayBuffers) || arrayBuffers < 0) return;

      const destination = path.join(reportDirectory, "runner-memory-class.json");
      const temporary = destination + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify({ arrayBuffers }), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporary, destination);
    } catch (error) {
      process.emitWarning(error);
    }
  });
}
