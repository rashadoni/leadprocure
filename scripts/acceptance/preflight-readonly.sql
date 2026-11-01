-- Operator preflight before a separately authorized upgrade. Counts only; never repairs customer data.
BEGIN READ ONLY;
SELECT 'duplicate_invoice_lines' AS check_name,count(*) FROM (SELECT invoice_id,po_item_id FROM invoice_items GROUP BY 1,2 HAVING count(*)>1) d;
SELECT 'duplicate_evaluation_scores' AS check_name,count(*) FROM (SELECT evaluation_id,bid_id,criterion FROM evaluation_scores GROUP BY 1,2,3 HAVING count(*)>1) d;
-- 1720000000043 replaces the (user_id, org_id, role) key with (user_id, org_id) and refuses,
-- naming the pairs, when one person holds two roles in one organization. Count them here so
-- the operator learns that before a release instead of from a halted migration.
SELECT 'duplicate_memberships' AS check_name,count(*) FROM (SELECT user_id,org_id FROM memberships GROUP BY 1,2 HAVING count(*)>1) d;
SELECT 'document_namespace_mismatch' AS check_name,count(*) FROM documents WHERE storage_key NOT LIKE owner_org_id::text||'/%';
SELECT 'bid_document_namespace_mismatch' AS check_name,count(*) FROM bid_documents WHERE storage_key NOT LIKE supplier_org_id::text||'/%';
SELECT 'kyc_namespace_mismatch' AS check_name,count(*) FROM supplier_verification_documents WHERE storage_key NOT LIKE supplier_org_id::text||'/%';
SELECT 'legacy_invoice_lines_requiring_tax_review' AS check_name,count(*) FROM invoice_items;
SELECT 'installed_licenses' AS check_name,count(*) FROM licenses;
ROLLBACK;
