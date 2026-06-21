interface SkeletonProps {
  className?: string;
}

/** Single shimmer block. Use multiple stacked to mimic the eventual
 *  content layout — Linear / Notion pattern (no layout shift on load). */
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse bg-secondary/60 ${className}`}
      aria-hidden="true"
    />
  );
}

/** Row matching the catalog-list shape (model name + meta + size tag). */
export function ModelRowSkeleton() {
  return (
    <div className="border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="mt-3 space-y-1.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  body?: string;
  cta?: { label: string; onClick: () => void };
}

/** Monochrome lucide-style empty state — Linear / Notion pattern.
 *  No mascot, no illustration. One headline + one optional CTA. */
export function EmptyState({ title, body, cta }: EmptyStateProps) {
  return (
    <div className="border border-border bg-card p-10 text-center">
      <p className="text-base font-medium">{title}</p>
      {body && (
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          {body}
        </p>
      )}
      {cta && (
        <button
          onClick={cta.onClick}
          className="mt-6 border border-border bg-primary px-4 py-2 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          {cta.label}
        </button>
      )}
    </div>
  );
}
