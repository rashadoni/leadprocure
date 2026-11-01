import axios from 'axios';

// Access token lives in memory only (never localStorage); the refresh token is an
// httpOnly cookie managed by the API. On 401 we refresh once and retry.
let accessToken: string | null = null;
export const setToken = (t: string | null) => (accessToken = t);
export const getToken = () => accessToken;

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000',
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

// Coalesce concurrent refreshes into one in-flight request. Without this, a page reload
// (StrictMode double-mount) or several 401s at once each POST /auth/refresh with the same
// cookie; rotating-refresh then sees the second as a replay. One shared promise = one
// rotation per burst.
let refreshInFlight: Promise<string> | null = null;
export function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = api
      .post('/auth/refresh')
      .then(({ data }) => {
        setToken(data.accessToken);
        return data.accessToken as string;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry && !original.url?.includes('/auth/')) {
      original._retry = true;
      try {
        const token = await refreshAccessToken();
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      } catch {
        setToken(null);
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

// The UI language decides how numbers and dates are written. US-style 7/14/2026 reads wrong
// in az and ru, and money used to be pinned to az-AZ whatever the interface was speaking.
const uiLocale = () => {
  const lang = localStorage.getItem('lp_lang') || 'ru';
  return lang === 'az' ? 'az-AZ' : lang === 'en' ? 'en-GB' : 'ru-RU';
};

// `···` is not "empty", it is "sealed": a bid amount the reader may not see yet. `—` means
// there is genuinely nothing. Keep them apart — the buyer's bid table says "🔒 amounts
// hidden until opening" above exactly these cells.
export const fmtMoney = (minor: number | string | null, currency = 'AZN'): string => {
  if (minor == null) return '···';
  return `${(Number(minor) / 100).toLocaleString(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
};

// Axis ticks on the spend chart. Three full amounts stacked up the side of a 170px plot are
// unreadable, and a bar chart whose scale appears nowhere is the one the reader distrusts.
// Intl's own compact notation writes the abbreviation in the interface language — «125 тыс.»,
// "125K" — so there is no hand-made suffix table to keep correct in three languages.
// Takes a plain number, not the nullable money the other helpers take: an axis tick is
// always computed, and `···` here would mean "sealed" where nothing is sealed.
// Two fraction digits, not one, because the round-top ladder in Analytics includes 2.5: a
// scale of 2 500 puts the middle rule at 1 250, and one digit printed that as «1,3 тыс.» —
// a label sitting 4% away from the line it names, which is worse than no label at all.
export const fmtNumShort = (minor: number): string =>
  (minor / 100).toLocaleString(uiLocale(), { notation: 'compact', maximumFractionDigits: 2 });

// Every date in the product goes through these two. Calling toLocaleString() with no
// arguments anywhere else brings back the browser's own locale — which is how one tender's
// deadline came to be written four different ways on four screens.
export const fmtDate = (iso: string | Date | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString(uiLocale()) : '—';
export const fmtDateTime = (iso: string | Date | null | undefined): string =>
  iso ? new Date(iso).toLocaleString(uiLocale(), { dateStyle: 'short', timeStyle: 'short' }) : '—';
// Anti-sniping moves an auction's close_at by seconds, so the one clock on that panel has
// to show them. Everywhere else seconds are noise.
export const fmtDateTimeSec = (iso: string | Date | null | undefined): string =>
  iso ? new Date(iso).toLocaleString(uiLocale(), { dateStyle: 'short', timeStyle: 'medium' }) : '—';
