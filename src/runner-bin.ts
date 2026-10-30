#!/usr/bin/env node
/**
 * `skeletonkey-runner`: the trusted runner as its own binary, so the process
 * boundary in §6.2 is visible in `ps` and in a service file, not just in the
 * code. Equivalent to `skeletonkey runner`.
 */
import { main } from "./cli.js";

void main([process.argv[0] ?? "node", process.argv[1] ?? "skeletonkey-runner", "runner", ...process.argv.slice(2)]);
