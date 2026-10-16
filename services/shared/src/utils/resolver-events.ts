/**
 * Resolver record history from the ENS subgraph.
 *
 * `textChangeds` / `multicoinAddrChangeds` / `contenthashChangeds` on Resolver are
 * ENSNode extensions; the standard ENS subgraph (e.g. the Sepolia Studio subgraph)
 * only exposes the `events` interface. Query `events` instead (works on both) and
 * rebuild the per-type arrays so callers can keep reading the familiar fields.
 */

// Newest 1000 events, so a resolver with heavy record churn keeps its latest values.
// normalizeResolverEvents() puts them back in chronological order.
export const RESOLVER_EVENTS_FIELDS = `
  events(first: 1000, orderBy: blockNumber, orderDirection: desc) {
    __typename
    ... on TextChanged {
      key
      value
    }
    ... on MulticoinAddrChanged {
      coinType
      addr
    }
    ... on ContenthashChanged {
      hash
    }
  }
`;

/**
 * Populate resolver.textChangeds, resolver.multicoinAddrChangeds and
 * resolver.contenthashChangeds (oldest first) from resolver.events.
 * Mutates and returns the resolver; no-op when it is null or has no events field.
 */
export function normalizeResolverEvents<T extends Record<string, any> | null | undefined>(resolver: T): T {
  if (!resolver || !Array.isArray(resolver.events)) {
    return resolver;
  }

  const events = [...resolver.events].reverse();
  const r = resolver as Record<string, any>;
  r.textChangeds = events
    .filter((e: any) => e.__typename === 'TextChanged')
    .map((e: any) => ({ key: e.key, value: e.value }));
  r.multicoinAddrChangeds = events
    .filter((e: any) => e.__typename === 'MulticoinAddrChanged')
    .map((e: any) => ({ coinType: e.coinType, addr: e.addr }));
  r.contenthashChangeds = events
    .filter((e: any) => e.__typename === 'ContenthashChanged')
    .map((e: any) => ({ hash: e.hash }));
  return resolver;
}
