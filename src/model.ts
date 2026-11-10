/**
 * Freight billing reconciliation — shared model.
 * Money is held as integer cents. Every record keeps the file and row it came from, so each
 * exception can point back to its source.
 */
export const CHARGE_TYPES = ['linehaul', 'fuel', 'detention', 'lumper', 'layover', 'tonu', 'stop-off', 'accessorial'] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];
export const CHARGE_LABEL: Record<ChargeType, string> = {
  linehaul: 'Line haul', fuel: 'Fuel surcharge', detention: 'Detention', lumper: 'Lumper',
  layover: 'Layover', tonu: 'Truck order not used', 'stop-off': 'Stop-off', accessorial: 'Other accessorial'
};

export interface SourceRef { system: string; file: string; row: number; }

/** One load as seen by one TMS export. */
export interface LoadRecord {
  loadId: string;
  /** Other references that identify the same shipment (BOL, PRO, PO, customer reference). */
  refs: string[];
  customer?: string;
  carrier?: string;
  status?: string;
  pickupDate?: string;     // ISO yyyy-mm-dd
  deliveryDate?: string;   // ISO yyyy-mm-dd
  /** Charges agreed with / billable to the customer (revenue side), in cents. */
  customerCharges: Partial<Record<ChargeType, number>>;
  /** Charges agreed with the carrier (rate confirmation / carrier pay side), in cents. */
  carrierCharges: Partial<Record<ChargeType, number>>;
  customerInvoice?: { number?: string; amount?: number; date?: string };
  carrierInvoice?: { number?: string; amount?: number; date?: string };
  documents: { bol?: boolean; pod?: boolean; rateCon?: boolean };
  source: SourceRef;
}

export function centsFromText(input: string | undefined | null): number | undefined {
  if (input === undefined || input === null) return undefined;
  const text = String(input).trim();
  if (!text || /^(n\/?a|-|—)$/i.test(text)) return undefined;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text) || /-$/.test(text);
  const m = /^\(?-?\s*(?:USD\s*)?\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2})\d*)?\s*-?\)?$/i.exec(text);
  if (!m) return undefined;
  const cents = Number(m[1].replace(/,/g, '')) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
  return Number.isSafeInteger(cents) ? (negative ? -cents : cents) : undefined;
}
export function formatCents(cents: number | undefined, signed = false): string {
  if (cents === undefined) return '—';
  const abs = Math.abs(cents);
  const body = '$' + Math.floor(abs / 100).toLocaleString('en-US') + '.' + String(abs % 100).padStart(2, '0');
  return cents < 0 ? '−' + body : signed && cents > 0 ? '+' + body : body;
}
export const sumCharges = (charges: Partial<Record<ChargeType, number>>): number =>
  Object.values(charges).reduce<number>((total, value) => total + (value ?? 0), 0);

/** Dates from TMS exports: ISO, US m/d/yyyy, or Excel serials. Returns ISO yyyy-mm-dd or undefined. */
export function isoDate(input: string | undefined | null): string | undefined {
  const text = (input ?? '').trim();
  if (!text) return undefined;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(text);
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  if (/^\d{5}(\.\d+)?$/.test(text)) {           // Excel serial date (1900 system)
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+text) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  return undefined;
}
function iso(y: number, mo: number, d: number): string | undefined {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : undefined;
}
export const truthy = (text: string | undefined): boolean | undefined => {
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return undefined;
  if (/^(y|yes|true|1|x|received|uploaded|attached|on file|complete|completed)$/.test(t)) return true;
  if (/^(n|no|false|0|missing|pending|none|not received)$/.test(t)) return false;
  return /\.(pdf|png|jpe?g|tiff?)$/i.test(t) || /^https?:\/\//.test(t) ? true : undefined;  // a file name or link means it's on file
};
export const normalizeRef = (ref: string) => ref.trim().toUpperCase().replace(/[\s#-]+/g, '');
