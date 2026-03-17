"""Complex Python fixture requiring cross-function understanding."""

from dataclasses import dataclass


@dataclass
class Item:
    sku: str
    price: float
    quantity: int


@dataclass
class Coupon:
    code: str
    kind: str  # "percent" or "fixed"
    amount: float


def subtotal(items: list[Item]) -> float:
    return sum(item.price * item.quantity for item in items)


def coupon_discount(current_subtotal: float, coupon: Coupon | None) -> float:
    if coupon is None:
        return 0.0
    if coupon.kind == "percent":
        return min(current_subtotal, current_subtotal * (coupon.amount / 100.0))
    if coupon.kind == "fixed":
        return min(current_subtotal, coupon.amount)
    raise ValueError(f"Unknown coupon kind: {coupon.kind}")


def shipping_cost(after_discount_total: float) -> float:
    if after_discount_total >= 100:
        return 0.0
    if after_discount_total >= 50:
        return 4.99
    return 9.99


def total_with_tax_and_shipping(items: list[Item], coupon: Coupon | None, tax_rate: float) -> float:
    raw_subtotal = subtotal(items)
    discount = coupon_discount(raw_subtotal, coupon)
    discounted_total = raw_subtotal - discount
    shipping = shipping_cost(discounted_total)
    tax = discounted_total * tax_rate
    return round(discounted_total + shipping + tax, 2)


def checkout_preview() -> float:
    basket = [
        Item("keyboard", 80.0, 1),
        Item("cable", 10.0, 2),
    ]
    coupon = Coupon(code="WELCOME10", kind="percent", amount=10)

    return total_with_tax_and_shipping(


def checkout_preview_with_explicit_rate() -> float:
    basket = [
        Item("keyboard", 80.0, 1),
        Item("cable", 10.0, 2),
    ]
    coupon = Coupon(code="WELCOME10", kind="percent", amount=10)
    return total_with_tax_and_shipping(basket, coupon, 
