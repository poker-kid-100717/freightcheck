/**
 * TMS-agnostic CSV/Excel load import. Each system's export is mapped once (column → field);
 * mappings are suggested from header names and can be edited and saved per TMS.
 */
import { parseCsv } from './csv';
import { centsFromText, isoDate, normalizeRef, truthy } from './model';
import type { ChargeType, LoadRecord } from './model';

export const LOAD_FIELDS = [
  'loadId', 'refBol', 'refPro', 'refPo', 'refCustomer', 'customer', 'carrier', 'status', 'pickupDate', 'deliveryDate',
  'customerTotal', 'customerLinehaul', 'customerFuel', 'customerDetention', 'customerLumper', 'customerLayover', 'customerTonu', 'customerStopOff', 'customerAccessorial',
  'carrierTotal', 'carrierLinehaul', 'carrierFuel', 'carrierDetention', 'carrierLumper', 'carrierLayover', 'carrierTonu', 'carrierStopOff', 'carrierAccessorial',
  'customerInvoiceNumber', 'customerInvoiceAmount', 'customerInvoiceDate',
  'carrierInvoiceNumber', 'carrierInvoiceAmount', 'carrierInvoiceDate',
  'hasBol', 'hasPod', 'hasRateCon'
] as const;
export type LoadField = (typeof LOAD_FIELDS)[number];
export type ColumnMapping = Partial<Record<LoadField, number>>;

export const FIELD_LABEL: Record<LoadField, string> = {
  loadId: 'Load number', refBol: 'BOL number', refPro: 'PRO number', refPo: 'PO number', refCustomer: 'Customer reference',
  customer: 'Customer', carrier: 'Carrier', status: 'Status', pickupDate: 'Pickup date', deliveryDate: 'Delivery date',
  customerTotal: 'Customer total', customerLinehaul: 'Customer line haul', customerFuel: 'Customer fuel', customerDetention: 'Customer detention',
  customerLumper: 'Customer lumper', customerLayover: 'Customer layover', customerTonu: 'Customer TONU', customerStopOff: 'Customer stop-off',
  customerAccessorial: 'Customer other accessorials',
  carrierTotal: 'Carrier pay total', carrierLinehaul: 'Carrier line haul', carrierFuel: 'Carrier fuel', carrierDetention: 'Carrier detention',
  carrierLumper: 'Carrier lumper', carrierLayover: 'Carrier layover', carrierTonu: 'Carrier TONU', carrierStopOff: 'Carrier stop-off',
  carrierAccessorial: 'Carrier other accessorials',
  customerInvoiceNumber: 'Customer invoice #', customerInvoiceAmount: 'Customer invoice amount', customerInvoiceDate: 'Customer invoice date',
  carrierInvoiceNumber: 'Carrier invoice #', carrierInvoiceAmount: 'Carrier invoice amount', carrierInvoiceDate: 'Carrier invoice date',
  hasBol: 'BOL on file', hasPod: 'POD on file', hasRateCon: 'Rate con on file'
};

// Header synonyms. Matched after lower-casing and stripping punctuation. Order = priority.
const SIDE_CUSTOMER = '(customer|cust|shipper|revenue|billing|bill|charge|sell|ar)';
const SIDE_CARRIER = '(carrier|truck|driver|pay|cost|buy|ap|vendor)';
const SYNONYMS: [LoadField, RegExp][] = [
  ['loadId', /^(load|order|shipment|trip|job)\s*(no|num|number|id|#)?$|^load$/],
  ['refBol', /\b(bol|bill of lading)\b/],
  ['refPro', /\bpro\b/],
  ['refPo', /\b(po|purchase order)\b/],
  ['refCustomer', /\b(customer|shipper)\s*(ref|reference)\b/],
  ['customerInvoiceNumber', new RegExp('^' + SIDE_CUSTOMER + '?\\s*invoice\\s*(no|num|number|id)?$|^inv\\s*(no)?$')],
  ['customerInvoiceAmount', new RegExp('^' + SIDE_CUSTOMER + '?\\s*invoice[d]?\\s*(amount|amt|total)$|^invoiced\\s*amount$')],
  ['customerInvoiceDate', new RegExp('^(' + SIDE_CUSTOMER + '\\s*)?invoice[d]?\\s*date$')],
  ['carrierInvoiceNumber', new RegExp('^' + SIDE_CARRIER + '\\s*(invoice|bill)\\s*(no|num|number|#|id)$')],
  ['carrierInvoiceAmount', new RegExp('^' + SIDE_CARRIER + '\\s*(invoice|bill)\\s*(amount|amt|total)$')],
  ['carrierInvoiceDate', new RegExp('^' + SIDE_CARRIER + '\\s*(invoice|bill)\\s*date$')],
  ['customer', /^(customer|shipper|bill to|client|account)(\s*name)?$/],
  ['carrier', /^(carrier|vendor|trucking company)(\s*name)?$/],
  ['status', /^(load\s*)?status$/],
  ['pickupDate', /\b(pickup|pick up|ship|origin)\s*(date|dt)?\b/],
  ['deliveryDate', /\b(delivery|deliver|delivered|drop|dest(ination)?)\s*(date|dt)\b|^delivered$/],
  ['hasPod', /\b(pod|proof of delivery)\b/],
  ['hasRateCon', /\b(rate\s*con|rate confirmation|ratecon)\b/],
  ['customerTotal', new RegExp('^(total\\s*)?' + SIDE_CUSTOMER + '\\s*(total|rate|amount|amt)?$|^(total\\s*)?(revenue|customer rate|total charges)$')],
  ['carrierTotal', new RegExp('^(total\\s*)?' + SIDE_CARRIER + '\\s*(total|rate|amount|amt)?$|^(carrier rate|carrier pay|total cost)$')]
];
const CHARGE_WORDS: [ChargeType, RegExp][] = [
  ['linehaul', /\b(line\s*haul|linehaul|base rate|flat rate)\b/], ['fuel', /\b(fuel|fsc)\b/], ['detention', /\bdetention\b/],
  ['lumper', /\blumper\b/], ['layover', /\blayover\b/], ['tonu', /\b(tonu|truck order not used)\b/],
  ['stop-off', /\b(stop\s*off|stop charge|extra stop)\b/], ['accessorial', /\b(accessorial|other charges|misc)\b/]
];
const chargeField = (side: 'customer' | 'carrier', type: ChargeType) =>
  (side + { linehaul: 'Linehaul', fuel: 'Fuel', detention: 'Detention', lumper: 'Lumper', layover: 'Layover', tonu: 'Tonu', 'stop-off': 'StopOff', accessorial: 'Accessorial' }[type]) as LoadField;

const clean = (header: string) => header.toLowerCase().replace(/[_.:()/\\#]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Suggest a mapping from a header row. Each column maps to at most one field and vice versa. */
export function suggestMapping(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<number>();
  const assign = (field: LoadField, index: number) => { if (mapping[field] === undefined && !taken.has(index)) { mapping[field] = index; taken.add(index); } };
  // Charge columns: need a charge word plus (optionally) a side word; default side = customer unless carrier words present.
  headers.forEach((raw, i) => {
    const h = clean(raw);
    const charge = CHARGE_WORDS.find(([, re]) => re.test(h));
    if (!charge || /invoice/.test(h)) return;
    const side = new RegExp('\\b' + SIDE_CARRIER + '\\b').test(h) ? 'carrier' : 'customer';
    assign(chargeField(side, charge[0]), i);
  });
  for (const [field, re] of SYNONYMS) headers.forEach((raw, i) => { if (re.test(clean(raw))) assign(field, i); });
  return mapping;
}

export interface ImportResult { system: string; file: string; headers: string[]; loads: LoadRecord[]; skipped: { row: number; reason: string }[]; }

/** Parse a TMS CSV export into load records using a column mapping. */
export function importLoads(csv: string, file: string, system: string, mapping?: ColumnMapping): ImportResult {
  const rows = parseCsv(csv, { rows: 100_000, columns: 300 });
  const headerIndex = rows.findIndex(r => r.filter(c => c.trim()).length >= 2);
  if (headerIndex < 0) throw new Error(file + ' has no header row.');
  const headers = rows[headerIndex].map(h => h.trim());
  const map = mapping ?? suggestMapping(headers);
  if (map.loadId === undefined) throw new Error('Choose which column in ' + file + ' holds the load number.');
  const get = (row: string[], field: LoadField) => { const i = map[field]; return i === undefined ? undefined : (row[i] ?? '').trim() || undefined; };
  const loads: LoadRecord[] = [], skipped: ImportResult['skipped'] = [];
  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const rowNumber = headerIndex + offset + 2;
    if (!row.some(c => c.trim())) return;
    const loadId = get(row, 'loadId');
    if (!loadId) { skipped.push({ row: rowNumber, reason: 'No load number' }); return; }
    const charges = (side: 'customer' | 'carrier') => {
      const out: Partial<Record<ChargeType, number>> = {};
      for (const [type] of CHARGE_WORDS) { const v = centsFromText(get(row, chargeField(side, type))); if (v !== undefined && v !== 0) out[type] = v; }
      // A total with no breakdown is treated as line haul so totals still reconcile.
      const total = centsFromText(get(row, side === 'customer' ? 'customerTotal' : 'carrierTotal'));
      const listed = Object.values(out).reduce((a, b) => a + (b ?? 0), 0);
      if (total !== undefined && total !== listed) out.linehaul = (out.linehaul ?? 0) + (total - listed);
      return out;
    };
    const refs = (['refBol', 'refPro', 'refPo', 'refCustomer'] as const).map(f => get(row, f)).filter((r): r is string => !!r);
    loads.push({
      loadId: loadId.trim(), refs,
      customer: get(row, 'customer'), carrier: get(row, 'carrier'), status: get(row, 'status'),
      pickupDate: isoDate(get(row, 'pickupDate')), deliveryDate: isoDate(get(row, 'deliveryDate')),
      customerCharges: charges('customer'), carrierCharges: charges('carrier'),
      customerInvoice: optional({ number: get(row, 'customerInvoiceNumber'), amount: centsFromText(get(row, 'customerInvoiceAmount')), date: isoDate(get(row, 'customerInvoiceDate')) }),
      carrierInvoice: optional({ number: get(row, 'carrierInvoiceNumber'), amount: centsFromText(get(row, 'carrierInvoiceAmount')), date: isoDate(get(row, 'carrierInvoiceDate')) }),
      documents: { bol: truthy(get(row, 'hasBol')), pod: truthy(get(row, 'hasPod')), rateCon: truthy(get(row, 'hasRateCon')) },
      source: { system, file, row: rowNumber }
    });
  });
  return { system, file, headers, loads, skipped };
}
function optional<T extends object>(value: T): T | undefined {
  return Object.values(value).some(v => v !== undefined) ? value : undefined;
}
export const refKey = (ref: string) => normalizeRef(ref);
