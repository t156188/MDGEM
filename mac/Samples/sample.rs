#[derive(Debug)]
struct Note {
    title: String,
    tags: Vec<String>,
}

impl Note {
    fn matches(&self, tag: &str) -> bool {
        self.tags.iter().any(|item| item == tag)
    }
}

fn main() {
    let notes = vec![
        Note { title: "Renderer".into(), tags: vec!["markdown".into(), "webview".into()] },
        Note { title: "Terminal".into(), tags: vec!["shell".into(), "pty".into()] },
    ];

    for note in notes.iter().filter(|note| note.matches("markdown")) {
        println!("{:?}", note);
    }
}
