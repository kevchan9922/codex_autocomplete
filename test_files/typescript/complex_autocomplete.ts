type Currency = "USD" | "EUR";

type LineItem = {
  sku: string;
  unitPrice: number;
  quantity: number;
};

type Discount =
  | { kind: "percent"; value: number }
  | { kind: "fixed"; value: number };

function subtotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

function discountAmount(total: number, discount?: Discount): number {
  if (!discount) return 0;
  if (discount.kind === "percent") {
    return Math.min(total, total * (discount.value / 100));
  }
  return Math.min(total, discount.value);
}

function shippingFee(afterDiscount: number, currency: Currency): number {
  if (afterDiscount >= 100) return 0;
  if (currency === "EUR") return 6;
  return 7;
}

export function checkoutTotal(items: LineItem[], currency: Currency, taxRate: number, discount?: Discount): number {
  const raw = subtotal(items);
  const discountValue = discountAmount(raw, discount);
  const afterDiscount = raw - discountValue;
  const shipping = shippingFee(afterDiscount, currency);
  const tax = afterDiscount * taxRate;
  return Number((afterDiscount + shipping + tax).toFixed(2));
}

const items: LineItem[] = [
  { sku: "mouse", unitPrice: 25, quantity: 2 },
  { sku: "monitor", unitPrice: 140, quantity: 1 },
];

const total = checkoutTotal(
const discountPreview = checkoutTotal(items, "USD", 0.07, 
