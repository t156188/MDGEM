// VSCode-style colored file-type icons for the sidebar tree. Authored as
// compact inline SVG strings (no external icon font / no async fetch) so
// buildNode() can drop them in synchronously without flicker. Imported by
// viewer.entry.js and compiled into the viewer bundle.
//
// Each known extension maps to a brand-ish color + a short monogram rendered
// on a rounded "page" badge. Media types get a small pictogram instead. The
// colors are theme-independent on purpose — that's the VSCode look (the icon
// color identifies the file type, not the UI theme).

// extension -> { c: fill color, t: 1-4 char label, fg?: label color }
const TYPES = {
  // JS / TS family
  js: { c: '#f1dd35', t: 'JS', fg: '#3a3000' }, mjs: { c: '#f1dd35', t: 'JS', fg: '#3a3000' },
  cjs: { c: '#f1dd35', t: 'JS', fg: '#3a3000' },
  jsx: { c: '#61dafb', t: 'JSX', fg: '#06202b' },
  ts: { c: '#3178c6', t: 'TS' }, tsx: { c: '#3178c6', t: 'TSX' },
  vue: { c: '#41b883', t: 'VUE' }, svelte: { c: '#ff3e00', t: 'SV' },
  // Web
  html: { c: '#e44d26', t: '<>' }, htm: { c: '#e44d26', t: '<>' },
  css: { c: '#2965f1', t: 'CSS' }, scss: { c: '#cd6799', t: 'SCSS' },
  sass: { c: '#cd6799', t: 'SASS' }, less: { c: '#2a4d80', t: 'LESS' },
  // Data / config
  json: { c: '#cbcb41', t: '{}', fg: '#33330a' }, jsonc: { c: '#cbcb41', t: '{}', fg: '#33330a' },
  yaml: { c: '#cb171e', t: 'YML' }, yml: { c: '#cb171e', t: 'YML' },
  toml: { c: '#9c4221', t: 'TML' }, xml: { c: '#ff6600', t: 'XML' },
  ini: { c: '#6d8086', t: 'INI' }, cfg: { c: '#6d8086', t: 'CFG' },
  conf: { c: '#6d8086', t: 'CFG' }, env: { c: '#6d8086', t: 'ENV' },
  properties: { c: '#6d8086', t: 'CFG' }, editorconfig: { c: '#6d8086', t: 'EC' },
  gitignore: { c: '#f1502f', t: 'GIT' },
  csv: { c: '#1a7f37', t: 'CSV' }, tsv: { c: '#1a7f37', t: 'TSV' },
  // Languages
  py: { c: '#3572A5', t: 'PY' }, rs: { c: '#dea584', t: 'RS', fg: '#3a2410' },
  go: { c: '#00add8', t: 'GO' }, java: { c: '#b07219', t: 'JV' },
  kt: { c: '#a97bff', t: 'KT' }, kts: { c: '#a97bff', t: 'KT' },
  swift: { c: '#f05138', t: 'SW' }, rb: { c: '#cc342d', t: 'RB' },
  php: { c: '#7377ad', t: 'PHP' }, c: { c: '#5c6bc0', t: 'C' },
  h: { c: '#a074c4', t: 'H' }, hpp: { c: '#a074c4', t: 'H' },
  cc: { c: '#f34b7d', t: 'C++' }, cpp: { c: '#f34b7d', t: 'C++' }, cxx: { c: '#f34b7d', t: 'C++' },
  cs: { c: '#178600', t: 'C#' }, m: { c: '#438eff', t: 'M' }, mm: { c: '#438eff', t: 'M' },
  sh: { c: '#4EAA25', t: 'SH' }, bash: { c: '#4EAA25', t: 'SH' },
  zsh: { c: '#4EAA25', t: 'ZSH' }, fish: { c: '#4EAA25', t: 'FSH' }, ps1: { c: '#5391fe', t: 'PS' },
  sql: { c: '#e38c00', t: 'SQL' }, lua: { c: '#5b6dd8', t: 'LUA' },
  r: { c: '#198ce7', t: 'R' }, pl: { c: '#0298c3', t: 'PL' },
  dart: { c: '#0175c2', t: 'DRT' }, scala: { c: '#c22d40', t: 'SC' },
  clj: { c: '#63b132', t: 'CLJ' }, ex: { c: '#6e4a7e', t: 'EX' }, exs: { c: '#6e4a7e', t: 'EX' },
  erl: { c: '#a90533', t: 'ERL' }, hs: { c: '#5e5086', t: 'HS' },
  // Docs / build
  md: { c: '#519aba', t: 'MD' }, markdown: { c: '#519aba', t: 'MD' },
  mdown: { c: '#519aba', t: 'MD' }, mkd: { c: '#519aba', t: 'MD' }, mkdn: { c: '#519aba', t: 'MD' },
  tex: { c: '#3D6117', t: 'TEX' }, bib: { c: '#3D6117', t: 'BIB' },
  txt: { c: '#7d8590', t: 'TXT' }, text: { c: '#7d8590', t: 'TXT' }, log: { c: '#7d8590', t: 'LOG' },
  dockerfile: { c: '#0db7ed', t: 'DK' }, makefile: { c: '#6d8086', t: 'MK' },
  cmake: { c: '#6d8086', t: 'CM' }, gradle: { c: '#02303a', t: 'GRD' },
  gemfile: { c: '#cc342d', t: 'GEM' }, rakefile: { c: '#cc342d', t: 'RAK' },
};

// Media / archive extensions get a pictogram rather than a monogram badge.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'ogg']);
const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz']);

function svg(inner) {
  return `<svg class="ti-svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${inner}</svg>`;
}

// A rounded "page" badge with a monogram. Font size shrinks for longer labels.
function badge(color, label, fg) {
  const n = label.length;
  const fs = n <= 1 ? 8 : n === 2 ? 7 : n === 3 ? 5.4 : 4.4;
  const text = label
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return svg(
    `<rect x="1.25" y="1.5" width="13.5" height="13" rx="2.4" fill="${color}"/>` +
    `<text x="8" y="8.3" dominant-baseline="central" text-anchor="middle" ` +
    `font-family="-apple-system,Segoe UI,sans-serif" font-weight="700" ` +
    `font-size="${fs}" fill="${fg || '#ffffff'}">${text}</text>`
  );
}

const IMAGE_ICON = svg(
  `<rect x="1.25" y="2.5" width="13.5" height="11" rx="2" fill="#26a269"/>` +
  `<circle cx="5.4" cy="6" r="1.4" fill="#fff"/>` +
  `<path d="M2 12.5l3.6-3.4 2.3 2.1 2.7-3 3.4 4.3z" fill="#bff0d0"/>`
);
const VIDEO_ICON = svg(
  `<rect x="1.25" y="2.5" width="13.5" height="11" rx="2" fill="#a347ba"/>` +
  `<path d="M6.4 5.4l4.4 2.6-4.4 2.6z" fill="#fff"/>`
);
const ARCHIVE_ICON = svg(
  `<rect x="1.5" y="1.5" width="13" height="13" rx="2.2" fill="#d9a441"/>` +
  `<rect x="7.1" y="1.5" width="1.8" height="13" fill="#9c6f1e"/>` +
  `<rect x="6.9" y="5" width="2.2" height="2.2" fill="#fff3d6"/>`
);
const DEFAULT_ICON = svg(
  `<path d="M3.5 1.5h5.6L13 5.4v8.1a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z" ` +
  `fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.7"/>` +
  `<path d="M9 1.6V5.2h3.6" fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.7"/>`
);

const FOLDER_CLOSED = svg(
  `<path d="M1.5 4.2a1.2 1.2 0 0 1 1.2-1.2h3.1l1.4 1.5h6.1a1.2 1.2 0 0 1 1.2 1.2v6.6a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2z" fill="#5b9bd5"/>`
);
const FOLDER_OPEN = svg(
  `<path d="M1.5 4.2a1.2 1.2 0 0 1 1.2-1.2h3.1l1.4 1.5h6.1a1.2 1.2 0 0 1 1.2 1.2v1.1H1.5z" fill="#5b9bd5"/>` +
  `<path d="M1.5 6.2h13.2l-1.5 6a1.1 1.1 0 0 1-1.07.83H2.7a1.2 1.2 0 0 1-1.2-1.2z" fill="#7eb6e8"/>`
);

// Public: SVG string for a file by extension (lowercased, dotless).
function iconForFile(ext) {
  const e = (ext || '').toLowerCase();
  if (IMAGE_EXT.has(e)) return IMAGE_ICON;
  if (VIDEO_EXT.has(e)) return VIDEO_ICON;
  if (ARCHIVE_EXT.has(e)) return ARCHIVE_ICON;
  const d = TYPES[e];
  if (d) return badge(d.c, d.t, d.fg);
  return DEFAULT_ICON;
}

function iconForFolder(open) {
  return open ? FOLDER_OPEN : FOLDER_CLOSED;
}

export { iconForFile, iconForFolder };
