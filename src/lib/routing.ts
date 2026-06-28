// Client-side provider routing for network inference.
//
// `tenzro_listModelEndpoints` returns every endpoint visible to the
// node — each with its live load + status — rather than a single
// pre-routed pick. Studio chooses among them here so the choice can
// react to load as the endpoint list refreshes.

export interface ModelEndpoint {
  instance_id: string;
  model_id: string;
  provider?: string;
  provider_name?: string;
  api_url?: string;
  api_endpoint?: string;
  /** "Online" | "Offline" | "Degraded" — from ServiceStatus. */
  status?: string;
  /** Live load snapshot from the node's load tracker (absent when the
   *  provider isn't actively serving / hasn't been probed). */
  load?: {
    active_requests?: number;
    max_concurrent?: number;
    utilization_percent?: number;
    load_level?: string;
  };
  pricing?: { input?: number; output?: number };
}

/** Pick the best provider for a model from the live endpoint list.
 *
 *  Order of preference:
 *    1. Online status (skip Offline/Degraded when a healthy one exists)
 *    2. Least loaded — lowest utilization_percent (spreads traffic,
 *       avoids queueing behind a saturated provider)
 *    3. Cheaper — lower output price as the tie-break
 *
 *  Returns null when the list is empty. When no endpoint reports load
 *  or status (older providers), this degrades to "first healthy, else
 *  first" — never worse than naive first-in-list selection. */
export function pickProvider(endpoints: ModelEndpoint[]): ModelEndpoint | null {
  if (endpoints.length === 0) return null;

  const isHealthy = (e: ModelEndpoint) =>
    !e.status || e.status.toLowerCase() === "online";
  const healthy = endpoints.filter(isHealthy);
  const pool = healthy.length > 0 ? healthy : endpoints;

  const utilization = (e: ModelEndpoint) =>
    e.load?.utilization_percent ?? Number.POSITIVE_INFINITY;
  const price = (e: ModelEndpoint) => e.pricing?.output ?? e.pricing?.input ?? 0;

  return [...pool].sort((a, b) => {
    const ua = utilization(a);
    const ub = utilization(b);
    if (ua !== ub) return ua - ub;
    return price(a) - price(b);
  })[0];
}
