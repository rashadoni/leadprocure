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
 * The list was flat and newest-first, so four messages about the same delivery sat in four
 * places, and the only question a reader actually has — "what happened to PO-7?" — took
 * reading every line to answer. One block per order answers it.
 *
 * Grouped by `po_id`, NOT by `po_no`: every notification an order emits carries the id,
 * but only four of the seven types carry the number (`GRN_RECORDED` and the two amendment
 * decisions do not — contracts.module.ts). Keying on the number left exactly the events a
 * reader cares about most — a receipt recorded, an amendment accepted — scattered outside
 * their order's block, and their own text names no order at all, so they read as orphans.
 * The number is only the heading's label; a group whose messages all lack it is still
 * gathered, just unlabelled, which beats scattering them.
 *
 * No count beside the number: the messages are right there to be counted, and a count taken
 * after the page's slice to eight rows would say "3" about an order that has five.
 *
 * A lone message keeps its own row: a heading over a single line is noise, and `notifText`
 * names the order inside the sentence for the types that carry the number. A group stays
 * where its NEWEST message would have been, so the page still reads newest-first —
 * gathering must not promote an old order to the top because it has a long history.
 */
export function groupNotes(notes: Note[]): { po?: string; items: Note[] }[] {
  const used = new Set<string>();
  const groups: { po?: string; items: Note[] }[] = [];
  const idOf = (n: Note): string | undefined => {
    const v = n.payload?.po_id;
    return v == null || v === '' ? undefined : String(v);
  };
  const noOf = (n: Note): string | undefined => {
    const v = n.payload?.po_no;
    return v == null || v === '' ? undefined : String(v);
  };
  for (const n of notes) {
    if (used.has(n.id)) continue;
    const id = idOf(n);
    if (!id) { used.add(n.id); groups.push({ items: [n] }); continue; }
    const items = notes.filter((o) => idOf(o) === id);
    items.forEach((o) => used.add(o.id));
    groups.push({ po: items.length > 1 ? items.map(noOf).find(Boolean) : undefined, items });
  }
  return groups;
}

/**
 * The notifications card, in ONE place: both panels drew their own table, and only the
 * buyer's learned to mark messages read — the supplier's had no way to clear anything,
 * though the endpoints carry no `@Roles` and RLS already scopes them to the reader's own
 * organisation. Both panels pass the handlers now. The props stay optional so a caller
 * that genuinely cannot clear messages does not have to draw controls that fail.
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
                  <b>{t('order_no')} {g.po}</b>
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
