/**
 * Containment tests for `@mgreten/contained-git-write`'s `write_file`
 * method.
 *
 * These exercise `model.methods.write_file.execute(args, context)` directly
 * against real temp-directory "repos" (a plain directory containing a `.git`
 * entry — the method only checks for that entry's existence, it never
 * inspects or requires a functioning git repository, so a stub `.git`
 * directory is sufficient and avoids shelling out to a `git` subprocess).
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { model } from "./model.ts";

const writeFile = model.methods.write_file;

/** Minimal shape written by the fake `context.writeResource` below. */
interface RecordedWrite {
  specName: string;
  name: string;
  data: Record<string, unknown>;
}

interface FakeContext {
  logger: { info: (msg: string, ...args: unknown[]) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  written: RecordedWrite[];
}

function makeContext(): FakeContext {
  const written: RecordedWrite[] = [];
  return {
    written,
    logger: { info: () => {} },
    writeResource: (specName, name, data) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
  };
}

/** A temp dir with a stub `.git` entry, satisfying the method's repo check. */
async function makeTempRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "contained-git-write-test-" });
  await Deno.mkdir(`${dir}/.git`);
  return dir;
}

Deno.test("write_file rejects a relative path containing .. that escapes the repo root", async () => {
  const repo = await makeTempRepo();
  try {
    const context = makeContext();
    await assertRejects(
      () =>
        writeFile.execute(
          {
            project: "test/project",
            localPath: repo,
            path: "../escape.txt",
            content: "hi",
          },
          context,
        ),
      Error,
      "path segment '..' is not allowed",
    );
    assertEquals(context.written.length, 0);
    const escaped = await Deno.stat(`${repo}/../escape.txt`).catch(() => null);
    assertEquals(escaped, null);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("write_file rejects an absolute target path", async () => {
  const repo = await makeTempRepo();
  try {
    const context = makeContext();
    await assertRejects(
      () =>
        writeFile.execute(
          {
            project: "test/project",
            localPath: repo,
            path: "/etc/passwd",
            content: "hi",
          },
          context,
        ),
      Error,
      "path must not be absolute",
    );
    assertEquals(context.written.length, 0);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("write_file rejects a path that escapes the repo root via a symlink", async () => {
  const repo = await makeTempRepo();
  const outside = await Deno.makeTempDir({
    prefix: "contained-git-write-outside-",
  });
  try {
    // A symlink planted inside the repo pointing at a directory outside it.
    await Deno.symlink(outside, `${repo}/escape-link`, { type: "dir" });

    const context = makeContext();
    await assertRejects(
      () =>
        writeFile.execute(
          {
            project: "test/project",
            localPath: repo,
            path: "escape-link/pwned.txt",
            content: "hi",
          },
          context,
        ),
      Error,
      "escapes repository root via symlink",
    );
    assertEquals(context.written.length, 0);

    const outsideEntries: string[] = [];
    for await (const entry of Deno.readDir(outside)) {
      outsideEntries.push(entry.name);
    }
    assertEquals(outsideEntries, [], "nothing should be written outside the repo");
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("write_file rejects a write into .git/", async () => {
  const repo = await makeTempRepo();
  try {
    const context = makeContext();
    await assertRejects(
      () =>
        writeFile.execute(
          {
            project: "test/project",
            localPath: repo,
            path: ".git/hooks/pre-commit",
            content: "#!/bin/sh\necho pwned",
          },
          context,
        ),
      Error,
      "writes under .git/ are refused",
    );
    assertEquals(context.written.length, 0);
    const hook = await Deno.stat(`${repo}/.git/hooks/pre-commit`).catch(() =>
      null
    );
    assertEquals(hook, null);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("write_file writes a file inside the repo on the happy path", async () => {
  const repo = await makeTempRepo();
  try {
    const context = makeContext();
    const result = await writeFile.execute(
      {
        project: "org/repo",
        localPath: repo,
        path: "src/nested/hello.txt",
        content: "hello world",
      },
      context,
    );

    assertEquals(result.dataHandles.length, 1);
    assertEquals(context.written.length, 1);

    const recorded = context.written[0];
    assertEquals(recorded.specName, "write");
    // `${project}--${path}` with every `/` replaced by `--`.
    assertEquals(recorded.name, "org--repo--src--nested--hello.txt");
    assertEquals(recorded.data.project, "org/repo");
    assertEquals(recorded.data.path, "src/nested/hello.txt");
    assertEquals(recorded.data.bytesWritten, "hello world".length);
    assertEquals(recorded.data.created, true);

    const onDisk = await Deno.readTextFile(`${repo}/src/nested/hello.txt`);
    assertEquals(onDisk, "hello world");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});
