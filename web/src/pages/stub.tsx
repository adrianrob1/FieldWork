import type { ReactNode } from 'react';

export function PagePlaceholder({
  glyph = '◔',
  heading,
  body,
  actions,
}: {
  glyph?: string;
  heading: string;
  body: string;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="glyph">{glyph}</p>
      <h2>{heading}</h2>
      <p>{body}</p>
      {actions}
    </div>
  );
}

export function SheetPlaceholder({
  kicker,
  heading,
  body,
}: {
  kicker: string;
  heading: string;
  body: string;
}) {
  return (
    <div className="sheet">
      <div className="chead rise">
        <p className="kick">{kicker}</p>
        <h1>{heading}</h1>
        <p className="sub">{body}</p>
      </div>
    </div>
  );
}
