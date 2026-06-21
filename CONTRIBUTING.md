# Contributing to Ipnops Edge

## Local development against an unreleased `tenzro-node`

Ipnops Edge depends on `tenzro-node` from crates.io. While
`tenzro-node` is pre-release and not yet published, contributors who want
to test against changes in the tenzro-network monorepo at
the same time can wire the local checkout in without modifying this
repo's `Cargo.toml`:

1. Clone `tenzro-network` adjacent to this repo.
2. Add a `[patch.crates-io]` block to your own machine's
   `~/.cargo/config.toml`, or a local workspace `Cargo.toml` that
   includes both repos as members:

   ```toml
   [patch.crates-io]
   tenzro-node = { path = "/absolute/path/to/tenzro-network/crates/tenzro-node" }
   ```

   The local patch is **not** checked into this repository so the
   published build always resolves from crates.io.

3. `npm run tauri dev` will then pick up your local `tenzro-node`
   changes.

## Pull requests

- Match the existing TypeScript and Rust code style.
- Run `npm run build` and `cargo build` inside `src-tauri/` before
  pushing — both must succeed.
- Keep changes scoped: UI changes, node-lifecycle changes, and bundling
  changes should be separate PRs where possible.

## Reporting issues

Open an issue at <https://github.com/hilarl/ipnops-edge/issues>.
