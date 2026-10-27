//! Live folder watching: debounced file-system events become indexer jobs.

use crate::scan::Job;
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::time::Duration;

pub type Watcher = Debouncer<RecommendedWatcher, RecommendedCache>;

pub fn watch(root: &Path, tx: Sender<Job>) -> Result<Watcher, String> {
    let mut d = new_debouncer(Duration::from_millis(1200), None, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths: Vec<PathBuf> =
            events.iter().filter(|e| !e.kind.is_access()).flat_map(|e| e.paths.iter().cloned()).collect();
        paths.sort();
        paths.dedup();
        if !paths.is_empty() {
            let _ = tx.send(Job::Paths(paths));
        }
    })
    .map_err(|e| e.to_string())?;
    d.watch(root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    Ok(d)
}
