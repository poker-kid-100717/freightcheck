/**
 * Load-level billing reconciliation across TMS exports and carrier invoices (from PDFs).
 * Deterministic: every exception has a rule, a dollar impact where one can be computed,
 * and the source rows/pages it came from. Unknown data is never treated as a problem.
 */
import { CHARGE_LABEL, formatCents, normalizeRef, sumCharges } from './model';
import type { ChargeType, LoadRecord, SourceRef } from './model';

/** A carrier invoice after PDF extraction and human review. */
export interface CarrierInvoice {
  invoiceNumber?: string;
  carrier?: string;
  date?: string;
  /** Load / PRO / BOL / PO numbers printed on the invoice. */
  refs: string[];
  lines: { type: ChargeType; amount: number; description?: string }[];
  total?: number;
  source: { file: string; page?: number };
}

export type Rule =
  | 'unbilled' | 'accessorial-not-billed' | 'carrier-overbilled' | 'carrier-unexpected-charge'
  | 'customer-invoice-mismatch' | 'negative-margin' | 'missing-pod' | 'missing-rate-con'
  | 'conflict-between-systems' | 'duplicate-carrier-invoice' | 'unmatched-carrier-invoice';
export type Severity = 'money' | 'risk' | 'info';
export const RULE_INFO: Record<Rule, { title: string; severity: Severity }> = {
  'unbilled': { title: 'Delivered, not invoiced', severity: 'money' },
  'accessorial-not-billed': { title: 'Accessorial paid to carrier, not billed to customer', severity: 'money' },
  'carrier-overbilled': { title: 'Carrier invoice above the rate confirmation', severity: 'money' },
  'carrier-unexpected-charge': { title: 'Carrier charge not on the rate confirmation', severity: 'money' },
  'customer-invoice-mismatch': { title: 'Customer invoice differs from load charges', severity: 'risk' },
  'negative-margin': { title: 'Carrier cost exceeds customer revenue', severity: 'risk' },
  'missing-pod': { title: 'POD missing — invoice likely to be rejected', severity: 'risk' },
  'missing-rate-con': { title: 'Rate confirmation missing', severity: 'risk' },
  'conflict-between-systems': { title: 'Systems disagree about this load', severity: 'risk' },
  'duplicate-carrier-invoice': { title: 'Possible duplicate carrier invoice', severity: 'money' },
  'unmatched-carrier-invoice': { title: 'Carrier invoice matches no load', severity: 'info' }
};

export interface Exception {
  rule: Rule;
  severity: Severity;
  title: string;
  /** Plain-language explanation with the numbers. */
  detail: string;
  /** Cents at stake (unbilled revenue, overcharge, …); undefined when not quantifiable. */
  impact?: number;
  loadId?: string;
  sources: (SourceRef | { file: string; page?: number })[];
}

export interface Load {
  key: string;
  loadId: string;
  records: LoadRecord[];
  invoices: CarrierInvoice[];
  customer?: string;
  carrier?: string;
  deliveryDate?: string;
  customerTotal: number;
  carrierTotal: number;
  exceptions: Exception[];
}
export interface Reconciliation {
  loads: Load[];
  exceptions: Exception[];
  totals: { loads: number; loadsWithExceptions: number; unbilled: number; underBilled: number; overBilled: number; byRule: Partial<Record<Rule, number>> };
}

const DELIVERED = /deliver|complete|closed|pod|invoic|billed|paid/i;
const ACCESSORIALS: ChargeType[] = ['detention', 'lumper', 'layover', 'tonu', 'stop-off', 'accessorial'];

/** Union-find over load ids and references so one shipment appearing in two systems becomes one load. */
function groupRecords(records: LoadRecord[]): LoadRecord[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: string, b: string) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const keyOf = (r: LoadRecord) => 'L:' + normalizeRef(r.loadId);
  for (const r of records) { add(keyOf(r)); for (const ref of r.refs) if (normalizeRef(ref).length >= 4) union(keyOf(r), 'R:' + normalizeRef(ref)); }
  const groups = new Map<string, LoadRecord[]>();
  for (const r of records) { const root = find(keyOf(r)); (groups.get(root) ?? groups.set(root, []).get(root)!).push(r); }
  return [...groups.values()];
}

export function reconcile(records: LoadRecord[], invoices: CarrierInvoice[] = [], asOf = new Date().toISOString().slice(0, 10)): Reconciliation {
  const loads: Load[] = groupRecords(records).map(group => {
    const primary = group[0];
    const pick = <K extends keyof LoadRecord>(k: K) => group.map(r => r[k]).find(v => v !== undefined && v !== '') as LoadRecord[K] | undefined;
    // Prefer the record with the most charge detail as the "agreed" view.
    const richest = [...group].sort((a, b) => Object.keys(b.customerCharges).length + Object.keys(b.carrierCharges).length -
      (Object.keys(a.customerCharges).length + Object.keys(a.carrierCharges).length))[0];
    return {
      key: normalizeRef(primary.loadId), loadId: primary.loadId, records: group, invoices: [],
      customer: pick('customer'), carrier: pick('carrier'), deliveryDate: pick('deliveryDate'),
      customerTotal: sumCharges(richest.customerCharges), carrierTotal: sumCharges(richest.carrierCharges), exceptions: []
    };
  });
  // Index loads by id and every reference.
  const index = new Map<string, Load>();
  for (const load of loads) for (const r of load.records) for (const ref of [r.loadId, ...r.refs]) {
    const k = normalizeRef(ref); if (k.length >= 3 && !index.has(k)) index.set(k, load);
  }
  const exceptions: Exception[] = [];
  const raise = (load: Load | undefined, rule: Rule, detail: string, sources: Exception['sources'], impact?: number) => {
    const e: Exception = { rule, severity: RULE_INFO[rule].severity, title: RULE_INFO[rule].title, detail, impact, loadId: load?.loadId, sources };
    exceptions.push(e); load?.exceptions.push(e);
  };

  // Attach carrier invoices; flag unmatched and duplicates.
  const seenInvoice = new Map<string, CarrierInvoice>();
  for (const inv of invoices) {
    const load = inv.refs.map(r => index.get(normalizeRef(r))).find(Boolean);
    const dupKey = inv.invoiceNumber ? normalizeRef((inv.carrier ?? '') + '|' + inv.invoiceNumber) : '';
    if (dupKey && seenInvoice.has(dupKey)) {
      raise(load, 'duplicate-carrier-invoice', 'Invoice ' + inv.invoiceNumber + ' from ' + (inv.carrier ?? 'this carrier') + ' appears more than once (' +
        seenInvoice.get(dupKey)!.source.file + ' and ' + inv.source.file + '). Pay it once.', [seenInvoice.get(dupKey)!.source, inv.source], invoiceTotal(inv));
      continue;
    }
    if (dupKey) seenInvoice.set(dupKey, inv);
    if (!load) { raise(undefined, 'unmatched-carrier-invoice', 'No load found for references ' + (inv.refs.join(', ') || '(none on the invoice)') + '.', [inv.source], invoiceTotal(inv)); continue; }
    if (load.invoices.length) raise(load, 'duplicate-carrier-invoice', 'Load ' + load.loadId + ' has more than one carrier invoice.', [load.invoices[0].source, inv.source], invoiceTotal(inv));
    load.invoices.push(inv);
  }

  for (const load of loads) {
    const src = load.records.map(r => r.source);
    const rich = load.records.reduce((a, r) => ({
      customer: Object.keys(r.customerCharges).length > Object.keys(a.customer).length ? r.customerCharges : a.customer,
      carrier: Object.keys(r.carrierCharges).length > Object.keys(a.carrier).length ? r.carrierCharges : a.carrier
    }), { customer: {} as Partial<Record<ChargeType, number>>, carrier: {} as Partial<Record<ChargeType, number>> });
    const customerInvoice = load.records.map(r => r.customerInvoice).find(Boolean);
    const delivered = !!load.deliveryDate || load.records.some(r => r.status && DELIVERED.test(r.status));

    // Systems disagree on money for the same load.
    if (load.records.length > 1) {
      const diff = (pick: (r: LoadRecord) => number) => new Set(load.records.map(pick).filter(v => v > 0)).size > 1;
      if (diff(r => sumCharges(r.customerCharges)) || diff(r => sumCharges(r.carrierCharges)))
        raise(load, 'conflict-between-systems', load.records.map(r => r.source.system + ': customer ' + formatCents(sumCharges(r.customerCharges)) +
          ', carrier ' + formatCents(sumCharges(r.carrierCharges))).join(' · ') + '.', src);
    }
    // Delivered but not invoiced.
    if (delivered && !customerInvoice && load.customerTotal > 0) {
      const days = load.deliveryDate ? Math.floor((Date.parse(asOf) - Date.parse(load.deliveryDate)) / 86_400_000) : undefined;
      raise(load, 'unbilled', 'Delivered' + (days !== undefined && days >= 0 ? ' ' + days + ' day' + (days === 1 ? '' : 's') + ' ago' : '') +
        ' with no customer invoice. ' + formatCents(load.customerTotal) + ' to bill' + (load.customer ? ' to ' + load.customer : '') + '.', src, load.customerTotal);
    }
    // Accessorials paid on the carrier side (TMS or carrier invoice) but not billed to the customer.
    const carrierAccessorials = new Map<ChargeType, number>();
    for (const t of ACCESSORIALS) if (rich.carrier[t]) carrierAccessorials.set(t, rich.carrier[t]!);
    for (const inv of load.invoices) for (const line of inv.lines)
      if (ACCESSORIALS.includes(line.type)) carrierAccessorials.set(line.type, Math.max(carrierAccessorials.get(line.type) ?? 0, line.amount));
    for (const [type, amount] of carrierAccessorials)
      if (!rich.customer[type] && amount > 0)
        raise(load, 'accessorial-not-billed', CHARGE_LABEL[type] + ' of ' + formatCents(amount) + ' is on the carrier side but not on the customer charges.', src, amount);
    // Carrier invoice vs rate confirmation (TMS carrier charges).
    const agreed = sumCharges(rich.carrier);
    for (const inv of load.invoices) {
      const billed = invoiceTotal(inv);
      if (agreed > 0 && billed !== undefined && billed > agreed)
        raise(load, 'carrier-overbilled', (inv.carrier ?? 'Carrier') + ' invoice ' + (inv.invoiceNumber ?? '') + ' is ' + formatCents(billed) +
          ' vs ' + formatCents(agreed) + ' agreed (' + formatCents(billed - agreed, true) + ').', [inv.source, ...src], billed - agreed);
      if (agreed > 0) for (const line of inv.lines)
        if (!rich.carrier[line.type] && line.type !== 'linehaul')
          raise(load, 'carrier-unexpected-charge', CHARGE_LABEL[line.type] + ' ' + formatCents(line.amount) + ' on the invoice is not on the rate confirmation.', [inv.source], line.amount);
    }
    if (!load.invoices.length) {
      const tmsInvoice = load.records.map(r => r.carrierInvoice).find(i => i?.amount !== undefined);
      if (tmsInvoice && agreed > 0 && tmsInvoice.amount! > agreed)
        raise(load, 'carrier-overbilled', 'Carrier invoice ' + (tmsInvoice.number ?? '') + ' is ' + formatCents(tmsInvoice.amount) + ' vs ' + formatCents(agreed) +
          ' agreed (' + formatCents(tmsInvoice.amount! - agreed, true) + ').', src, tmsInvoice.amount! - agreed);
    }
    // Customer invoice amount vs load charges.
    if (customerInvoice?.amount !== undefined && load.customerTotal > 0 && customerInvoice.amount !== load.customerTotal)
      raise(load, 'customer-invoice-mismatch', 'Invoice ' + (customerInvoice.number ?? '') + ' is ' + formatCents(customerInvoice.amount) + ' but the load charges total ' +
        formatCents(load.customerTotal) + ' (' + formatCents(load.customerTotal - customerInvoice.amount, true) + ' not invoiced).', src,
        load.customerTotal > customerInvoice.amount ? load.customerTotal - customerInvoice.amount : undefined);
    if (load.customerTotal > 0 && load.carrierTotal > 0 && load.carrierTotal > load.customerTotal)
      raise(load, 'negative-margin', 'Customer ' + formatCents(load.customerTotal) + ', carrier ' + formatCents(load.carrierTotal) + ' (' +
        formatCents(load.customerTotal - load.carrierTotal) + ' margin).', src);
    // Paperwork: only flag when the export explicitly says it's missing (unknown ≠ missing).
    if ((delivered || customerInvoice) && load.records.some(r => r.documents.pod === false) && !load.records.some(r => r.documents.pod === true))
      raise(load, 'missing-pod', 'No proof of delivery on file' + (customerInvoice ? ' for invoice ' + (customerInvoice.number ?? '') : '') + '.', src);
    if ((load.invoices.length || load.records.some(r => r.carrierInvoice)) && load.records.some(r => r.documents.rateCon === false) && !load.records.some(r => r.documents.rateCon === true))
      raise(load, 'missing-rate-con', 'Carrier invoice received but no rate confirmation on file to check it against.', src);
  }

  const sum = (rule: Rule[]) => exceptions.filter(e => rule.includes(e.rule)).reduce((t, e) => t + (e.impact ?? 0), 0);
  const byRule: Partial<Record<Rule, number>> = {};
  for (const e of exceptions) byRule[e.rule] = (byRule[e.rule] ?? 0) + 1;
  const severityRank = { money: 0, risk: 1, info: 2 };
  loads.sort((a, b) => b.exceptions.length - a.exceptions.length || a.loadId.localeCompare(b.loadId, undefined, { numeric: true }));
  exceptions.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || (b.impact ?? 0) - (a.impact ?? 0));
  return {
    loads, exceptions,
    totals: {
      loads: loads.length, loadsWithExceptions: loads.filter(l => l.exceptions.length).length,
      unbilled: sum(['unbilled', 'customer-invoice-mismatch']), underBilled: sum(['accessorial-not-billed']),
      // Unexpected-charge lines explain an overbilled total; counting both would double the figure.
      overBilled: sum(['carrier-overbilled', 'duplicate-carrier-invoice']), byRule
    }
  };
}
export function invoiceTotal(inv: CarrierInvoice): number | undefined {
  return inv.total ?? (inv.lines.length ? inv.lines.reduce((t, l) => t + l.amount, 0) : undefined);
}
