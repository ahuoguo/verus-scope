#!/usr/bin/env node
/* Terminal harness for the classifier: renders a file with ANSI colors the
 * same way the extension classifies it. Usage:
 *   node test/cli.js [-m 1|2|3] <file.rs>
 */
const fs = require("fs");
const path = require("path");
const { Parser, Language } = require("web-tree-sitter");
const { classify, filterText, styleAt, visibleAt } = require("../out/classifier");

const ANSI = { assume: "\x1b[31m", spec: "\x1b[33m", proof: "\x1b[90m", exec: "", reset: "\x1b[0m", dim: "\x1b[2m" };

async function main() {
  const args = process.argv.slice(2);
  let mode = 1;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-m") mode = Number(args[++i]);
    else files.push(args[i]);
  }
  await Parser.init();
  const lang = await Language.load(path.join(__dirname, "..", "wasm", "verus.wasm"));
  const parser = new Parser();
  parser.setLanguage(lang);

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const tree = parser.parse(src);
    const cls = classify(tree, src, (s) => parser.parse(s));

    if (mode === 1) {
      // full render with colors
      let out = "";
      let cur = null;
      for (let i = 0; i < src.length; i++) {
        const st = styleAt(cls, i);
        if (st !== cur) {
          out += ANSI.reset + (ANSI[st] || "");
          cur = st;
        }
        out += src[i];
      }
      process.stdout.write(out + ANSI.reset + "\n");
    } else {
      const { text, spans } = filterText(src, cls, mode, true);
      // colorize filtered text from spans
      let out = "";
      let pos = 0;
      for (const s of spans) {
        out += ANSI.dim + text.slice(pos, s.start).replace(/\/\* … .*? \*\//g, (m) => m) + ANSI.reset;
        out += (ANSI[s.style] || "") + text.slice(s.start, s.end) + ANSI.reset;
        pos = s.end;
      }
      out += ANSI.dim + text.slice(pos) + ANSI.reset;
      process.stdout.write(out + "\n");
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
