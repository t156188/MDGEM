import Foundation

struct Task: Identifiable {
    let id = UUID()
    var title: String
    var isDone: Bool = false
}

final class TaskStore {
    private(set) var tasks: [Task] = []

    func add(_ title: String) {
        tasks.append(Task(title: title))
    }

    func markDone(id: UUID) {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        tasks[index].isDone = true
    }
}

let store = TaskStore()
store.add("Open a markdown workspace")
store.add("Preview source files")

for task in store.tasks {
    print("- \(task.title)")
}
