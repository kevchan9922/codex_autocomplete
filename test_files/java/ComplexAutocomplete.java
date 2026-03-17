import java.util.List;

public class ComplexAutocomplete {
    record Item(String sku, double price, int quantity) {}
    record Coupon(String code, String kind, double amount) {}

    static double subtotal(List<Item> items) {
        return items.stream().mapToDouble(item -> item.price() * item.quantity()).sum();
    }

    static double couponDiscount(double subtotal, Coupon coupon) {
        if (coupon == null) return 0.0;
        return switch (coupon.kind()) {
            case "percent" -> Math.min(subtotal, subtotal * (coupon.amount() / 100.0));
            case "fixed" -> Math.min(subtotal, coupon.amount());
            default -> throw new IllegalArgumentException("Unknown coupon type: " + coupon.kind());
        };
    }

    static double shipping(double afterDiscount) {
        if (afterDiscount >= 100.0) return 0.0;
        if (afterDiscount >= 50.0) return 5.0;
        return 9.0;
    }

    static double checkoutTotal(List<Item> items, Coupon coupon, double taxRate) {
        double rawSubtotal = subtotal(items);
        double discount = couponDiscount(rawSubtotal, coupon);
        double discounted = rawSubtotal - discount;
        double tax = discounted * taxRate;
        return Math.round((discounted + shipping(discounted) + tax) * 100.0) / 100.0;
    }

    public static void main(String[] args) {
        List<Item> cart = List.of(
            new Item("keyboard", 80.0, 1),
            new Item("cable", 10.0, 2)
        );
        Coupon coupon = new Coupon("WELCOME10", "percent", 10.0);
        Coupon draftCoupon = new Coupon(

        double total = checkoutTotal(
    }
}
