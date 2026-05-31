// Lazy-loaded code editor bundle. Exposes CodeMirror 6 as window.MDEditor
// (globalName set in build.mjs). The viewer bundle loads this on demand the
// first time an editable file is opened in edit mode, mirroring how the
// terminal / mermaid bundles are loaded.
//
// The viewer talks to a single high-level factory — createEditor(opts) —
// so all CodeMirror wiring (language pick, theme, keymaps, save binding)
// stays isolated in this bundle and viewer.entry.js only tracks editor
// lifecycle (path / dirty / mode).
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, highlightSpecialChars,
  dropCursor, rectangularSelection, crosshairCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, copyLineDown } from '@codemirror/commands';
import {
  syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching,
  foldGutter, foldKeymap, StreamLanguage,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { cpp } from '@codemirror/lang-cpp';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { java } from '@codemirror/lang-java';
import { go } from '@codemirror/lang-go';

import { shell } from '@codemirror/legacy-modes/mode/shell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { r as rMode } from '@codemirror/legacy-modes/mode/r';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { csharp, kotlin, scala, dart, objectiveC } from '@codemirror/legacy-modes/mode/clike';

// Resolve an extension to a CodeMirror language extension (or null for plain
// text). Mirrors the TEXT_EXT allowlist in viewer.entry.js — anything not
// matched just gets no syntax highlighting.
function languageForExt(ext) {
  const legacy = (m) => StreamLanguage.define(m);
  switch ((ext || '').toLowerCase()) {
    case 'js': case 'mjs': case 'cjs': return javascript();
    case 'jsx': return javascript({ jsx: true });
    case 'ts': return javascript({ typescript: true });
    case 'tsx': return javascript({ typescript: true, jsx: true });
    case 'py': return python();
    case 'rs': return rust();
    case 'css': case 'scss': case 'sass': case 'less': return css();
    case 'html': case 'htm': case 'vue': case 'svelte': return html();
    case 'json': case 'jsonc': return json();
    case 'md': case 'markdown': case 'mdown': case 'mkd': case 'mkdn': return markdown();
    case 'c': case 'h': case 'cc': case 'cpp': case 'hpp': case 'cxx': return cpp();
    case 'php': return php();
    case 'sql': return sql();
    case 'xml': return xml();
    case 'yaml': case 'yml': return yaml();
    case 'java': return java();
    case 'go': return go();
    case 'sh': case 'bash': case 'zsh': case 'fish': return legacy(shell);
    case 'rb': case 'gemfile': case 'rakefile': return legacy(ruby);
    case 'lua': return legacy(lua);
    case 'toml': return legacy(toml);
    case 'ini': case 'cfg': case 'conf': case 'env': case 'properties': case 'editorconfig':
      return legacy(properties);
    case 'dockerfile': return legacy(dockerFile);
    case 'pl': return legacy(perl);
    case 'r': return legacy(rMode);
    case 'ps1': return legacy(powerShell);
    case 'swift': return legacy(swift);
    case 'cs': return legacy(csharp);
    case 'kt': case 'kts': return legacy(kotlin);
    case 'scala': return legacy(scala);
    case 'dart': return legacy(dart);
    case 'm': case 'mm': return legacy(objectiveC);
    default: return null;
  }
}

// Two syntax palettes — picked by the active theme's light/dark base. The
// editor *chrome* (background, gutter, selection, cursor) is driven by the
// app's CSS variables via theme literals below, so it tracks any named theme
// exactly; only these token colors switch on base. Colors are GitHub-ish so
// they sit well against both the light and dark variable sets.
const darkHL = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#ff7b72' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#ff7b72' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: '#e6edf3' },
  { tag: [t.propertyName], color: '#79c0ff' },
  { tag: [t.variableName, t.labelName], color: '#e6edf3' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#d2a8ff' },
  { tag: [t.definition(t.name)], color: '#ffa657' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: '#7ee787' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#79c0ff' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#a5d6ff' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#8b949e', fontStyle: 'italic' },
  { tag: [t.meta, t.documentMeta], color: '#8b949e' },
  { tag: [t.attributeName], color: '#79c0ff' },
  { tag: [t.attributeValue], color: '#a5d6ff' },
  { tag: [t.heading], color: '#79c0ff', fontWeight: 'bold' },
  { tag: [t.link, t.url], color: '#a5d6ff', textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.invalid], color: '#ffa198' },
]);

const lightHL = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#cf222e' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#cf222e' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: '#1f2328' },
  { tag: [t.propertyName], color: '#0550ae' },
  { tag: [t.variableName, t.labelName], color: '#1f2328' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#8250df' },
  { tag: [t.definition(t.name)], color: '#953800' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: '#116329' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#0550ae' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#0a3069' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6e7781', fontStyle: 'italic' },
  { tag: [t.meta, t.documentMeta], color: '#6e7781' },
  { tag: [t.attributeName], color: '#0550ae' },
  { tag: [t.attributeValue], color: '#0a3069' },
  { tag: [t.heading], color: '#0550ae', fontWeight: 'bold' },
  { tag: [t.link, t.url], color: '#0a3069', textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.invalid], color: '#82071e' },
]);

// Editor chrome bound to the app's CSS variables, so the editor matches the
// active theme without per-theme reconfigure. Font size reads --editor-font-size
// (set on :root by the settings panel), defaulting to 13px.
const chromeTheme = EditorView.theme({
  '&': {
    color: 'var(--fg)',
    backgroundColor: 'var(--bg)',
    height: '100%',
    fontSize: 'var(--editor-font-size, 13px)',
  },
  '.cm-scroller': {
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
    lineHeight: '1.6',
  },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)',
    color: 'var(--fg)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--code-bg)',
    border: '1px solid var(--border)',
    color: 'var(--muted)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    outline: 'none',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)',
  },
  '.cm-panels': { backgroundColor: 'var(--code-bg)', color: 'var(--fg)' },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 45%, transparent)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--code-bg)',
    border: '1px solid var(--border)',
    color: 'var(--fg)',
  },
});

// Create an editor inside `parent`. Returns a small handle the viewer drives.
//   opts: { parent, doc, ext, base, readOnly, onChange, onSave }
function createEditor(opts) {
  const o = opts || {};
  const hlCompartment = new Compartment();
  const lang = languageForExt(o.ext);

  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    hlCompartment.of(syntaxHighlighting(o.base === 'dark' ? darkHL : lightHL, { fallback: true })),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { if (o.onSave) o.onSave(); return true; } },
      // Duplicate the current line/selection downward (VSCode ⌘D-ish).
      { key: 'Mod-d', preventDefault: true, run: copyLineDown },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    chromeTheme,
    EditorView.lineWrapping,
  ];
  if (lang) extensions.push(lang);
  if (o.readOnly) extensions.push(EditorState.readOnly.of(true));
  if (o.onChange) {
    extensions.push(EditorView.updateListener.of((u) => {
      if (u.docChanged) o.onChange();
    }));
  }
  if (o.onBlur) {
    extensions.push(EditorView.domEventHandlers({
      blur: () => { o.onBlur(); return false; },
    }));
  }

  const view = new EditorView({
    state: EditorState.create({ doc: o.doc || '', extensions }),
    parent: o.parent,
  });

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setBase: (base) => {
      view.dispatch({
        effects: hlCompartment.reconfigure(
          syntaxHighlighting(base === 'dark' ? darkHL : lightHL, { fallback: true })
        ),
      });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

export { createEditor, languageForExt, EditorView, EditorState };
