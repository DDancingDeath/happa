/**
 * Shapes the money and calculation modules read (#71), for `npm run typecheck`
 * (tsc checks the files that start with `// @ts-check`; nothing is compiled or
 * shipped). Every field is optional: stored records come from several app
 * versions, so the code checks what is there. The index signatures keep older or
 * rarer fields readable.
 */

/** A money amount as stored: a number, or a numeric string from an old record. */
type Amount = number;

/** Nested payment state of a bill (canonical when present). */
interface Payment {
    cash?: Amount;
    online?: Amount;
    due?: Amount;
    total?: Amount;
    writtenOff?: Amount;
    [key: string]: any;
}

/** One line of a bill. */
interface BillLine {
    itemId?: string;
    item?: string;
    name?: string;
    hindiName?: string;
    qty?: Amount;
    quantity?: Amount;
    rate?: Amount;
    total?: Amount;
    amount?: Amount;
    weights?: number[];
    packets?: number;
    [key: string]: any;
}

/** A purchase, retail sale or wholesale sale as stored (any app version). */
interface Bill {
    id?: string;
    billNumber?: string;
    date?: any;
    timestamp?: number;
    items?: BillLine[];
    grandTotal?: Amount;
    amountPayable?: Amount;
    total?: Amount;
    billTotal?: Amount;
    saleTotal?: Amount;
    laborCharges?: Amount;
    labour?: Amount;
    cashPayment?: Amount;
    onlinePayment?: Amount;
    amountPaid?: Amount;
    dueAmount?: Amount;
    due?: Amount;
    payment?: Payment;
    payments?: Rec[];
    cleared?: boolean;
    voided?: boolean;
    openingBalance?: any;
    [key: string]: any;
}

/** An expense (business or personal). */
interface Expense {
    amount?: Amount;
    category?: string;
    type?: string;
    paymentMode?: string;
    date?: any;
    day?: string;
    [key: string]: any;
}

/** A cash-drawer session (`cashManagement`). */
interface CashSession {
    id?: string;
    date?: string;
    openingBalance?: Amount;
    closingBalance?: Amount;
    expectedBalance?: Amount;
    signedOut?: boolean;
    counted?: boolean;
    cashDeposits?: Rec[];
    duePayments?: Rec[];
    [key: string]: any;
}

/** Any plain record with string keys (settings, maps of totals, stock state). */
type Rec = { [key: string]: any };
