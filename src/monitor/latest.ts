/** `skeletonkey monitor report`: finds the most recent `weekly-*.md` report. */
import fs from "node:fs";
import path from "node:path";
import { monitorReportsDir, skeletonKeyHome } from "../paths.js";

export interface LatestReport {
  path: string;
  content: string;
}

/** `weekly-YYYY-MM-DD.md` sorts lexically the same as chronologically. */
export function findLatestReport(home = skeletonKeyHome(), dir?: string): LatestReport | null {
  const reportsDir = dir ?? monitorReportsDir(home);
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs
    .readdirSync(reportsDir)
    .filter((name) => /^weekly-\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort();
  const latest = files.at(-1);
  if (latest === undefined) return null;
  const file = path.join(reportsDir, latest);
  return { path: file, content: fs.readFileSync(file, "utf8") };
}
