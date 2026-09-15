import { useCallback, useEffect, useState } from 'react';

import { getJson, type ApiFailure } from '../shared/api.js';

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; failure: ApiFailure };

export interface ApiResource<T> {
  state: ResourceState<T>;
  reload: () => void;
}

// Fetches one GET endpoint and exposes loading / ready / error, with a reload
// that re-runs the request. The route is the effect key so navigation and
// reloads refetch; callers must pass a stable, serialized route. A null route
// means "idle": no request is made and the last state is kept, for callers that
// mount a resource conditionally without changing hook order.
export function useApiResource<T>(route: string | null): ApiResource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (route === null) return;
    let active = true;
    setState({ status: 'loading' });
    void getJson<T>(route).then((outcome) => {
      if (!active) return;
      setState(
        outcome.ok
          ? { status: 'ready', data: outcome.data }
          : { status: 'error', failure: outcome.failure },
      );
    });
    return () => {
      active = false;
    };
  }, [route, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { state, reload };
}
