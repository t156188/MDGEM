// Java 程序模板
import java.util.List;
import java.util.stream.Collectors;

public class Main {

    record Task(String title, boolean done) {
        static Task of(String title) {
            return new Task(title, false);
        }
    }

    public static void main(String[] args) {
        List<Task> tasks = List.of(
            new Task("写文档", true),
            Task.of("写代码"),
            Task.of("测试")
        );

        tasks.stream()
            .filter(t -> !t.done())
            .map(Task::title)
            .collect(Collectors.toList())
            .forEach(title -> System.out.println("待办: " + title));
    }
}
