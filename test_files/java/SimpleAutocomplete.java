public class SimpleAutocomplete {
    static String formatName(String first, String last) {
        return first + " " + last;
    }

    static String greet(String fullName) {
        return "Hello, " + fullName + "!";
    }

    public static void main(String[] args) {
        String name = formatName("Rina", "Patel");
        System.out.println(name);

        String message = greet(
    }

    static void suffixMidlineDemo() {
        String name = formatName("Rina", "Patel");
        String suffixMessage = greet();
        System.out.println(suffixMessage);
    }

    static String maskedWordDemo() {
        String name = formatName("Rina", "Patel");
        return nam;
    }
}
