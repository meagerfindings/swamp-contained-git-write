# @mgreten/contained-git-write

A minimal model type that does exactly one thing: write a file into an
*existing* git clone, refusing any path that escapes the repository root or
targets `.git/`.

## Why this exists

Hermes needs to update files inside `/opt/data/swamp-unifi-release-safety` —
a plain git clone, not a Swamp-managed repo — which the `swamp_definition_write`
tool cannot reach. The installed `@twonines/git-workspace` model type covers
clone/branch/read/commit/push for that same workspace, but has no write
method.

This was first attempted as an extension of `@twonines/git-workspace`
(`export const extension`), per the "extend, don't be clever" rule. That
approach was abandoned after two problems surfaced on this deployment's
Swamp build: an extension-declared `resources` entry builds but is never
wired into the runtime resource registry (every write then fails with
`Undeclared resource spec`), and even the `methods` merge itself was
nondeterministic — four back-to-back, unmodified `swamp model type describe`
calls returned the merged method on three and silently omitted it on the
fourth, with the extension's own bundle flipping between `Indexed` and
`BundleBuildFailed` in between. A write path whose availability is a coin
flip is worse than no write path, so this is a plain new model type instead
— one load, its own resource spec, no merge step, no race.

## Containment

`localPath` is a per-call, caller-supplied argument — there is no implicit
workspace to constrain it to. An unconstrained write would be an
arbitrary-file-write primitive anywhere the process user can reach, so
`write_file` refuses:

- any `path` that resolves outside `localPath` (`..` traversal, an absolute
  path, or a symlink — inside the repo or mid-path — that resolves outside
  the root);
- any `path` that resolves under `.git/`, even via a symlink that resolves
  back inside the repo — a hook write there is remote code execution on the
  next git operation;
- writing into a `localPath` that has no `.git` entry at all, or that
  doesn't exist.

It creates parent directories for new files as needed.

## Example

```bash
swamp model create @mgreten/contained-git-write unifi-safety-writer --json
swamp model method run unifi-safety-writer write_file --json \
  --input project=meagerfindings/swamp-unifi-release-safety \
  --input localPath=/opt/data/swamp-unifi-release-safety \
  --input path=README.md \
  --input content="# updated"
```

A successful call records a `write` resource shaped like this:

```json
{
  "project": "meagerfindings/swamp-unifi-release-safety",
  "localPath": "/opt/data/swamp-unifi-release-safety",
  "path": "README.md",
  "bytesWritten": 9,
  "created": false,
  "writtenAt": "2026-07-20T23:00:00.000Z"
}
```

A refused call — traversal, an absolute path, a `.git/` target, or a symlink
that resolves outside the workspace — throws before any file I/O happens, so
the repository is left exactly as it was found.

## License

MIT — see [LICENSE.md](LICENSE.md).
