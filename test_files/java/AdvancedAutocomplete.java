import java.util.List;
import java.util.stream.Collectors;

public class AdvancedAutocomplete {
    record Invoice(String id, double total) {}

    static String buildSummary(String customerId, List<Double> amounts, double taxRate, String currency) {
        double subtotal = amounts.stream().mapToDouble(Double::doubleValue).sum();
        double total = subtotal * (1.0 + taxRate);
        return customerId + ":" + currency + ":" + String.format("%.2f", total);
    }

    static String runArgumentsCase(List<Double> amounts) {
        String summary = buildSummary("C-100", amounts, 
        return summary;
    }

    static String runFormatCase(Invoice invoice) {
        String label = String.format("Invoice %s", invoice.id(
        return label;
    }

    static String runStreamCase(List<String> lines) {
        String joined = lines.stream().map(String::trim).filter(value -> !value.isEmpty()).collect(
        return joined;
    }
}
