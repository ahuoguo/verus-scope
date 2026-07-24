# Verus Scope

VS Code extension that classifies [Verus](https://github.com/verus-lang/verus)
code into exec / spec / proof using the
[tree-sitter-verus](https://github.com/secure-foundations/tree-sitter-verus)
grammar, and displays it in three modes:

| Mode | Shows |
|------|-------|
| 1 | everything |
| 2 | exec + spec + **assumptions** (proofs hidden) |
| 3 | exec only |

Lines are highlighted with a background color (configurable, subtle rgba by
default; syntax highlighting is left untouched):

- **Assumptions** — red background: `assume(..)`, `assume_specification`,
  `#[verifier::external_body]` / `#[verifier::external*]` items, `axiom fn`,
  `admit()`. Everything your verification result *trusts without proof*.
- **Spec** — yellow background: `spec fn`, `requires` / `ensures` / `returns` /
  `recommends` / `invariant` / `decreases` / `opens_invariants` / `no_unwind`
  clauses, `ghost` / `tracked` data and lets.
- **Proof** — grey background: `proof fn`, `proof { .. }` blocks, `assert` /
  `assert .. by` / `assert forall`, `calc!`, `broadcast group` / `broadcast use`.
- **Exec** — no highlight.

When a line mixes categories, the highest-priority one wins
(assumption > proof > spec); highlights also appear in the overview ruler.

## Usage

- Open a `.rs` file containing Verus code (language id `rust` or `verus`).
- Click the **Verus** status bar item (bottom right) or run
  **“Verus Scope: Cycle Display Mode”** to switch between modes 1/2/3.
- In modes 2 and 3, hidden regions are auto-folded (and dimmed where a fold
  isn't possible). Set `verus-scope.autoFold: false` to only dim.
- **“Verus Scope: Open Filtered Preview to the Side”** opens a read-only view
  with hidden lines fully removed and `/* … N lines hidden (…) */` markers —
  the cleanest rendering of modes 2/3.

## Settings

| Setting | Default | |
|---|---|---|
| `verus-scope.enabled` | `true` | master switch for colorization |
| `verus-scope.assumptionColor` | `#f14c4c` | red |
| `verus-scope.specColor` | `#d7ba7d` | yellow |
| `verus-scope.proofColor` | `#7f7f7f` | grey |
| `verus-scope.hiddenOpacity` | `0.18` | dimming for un-foldable hidden spans |
| `verus-scope.autoFold` | `true` | fold hidden regions in modes 2/3 |

## How it works

`wasm/verus.wasm` is the tree-sitter-verus grammar compiled to WebAssembly,
loaded with `web-tree-sitter`. Every character of the document is assigned a
mode (exec/spec/proof), an enclosing-item mode, and an "assumed" flag by
walking the parse tree (`src/classifier.ts`). Decorations, folding ranges,
and the preview are all derived from that classification.

## Development



```sh
npm install
npm run compile

# terminal smoke test of the classifier (ANSI rendering):
node test/cli.js -m 2 ../examples/demo.rs

# package a .vsix:
npx @vscode/vsce package
```
