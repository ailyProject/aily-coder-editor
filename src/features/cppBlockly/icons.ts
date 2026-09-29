// Small outline icons shared by the editor toolbar and its toolbox categories.
const paths = {
  blocks: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  source: 'M8 8l-4 4 4 4 M16 8l4 4-4 4 M14 4l-4 16',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6.1 6.1A8 8 0 0 1 20 12 M4 12a8 8 0 0 0 13.9 5.9',
  undo: 'M8 4L3 9l5 5 M3 9h11a6 6 0 0 1 0 12',
  redo: 'M16 4l5 5-5 5 M21 9H10a6 6 0 0 0 0 12',
  fit: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M8 8h8v8H8z',
  preview: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  apply: 'M5 3h9l5 5v5 M14 3v5h5 M5 3v18h6 M13 18l3 3 6-7',
  call: 'M4 5h6v6H4z M14 13h6v6h-6z M7 11v5h7 M11 5h6v5',
  control: 'M12 3l5 5-5 5-5-5z M7 8H3v11h7 M17 8h4v11h-7 M10 17v4h4v-4z',
  variable: 'M8 4H6a2 2 0 0 0-2 2v3l-2 3 2 3v3a2 2 0 0 0 2 2h2 M16 4h2a2 2 0 0 1 2 2v3l2 3-2 3v3a2 2 0 0 1-2 2h-2 M9 9l6 6 M15 9l-6 6',
  math: 'M3 7h8 M7 3v8 M15 7h6 M4 16l6 6 M10 16l-6 6 M15 16h6 M15 21h6',
  function: 'M16 4c-5-2-6 1-7 6l-1 6c-.5 4-2 5-5 3 M5 10h10 M16 13l5 7 M21 13l-5 7',
  text: 'M4 5h16 M12 5v15 M8 20h8 M4 9V5 M20 9V5',
  array: 'M12 3L2 8l10 5 10-5z M2 12l10 5 10-5 M2 16l10 5 10-5',
  chip: 'M6 6h12v12H6z M9 9h6v6H9z M9 2v4 M15 2v4 M9 18v4 M15 18v4 M2 9h4 M2 15h4 M18 9h4 M18 15h4',
  time: 'M9 2h6 M12 2v3 M12 8v5l3 2 M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  serial: 'M3 7h18 M17 3l4 4-4 4 M21 17H3 M7 13l-4 4 4 4',
  flag: 'M5 22V3 M5 3c5-4 9 4 15 0v11c-6 4-10-4-15 0',
  search: 'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'
} as const
export type CppIcon = keyof typeof paths
export function cppIcon(name: CppIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name]); svg.append(path)
  return svg
}
