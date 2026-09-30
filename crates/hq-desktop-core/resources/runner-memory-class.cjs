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
      let prior = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(destination, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prior = parsed;
      } catch (_) {
        // The signal may be the first writer or race an incomplete first sample.
      }
      fs.writeFileSync(temporary, JSON.stringify({ ...prior, arrayBuffers }), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporary, destination);
    } catch (error) {
      process.emitWarning(error);
    }
  });
}
