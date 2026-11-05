//! Browser adapter derived from the Strands Shell terminal prototype.
//! Adds session metadata without executing an extra command or changing `$?`.

use std::cell::RefCell;

use strands_shell::Shell;
use tokio::runtime::{Builder, Runtime};
use tokio::task::LocalSet;

wit_bindgen::generate!({
    path: "wit",
    world: "terminal",
});

struct Session {
    shell: Shell,
    runtime: Runtime,
    tasks: LocalSet,
}

impl Session {
    fn new() -> Self {
        Self {
            shell: Shell::builder()
                .max_input(64 * 1024)
                .max_output(128 * 1024)
                .max_file_size(1024 * 1024)
                .max_inodes(512)
                .max_bg_jobs(0)
                .build()
                .expect("create in-memory shell"),
            runtime: Builder::new_current_thread()
                .build()
                .expect("create shell runtime"),
            tasks: LocalSet::new(),
        }
    }

    fn execute(&mut self, command: &str) -> Output {
        let output = self
            .runtime
            .block_on(self.tasks.run_until(self.shell.run(command)));
        let files = self
            .runtime
            .block_on(self.tasks.run_until(self.shell.list_files(".")))
            .unwrap_or_default()
            .into_iter()
            .map(|file| {
                if file.is_dir == Some(true) {
                    format!("{}/", file.name)
                } else {
                    file.name
                }
            })
            .collect();
        Output {
            status: output.status,
            stdout: output.stdout,
            stderr: output.stderr,
            cwd: self.shell.get_env("PWD").unwrap_or("/").to_owned(),
            files,
        }
    }
}

thread_local! {
    static SESSION: RefCell<Session> = RefCell::new(Session::new());
}

struct Terminal;

impl Guest for Terminal {
    fn execute(command: String) -> Output {
        SESSION.with_borrow_mut(|session| session.execute(&command))
    }
}

export!(Terminal);
