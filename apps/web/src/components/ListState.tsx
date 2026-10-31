import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

// 403 is this API's "you may not have this": FeatureGuard throws ForbiddenException for an
// unlicensed feature and the role guard answers the same way. A page that then shows fewer
// options is CORRECT, so that one failure stays quiet. Every other failure is a dead
// request, and swallowing it the same way is exactly what makes a broken read look like an
// org that simply has nothing configured.
export const isDenied = (e: any) => e?.response?.status === 403;

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
    } catch (e) {
      // Denied is not failed, here too: an org without a feature's licence used to see an
      // empty list, and reporting that as "could not load" would be the same lie in the
      // other direction.
      if (mine === seq.current && !isDenied(e)) setFailed(true);
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
  // Order is load-bearing and must stay error → loading → empty: with "empty" first, a dead
  // request reads as "there is nothing here", which is the exact lie this component exists
  // to stop. The classes below are presentation only — `role="alert"` and `role="status"`
  // are what the browser specs select on, and nothing here adds a SECOND alert to a page
  // (analytics.spec.ts and helpers/budget-report.ts match getByRole('alert') unfiltered and
  // assert it is absent once healthy, so a second one is a strict-mode violation, not a
  // readable failure).
  if (broken.length) {
    return (
      <div role="alert" className="state-error">
        <span aria-hidden="true">⚠</span>
        <span>{t('list_error')}</span>
        <button className="btn small ghost" onClick={() => broken.forEach((l) => l.reload())}>
          {t('list_retry')}
        </button>
      </div>
    );
  }
  if (all.some((l) => l.loading)) return <div role="status" className="hint state-empty">{t('list_loading')}</div>;
  if (empty) return <div className="hint state-empty">{t('list_empty')}</div>;
  return null;
}
