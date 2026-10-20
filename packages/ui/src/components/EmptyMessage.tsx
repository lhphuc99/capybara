import type { ReactNode } from 'react';

/** What a list shows while it has nothing to show: a title, and what to do about it. */
export function EmptyMessage({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={className ? `empty ${className}` : 'empty'}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** A whole panel with nothing to show yet. */
export function EmptyPanel(props: { title: string; children?: ReactNode; className?: string }) {
  return (
    <section className="panel">
      <EmptyMessage {...props} />
    </section>
  );
}
