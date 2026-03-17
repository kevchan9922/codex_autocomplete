import java.util.ArrayList;
import java.util.List;

public class LargeAutocomplete {
    record Metric(String day, int signups, int activated, int retained) {}

    static final List<Metric> METRICS = List.of(
        new Metric("2024-06-01", 120, 73, 60),
        new Metric("2024-06-02", 133, 81, 63),
        new Metric("2024-06-03", 98, 61, 50),
        new Metric("2024-06-04", 145, 90, 71),
        new Metric("2024-06-05", 160, 101, 83),
        new Metric("2024-06-06", 140, 87, 72),
        new Metric("2024-06-07", 170, 110, 91)
    );

    static double activationRate(Metric metric) {
        if (metric.signups() == 0) return 0.0;
        return (double) metric.activated() / metric.signups();
    }

    static double retentionRate(Metric metric) {
        if (metric.activated() == 0) return 0.0;
        return (double) metric.retained() / metric.activated();
    }

    static String summarizeMetric(Metric metric) {
        return "%s signups=%d activation=%.2f%% retention=%.2f%%".formatted(
            metric.day(),
            metric.signups(),
            activationRate(metric) * 100,
            retentionRate(metric) * 100
        );
    }

    static String buildWeeklyReport() {
        List<String> lines = new ArrayList<>();
        lines.add("Weekly KPI report");
        lines.add("-----------------");
        for (Metric metric : METRICS) {
            lines.add(summarizeMetric(metric));
        }
        return String.join("\n", lines);
    }

    static String p0Summary() {
        return summarizeMetric(
    }

    static int nearDuplicateSummaryCount() {
        String summary = buildWeeklyReport();
        String summaryLine = summarizeMetric(METRICS.get(0));
        List<String> summaryLines = List.of(summaryLine, summary);
        return summaryLines.
    }

    public static void main(String[] args) {
        System.out.println(buildWeeklyReport());
    }
}
