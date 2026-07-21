/**
 * Contained file writes into an existing plain git clone.
 *
 * A standalone model type rather than an extension of
 * `@twonines/git-workspace`. It was originally authored as
 * `export const extension = { type: "@twonines/git-workspace", ... }`, per
 * the "extend, don't be clever" rule — the domain (a git workspace) is
 * already covered by an installed type, so a new method was the right
 * first move. That approach was abandoned after two independent,
 * empirically-confirmed problems with method/resource extension on this
 * deployed Swamp build (rubric version 3, CLI built ~51 days before this
 * was written):
 *
 * 1. Declaring a new `resources` entry on `export const extension` builds
 *    cleanly and the method registers, but every call to
 *    `context.writeResource` against it then fails at runtime with
 *    `Undeclared resource spec 'write' in model '@twonines/git-workspace'`
 *    — the extension's `resources` field is silently dropped somewhere
 *    between build and the runtime resource registry, even though
 *    `methods` merges correctly.
 * 2. Even the `methods` merge itself proved nondeterministic: four
 *    consecutive, unmodified `swamp model type describe
 *    @twonines/git-workspace --json` calls returned the merged
 *    `write_file` method on three of them and silently omitted it on the
 *    fourth, with `swamp doctor extensions --json` in between showing the
 *    extension's own bundle flipping between `Indexed` and
 *    `BundleBuildFailed` (`Error: Method 'write_file' already exists on
 *    model type '@twonines/git-workspace'`) with no source change between
 *    calls — a self-conflicting duplicate-registration race in the
 *    extension loader itself.
 *
 * Shipping a write path (however well-contained) whose *availability* is a
 * coin flip is worse than not shipping it, so this is a plain new model
 * type instead: `export const model`, its own resource spec, one load,
 * no merge step, no race.
 *
 * The containment guarantees are unchanged from the abandoned extension
 * attempt:
 *
 * - `localPath` must already exist, resolve (via `Deno.realPath`) to a
 *   real directory, and contain a `.git` entry (directory or file, so
 *   worktrees/submodules still count) — this method never clones or
 *   creates a repository, only writes into one that is already there;
 * - the target `path` is resolved against that real, symlink-resolved
 *   root. Absolute paths, `..`/`.`/empty segments, and null bytes are
 *   rejected outright. Any symlink encountered while walking the path —
 *   an existing intermediate directory or the leaf itself — is resolved
 *   with `Deno.realPath` and re-checked against the real root, so a
 *   symlink planted inside the repo cannot be used to escape it, and a
 *   symlink that resolves back into the repo but under `.git/` is still
 *   refused;
 * - `.git/**` is refused unconditionally, both as a literal path prefix
 *   and after symlink resolution — writing there could rewrite hooks,
 *   config, or refs, and a hook write is remote code execution on the
 *   next git operation in that workspace;
 * - the write itself is plain Deno file I/O — no subprocess, no shell, so
 *   the command-injection risk category that applies to shell-backed
 *   tools does not apply here.
 *
 * `localPath` is a per-call, caller-supplied argument (there is no
 * "workspace" concept here to constrain it implicitly), so an
 * unconstrained write would be an arbitrary-file-write primitive anywhere
 * the process user can reach — exactly the capability the `file` toolset
 * was deliberately removed to deny. Every guarantee above exists because
 * of that, not in spite of it.
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";

/** Everything this model's single method needs from the execution context. */
interface WriteFileContext {
  logger: { info: (msg: string, ...args: unknown[]) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Arguments accepted by `write_file`. */
interface WriteFileArgs {
  project: string;
  localPath: string;
  path: string;
  content: string;
}

/** Result persisted under the `write` resource spec. */
interface WriteResult {
  project: string;
  localPath: string;
  path: string;
  bytesWritten: number;
  created: boolean;
  writtenAt: string;
}

const WriteOutputSchema = z.object({
  project: z.string(),
  localPath: z.string(),
  path: z.string(),
  bytesWritten: z.number(),
  created: z.boolean(),
  writtenAt: z.string(),
});

/** Raised for any path that fails the containment checks below. */
class ContainmentError extends Error {}

/**
 * Split a caller-supplied repo-relative path into clean segments, or throw
 * `ContainmentError` if it is absolute, contains `..`/`.`/empty segments,
 * a null byte, or targets `.git` as its first segment.
 */
function normalizeRelativePath(rawPath: string): string[] {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new ContainmentError("path must be a non-empty string");
  }
  if (rawPath.includes("\x00")) {
    throw new ContainmentError("path contains a null byte");
  }
  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new ContainmentError("path must not be absolute");
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ContainmentError(
        `path segment '${segment || "(empty)"}' is not allowed`,
      );
    }
  }
  if (segments[0] === ".git") {
    throw new ContainmentError("writes under .git/ are refused");
  }
  return segments;
}

/** True when `candidate` is `root` itself or nested inside it. */
function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + "/");
}

/**
 * Throw `ContainmentError` if `current` (an absolute path known to be
 * within `root`) has entered `.git` — catches a symlink inside the repo
 * that resolves back under the repo's own `.git` directory, which
 * `isWithinRoot` alone would not flag as an escape.
 */
function assertNotInsideGit(root: string, current: string): void {
  if (current === root) return;
  const relative = current.slice(root.length + 1);
  if (relative.split("/")[0] === ".git") {
    throw new ContainmentError("writes under .git/ are refused");
  }
}

/**
 * Resolve `segments` against `realRoot`, following any symlink encountered
 * along the way (an existing intermediate directory or the leaf) through
 * `Deno.realPath` and re-verifying containment at each step. Segments that
 * do not exist yet are joined literally — they will be created fresh by
 * this method, never traversed through a pre-existing symlink. Throws
 * `ContainmentError` if any resolved step escapes `realRoot` or lands
 * inside `.git`.
 */
async function resolveContained(
  realRoot: string,
  segments: string[],
): Promise<string> {
  let current = realRoot;
  for (const segment of segments) {
    const next = `${current}/${segment}`;
    let isSymlink = false;
    try {
      const info = await Deno.lstat(next);
      isSymlink = info.isSymlink;
    } catch {
      // Does not exist yet — fine, it will be created under `current`.
    }
    if (isSymlink) {
      const resolved = await Deno.realPath(next);
      if (!isWithinRoot(realRoot, resolved)) {
        throw new ContainmentError(
          `path escapes repository root via symlink at '${segment}'`,
        );
      }
      assertNotInsideGit(realRoot, resolved);
      current = resolved;
    } else {
      current = next;
      assertNotInsideGit(realRoot, current);
    }
  }
  if (!isWithinRoot(realRoot, current)) {
    throw new ContainmentError("path escapes repository root");
  }
  return current;
}

/** Contained file-write model for an existing plain git clone. */
export const model = {
  type: "@mgreten/contained-git-write",
  version: "2026.07.20.1",
  description:
    "Write a file into an existing git clone, refusing any path that " +
    "escapes the repository root or targets .git/. Does not clone, " +
    "branch, commit, or push — pair it with a workspace-managing model " +
    "(e.g. @twonines/git-workspace) for the rest of the git lifecycle.",
  globalArguments: z.object({}),
  resources: {
    write: {
      description: "Result of a contained file write into a git clone",
      schema: WriteOutputSchema,
      lifetime: "30m" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    write_file: {
      description: "Write content to a file inside an existing git clone at " +
        "localPath, refusing any path that escapes the repository root " +
        "or targets .git/. Creates parent directories as needed.",
      arguments: z.object({
        project: z.string().describe(
          "Descriptive label for the target repo (e.g. myorg/my-repo). " +
            "Not used to resolve the path — localPath is authoritative.",
        ),
        localPath: z.string().describe(
          "Absolute path to an existing git clone's working directory.",
        ),
        path: z.string().describe(
          "File path relative to repo root (no .. or absolute paths, " +
            "and nothing under .git/).",
        ),
        content: z.string().describe("Full content to write to the file."),
      }),
      execute: async (
        args: WriteFileArgs,
        context: WriteFileContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        let realRoot: string;
        try {
          realRoot = await Deno.realPath(args.localPath);
        } catch (e) {
          throw new Error(
            `Workspace '${args.localPath}' does not exist: ${
              (e as Error).message
            }.`,
          );
        }

        const rootInfo = await Deno.stat(realRoot).catch(() => null);
        if (!rootInfo || !rootInfo.isDirectory) {
          throw new Error(`Workspace '${realRoot}' is not a directory.`);
        }

        const gitEntry = await Deno.lstat(`${realRoot}/.git`).catch(
          () => null,
        );
        if (!gitEntry) {
          throw new Error(
            `'${realRoot}' has no .git entry — refusing to write into a ` +
              "directory that is not a git repository.",
          );
        }

        let segments: string[];
        let targetPath: string;
        try {
          segments = normalizeRelativePath(args.path);
          targetPath = await resolveContained(realRoot, segments);
        } catch (e) {
          if (e instanceof ContainmentError) {
            throw new Error(`Refusing to write '${args.path}': ${e.message}`);
          }
          throw e;
        }

        let existedBefore: boolean;
        try {
          const existing = await Deno.lstat(targetPath);
          if (existing.isDirectory) {
            throw new Error(
              `'${args.path}' is an existing directory, not a file.`,
            );
          }
          existedBefore = true;
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) {
            existedBefore = false;
          } else {
            throw e;
          }
        }

        const parentDir = targetPath.slice(0, targetPath.lastIndexOf("/"));
        await Deno.mkdir(parentDir, { recursive: true });

        const encoded = new TextEncoder().encode(args.content);
        await Deno.writeFile(targetPath, encoded);

        const result: WriteResult = {
          project: args.project,
          localPath: realRoot,
          path: args.path,
          bytesWritten: encoded.byteLength,
          created: !existedBefore,
          writtenAt: new Date().toISOString(),
        };

        context.logger.info(
          "Wrote {path} into {project} ({localPath}): {bytesWritten} " +
            "bytes, created={created}",
          {
            path: args.path,
            project: args.project,
            localPath: realRoot,
            bytesWritten: result.bytesWritten,
            created: result.created,
          },
        );

        const instanceName = `${args.project}--${args.path}`.replace(
          /\//g,
          "--",
        );
        const handle = await context.writeResource(
          "write",
          instanceName,
          result as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
