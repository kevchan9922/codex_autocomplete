type InvoiceOptions = {
  taxRate: number;
  currency: "USD" | "EUR";
  note?: string;
};

type LineItem = {
  sku: string;
  price: number;
  quantity: number;
};

function buildInvoice(customerId: string, items: LineItem[], options: InvoiceOptions): string {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const total = subtotal * (1 + options.taxRate);
  return `${customerId}:${options.currency}:${total.toFixed(2)}`;
}

export function runObjectArgCase(items: LineItem[]): string {
  const invoice = buildInvoice("C-100", items, 
  return invoice;
}

export function runTemplateLiteralCase(invoice: { id: string; total: number }): string {
  const label = `Invoice ${invoice.id
  return label;
}

export function runChainCase(lines: string[]): string {
  const first = lines.map((line) => line.trim()).filter(Boolean).join(", ").split(
  return first;
}
