public class SuggestionDocumentation {
    static String normalizeName(String rawName) {
        String trimmed = rawName.trim();
        String[] parts = trimmed.split("\\s+");
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < parts.length; i += 1) {
            String part = parts[i];
            String normalized = part.substring(0, 1).toUpperCase() + part.substring(1).toLowerCase();
            if (i > 0) {
                builder.append(" ");
            }
            builder.append(normalized);
        }
        return builder.toString();
    }

    static String wrapPreview(String value) {
        return "[" + value + "]";
    }

    static String docPreview() {
        String user = normalizeName("  rina patel ");
        String badge = "eng:" + user;
        // DOC-CURSOR: trigger autocomplete after "(" and document ghost text.
        return wrapPreview(
    }
}
