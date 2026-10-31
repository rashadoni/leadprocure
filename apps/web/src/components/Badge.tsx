import { useI18n } from '../i18n';

// Every status this product can show, sorted into the five groups a reader actually
// distinguishes at a glance. The colour lives HERE and nowhere else: pages used to pick a
// colour themselves by passing a status enum as a CSS class (`cls={badge(status)}`), which
// is how DISPUTED ended up painted with REJECTED's red and how a dozen chips that are not
// statuses at all came to be class="badge INVITED".
//
// Why it matters that this table is complete: `.badge` sets no background and no colour of
// its own, so a status missing from here is not invisible — it renders as ordinary dark
// text in a hairline outline. It reads fine on its own and is indistinguishable from the
// status above it, which is the real cost: a status column stops being scannable and has to
// be read line by line. 24 of these 38 used to be in that state.
const GROUP: Record<string, string> = {};
const group = (names: string[], cls: string) => names.forEach((n) => (GROUP[n] = cls));

// nothing has happened yet, or it is over and filed away
group(['DRAFT', 'CREATED', 'NEW', 'ARCHIVED', 'SUPERSEDED'], 'is-neutral');
// under way — someone is working on it, no action owed by the reader
group(['SUBMITTED', 'PENDING', 'IN_REVIEW', 'PUBLISHED', 'OPEN', 'OPENING', 'OPENED',
  'EVALUATION', 'INVITED', 'ISSUED', 'CONFIRMED', 'PACKED', 'SHIPPED', 'IN_TRANSIT',
  'PICKED_UP', 'ARRIVED', 'CUSTOMS'], 'is-progress');
// the good terminal states
group(['APPROVED', 'AWARDED', 'ACCEPTED', 'DELIVERED', 'PAID', 'MATCHED', 'ACTIVE'], 'is-good');
// not broken, but someone has to look: a deadline passed, a shipment is stuck, a bill disagrees
group(['CLOSED', 'DISPUTED', 'EXCEPTION', 'LATE'], 'is-warn');
// stopped on purpose
group(['REJECTED', 'BLOCKED', 'CANCELLED', 'WITHDRAWN', 'DISQUALIFIED'], 'is-bad');

// Exported for the few places that draw a status pill without this component — budget
// statuses have their own `bud_status_*` vocabulary but the same five colours.
export const statusGroup = (status?: string | null): string => (status && GROUP[status]) || 'is-neutral';

// Status pill, localized. The st_<STATUS> dictionary entry is "Label — explanation": the
// short label becomes the pill text, the full sentence stays as the hover tooltip. Four
// entries separate the two with a slash instead of a dash (ru APPROVED, EVALUATION in all
// three languages), and splitting on the dash alone put the whole sentence inside the pill —
// in Russian "Утверждено / одобрено" went two lines tall in every approved row there is.
// Unknown codes render raw so nothing silently disappears.
//
// The raw status always stays in the class list: the browser specs select `.badge.PAID`,
// `.badge.APPROVED`, `.badge.MATCHED` and friends in about thirty places, and they are
// identifying the row's state, not its colour.
export function Badge({ status }: { status?: string | null }) {
  const { t } = useI18n();
  if (status == null || status === '') return <>—</>;
  const key = `st_${status}`;
  const full = t(key);
  const known = full !== key;
  const label = known ? full.split(' — ')[0].split(' / ')[0].split(' (')[0] : status;
  return (
    <span className={`badge ${statusGroup(status)} ${status}`} data-tip={known ? full : undefined}>
      {label}
    </span>
  );
}
