// Swift 程序模板
import Foundation

struct Task {
    let title: String
    var done: Bool = false
}

struct TaskList {
    private(set) var tasks: [Task]

    var pending: [Task] {
        tasks.filter { !$0.done }
    }

    mutating func add(_ title: String) {
        tasks.append(Task(title: title))
    }
}

var list = TaskList(tasks: [Task(title: "写文档", done: true)])
list.add("写代码")
list.add("测试")

for task in list.pending {
    print("待办: \(task.title)")
}
