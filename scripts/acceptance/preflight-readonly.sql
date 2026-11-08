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
-- 1720000000029 добавила строкам счетов снимок НДС (vat_rate_bp/vat_minor/gross_minor) и НЕ
-- пересчитала старые: у них снимок остался NULL, а legacy-выгрузки на таких строках падают
-- явно. Отсюда и условие. ДО 8.11.2026 условия тут не было вовсе — считались ВСЕ строки
-- счетов, и журнал выкладок семнадцать раз прочёл этот итог как «строки без снимка НДС».
-- Совпадало это случайно: на проде всех строк счетов было пять, и у всех пяти снимка не было.
SELECT 'legacy_invoice_lines_requiring_tax_review' AS check_name,count(*) FROM invoice_items WHERE vat_rate_bp IS NULL;
SELECT 'invoice_lines_total' AS check_name,count(*) FROM invoice_items;
SELECT 'installed_licenses' AS check_name,count(*) FROM licenses;
ROLLBACK;
