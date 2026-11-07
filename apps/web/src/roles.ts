// Who may open which section — ONE list, read by the router, by the rail and by the
// course on /learn.
//
// It used to live in main.tsx alone, which was fine while the router was the only reader.
// The course page has to know it too: it offers a «go to the section» button beside each
// lesson, and a button that lands a BUYER_FINANCE user on the home page because the route
// refused them is worse than no button. Three copies of a role matrix drift; one does not.
export const BUYER = ['BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER'];
// Finance reads the money sections but runs no tender: requests, budgets, analytics,
// dashboard and settings. Everything else on the buyer side is BUYER only.
export const FINANCE_READ = [...BUYER, 'BUYER_FINANCE'];
export const SUPPLIER = ['SUPPLIER_USER'];
