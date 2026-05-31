import java.util.List;

public class Sample {
    record Document(String name, List<String> tags) {
        boolean hasTag(String tag) {
            return tags.contains(tag);
        }
    }

    public static void main(String[] args) {
        var documents = List.of(
            new Document("README.md", List.of("markdown", "guide")),
            new Document("sample.java", List.of("code", "java"))
        );

        documents.stream()
            .filter(document -> document.hasTag("code"))
            .forEach(document -> System.out.println(document.name()));
    }
}
