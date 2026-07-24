# verus-scope

VS Code extension that detects Verus exec / spec / proof code and displays
it in three modes — see [`vscode-verus-scope/README.md`](vscode-verus-scope/README.md).

- mode 1: show everything
- mode 2: exec + spec + assumptions (proofs hidden)
- mode 3: exec only
- mode 4: off (plain display)

Assumptions (`assume`, `assume_specification`, `#[verifier::external_body]`,
`axiom`, `admit`) are red; specs yellow; proofs grey.

## Layout

- `vscode-verus-scope/` — the extension (install `verus-scope-0.1.1.vsix`, or F5 from this folder)
- `tree-sitter-verus/` — grammar as a git submodule (used to build `vscode-verus-scope/wasm/verus.wasm`); after cloning run `git submodule update --init`
- `examples/demo.rs` — demo file exercising all the constructs
