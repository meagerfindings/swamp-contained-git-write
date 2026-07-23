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
const writeFileBase64 = model.methods.write_file_base64;

async function digestHex(content: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(content).buffer),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function standardBase64(content: Uint8Array): string {
  return btoa(String.fromCharCode(...content));
}

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
      if (name.includes("\\") || name.includes("..") || name.length > 255) {
        throw new Error(`invalid resource instance name: ${name}`);
      }
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
    assertEquals(
      outsideEntries,
      [],
      "nothing should be written outside the repo",
    );
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

Deno.test("write_file rejects case variants of .git on case-insensitive filesystems", async () => {
  const repo = await makeTempRepo();
  try {
    const context = makeContext();
    await assertRejects(
      () =>
        writeFile.execute(
          {
            project: "test/project",
            localPath: repo,
            path: ".Git/hooks/pre-commit",
            content: "#!/bin/sh\necho pwned",
          },
          context,
        ),
      Error,
      "writes under .git/ are refused",
    );
    assertEquals(context.written.length, 0);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("write_file rejects a nested .git segment", async () => {
  const repo = await makeTempRepo();
  try {
    const context = makeContext();
    await assertRejects(
      () =>
        writeFile.execute(
          {
            project: "test/project",
            localPath: repo,
            path: "submodule/.git/hooks/pre-commit",
            content: "#!/bin/sh\necho pwned",
          },
          context,
        ),
      Error,
      "writes under .git/ are refused",
    );
    assertEquals(context.written.length, 0);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("write_file rejects a symlink resolving under a nested case-variant .git", async () => {
  const repo = await makeTempRepo();
  try {
    const nestedGit = `${repo}/nested/.GiT`;
    await Deno.mkdir(`${nestedGit}/hooks`, { recursive: true });
    await Deno.symlink(nestedGit, `${repo}/git-link`, { type: "dir" });

    const context = makeContext();
    await assertRejects(
      () =>
        writeFile.execute(
          {
            project: "test/project",
            localPath: repo,
            path: "git-link/hooks/pre-commit",
            content: "#!/bin/sh\necho pwned",
          },
          context,
        ),
      Error,
      "writes under .git/ are refused",
    );
    assertEquals(context.written.length, 0);
    const hook = await Deno.stat(`${nestedGit}/hooks/pre-commit`).catch(() =>
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
    assertEquals(/^write-[0-9a-f]{64}$/.test(recorded.name), true);
    assertEquals(recorded.data.project, "org/repo");
    assertEquals(recorded.data.path, "src/nested/hello.txt");
    assertEquals(recorded.data.bytesWritten, "hello world".length);
    assertEquals(recorded.data.created, true);
    assertEquals(
      recorded.data.sha256,
      await digestHex(new TextEncoder().encode("hello world")),
    );

    const onDisk = await Deno.readTextFile(`${repo}/src/nested/hello.txt`);
    assertEquals(onDisk, "hello world");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("write_file uses a storage-safe receipt name for punctuation in valid metadata", async () => {
  const repo = await makeTempRepo();
  try {
    const context = makeContext();
    await writeFile.execute(
      {
        project: "org\\repo..label",
        localPath: repo,
        path: "notes..txt",
        content: "still valid",
      },
      context,
    );

    assertEquals(context.written.length, 1);
    assertEquals(/^write-[0-9a-f]{64}$/.test(context.written[0].name), true);
    assertEquals(await Deno.readTextFile(`${repo}/notes..txt`), "still valid");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("write_file_base64 preserves literal Swamp expression syntax exactly", async () => {
  const repo = await makeTempRepo();
  try {
    const content = new TextEncoder().encode(
      "token: ${{ vault.get(my-vault, TODOIST_API_TOKEN) }}\n",
    );
    const context = makeContext();
    await writeFileBase64.execute(
      {
        project: "org/repo",
        localPath: repo,
        path: "config/literal.yaml",
        contentBase64: standardBase64(content),
        expectedSha256: (await digestHex(content)).toUpperCase(),
      },
      context,
    );

    assertEquals(
      await Deno.readFile(`${repo}/config/literal.yaml`),
      content,
    );
    assertEquals(context.written[0].data.sha256, await digestHex(content));
    assertEquals(context.written[0].data.bytesWritten, content.byteLength);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("write_file_base64 rejects invalid standard base64", async () => {
  const repo = await makeTempRepo();
  try {
    const context = makeContext();
    await assertRejects(
      () =>
        writeFileBase64.execute(
          {
            project: "org/repo",
            localPath: repo,
            path: "invalid.txt",
            contentBase64: "not base64-_",
            expectedSha256: "0".repeat(64),
          },
          context,
        ),
      Error,
      "valid standard base64",
    );
    assertEquals(context.written.length, 0);
    assertEquals(
      await Deno.stat(`${repo}/invalid.txt`).catch(() => null),
      null,
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("write_file_base64 rejects a hash mismatch without mutation", async () => {
  const repo = await makeTempRepo();
  try {
    const target = `${repo}/existing.txt`;
    await Deno.writeTextFile(target, "original");
    const content = new TextEncoder().encode("replacement");
    const context = makeContext();
    await assertRejects(
      () =>
        writeFileBase64.execute(
          {
            project: "org/repo",
            localPath: repo,
            path: "existing.txt",
            contentBase64: standardBase64(content),
            expectedSha256: "0".repeat(64),
          },
          context,
        ),
      Error,
      "SHA-256 mismatch",
    );
    assertEquals(await Deno.readTextFile(target), "original");
    assertEquals(context.written.length, 0);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("write_file_base64 retains existing containment checks", async () => {
  const repo = await makeTempRepo();
  try {
    const content = new TextEncoder().encode("escape");
    const expectedSha256 = await digestHex(content);
    const context = makeContext();
    await assertRejects(
      () =>
        writeFileBase64.execute(
          {
            project: "org/repo",
            localPath: repo,
            path: ".git/hooks/pre-commit",
            contentBase64: standardBase64(content),
            expectedSha256,
          },
          context,
        ),
      Error,
      "writes under .git/ are refused",
    );
    assertEquals(context.written.length, 0);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});
