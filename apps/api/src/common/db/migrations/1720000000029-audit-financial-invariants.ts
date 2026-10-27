import { MigrationInterface, QueryRunner } from 'typeorm';
export class AuditFinancialInvariants1720000000029 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE purchase_orders ADD COLUMN vat_mode text NOT NULL DEFAULT 'EXCLUSIVE'
      CHECK(vat_mode IN ('EXCLUSIVE','INCLUSIVE'));
      UPDATE purchase_orders p SET vat_mode=c.vat_mode::text FROM contracts c WHERE c.id=p.contract_id;
      ALTER TABLE invoice_items ADD COLUMN vat_rate_bp int, ADD COLUMN vat_minor bigint, ADD COLUMN gross_minor bigint;
      CREATE UNIQUE INDEX invoice_item_once ON invoice_items(invoice_id,po_item_id);
      CREATE UNIQUE INDEX evaluation_criterion_once ON evaluation_scores(evaluation_id,bid_id,criterion);`);
    // Existing invoice values are preserved. Legacy exports fail explicitly if no tax snapshot exists.
    await q.query(`CREATE OR REPLACE FUNCTION invoice_rematch(p_po uuid)
      RETURNS TABLE(invoice_id uuid,invoice_no text,supplier_org_id uuid,old_status text,new_status text)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
      DECLARE inv record; lines jsonb; ok boolean; nxt invoice_status;
      BEGIN
        IF app_org_id() IS NULL OR NOT EXISTS(SELECT 1 FROM purchase_orders WHERE id=p_po AND buyer_org_id=app_org_id()) THEN
          RAISE EXCEPTION 'Only buyer can rematch'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(p_po::text,84));
        FOR inv IN SELECT * FROM invoices WHERE po_id=p_po AND status IN ('SUBMITTED','MATCHED','DISPUTED') FOR UPDATE LOOP
          SELECT jsonb_agg(jsonb_build_object('po_item_id',s.id,'invoice_qty',s.qty,'invoice_price',s.price,
            'po_price',s.po_price,'received',s.received,'already_invoiced',s.used,'billable',s.received-s.used,
            'price_ok',s.price<=s.po_price,'qty_ok',s.qty<=s.received-s.used)),
            bool_and(s.price<=s.po_price AND s.qty<=s.received-s.used)
          INTO lines,ok FROM (
            SELECT poi.id, sum(ii.qty) qty,max(ii.unit_price_minor) price,poi.unit_price_minor po_price,
              COALESCE((SELECT sum(g.qty_received) FROM goods_receipt_items g WHERE g.po_item_id=poi.id),0) received,
              COALESCE((SELECT sum(x.qty) FROM invoice_items x JOIN invoices xi ON xi.id=x.invoice_id
                WHERE x.po_item_id=poi.id AND xi.id<>inv.id AND xi.status<>'REJECTED'),0) used
            FROM invoice_items ii JOIN purchase_order_items poi ON poi.id=ii.po_item_id
            WHERE ii.invoice_id=inv.id GROUP BY poi.id
          ) s;
          nxt := CASE WHEN COALESCE(ok,false) THEN 'MATCHED' ELSE 'DISPUTED' END;
          UPDATE invoices SET status=nxt, match=jsonb_build_object('ok',COALESCE(ok,false),'lines',lines) WHERE id=inv.id;
          IF nxt<>inv.status THEN invoice_id:=inv.id; invoice_no:=inv.invoice_no; supplier_org_id:=inv.supplier_org_id;
            old_status:=inv.status::text;new_status:=nxt::text;RETURN NEXT; END IF;
        END LOOP;
      END $$`);
    await q.query(`CREATE OR REPLACE FUNCTION close_due_events() RETURNS TABLE(event_id uuid,buyer_org_id uuid)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE e record; BEGIN
      FOR e IN SELECT id FROM sourcing_events WHERE status='OPEN' AND close_at<=clock_timestamp() LOOP
        IF pg_try_advisory_xact_lock(hashtextextended(e.id::text,42)) THEN
          UPDATE sourcing_events SET status='CLOSED',updated_at=clock_timestamp()
            WHERE id=e.id AND status='OPEN' AND close_at<=clock_timestamp()
            RETURNING id,sourcing_events.buyer_org_id INTO event_id,buyer_org_id;
          IF FOUND THEN
            INSERT INTO audit_events(org_id,action,entity_type,entity_id,payload,hash)
              VALUES(NULL,'EVENT_CLOSED','sourcing_event',event_id,jsonb_build_object('buyer_org_id',buyer_org_id),md5(event_id::text||clock_timestamp()::text));
            RETURN NEXT;
          END IF;
        END IF;
      END LOOP; END $$`);
    await q.query(`CREATE OR REPLACE FUNCTION auction_try_extend(p_event_id uuid) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
      UPDATE sourcing_events e SET close_at=clock_timestamp()+make_interval(secs=>e.auction_extend_by_sec),
        auction_extension_count=e.auction_extension_count+1,updated_at=clock_timestamp()
      WHERE e.id=p_event_id AND e.status='OPEN' AND e.format='REVERSE'
        AND e.close_at>clock_timestamp()
        AND e.close_at-clock_timestamp()<make_interval(secs=>e.auction_extend_threshold_sec)
        AND e.auction_extension_count<e.auction_max_extensions;
      RETURN FOUND; END $$`);
  }
  async down() { throw new Error('Forward-only financial migration: reconcile historical duplicates before upgrade'); }
}
