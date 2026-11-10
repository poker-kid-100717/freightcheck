# FreightCheck

Freight billing reconciliation for brokers and carriers. Bring in load exports from any TMS (CSV/Excel) and carrier invoice PDFs; get one list of the loads that are costing you money.

**What it flags**

| Problem | Example |
|---|---|
| Delivered, not invoiced | "Delivered 9 days ago with no customer invoice. $2,300.00 to bill to Acme Foods." |
| Accessorial paid but not billed | Detention $150 on the carrier side, not on the customer charges |
| Carrier overbilled | Invoice $2,175 vs $1,950 agreed on the rate confirmation |
| Charge not on the rate con | Lumper $75 on the invoice, never agreed |
| Duplicate carrier invoice | Same invoice number received twice |
| Customer invoice short | Invoice $2,200 vs $2,400 load charges |
| Negative margin | Carrier cost above customer revenue |
| Paperwork missing | No POD on an invoiced load (only when the export says so — unknown is never treated as missing) |
| Systems disagree | Same load in two TMSs with different amounts |

**How it works**

- `src/tms-import.ts` — reads any TMS export; suggests a column mapping from header names (editable, saved per TMS).
- `src/reconcile.ts` — merges the same shipment across systems by load number and shared references (BOL/PRO/PO), then applies the rules above. Deterministic, integer cents, every exception cites its source file and row/page.
- Carrier invoice PDFs → structured invoices (AI extraction with citations, human-reviewed) → matched to loads. *(next)*

**Status:** reconciliation engine + TMS import with tests. Next: PDF invoice extraction, web app, Excel export, accounts and billing.

```
npm install
npm test
```
