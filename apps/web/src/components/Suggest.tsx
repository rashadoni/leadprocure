import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';

// Поле, которое подсказывает из уже известного и принимает новое.
//
// До этого здесь стоял обычный `<input list="...">` с `<datalist>`, и это выглядело не как
// часть продукта: браузер рисует свой список своим шрифтом, в Chrome на тёмной теме — чёрным
// пузырём, похожим на подсказку. Владелец, набрав «av» и увидев этот пузырь с одним словом,
// сказал: «поиск не такой должен быть». Нативный список и правда отвечает на другой вопрос:
// он предлагает варианты, но не говорит ни сколько их, ни что будет, если ввести своё, —
// а в закупках своё вводят постоянно: категория у каждой компании называется по-своему.
//
// Поэтому список рисует приложение:
//  · совпадения фильтруются по подстроке, без учёта регистра, и видно, сколько их;
//  · последней строкой, когда набранного среди известных нет, стоит «+ создать "AV"» —
//    то есть «добавится само» сказано словами, а не угадывается;
//  · стрелки/Enter/Esc работают, поэтому роли `combobox`/`listbox` здесь честные: обещание,
//    которого клавиатура не держит, хуже отсутствия обещания (см. RowMenu).
//
// Значение поля — это ТЕКСТ, а не идентификатор: страница отправляет его как раньше, и
// ничего на сервере не меняется. Новая категория заводится на стороне страницы, если она
// того хочет (`onCreate`), и это не условие отправки формы.
export interface SuggestOption {
  value: string;
  /** Что показать вместо значения — например «Bütün kateqoriyalar (*)» для `*`. */
  label?: string;
  /** Вторая строка в списке: откуда вариант взялся или что он значит. */
  hint?: string;
}

export function Suggest({
  value, onChange, options, id, testid, placeholder, required, allowNew = true, tip, emptyHint,
}: {
  value: string;
  onChange: (v: string) => void;
  options: (string | SuggestOption)[];
  id?: string;
  testid?: string;
  placeholder?: string;
  required?: boolean;
  /** false — только из списка (поле всё равно текстовое, просто не предлагает «создать»). */
  allowNew?: boolean;
  tip?: string;
  /** Что сказать, когда список пуст вовсе: «ещё ни одной категории». */
  emptyHint?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  const all: SuggestOption[] = useMemo(
    () => options.map((o) => (typeof o === 'string' ? { value: o } : o)).filter((o) => o.value !== ''),
    [options],
  );

  // Фильтр по подстроке, а не по началу: категорию «OFFICE_FURNITURE» ищут и по «furn».
  const needle = value.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return all;
    return all.filter((o) => `${o.value} ${o.label ?? ''}`.toLowerCase().includes(needle));
  }, [all, needle]);

  // «Создать» предлагается только когда набранного ТОЧНО нет среди известных: иначе строка
  // «создать "IT"» стояла бы под строкой «IT» и спрашивала бы, чем они отличаются.
  const exact = all.some((o) => o.value.toLowerCase() === needle);
  const canCreate = allowNew && needle.length > 0 && !exact;
  const rows = canCreate ? matches.length + 1 : matches.length;
  // Пустой список без объяснения не рисуется вовсе: у поля, куда и так пишут своё
  // (заголовок заявки), «совпадений нет» — шум, закрывающий то, что под ним.
  const show = open && (rows > 0 || !!emptyHint);

  useEffect(() => { setCursor(0); }, [needle, open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const pick = (i: number) => {
    if (canCreate && i === matches.length) { onChange(value.trim()); setOpen(false); return; }
    const o = matches[i];
    if (o) { onChange(o.value); setOpen(false); }
  };

  return (
    <div className="suggest" ref={box}>
      <input
        id={id}
        data-testid={testid}
        data-tip={tip}
        value={value}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        // Выбор мышью идёт на mousedown (он раньше blur), поэтому закрыть на blur
        // безопасно — и список перестаёт накрывать поле, стоящее под ним.
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); return; }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) { setOpen(true); return; }
            setCursor((c) => (rows ? (c + (e.key === 'ArrowDown' ? 1 : rows - 1)) % rows : 0));
            return;
          }
          // Enter выбирает подсвеченное и НЕ отправляет форму: иначе первое же нажатие
          // создавало бы заявку с полузаполненной строкой. Форма отправляется кнопкой.
          if (e.key === 'Enter' && open && rows) { e.preventDefault(); pick(cursor); }
        }}
      />
      {show && (
        <div className="suggest-pop" id={listId} role="listbox">
          {matches.map((o, i) => (
            <button type="button" key={o.value} role="option" aria-selected={i === cursor}
              className={`suggest-row${i === cursor ? ' on' : ''}`}
              // mousedown, а не click: click приходит уже после blur поля, и список к тому
              // моменту закрыт — выбор мышью просто не срабатывал бы.
              onMouseDown={(e) => { e.preventDefault(); pick(i); }}
              onMouseEnter={() => setCursor(i)}>
              <b>{o.label ?? o.value}</b>
              {o.hint && <span className="hint">{o.hint}</span>}
            </button>
          ))}
          {canCreate && (
            <button type="button" role="option" aria-selected={cursor === matches.length}
              data-testid={testid ? `${testid}-create` : undefined}
              className={`suggest-row suggest-new${cursor === matches.length ? ' on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(matches.length); }}
              onMouseEnter={() => setCursor(matches.length)}>
              <b>+ {t('suggest_create').replace('%s', value.trim())}</b>
              <span className="hint">{t('suggest_create_hint')}</span>
            </button>
          )}
          {!matches.length && !canCreate && (
            <div className="suggest-row suggest-empty hint">{emptyHint ?? t('suggest_empty')}</div>
          )}
        </div>
      )}
    </div>
  );
}
