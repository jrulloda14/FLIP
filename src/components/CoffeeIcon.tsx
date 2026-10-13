/** A line-drawn coffee cup in the board's ink, sized to the surrounding text. */
export function CoffeeIcon() {
  return (
    <svg className="fl-icon" viewBox="0 0 16 16" width="1.15em" height="1.15em" aria-hidden="true" focusable="false">
      <path d="M2.5 6.5h9v4a3 3 0 0 1-3 3h-3a3 3 0 0 1-3-3z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M11.5 7.5h1a1.75 1.75 0 0 1 0 3.5h-1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 1.8c-.6.7.6 1.3 0 2.2M8 1.8c-.6.7.6 1.3 0 2.2" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}
