# @mgreten/contained-git-write

A minimal model type that does exactly one thing: write a file into an
_existing_ git clone, refusing any path that escapes the repository root or
targets `.git/`.

## Why this exists

A caller sometimes needs to write a file into an _existing plain git clone_ —
one that is not a Swamp-managed repo — which the `swamp_definition_write` tool
cannot reach. An installed git-workspace model may cover
clone/branch/read/commit/push for such a workspace but provide no write method.

This was first attempted as an extension of a git-workspace type, per the
"extend, don't be clever" rule. That approach was abandoned after two problems
surfaced on the Swamp build it was first tried on: an extension-declared
resource built but was never wired into the runtime resource registry, and even
the method merge was nondeterministic across back-to-back, unmodified type
descriptions. A write path whose availability is a coin flip is worse than no
write path, so this is a plain new model type instead — one load, its own
resource spec, no merge step, no race.

## Containment

`localPath` is a per-call, caller-supplied argument — there is no implicit
workspace to constrain it to. An unconstrained write would be an
arbitrary-file-write primitive anywhere the process user can reach, so
`write_file` refuses:

- any `path` that resolves outside `localPath` (`..` traversal, an absolute
  path, or a symlink — inside the repo or mid-path — that resolves outside the
  root);
- any `path` that resolves under `.git/`, even via a symlink that resolves back
  inside the repo — a hook write there is remote code execution on the next git
  operation;
- writing into a `localPath` that has no `.git` entry at all, or that doesn't
  exist.

Both `write_file` and `write_file_base64` use these checks and create parent
directories for new files as needed.

The containment check assumes the workspace is not being modified by a hostile
concurrent process while the method runs, and that the target file is not
hard-linked to a name outside the workspace. Deno does not expose the
descriptor-relative filesystem operations needed to close those two operating
system-level races. The `.git` check verifies the filesystem shape this model
needs — an existing directory with a `.git` file or directory — rather than
invoking Git to prove repository integrity.

## Example

```bash
swamp model create @mgreten/contained-git-write my-writer --json
swamp model method run my-writer write_file --json \
  --input project=myorg/my-repo \
  --input localPath=/path/to/clone \
  --input path=README.md \
  --input content="# updated"
```

When content must be opaque to Swamp's method-input expression handling, use
`write_file_base64`. It strictly accepts padded standard base64 (not URL-safe
base64 or whitespace), verifies the expected SHA-256 before any filesystem
write, and writes the decoded bytes exactly. The digest is case-insensitive:

```bash
content='token: ${{ vault.get(my-vault, TODOIST_API_TOKEN) }}'
encoded="$(printf %s "$content" | base64)"
sha256="$(printf %s "$content" | shasum -a 256 | cut -d' ' -f1)"

swamp model method run my-writer write_file_base64 --json \
  --input project=myorg/my-repo \
  --input localPath=/path/to/clone \
  --input path=config.yaml \
  --input contentBase64="$encoded" \
  --input expectedSha256="$sha256"
```

A successful call records a `write` resource shaped like this:

```json
{
  "project": "myorg/my-repo",
  "localPath": "/path/to/clone",
  "path": "README.md",
  "bytesWritten": 9,
  "created": false,
  "writtenAt": "2026-07-20T23:00:00.000Z",
  "sha256": "1f4f3b598f5db099cd45dfb9b87bd7a040bb30932f0437740065dfafb9e3d62d"
}
```

`write_file` remains available with the same inputs. Receipts from both methods
include the lowercase SHA-256 of the bytes written in addition to the existing
receipt fields.

A refused call — traversal, an absolute path, a `.git/` target, or a symlink
that resolves outside the workspace — throws before any file I/O happens, so the
repository is left exactly as it was found.

## License

MIT — see [LICENSE.md](LICENSE.md).
