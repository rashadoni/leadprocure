import { useEffect, useState } from 'react';

// Время, по которому страница решает, истёк ли срок.
//
// `Date.now()` прямо в отрисовке читается один раз и больше не меняется: срок истекает сам,
// без действий человека, а страница об этом не узнаёт. На карточке закупки это выглядело как
// кнопка «Сделать контракт», которая остаётся серой до перезагрузки, хотя пауза уже кончилась.
//
// Поэтому вместо опроса раз в секунду — одна перерисовка ровно в тот момент, когда истекает
// БЛИЖАЙШИЙ из переданных сроков. Нет сроков впереди — нет и таймера.
export function useDeadlineTick(deadlines: Array<string | null | undefined>): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const next = deadlines
    .map((d) => (d ? new Date(d).getTime() : NaN))
    .filter((t) => Number.isFinite(t) && t > nowMs)
    .sort((a, b) => a - b)[0];
  useEffect(() => {
    if (next === undefined) return;
    // +1000 мс, чтобы перерисовка случилась уже ПОСЛЕ срока, а не на его границе.
    const id = setTimeout(() => setNowMs(Date.now()), next - Date.now() + 1000);
    return () => clearTimeout(id);
  }, [next]);
  return nowMs;
}
