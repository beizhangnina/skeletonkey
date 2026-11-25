/**
 * Resolves an account's vendor id to its index row -- specifically its
 * `usage_api` facts. Mirrors `accounts/store.ts`'s `vendorKnown`: the merged
 * index drops a shard row's id when it folds into an apis.yaml entry sharing a
 * registrable domain, so a shard file is also searched directly to recover a
 * row the merge discarded.
 */
import type { ApiEntry } from "../apis.js";
import { loadApiIndex, readShardFile, resolveShardDirs, shardFiles } from "../apis.js";
import { skeletonKeyHome } from "../paths.js";

export interface VendorEntryOptions {
  home?: string;
  apisFile?: string;
  apiShardDirs?: string[];
}

export function findVendorEntry(vendor: string, options: VendorEntryOptions = {}): ApiEntry | null {
  const home = options.home ?? skeletonKeyHome();
  const index = loadApiIndex({
    home,
    ...(options.apisFile === undefined ? {} : { apisFile: options.apisFile }),
    ...(options.apiShardDirs === undefined ? {} : { shardDirs: options.apiShardDirs }),
  });
  const target = vendor.toLowerCase();
  const direct = index.entries.find((entry) => entry.name.toLowerCase() === target);
  if (direct !== undefined) return direct;

  const shardDirs = options.apiShardDirs ?? resolveShardDirs(home);
  for (const dir of shardDirs) {
    for (const file of shardFiles(dir)) {
      const match = readShardFile(file).entries.find((entry) => entry.name.toLowerCase() === target);
      if (match !== undefined) return match;
    }
  }
  return null;
}
