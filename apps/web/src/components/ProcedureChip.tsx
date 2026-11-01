import { useI18n } from '../i18n';

// The procedure chip, in ONE place. The tender list drew it properly — icon, short name, and
// a tip saying what the procedure actually is — while the tender's own card put the raw enum
// in a plain pill right next to the title: one concept with two looks on two screens a click
// apart. The list's version is the one that reads, so it moved here and both screens use it.
const TYPE_META: Record<string, { ico: string; label: string }> = {
  RFQ: { ico: '🔒', label: 'RFQ' }, RFP: { ico: '📄', label: 'RFP' },
  // AUCTION carries no label: it is the one procedure named in the interface language.
  RFI: { ico: '❓', label: 'RFI' }, AUCTION: { ico: '⚡', label: '' },
};

export function ProcedureChip({ type, format }: { type?: string | null; format?: string | null }) {
  const { t } = useI18n();
  // A reverse auction is a FORMAT over a sealed type in the data model, and the pages that
  // decide anything by it read `type === 'AUCTION' || format === 'REVERSE'`. The chip says
  // the same thing: a tender switched to live bidding is an auction to the reader, whatever
  // the type column still holds.
  const kind = format === 'REVERSE' ? 'AUCTION' : (type ?? '');
  const meta = TYPE_META[kind];
  // `t()` hands back the key itself when it misses, so an unknown kind would have printed
  // the literal «tip_» into the bubble. The column is NOT NULL in the database; this is the
  // guard for a card drawn before its event has loaded, not for a row that exists.
  const tip = meta ? t(`tip_${kind.toLowerCase()}`) : undefined;
  return (
    <span className="chip" data-tip={tip}>
      <span className="chip-ico">{meta?.ico ?? '•'}</span>
      {kind === 'AUCTION' ? t('auction') : (meta?.label || kind)}
    </span>
  );
}
