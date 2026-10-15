/**
 * Classifies every character of a Verus source file as exec / spec / proof,
 * with an orthogonal "assumed" flag for trusted/unverified constructs
 * (assume, assume_specification, external_body, axiom, admit).
 *
 * Works on the tree-sitter-verus parse tree. All indices are UTF-16 code
 * units, matching both web-tree-sitter string parsing and VS Code offsets.
 */

import type { Node, Tree } from "web-tree-sitter";

export const EXEC = 0;
export const SPEC = 1;
export const PROOF = 2;

export type Style = "exec" | "spec" | "proof" | "assume";
export type DisplayMode = 1 | 2 | 3 | 4;

export interface Classification {
  /** per-character mode: EXEC | SPEC | PROOF */
  mode: Uint8Array;
  /** per-character assumption flag (0/1) */
  assumed: Uint8Array;
  /**
   * per-character mode of the nearest enclosing moded item (fn/const/...).
   * Lets a proof fn's spec clauses hide together with the fn in mode 2.
   */
  item: Uint8Array;
  /**
   * 0-based lines on which a multi-line syntax node starts. Other folding
   * providers (rust-analyzer) may start a range there, which would clash
   * with a fold anchored on that line.
   */
  nodeStartLines: Set<number>;
}

/** Signature/loop clauses: specification text. */
const SPEC_CLAUSE_NODES = new Set([
  "requires_clause",
  "ensures_clause",
  "returns_clause",
  "recommends_clause",
  "decreases_clause",
  "invariant_clause",
  "invariant_ensures_clause",
  "invariant_except_break_clause",
  "opens_invariants_clause",
  "no_unwind_clause",
]);

/** Proof-only constructs. */
const PROOF_NODES = new Set([
  "proof_block",
  "assert_expression",
  "assert_by_expression",
  "assert_by_block_expression",
  "assert_forall_expression",
  "broadcast_group",
  "broadcast_use",
]);

/** Assumptions: unverified things the verification depends on. */
const ASSUME_NODES = new Set(["assume_expression", "assume_specification_item"]);

/** Items that may carry a `spec`/`proof`/`exec` function_mode child. */
const MODED_ITEMS = new Set([
  "function_item",
  "function_signature_item",
  "const_item",
  "static_item",
]);

const PROOF_MACROS = new Set(["calc"]);
const ASSUME_CALLS = new Set(["admit"]);

/** #[verifier::...] attributes that mark the following item as an assumption. */
const ASSUME_ATTR_RE =
  /\bverifier\s*(?:::|\()\s*(external_body|external_fn_specification|external_type_specification|external_trait_specification|external_trait_blanket|external)\b/;

/**
 * Invariant / atomic-update opening macros whose `{ .. }` body is ordinary
 * Verus code (with `let tracked`, `proof { .. }`, ...). tree-sitter leaves
 * macro arguments as an opaque token_tree, so the body is re-parsed.
 */
const BODY_MACRO_RE = /^(?:try_)?open_\w*(?:invariant|atomic_update)\w*$/;
const BODY_WRAPPER = "fn _()";

/** bare `axiom fn` keyword (newer Verus; not a grammar keyword yet). */
const AXIOM_KEYWORDS = new Set(["axiom"]);

/**
 * `parse` (optional) re-parses a source string; when given, the bodies of
 * invariant-opening macros (see BODY_MACRO_RE) are classified too.
 * Trees it returns are deleted after use.
 */
export function classify(
  tree: Tree,
  text: string,
  parse?: (src: string) => Tree | null
): Classification {
  const n = text.length;
  const mode = new Uint8Array(n); // EXEC by default
  const assumed = new Uint8Array(n);
  const item = new Uint8Array(n);
  const nodeStartLines = new Set<number>();

  const nodeText = (node: Node) => text.slice(node.startIndex, node.endIndex);

  /** Explicit mode of an item node, or -1 if it has none. */
  const itemMode = (node: Node): number => {
    const t = node.type;
    if (t === "assume_specification_item") return PROOF;
    if (MODED_ITEMS.has(t)) {
      for (const ch of node.namedChildren) {
        if (ch && ch.type === "function_mode") {
          const kw = nodeText(ch).split("(")[0].trim();
          if (kw === "spec") return SPEC;
          if (kw === "proof") return PROOF;
          if (kw === "exec") return EXEC;
        }
      }
      for (const ch of node.children) {
        if (!ch) continue;
        if (ch.type === "identifier" && AXIOM_KEYWORDS.has(nodeText(ch))) return PROOF;
        if (ch.type === "fn") break;
      }
      return -1;
    }
    if (t === "struct_item" || t === "enum_item" || t === "union_item" || t === "type_item") {
      for (const ch of node.namedChildren) {
        if (ch && ch.type === "data_mode") return SPEC;
      }
    }
    return -1;
  };

  /** Include the wrapping expression_statement (and its `;`) if any. */
  const stmtSpan = (node: Node): [number, number] => {
    const p = node.parent;
    if (p && p.type === "expression_statement") {
      return [p.startIndex, p.endIndex];
    }
    let end = node.endIndex;
    const sib = node.nextSibling;
    if (sib && sib.type === ";") {
      end = sib.endIndex;
    }
    return [node.startIndex, end];
  };

  const classifyNode = (node: Node) => {
    const t = node.type;

    if (SPEC_CLAUSE_NODES.has(t)) {
      mode.fill(SPEC, node.startIndex, node.endIndex);
      // Error recovery can attach the fn/loop body block to the clause
      // (a block is a valid expression after a trailing comma). A bare
      // block child is really body code — leave it exec.
      for (const ch of node.namedChildren) {
        if (ch && ch.type === "block") {
          mode.fill(EXEC, ch.startIndex, ch.endIndex);
        }
      }
    } else if (PROOF_NODES.has(t)) {
      const [a, b] = stmtSpan(node);
      mode.fill(PROOF, a, b);
    } else if (ASSUME_NODES.has(t)) {
      const [a, b] = stmtSpan(node);
      mode.fill(PROOF, a, b);
      item.fill(PROOF, a, b);
      assumed.fill(1, a, b);
    } else if (
      MODED_ITEMS.has(t) ||
      t === "struct_item" ||
      t === "enum_item" ||
      t === "union_item" ||
      t === "type_item"
    ) {
      const m = itemMode(node);
      if (m >= 0) {
        mode.fill(m, node.startIndex, node.endIndex);
        item.fill(m, node.startIndex, node.endIndex);
      }
      // bare-identifier `axiom fn ...` counts as an assumption
      for (const ch of node.children) {
        if (!ch) continue;
        if (ch.type === "identifier" && AXIOM_KEYWORDS.has(nodeText(ch))) {
          assumed.fill(1, node.startIndex, node.endIndex);
          break;
        }
        if (ch.type === "fn") break;
      }
    } else if (t === "let_declaration") {
      for (const ch of node.children) {
        if (ch && (ch.type === "ghost" || ch.type === "tracked")) {
          mode.fill(SPEC, node.startIndex, node.endIndex);
          break;
        }
      }
    } else if (t === "macro_invocation") {
      const mac = node.childForFieldName("macro");
      if (mac && PROOF_MACROS.has(nodeText(mac))) {
        const [a, b] = stmtSpan(node);
        mode.fill(PROOF, a, b);
      } else if (mac && parse && BODY_MACRO_RE.test(nodeText(mac))) {
        classifyMacroBody(node);
      }
    } else if (t === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn && ASSUME_CALLS.has(nodeText(fn))) {
        const [a, b] = stmtSpan(node);
        mode.fill(PROOF, a, b);
        assumed.fill(1, a, b);
      }
    }
  };

  /**
   * Re-parse the trailing `{ .. }` argument of a body macro as a function
   * body. The source is masked to the same length (everything outside the
   * body blanked, line breaks kept) so the sub-tree's offsets match `text`.
   */
  const classifyMacroBody = (node: Node) => {
    const args = node.namedChildren.find((ch) => ch && ch.type === "token_tree");
    if (!args) return;
    const trees = args.namedChildren.filter((ch) => ch && ch.type === "token_tree");
    const body = trees[trees.length - 1];
    if (!body || text[body.startIndex] !== "{" || body.startIndex < BODY_WRAPPER.length) return;
    const a = body.startIndex;
    const b = body.endIndex;
    const masked =
      text.slice(0, a).replace(/[^\r\n]/g, " ").slice(0, a - BODY_WRAPPER.length) +
      BODY_WRAPPER +
      text.slice(a, b);
    const sub = parse!(masked);
    if (!sub) return;
    try {
      const fn = sub.rootNode.descendantsOfType("function_item")[0];
      const block = fn?.childForFieldName("body");
      if (block && block.startIndex === a && block.endIndex === b) walk(block);
    } finally {
      sub.delete();
    }
  };

  /** Mode of an item, looking through a declaration_with_attrs wrapper. */
  const wrappedItemMode = (node: Node): number => {
    if (node.type === "declaration_with_attrs") {
      const inner = node.namedChildren.filter(
        (ch) => ch && ch.type !== "attribute_item" && !ch.type.endsWith("_comment")
      );
      const last = inner[inner.length - 1];
      return last ? itemMode(last) : -1;
    }
    return itemMode(node);
  };

  const walk = (node: Node) => {
    classifyNode(node);
    // a line comment's span includes its newline, ending at column 0 of the next row
    const endRow = node.endPosition.column === 0 ? node.endPosition.row - 1 : node.endPosition.row;
    if (endRow > node.startPosition.row) nodeStartLines.add(node.startPosition.row);
    let attrStart = -1; // first attribute of a consecutive run
    let assumeAttr = false;
    let docStart = -1; // first outer doc comment of a consecutive run
    for (const ch of node.children) {
      if (!ch) continue;
      if (ch.type === "attribute_item") {
        if (attrStart < 0) attrStart = ch.startIndex;
        if (ASSUME_ATTR_RE.test(nodeText(ch))) assumeAttr = true;
      } else if (ch.type === "line_comment" || ch.type === "block_comment") {
        // attributes may be separated from their item by comments
        if (ch.childForFieldName("outer")) {
          if (docStart < 0) docStart = ch.startIndex;
        } else {
          docStart = -1;
        }
      } else if (ch.isNamed) {
        if (docStart >= 0) {
          // doc comments share the mode of the item they document
          const m = wrappedItemMode(ch);
          if (m >= 0) {
            mode.fill(m, docStart, ch.startIndex);
            item.fill(m, docStart, ch.startIndex);
          }
          docStart = -1;
        }
        if (attrStart >= 0) {
          // attributes share the fate of the item they decorate
          const m = itemMode(ch);
          if (m >= 0) {
            mode.fill(m, attrStart, ch.startIndex);
            item.fill(m, attrStart, ch.endIndex);
          }
          if (assumeAttr) assumed.fill(1, attrStart, ch.endIndex);
          attrStart = -1;
          assumeAttr = false;
        }
      }
      walk(ch);
    }
  };

  walk(tree.rootNode);
  return { mode, assumed, item, nodeStartLines };
}

export function styleAt(cls: Classification, i: number): Style {
  if (cls.assumed[i]) return "assume";
  return cls.mode[i] === SPEC ? "spec" : cls.mode[i] === PROOF ? "proof" : "exec";
}

/** Style used for "N lines hidden (...)" markers: a proof fn's spec clauses
 *  count as proof, since they hide because the enclosing item is proof. */
function markerStyleAt(cls: Classification, i: number): Style {
  if (cls.assumed[i]) return "assume";
  if (cls.item[i] === PROOF) return "proof";
  return styleAt(cls, i);
}

/** Is the character at i visible under the given display mode? */
export function visibleAt(cls: Classification, i: number, dm: DisplayMode): boolean {
  // mode 4: special display off — everything visible
  if (dm === 1 || dm === 4) return true;
  if (dm === 2) {
    // hide proof code, incl. spec clauses of proof-mode items — unless assumed
    return !((cls.mode[i] === PROOF || cls.item[i] === PROOF) && !cls.assumed[i]);
  }
  // mode 3: only exec code (incl. assumed exec, e.g. external_body exec fns)
  return cls.mode[i] === EXEC;
}

export interface StyledSpan {
  start: number;
  end: number;
  style: Style;
}

/** Contiguous same-style spans of *visible* characters. */
export function styledSpans(
  cls: Classification,
  dm: DisplayMode,
  length: number
): StyledSpan[] {
  const spans: StyledSpan[] = [];
  let cur: StyledSpan | null = null;
  for (let i = 0; i < length; i++) {
    if (!visibleAt(cls, i, dm)) {
      cur = null;
      continue;
    }
    const st = styleAt(cls, i);
    if (cur && cur.style === st && cur.end === i) {
      cur.end = i + 1;
    } else {
      cur = { start: i, end: i + 1, style: st };
      spans.push(cur);
    }
  }
  return spans;
}

/** Contiguous spans of *hidden* characters (for dimming / folding). */
export function hiddenSpans(
  cls: Classification,
  dm: DisplayMode,
  length: number
): StyledSpan[] {
  const spans: StyledSpan[] = [];
  let cur: StyledSpan | null = null;
  for (let i = 0; i < length; i++) {
    if (visibleAt(cls, i, dm)) {
      cur = null;
      continue;
    }
    const st = styleAt(cls, i);
    if (cur && cur.style === st && cur.end === i) {
      cur.end = i + 1;
    } else {
      cur = { start: i, end: i + 1, style: st };
      spans.push(cur);
    }
  }
  return spans;
}

export interface FilterResult {
  text: string;
  /** styled spans re-based onto the filtered text */
  spans: StyledSpan[];
}

/**
 * Produce the filtered source for a display mode: hidden characters removed,
 * lines that end up blank (or a lone `;`) dropped, with elision markers.
 * Used by the read-only preview.
 */
export function filterText(
  src: string,
  cls: Classification,
  dm: DisplayMode,
  markers: boolean
): FilterResult {
  const outParts: string[] = [];
  const spans: StyledSpan[] = [];
  let outLen = 0;
  let droppedLines = 0;
  const droppedStyles = new Set<Style>();

  const emitMarker = () => {
    if (!markers || droppedLines === 0) return;
    const what = [...droppedStyles].sort().join("+") || "code";
    const marker = `/* … ${droppedLines} line${droppedLines === 1 ? "" : "s"} hidden (${what}) */\n`;
    outParts.push(marker);
    outLen += marker.length;
    droppedLines = 0;
    droppedStyles.clear();
  };

  const lines = src.split(/(?<=\n)/); // keep line terminators
  let pos = 0;
  for (const rawLine of lines) {
    const start = pos;
    pos += rawLine.length;
    const nl = rawLine.endsWith("\n") ? (rawLine.endsWith("\r\n") ? "\r\n" : "\n") : "";
    const contentLen = rawLine.length - nl.length;

    // collect visible runs on this line
    let visibleText = "";
    const lineSpans: StyledSpan[] = [];
    let anyHidden = false;
    for (let i = start; i < start + contentLen; i++) {
      if (visibleAt(cls, i, dm)) {
        const st = styleAt(cls, i);
        const last = lineSpans[lineSpans.length - 1];
        const outPos = outLen + visibleText.length;
        if (last && last.style === st && last.end === outPos) {
          last.end = outPos + 1;
        } else {
          lineSpans.push({ start: outPos, end: outPos + 1, style: st });
        }
        visibleText += src[i];
      } else {
        anyHidden = true;
        droppedStyles.add(markerStyleAt(cls, i));
      }
    }
    // blank line: judge by its newline character's classification
    if (contentLen === 0 && nl && !visibleAt(cls, start, dm)) {
      anyHidden = true;
      droppedStyles.add(markerStyleAt(cls, start));
    }

    const stripped = visibleText.trim();
    const drop = anyHidden && (stripped === "" || stripped === ";");
    if (drop) {
      droppedLines++;
      continue;
    }

    emitMarker();
    outParts.push(visibleText + nl);
    outLen += visibleText.length + nl.length;
    spans.push(...lineSpans);
  }
  emitMarker();

  return { text: outParts.join(""), spans };
}

/**
 * Fully-hidden line ranges [startLine, endLine] (0-based, inclusive) for
 * folding. A line counts as hidden when removing its hidden characters
 * leaves nothing (or a lone `;`).
 */
export function hiddenLineBlocks(
  src: string,
  cls: Classification,
  dm: DisplayMode
): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  const lines = src.split(/(?<=\n)/);
  let pos = 0;
  let lineNo = 0;
  for (const rawLine of lines) {
    const start = pos;
    pos += rawLine.length;
    const nl = rawLine.endsWith("\n") ? (rawLine.endsWith("\r\n") ? "\r\n" : "\n") : "";
    const contentLen = rawLine.length - nl.length;

    let visibleText = "";
    let anyHidden = false;
    for (let i = start; i < start + contentLen; i++) {
      if (visibleAt(cls, i, dm)) visibleText += src[i];
      else anyHidden = true;
    }
    if (contentLen === 0 && nl && !visibleAt(cls, start, dm)) anyHidden = true;

    const stripped = visibleText.trim();
    const hidden = anyHidden && (stripped === "" || stripped === ";");
    if (hidden) {
      const last = blocks[blocks.length - 1];
      if (last && last[1] === lineNo - 1) last[1] = lineNo;
      else blocks.push([lineNo, lineNo]);
    }
    lineNo++;
  }
  return blocks;
}

export interface LineStyleBlock {
  startLine: number;
  /** inclusive */
  endLine: number;
  style: Style;
}

/** Highlight priority when a line mixes categories. */
const LINE_PRIORITY: Style[] = ["assume", "proof", "spec"];

/**
 * Per-line background style, merged into consecutive blocks. A line gets the
 * highest-priority non-exec style among its *visible* characters
 * (assume > proof > spec); blank lines take the style of their newline so
 * multi-line constructs highlight as one solid block.
 */
export function lineStyleBlocks(
  src: string,
  cls: Classification,
  dm: DisplayMode
): LineStyleBlock[] {
  const blocks: LineStyleBlock[] = [];
  const lines = src.split(/(?<=\n)/);
  let pos = 0;
  let lineNo = 0;
  for (const rawLine of lines) {
    const start = pos;
    pos += rawLine.length;
    const nl = rawLine.endsWith("\n") ? (rawLine.endsWith("\r\n") ? "\r\n" : "\n") : "";
    const contentLen = rawLine.length - nl.length;

    const present = new Set<Style>();
    for (let i = start; i < start + contentLen; i++) {
      if (visibleAt(cls, i, dm)) present.add(styleAt(cls, i));
    }
    if (contentLen === 0 && nl && visibleAt(cls, start, dm)) {
      present.add(styleAt(cls, start));
    }

    let style: Style | null = null;
    for (const s of LINE_PRIORITY) {
      if (present.has(s)) {
        style = s;
        break;
      }
    }

    if (style) {
      const last = blocks[blocks.length - 1];
      if (last && last.style === style && last.endLine === lineNo - 1) {
        last.endLine = lineNo;
      } else {
        blocks.push({ startLine: lineNo, endLine: lineNo, style });
      }
    }
    lineNo++;
  }
  return blocks;
}

/**
 * Same as lineStyleBlocks but for already-filtered preview text, computed
 * from the re-based styled spans that filterText returned.
 */
export function lineStyleBlocksFromSpans(
  text: string,
  spans: StyledSpan[]
): LineStyleBlock[] {
  // per-character style map (sparse: only non-exec spans matter)
  const styleRank = new Map<Style, number>([
    ["assume", 0],
    ["proof", 1],
    ["spec", 2],
  ]);
  const lineStyle: (Style | null)[] = [];
  // precompute line start offsets
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  for (const s of spans) {
    if (s.style === "exec") continue;
    const rank = styleRank.get(s.style)!;
    const firstLine = lineOf(s.start);
    const lastLine = lineOf(Math.max(s.start, s.end - 1));
    for (let ln = firstLine; ln <= lastLine; ln++) {
      const cur = lineStyle[ln];
      if (cur == null || styleRank.get(cur)! > rank) lineStyle[ln] = s.style;
    }
  }
  const blocks: LineStyleBlock[] = [];
  for (let ln = 0; ln < lineStyle.length; ln++) {
    const style = lineStyle[ln];
    if (!style) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.style === style && last.endLine === ln - 1) last.endLine = ln;
    else blocks.push({ startLine: ln, endLine: ln, style });
  }
  return blocks;
}
