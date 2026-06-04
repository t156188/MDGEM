// Rust 程序模板

#[derive(Debug)]
struct Task {
    title: String,
    done: bool,
}

impl Task {
    fn new(title: &str) -> Self {
        Task {
            title: title.to_string(),
            done: false,
        }
    }
}

fn main() {
    let tasks = vec![
        Task { title: "写文档".into(), done: true },
        Task::new("写代码"),
        Task::new("测试"),
    ];

    for task in tasks.iter().filter(|t| !t.done) {
        println!("待办: {}", task.title);
    }
}
