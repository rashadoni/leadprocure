import {MigrationInterface,QueryRunner} from 'typeorm';
// A disputed invoice does not reserve accepted quantities; only the dispatched job gets a lease.
export class ReviewAllocationAndDelivery1720000000034 implements MigrationInterface {
 async up(q:QueryRunner){
  await q.query(`CREATE OR REPLACE FUNCTION invoice_rematch(p_po uuid)
      RETURNS TABLE(invoice_id uuid,invoice_no text,supplier_org_id uuid,old_status text,new_status text)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
      DECLARE inv record; lines jsonb; ok boolean; nxt invoice_status;
      BEGIN
        IF app_org_id() IS NULL OR NOT EXISTS(SELECT 1 FROM purchase_orders WHERE id=p_po AND buyer_org_id=app_org_id()) THEN
          RAISE EXCEPTION 'Only buyer can rematch'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(p_po::text,84));
        FOR inv IN SELECT * FROM invoices WHERE po_id=p_po AND status IN ('SUBMITTED','MATCHED','DISPUTED') ORDER BY CASE WHEN status='MATCHED' THEN 0 ELSE 1 END,created_at,id FOR UPDATE LOOP
          SELECT jsonb_agg(jsonb_build_object('po_item_id',s.id,'invoice_qty',s.qty,'invoice_price',s.price,
            'po_price',s.po_price,'received',s.received,'already_invoiced',s.used,'billable',s.received-s.used,
            'price_ok',s.price<=s.po_price,'qty_ok',s.qty<=s.received-s.used)),
            bool_and(s.price<=s.po_price AND s.qty<=s.received-s.used)
          INTO lines,ok FROM (
            SELECT poi.id, sum(ii.qty) qty,max(ii.unit_price_minor) price,poi.unit_price_minor po_price,
              COALESCE((SELECT sum(g.qty_received) FROM goods_receipt_items g WHERE g.po_item_id=poi.id),0) received,
              COALESCE((SELECT sum(x.qty) FROM invoice_items x JOIN invoices xi ON xi.id=x.invoice_id
                WHERE x.po_item_id=poi.id AND xi.id<>inv.id AND xi.status IN ('MATCHED','APPROVED','PAID')),0) used
            FROM invoice_items ii JOIN purchase_order_items poi ON poi.id=ii.po_item_id
            WHERE ii.invoice_id=inv.id GROUP BY poi.id
          ) s;
          nxt := CASE WHEN COALESCE(ok,false) THEN 'MATCHED' ELSE 'DISPUTED' END;
          UPDATE invoices SET status=nxt, match=jsonb_build_object('ok',COALESCE(ok,false),'lines',lines) WHERE id=inv.id;
          IF nxt<>inv.status THEN invoice_id:=inv.id; invoice_no:=inv.invoice_no; supplier_org_id:=inv.supplier_org_id;
            old_status:=inv.status::text;new_status:=nxt::text;RETURN NEXT; END IF;
        END LOOP;
      END $$`);
  await q.query(`CREATE OR REPLACE FUNCTION followup_claim_outbox() RETURNS SETOF followup_outbox
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE w record; recipient text; BEGIN
      -- Unknown delivery after process death must never be blindly replayed (SMTP/Meta lack universal idempotency).
      WITH stale AS (UPDATE followup_outbox SET status='UNKNOWN',lease_until=NULL
        WHERE status='SENDING' AND lease_until<clock_timestamp() RETURNING *)
      INSERT INTO followup_messages(enrollment_id,buyer_org_id,supplier_org_id,step_no,channel,recipient,status,detail)
        SELECT s.enrollment_id,s.buyer_org_id,fe.supplier_org_id,s.step_no,s.work->>'channel',s.recipient,'UNKNOWN','Worker lease expired; reconcile before retry'
        FROM stale s JOIN followup_enrollments fe ON fe.id=s.enrollment_id;
      FOR w IN SELECT * FROM followup_advance_due(50) LOOP
        FOREACH recipient IN ARRAY (CASE WHEN w.channel='EMAIL' THEN COALESCE(w.emails,ARRAY['-']) ELSE ARRAY[COALESCE(w.phone,'-')] END) LOOP
          INSERT INTO followup_outbox(enrollment_id,buyer_org_id,step_no,recipient,work)
            VALUES(w.enrollment_id,w.buyer_org_id,w.step_no,recipient,to_jsonb(w)) ON CONFLICT DO NOTHING;
        END LOOP;
      END LOOP;
      RETURN QUERY WITH candidates AS (SELECT id FROM followup_outbox WHERE status='PENDING' AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE followup_outbox o SET status='SENDING',attempts=attempts+1,lease_until=clock_timestamp()+interval '5 minutes'
        FROM candidates c WHERE o.id=c.id RETURNING o.*;
      END $$`);
 }
 async down(){throw new Error('Forward-only allocation and delivery correction');}
}
