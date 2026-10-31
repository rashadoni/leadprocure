import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

export type Loader<T> = {
  data: T;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
  set: (next: T) => void;
};

// One list load, one honest outcome. A bare `api.get(...).then(setRows)` turns a failed
// request into an empty table — the reader cannot tell "the market is empty" from "the
// request died", and the rejection is never handled at all. The sequence guard also keeps
// a slow earlier response (page 1) from landing on top of the page the reader asked for.
// NoInfer on the fetcher is load-bearing: `api.get(...).then((r) => r.data)` is
// Promise<any>, and an `any` candidate wins inference outright — T would collapse to
// `any` and every `loader.data.map((x) => …)` on a page would become an implicit-any
// build error. Inferring T from `initial` alone keeps the `any[]` the pages used to get
// from useState<any[]>([]).
export function useLoad<T>(fetcher: () => Promise<NoInfer<T>>, deps: DependencyList, initial: T): Loader<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  // The fetcher closes over this page's own state; the call site names what it depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setFailed(false);
    try {
      const next = await fetcher();
      if (mine === seq.current) setData(next);
    } catch {
      if (mine === seq.current) setFailed(true);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, deps);
  useEffect(() => {
    run();
    // A response that arrives after the deps changed, or after unmount, is no longer ours.
    return () => { seq.current++; };
  }, [run]);
  return { data, loading, failed, reload: run, set: setData };
}

type AnyLoader = { loading: boolean; failed: boolean; reload: () => unknown };

// The one line a list owes its reader: loading, or a failure with a Retry that really
// retries, or that it is genuinely empty. Pages that load several lists share one line;
// Retry then re-runs exactly the loads that failed.
export function ListState({ of, empty }: { of: AnyLoader | AnyLoader[]; empty?: boolean }) {
  const { t } = useI18n();
  const all = Array.isArray(of) ? of : [of];
  const broken = all.filter((l) => l.failed);
  if (broken.length) {
    return (
      <div role="alert">
        <span>{t('list_error')}</span>{' '}
        <button className="btn small ghost" onClick={() => broken.forEach((l) => l.reload())}>
          {t('list_retry')}
        </button>
      </div>
    );
  }
  if (all.some((l) => l.loading)) return <div role="status" className="hint">{t('list_loading')}</div>;
  if (empty) return <div className="hint">{t('list_empty')}</div>;
  return null;
}
