// Line icons in the spirit of SF Symbols, drawn on a 24px grid. Render <IconSprite /> once.

const PATHS = {
  overview: "M12 3v9h9M21 12a9 9 0 1 1-9-9",
  list: "M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01",
  tray: "M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6H3v-6z",
  import: "M12 3v12M7 10l5 5 5-5M4 20h16",
  tag: "M3 12V4h8l10 10-8 8zM7.5 7.5h.01",
  bank: "M3 10h18M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18M12 3l9 5H3z",
  card: "M5 5.5h14a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 16V8A2.5 2.5 0 0 1 5 5.5zM2.5 10h19",
  search: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.2-4.2",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  updown: "M7 9l5-5 5 5M7 15l5 5 5-5",
  cart: "M3 4h2.5l2.2 11h10.8L21 7.5H6.4M9.5 20h.01M17.5 20h.01",
  fork: "M7 3v18M4.5 3v5a2.5 2.5 0 0 0 5 0V3M17 21V3c-2.4 1.6-3 5-3 8h3",
  house: "M3.5 11L12 4l8.5 7M6 9.5V20h12V9.5",
  bolt: "M13 2L5 13.5h6L10 22l8-11.5h-6z",
  bag: "M5 8h14l-1.2 13H6.2zM9 8V6.5a3 3 0 0 1 6 0V8",
  tram: "M9 3h6a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM6 10h12M9 20l-2 1.5M15 20l2 1.5M9.5 13h.01M14.5 13h.01",
  plane: "M10.5 21l1.5-1.5V14l8 3v-2.5l-8-5V4a1.5 1.5 0 0 0-3 0v5.5l-8 5V17l8-3v5.5L10.5 21",
  tv: "M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 21h8",
  heart: "M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z",
  gift: "M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-1.5-3-5-3-5-1s3 1 5 1zM12 7c1.5-3 5-3 5-1s-3 1-5 1z",
  shield: "M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z",
  swap: "M5 8h14M15.5 4.5L19 8l-3.5 3.5M19 16H5M8.5 12.5L5 16l3.5 3.5",
  back: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  q: "M9.2 9a3 3 0 1 1 4.1 2.8c-.8.3-1.3 1-1.3 1.9v.3M12 17.5h.01",
  case: "M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zM9 7V5h6v2M3 12.5h18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  doc: "M6.5 2.5h8l4 4v15h-12zM14 2.5V7h4.5",
  split: "M12 21v-6M12 15L6 9V4M12 15l6-6V4M3.5 6.5L6 4l2.5 2.5M15.5 6.5L18 4l2.5 2.5",
  people: "M9 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14a6.5 6.5 0 0 1 3 6",
  trash: "M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
  jar: "M8 3h8M9 3v2.5A5 5 0 0 0 5 10.5V17a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4v-6.5a5 5 0 0 0-4-5V3M9.5 13h5",
  cash: "M3 7h18v10H3zM12 9.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM6.5 10v4M17.5 10v4",
} as const;

export type IconName = keyof typeof PATHS;

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      {Object.entries(PATHS).map(([name, d]) => (
        <symbol key={name} id={`i-${name}`} viewBox="0 0 24 24">
          <path d={d} />
        </symbol>
      ))}
    </svg>
  );
}

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg className={`i ${className}`} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}
