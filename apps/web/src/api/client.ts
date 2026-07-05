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

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry && !original.url?.includes('/auth/')) {
      original._retry = true;
      try {
        const { data } = await api.post('/auth/refresh');
        setToken(data.accessToken);
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return api(original);
      } catch {
        setToken(null);
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

export const fmtMoney = (minor: number | string | null, currency = 'AZN'): string => {
  if (minor == null) return '···';
  return `${(Number(minor) / 100).toLocaleString('az-AZ', { minimumFractionDigits: 2 })} ${currency}`;
};
