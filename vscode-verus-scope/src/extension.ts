import * as path from "path";
import * as vscode from "vscode";
import { Language, Parser } from "web-tree-sitter";
import {
  Classification,
  DisplayMode,
  Style,
  classify,
  filterText,
  hiddenLineBlocks,
  hiddenSpans,
  lineStyleBlocks,
  lineStyleBlocksFromSpans,
} from "./classifier";

const MODE_LABEL: Record<DisplayMode, string> = {
  1: "1: everything",
  2: "2: exec+spec+assumptions",
  3: "3: exec only",
  4: "4: off",
};

let parser: Parser | undefined;
let displayMode: DisplayMode = 1;
let statusBar: vscode.StatusBarItem;
let decorations: Record<Style, vscode.TextEditorDecorationType> | undefined;
let hiddenDecoration: vscode.TextEditorDecorationType | undefined;

/** classification cache: uri -> { version, cls } */
const cache = new Map<string, { version: number; cls: Classification }>();
/** lines we folded per editor uri, so we can unfold them on mode change */
const foldedLines = new Map<string, number[]>();
/** styled spans for preview documents, keyed by preview uri string */
const previewSpans = new Map<string, { spans: { start: number; end: number; style: Style }[] }>();

function isVerusDoc(doc: vscode.TextDocument): boolean {
  return (
    (doc.languageId === "rust" || doc.languageId === "verus" || doc.fileName.endsWith(".rs")) &&
    doc.uri.scheme !== PREVIEW_SCHEME
  );
}

function config() {
  return vscode.workspace.getConfiguration("verus-scope");
}

function makeDecorations() {
  decorations?.exec.dispose();
  decorations?.spec.dispose();
  decorations?.proof.dispose();
  decorations?.assume.dispose();
  hiddenDecoration?.dispose();
  const c = config();
  const lineBackground = (color: string) =>
    vscode.window.createTextEditorDecorationType({
      backgroundColor: color,
      isWholeLine: true,
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
  decorations = {
    exec: vscode.window.createTextEditorDecorationType({}),
    spec: lineBackground(c.get<string>("specColor", "rgba(215, 186, 125, 0.14)")),
    proof: lineBackground(c.get<string>("proofColor", "rgba(128, 128, 128, 0.16)")),
    assume: lineBackground(c.get<string>("assumptionColor", "rgba(241, 76, 76, 0.16)")),
  };
  hiddenDecoration = vscode.window.createTextEditorDecorationType({
    opacity: c.get<string>("hiddenOpacity", "0.18"),
  });
}

function getClassification(doc: vscode.TextDocument): Classification | undefined {
  if (!parser) return undefined;
  const key = doc.uri.toString();
  const hit = cache.get(key);
  if (hit && hit.version === doc.version) return hit.cls;
  const text = doc.getText();
  const tree = parser.parse(text);
  if (!tree) return undefined;
  const cls = classify(tree, text);
  tree.delete();
  cache.set(key, { version: doc.version, cls });
  return cls;
}

function decorateEditor(editor: vscode.TextEditor) {
  if (!decorations || !hiddenDecoration) return;
  const doc = editor.document;
  if (!isVerusDoc(doc)) return;
  if (!config().get<boolean>("enabled", true) || displayMode === 4) {
    for (const st of ["spec", "proof", "assume"] as Style[]) {
      editor.setDecorations(decorations[st], []);
    }
    editor.setDecorations(hiddenDecoration, []);
    return;
  }
  const cls = getClassification(doc);
  if (!cls) return;
  const text = doc.getText();

  const byStyle: Record<Style, vscode.Range[]> = { exec: [], spec: [], proof: [], assume: [] };
  for (const b of lineStyleBlocks(text, cls, displayMode)) {
    byStyle[b.style].push(new vscode.Range(b.startLine, 0, b.endLine, 0));
  }
  for (const st of ["spec", "proof", "assume"] as Style[]) {
    editor.setDecorations(decorations[st], byStyle[st]);
  }

  // Dim whatever the current mode hides (folding collapses the full lines;
  // dimming covers inline spans and fold anchor lines).
  const hidden: vscode.Range[] = [];
  if (displayMode > 1) {
    for (const s of hiddenSpans(cls, displayMode, text.length)) {
      hidden.push(new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.end)));
    }
  }
  editor.setDecorations(hiddenDecoration, hidden);
}

async function refoldEditor(editor: vscode.TextEditor) {
  const doc = editor.document;
  if (!isVerusDoc(doc)) return;
  const key = doc.uri.toString();

  const prev = foldedLines.get(key) ?? [];
  if (prev.length > 0) {
    await vscode.commands.executeCommand("editor.unfold", {
      levels: 1,
      selectionLines: prev,
    });
    foldedLines.delete(key);
  }

  if (displayMode === 1 || displayMode === 4 || !config().get<boolean>("autoFold", true)) return;
  const cls = getClassification(doc);
  if (!cls) return;

  // Fold anchored on the line *before* each hidden block so the entire
  // block disappears behind the anchor line's fold marker.
  const anchors: number[] = [];
  for (const [startLine] of hiddenLineBlocks(doc.getText(), cls, displayMode)) {
    if (startLine > 0) anchors.push(startLine - 1);
  }
  if (anchors.length > 0) {
    await vscode.commands.executeCommand("editor.fold", {
      levels: 1,
      selectionLines: anchors,
    });
    foldedLines.set(key, anchors);
  }
}

class VerusFoldingProvider implements vscode.FoldingRangeProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeFoldingRanges = this.emitter.event;

  refresh() {
    this.emitter.fire();
  }

  provideFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
    if (displayMode === 1 || displayMode === 4 || !isVerusDoc(doc)) return [];
    const cls = getClassification(doc);
    if (!cls) return [];
    const ranges: vscode.FoldingRange[] = [];
    for (const [startLine, endLine] of hiddenLineBlocks(doc.getText(), cls, displayMode)) {
      if (startLine > 0) {
        ranges.push(new vscode.FoldingRange(startLine - 1, endLine, vscode.FoldingRangeKind.Region));
      }
    }
    return ranges;
  }
}

const PREVIEW_SCHEME = "verus-scope";

class VerusPreviewProvider implements vscode.TextDocumentContentProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  refresh(uri: vscode.Uri) {
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    // uri.query = mode=N&src=<encoded original uri>
    const params = new URLSearchParams(uri.query);
    const mode = Number(params.get("mode") ?? displayMode) as DisplayMode;
    const srcUri = vscode.Uri.parse(params.get("src") ?? "");
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === srcUri.toString()
    );
    if (!doc || !parser) return "// verus-scope: source document not open";
    const cls = getClassification(doc);
    if (!cls) return "// verus-scope: parse failed";
    const { text, spans } = filterText(doc.getText(), cls, mode, true);
    // mode 4: plain text, no coloring
    previewSpans.set(uri.toString(), { spans: mode === 4 ? [] : spans });
    return text;
  }
}

function decoratePreviewEditors() {
  if (!decorations) return;
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== PREVIEW_SCHEME) continue;
    const entry = previewSpans.get(editor.document.uri.toString());
    if (!entry) continue;
    const doc = editor.document;
    const byStyle: Record<Style, vscode.Range[]> = { exec: [], spec: [], proof: [], assume: [] };
    for (const b of lineStyleBlocksFromSpans(doc.getText(), entry.spans)) {
      byStyle[b.style].push(new vscode.Range(b.startLine, 0, b.endLine, 0));
    }
    for (const st of ["spec", "proof", "assume"] as Style[]) {
      editor.setDecorations(decorations[st], byStyle[st]);
    }
  }
}

function updateStatusBar() {
  statusBar.text = `$(verified) Verus ${MODE_LABEL[displayMode]}`;
  statusBar.tooltip =
    "Verus Scope display mode (click to cycle)\n" +
    "1: everything · 2: hide proofs · 3: exec only · 4: off\n" +
    "assumptions red · spec yellow · proof grey";
  statusBar.show();
}

export async function activate(context: vscode.ExtensionContext) {
  // web-tree-sitter runtime + verus grammar
  const wasmDir = path.join(context.extensionPath, "wasm");
  await Parser.init({
    locateFile: (name: string) => path.join(wasmDir, name),
  });
  const language = await Language.load(path.join(wasmDir, "verus.wasm"));
  parser = new Parser();
  parser.setLanguage(language);

  displayMode = (context.workspaceState.get<number>("verus-scope.mode", 1) as DisplayMode) ?? 1;

  makeDecorations();

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = "verus-scope.cycleMode";
  context.subscriptions.push(statusBar);
  updateStatusBar();

  const foldingProvider = new VerusFoldingProvider();
  const previewProvider = new VerusPreviewProvider();
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(
      [{ language: "rust" }, { language: "verus" }, { pattern: "**/*.rs" }],
      foldingProvider
    ),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider)
  );

  const applyEverywhere = async () => {
    updateStatusBar();
    foldingProvider.refresh();
    for (const editor of vscode.window.visibleTextEditors) {
      if (!isVerusDoc(editor.document)) continue;
      decorateEditor(editor);
      await refoldEditor(editor);
    }
    // refresh open previews
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === PREVIEW_SCHEME) previewProvider.refresh(doc.uri);
    }
  };

  const setMode = async (m: DisplayMode) => {
    displayMode = m;
    await context.workspaceState.update("verus-scope.mode", m);
    await applyEverywhere();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("verus-scope.cycleMode", () =>
      setMode(((displayMode % 4) + 1) as DisplayMode)
    ),
    vscode.commands.registerCommand("verus-scope.mode1", () => setMode(1)),
    vscode.commands.registerCommand("verus-scope.mode2", () => setMode(2)),
    vscode.commands.registerCommand("verus-scope.mode3", () => setMode(3)),
    vscode.commands.registerCommand("verus-scope.mode4", () => setMode(4)),
    vscode.commands.registerCommand("verus-scope.openPreview", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isVerusDoc(editor.document)) {
        vscode.window.showInformationMessage("verus-scope: open a Verus (.rs) file first");
        return;
      }
      const src = editor.document.uri;
      const uri = vscode.Uri.from({
        scheme: PREVIEW_SCHEME,
        path: path.basename(src.path) + ` (mode ${displayMode})`,
        query: `mode=${displayMode}&src=${encodeURIComponent(src.toString())}`,
      });
      previewProvider.refresh(uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(doc, "rust");
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: true,
      });
      decoratePreviewEditors();
    })
  );

  let debounce: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor && isVerusDoc(editor.document)) {
        decorateEditor(editor);
        await refoldEditor(editor);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => decoratePreviewEditors()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isVerusDoc(e.document)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        cache.delete(e.document.uri.toString());
        foldingProvider.refresh();
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === e.document) decorateEditor(editor);
        }
      }, 200);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      cache.delete(doc.uri.toString());
      foldedLines.delete(doc.uri.toString());
      previewSpans.delete(doc.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("verus-scope")) {
        makeDecorations();
        await applyEverywhere();
        decoratePreviewEditors();
      }
    })
  );

  await applyEverywhere();
}

export function deactivate() {
  parser?.delete();
}
