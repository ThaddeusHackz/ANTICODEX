import React from 'react';

// One icon set for the whole shell. The old rail used Unicode glyphs (⌗ ⌘ ✳
// ⌥ ▦ ▶ ⇄ ▣ ✦ ⟲ ◈ ⇪) which render at different weights and baselines on every
// OS and made the same product look different on macOS, Windows and Linux.
// These are 24×24 stroked paths: crisp at 16–20px, inheriting currentColor.
const PATHS = {
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l2.1-4.2A8.5 8.5 0 1 1 21 11.5Z|M8 11h8M8 15h5',
  codex: 'M8 9 4 12l4 3M16 9l4 3-4 3M14 5l-4 14',
  agent: 'M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3Z|M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14Z',
  sandbox: 'M5 7h14v11H5z|M9 7V5h6v2M8 11h8M8 14h5',
  images: 'M4 5h16v14H4z|M4 16l4.5-4.5 3 3L15 11l5 5|M9 9.2a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0Z',
  video: 'M4 6h11v12H4z|M15 10l5-3v10l-5-3',
  connectors: 'M9 7V4M15 7V4|M6 7h12v5a6 6 0 0 1-12 0V7Z|M12 18v3',
  computer: 'M3 5h18v12H3z|M8 21h8M12 17v4',
  skills: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3Z|M19 3l.7 1.8L21.5 5.5l-1.8.7L19 8l-.7-1.8L16.5 5.5l1.8-.7L19 3Z',
  rea: 'M20 11a8 8 0 1 1-2.3-5.6|M20 4v6h-6|M12 8v4l3 2',
  qoder: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z|M12 8l4 2.2v4.4L12 17l-4-2.4v-4.4L12 8Z',
  setup: 'M12 4v12|M7 9l5-5 5 5|M5 20h14',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z|M21 21l-4.3-4.3',
  library: 'M4 5h5v14H4zM11 5h4v14h-4zM17 6l3-.8 3.5 12.3-3 .8z',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z|M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V20h-3v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L6.6 16l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H5v-3h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L6.3 7l2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V4h3v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.7 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v3h-.2a1.7 1.7 0 0 0-1.4 1Z',
  send: 'M12 19V5|M6 11l6-6 6 6',
  stop: 'M7 7h10v10H7z',
  attach: 'M8 12.5l6.4-6.4a3 3 0 0 1 4.2 4.2l-8.5 8.5a5 5 0 0 1-7.1-7.1l8-8',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z|M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8',
  copy: 'M9 9h10v10H9z|M5 15H4V4h11v1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  file: 'M6 3h8l4 4v14H6z|M14 3v5h4',
  folder: 'M3 7h7l2 2h9v10H3z',
  terminal: 'M4 5h16v14H4z|M7 9l3 3-3 3M13 15h4',
  check: 'M5 12.5l4.5 4.5L19 7',
  alert: 'M12 3l9 17H3L12 3Z|M12 9v5M12 17h.01',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z|M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z',
  remote: 'M5 17h14v3H5z|M8 17V9h8v8|M12 5v4M9 2h6',
  arrow: 'M5 12h14|M13 6l6 6-6 6',
  refresh: 'M20 11a8 8 0 1 0-2 5.5|M20 4v7h-7',
  download: 'M12 3v12|M7 10l5 5 5-5|M4 21h16',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  spark: 'M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2Z',
  key: 'M14 7a4 4 0 1 1-2.5 7.1L4 21.5 2.5 20 2 18l2-2 1.5 1 2-2 1.5 1 3-3A4 4 0 0 1 14 7Z|M16 6h.01',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6l1-8Z',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  layers: 'M12 3l9 5-9 5-9-5 9-5Z|M3 12l9 5 9-5|M3 16l9 5 9-5',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z|M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z|M12 7v5l3 2',
  external: 'M14 4h6v6|M20 4l-9 9|M18 14v6H4V6h6',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z|M15.5 8.5l-2 5-5 2 2-5 5-2Z'
};

export default function Icon({ name, size = 18, strokeWidth = 1.7, className = '', title }) {
  const paths = String(PATHS[name] || PATHS.chat).split('|');
  return (
    <svg
      className={`acx-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS);
