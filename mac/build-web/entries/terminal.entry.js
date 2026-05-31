// Lazy-loaded terminal bundle. Exposes xterm.js + addons as window.MDTerm
// (globalName set in build.mjs). The viewer bundle loads this on demand the
// first time the terminal panel is opened, mirroring how mermaid is loaded.
//   - FitAddon       : size the grid to the host element
//   - Unicode11Addon : Unicode 11 wide-char width tables so emoji / box-drawing
//                      glyphs (which Claude CLI & co. lean on) measure correctly
//   - WebglAddon     : GPU renderer — crisp, integer-aligned cells so box lines
//                      actually connect, and far cheaper redraws for busy TUIs
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';

export { Terminal, FitAddon, Unicode11Addon, WebglAddon };
