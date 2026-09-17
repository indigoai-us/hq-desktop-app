/**
 * Machine + power context recorded into every run file.
 *
 * Perf numbers from this harness are ONLY comparable within one machine in one
 * power state. A MacBook on battery throttles the GPU and parks efficiency
 * cores; the same commit can measure 40% slower with the charger out. Recording
 * the context is what lets a future reader tell "the app regressed" from "you
 * unplugged the laptop".
 */
import { execFileSync } from "node:child_process";
import os from "node:os";

function powerSource() {
  if (process.platform !== "darwin") return "unknown";
  try {
    const out = execFileSync("pmset", ["-g", "batt"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (out.includes("AC Power")) return "ac";
    if (out.includes("Battery Power")) {
      const pct = /(\d+)%/.exec(out)?.[1];
      return pct ? `battery (${pct}%)` : "battery";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function machineContext(extra = {}) {
  const cpus = os.cpus();
  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    loadAvg1m: Math.round(os.loadavg()[0] * 100) / 100,
    powerSource: powerSource(),
    node: process.version,
    ...extra,
  };
}
