
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub struct Task {
    pub id: u32,
    pub payload: String,
    pub is_completed: bool,
}

pub struct TaskScheduler {
    tasks: Arc<Mutex<HashMap<u32, Task>>>,
}

impl TaskScheduler {
    pub fn new() -> Self {
        TaskScheduler {
            tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn add_task(&self, id: u32, payload: String) {
        let mut map = self.tasks.lock().unwrap();
        map.insert(id, Task { id, payload, is_completed: false });
    }

    pub fn process_all(&self) {
        let tasks_clone = Arc::clone(&self.tasks);
        thread::spawn(move || {
            let mut map = tasks_clone.lock().unwrap();
            for (id, task) in map.iter_mut() {
                if !task.is_completed {
                    println!("Processing task {}", id);
                    thread::sleep(Duration::from_millis(100));
                    task.is_completed = true;
                }
            }
        }).join().unwrap();
    }

    pub fn get_completed(&self) -> Vec<Task> {
        let map = self.tasks.lock().unwrap();
        map.values()
            .filter(|t| t.is_completed)
            .cloned()
            .collect()
    }
}
