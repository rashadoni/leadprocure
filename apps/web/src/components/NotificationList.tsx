import { fmtDateTime } from '../api/client';
import { useI18n } from '../i18n';
import { notifText } from './humanize';
import { ListState, Loader } from './ListState';

type Note = {
  id: string; type: string; payload?: Record<string, unknown>;
  read_at?: string | null; created_at: string;
};

/**
 * Notifications about one order, gathered into one block.
 *
 * The list was flat and newest-first, so three messages about the same delivery sat in
 * three places with the order number repeated in each, and the only question a reader
 * actually has — "what happened to PO-7?" — took reading every line to answer.
 *
 * A lone message keeps its own row on purpose: a heading over a single line is noise, and
 * `notifText` already names the order inside the sentence. A group stays where its NEWEST
 * message would have been, so the page still reads newest-first — gathering must not
 * promote an old order to the top because it has a long history.
 */
export function groupNotes(notes: Note[]): { po?: string; items: Note[] }[] {
  const used = new Set<string>();
  const groups: { po?: string; items: Note[] }[] = [];
  const poOf = (n: Note): string | undefined =>
    typeof n.payload?.po_no === 'string' && n.payload.po_no ? n.payload.po_no : undefined;
  for (const n of notes) {
    if (used.has(n.id)) continue;
    const po = poOf(n);
    if (!po) { used.add(n.id); groups.push({ items: [n] }); continue; }
    const items = notes.filter((o) => poOf(o) === po);
    items.forEach((o) => used.add(o.id));
    groups.push({ po: items.length > 1 ? po : undefined, items });
  }
  return groups;
}

/**
 * The notifications card, in ONE place: both panels drew their own table, and only the
 * buyer's learned to mark messages read — the supplier's had no way to clear anything.
 * `onRead`/`onReadAll` are optional so the read controls appear only where the caller
 * supports them, rather than pretending to.
 */
export function NotificationList({ notes, onRead, onReadAll }: {
  notes: Loader<Note[]>;
  onRead?: (id: string) => void;
  onReadAll?: () => void;
}) {
  const { t } = useI18n();
  const groups = groupNotes(notes.data);
  const columns = onRead ? 3 : 2;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0 }}>{t('notifications')}</h3>
        {onReadAll && notes.data.some((n) => !n.read_at) && (
          <button className="btn small ghost" onClick={onReadAll}>✓ {t('mark_all_read')}</button>
        )}
      </div>
      <ListState of={notes} empty={!notes.data.length} />
      <table>
        {groups.map((g, gi) => (
          // One tbody per group: the heading row belongs to its messages, so a browser
          // keeps them together and the rule under the last row falls between orders.
          <tbody key={g.po ?? g.items[0]?.id ?? gi}>
            {g.po && (
              <tr>
                <td colSpan={columns} style={{ paddingTop: gi === 0 ? 0 : 10 }}>
                  <b>{t('order_no')} {g.po}</b>{' '}
                  <span className="hint">· {g.items.length} {t('notif_group_order')}</span>
                </td>
              </tr>
            )}
            {g.items.map((n) => (
              <tr key={n.id} style={{ opacity: n.read_at ? 0.5 : 1 }}>
                {/* indented under its heading, so the block reads as one order's history */}
                <td style={g.po ? { paddingLeft: 18 } : undefined}>{notifText(t, n)}</td>
                <td className="hint nowrap">{fmtDateTime(n.created_at)}</td>
                {onRead && (
                  <td>
                    {!n.read_at && (
                      <button className="btn small ghost" onClick={() => onRead(n.id)}>✓ {t('mark_read')}</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
