import { describe, expect, it } from 'vitest';
import { centsFromText, isoDate, truthy } from './model';
import { importLoads, suggestMapping } from './tms-import';
import { reconcile } from './reconcile';
import type { CarrierInvoice } from './reconcile';

// Synthetic exports with deliberately different layouts (column names are illustrative, not any vendor's real format).
const TMS_A = `Load #,Customer,Carrier,Status,Pickup Date,Delivery Date,BOL #,Linehaul,Fuel Surcharge,Detention,Customer Total,Carrier Pay,Carrier Detention,Invoice #,Invoice Amount,POD,Rate Con
1001,Acme Foods,Swift Haul,Delivered,2026-10-30,2026-11-01,BOL1001,"$2,000.00",$300.00,,"$2,300.00","$1,950.00",$150.00,,,Yes,Yes
1002,Acme Foods,Swift Haul,Invoiced,10/28/2026,10/29/2026,BOL1002,"2,100.00",300.00,,"2,400.00","1,900.00",,INV-2002,"2,200.00",No,Yes
1003,Beta Retail,Rio Freight,Invoiced,2026-10-25,2026-10-26,BOL1003,1300,200,,1500,1200,,INV-2003,1500,Yes,Yes
1004,Gamma Supply,Rio Freight,In Transit,2026-11-07,,BOL55501,2100,300,,2400,2000,,,,,Yes
1005,Delta Co,Swift Haul,Booked,2026-11-12,,BOL1005,1700,200,,1900,2100,,,,,
`;
const TMS_B = `Order Number;Shipper;Carrier;BOL;Delivered;Total Charges;Carrier Rate;Proof of Delivery
TB-77;Gamma Supply;Rio Freight;BOL 555-01;11/08/2026;2250.00;2000.00;uploaded.pdf
TB-80;Echo Imports;North Line;BOL8000;11/02/2026;900.00;700.00;
`;
const invoice = (o: Partial<CarrierInvoice>): CarrierInvoice => ({ refs: [], lines: [], source: { file: 'x.pdf' }, ...o });

describe('parsing helpers', () => {
  it('reads money as integer cents in common TMS formats', () => {
    expect(['$2,000.00', '2000', '(150.00)', '-75', '1,234.5', 'USD 99.99', '', 'n/a'].map(centsFromText))
      .toEqual([200000, 200000, -15000, -7500, 123450, 9999, undefined, undefined]);
  });
  it('reads dates and yes/no flags', () => {
    expect([isoDate('2026-11-01'), isoDate('11/8/2026'), isoDate('46327'), isoDate('2/30/2026')]).toEqual(['2026-11-01', '2026-11-08', '2026-11-01', undefined]);
    expect([truthy('Yes'), truthy('No'), truthy('uploaded.pdf'), truthy(''), truthy('maybe')]).toEqual([true, false, true, undefined, undefined]);
  });
});

describe('column mapping suggestions', () => {
  it('maps differently named exports to the same fields', () => {
    const a = suggestMapping(TMS_A.split('\n')[0].split(','));
    expect(a).toMatchObject({ loadId: 0, customer: 1, carrier: 2, status: 3, pickupDate: 4, deliveryDate: 5, refBol: 6, customerLinehaul: 7,
      customerFuel: 8, customerDetention: 9, customerTotal: 10, carrierTotal: 11, carrierDetention: 12, customerInvoiceNumber: 13, customerInvoiceAmount: 14, hasPod: 15, hasRateCon: 16 });
    const b = suggestMapping(TMS_B.split('\n')[0].split(';'));
    expect(b).toMatchObject({ loadId: 0, customer: 1, carrier: 2, refBol: 3, deliveryDate: 4, customerTotal: 5, carrierTotal: 6, hasPod: 7 });
  });
});

describe('reconciliation across two TMSs and carrier invoice PDFs', () => {
  const a = importLoads(TMS_A, 'tms-a.csv', 'TMS A');
  const b = importLoads(TMS_B, 'tms-b.csv', 'TMS B');
  const invoices: CarrierInvoice[] = [
    invoice({ invoiceNumber: 'SH-9001', carrier: 'Swift Haul', refs: ['1001'], source: { file: 'swift-9001.pdf', page: 1 },
      lines: [{ type: 'linehaul', amount: 195000 }, { type: 'detention', amount: 15000 }, { type: 'lumper', amount: 7500 }] }),
    invoice({ invoiceNumber: 'SH-9001', carrier: 'Swift Haul', refs: ['1001'], source: { file: 'swift-9001-resent.pdf' }, total: 217500 }),
    invoice({ invoiceNumber: 'NL-1', carrier: 'North Line', refs: ['LOAD 9999'], source: { file: 'northline.pdf' }, total: 50000 })
  ];
  const r = reconcile([...a.loads, ...b.loads], invoices, '2026-11-10');
  const rules = (loadId: string) => r.loads.find(l => l.loadId === loadId)!.exceptions.map(e => e.rule).sort();

  it('merges the same shipment from both systems by shared reference', () => {
    expect(r.totals.loads).toBe(6);                             // 1001-1005 from A, TB-80 from B, TB-77 merged into 1004
    expect(r.loads.find(l => l.loadId === '1004')!.records.map(x => x.source.system)).toEqual(['TMS A', 'TMS B']);
  });
  it('finds money problems per load', () => {
    expect(rules('1001')).toEqual(['accessorial-not-billed', 'accessorial-not-billed', 'carrier-overbilled', 'carrier-unexpected-charge', 'duplicate-carrier-invoice', 'unbilled']);
    expect(rules('1002')).toEqual(['customer-invoice-mismatch', 'missing-pod']);
    expect(rules('1003')).toEqual([]);                           // clean load: no noise
    expect(rules('1004')).toEqual(['conflict-between-systems', 'unbilled']);
    expect(rules('1005')).toEqual(['negative-margin']);         // booked, not delivered: not "unbilled"
    expect(rules('TB-80')).toEqual(['unbilled']);
    expect(r.exceptions.filter(e => e.rule === 'unmatched-carrier-invoice')).toHaveLength(1);
  });
  it('totals the dollars at stake without double counting', () => {
    expect(r.totals.unbilled).toBe(230000 + 240000 + 90000 + 20000);   // 1001, 1004, TB-80 unbilled + 1002 short-invoiced
    expect(r.totals.underBilled).toBe(15000 + 7500);                    // detention + lumper paid but not billed on 1001
    expect(r.totals.overBilled).toBe(22500 + 217500);                   // $225 over the $1,950 rate con (incl. detention) + a duplicate invoice
    const unbilled = r.exceptions.find(e => e.rule === 'unbilled' && e.loadId === '1001')!;
    expect(unbilled.detail).toBe('Delivered 9 days ago with no customer invoice. $2,300.00 to bill to Acme Foods.');
    expect(unbilled.sources[0]).toEqual({ system: 'TMS A', file: 'tms-a.csv', row: 2 });
  });
  it('never flags unknown paperwork as missing', () => {
    expect(rules('TB-80')).not.toContain('missing-pod');        // POD column blank = unknown, not missing
  });
});
