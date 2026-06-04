# Vendored third-party browser bundles

## hterm_all.js
Google hterm (Chromium libapps) terminal emulator, bundled as an IIFE that
exposes `window.MDTerm = { lib, hterm }`. Used by the terminal panel
(`entries/viewer.entry.js`) in place of xterm.js — hterm has mature in-webview
IME/composition handling, which xterm.js lacks under WKWebView (mac).

**Do not edit by hand.** Regenerate with:
```sh
git clone --depth 1 https://chromium.googlesource.com/apps/libapps /tmp/libapps
cd /tmp/libapps && npm install --no-save rollup@2 @bkuri/rollup-plugin-string \
  @rollup/plugin-image @rollup/plugin-node-resolve @rollup/plugin-terser \
  @rollup/plugin-url rollup-plugin-git-info @rollup/plugin-json
( cd libdot && NODE_ENV=production npx rollup -c )
( cd hterm  && NODE_ENV=production npx rollup -c )   # generates dist/js/*_resources.js
printf "export {lib} from './libdot/index.js';\nexport {hterm} from './hterm/index.js';\n" > entry.js
esbuild entry.js --bundle --format=iife --global-name=MDTerm --minify \
  --legal-comments=none --outfile=hterm_all.js
```
Pinned source commit: 2582c8a8a8c5f9d158b604479140390dcd759158
